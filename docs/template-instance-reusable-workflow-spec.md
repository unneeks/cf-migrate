# Template / Instance Detection & Reusable-Workflow Generation — Spec

## Overview

Codefresh pipelines are often copy-pasted across services or environments: the same step
structure, deployed once per microservice (CRM, billing, notifications, …) or once per
environment (DEV/STAGING/PROD), differing only in variable values (image names, namespaces,
release names, replica counts). Migrating each copy independently means mapping — and
maintaining — the same logic N times.

This feature detects that pattern in the Map Run tree, restructures it so the shared
structure ("the template") is mapped once and its copies ("instances") are shown underneath
it, and generates a GitHub Actions **reusable workflow** (`workflow_call`) for the template
plus one thin **caller workflow** per instance that passes its own variable values as inputs.

No changes were made to discovery, the core `MapRunFile` schema, or the LLM-driven
analyse/plan/generate pipeline — detection and generation are computed entirely from data
already on disk (`*.map.json` + the CF source YAML files), as a read-only view layered on
top of the existing Map Run tree.

---

## 1. Template/instance detection

**File:** `packages/extension/src/utils/TemplateGrouping.ts`

Two map runs are considered instances of the same template when they have an identical
**structural signature**:

```ts
signature = JSON.stringify({
  mapping_source: meta.mapping_source,
  steps: mappings.map(m => [m.cf_step, m.cf_type, m.cf_stage, m.gha_job, m.gha_step, m.rule_id, m.action]),
})
```

This intentionally excludes `cf_title`, `rationale`, and `confidence` (cosmetic/LLM-variance
fields) and the actual CF/GHA *content* — it only compares the shape of the mapping. Two
pipelines with the same step sequence mapped the same way are the same template, even if
their underlying YAML differs in variable values.

- 2+ entries sharing a signature → a `TemplateGroup`. The **template** is the entry with the
  alphabetically-lowest `source_file` path (deterministic across re-scans — re-running
  discovery never reshuffles which one is "the template"). The rest become `instances`.
- A signature matched by only one entry → that entry is `standalone` (rendered as before).
- Detection runs **across the whole workspace**, not scoped to one CF project — instances of
  the same template typically live in different CF projects (e.g. one per environment).

## 2. Map Run tree restructuring

**File:** `packages/extension/src/views/MapRunTreeProvider.ts`

```
Template: <name>                     (new node, contextValue: maprun-template-group)
├─ <name> (template)                 (contextValue: maprun-entry — opens the diff panel as before)
├─ <instance 1>                      (contextValue: maprun-instance)
└─ <instance 2>                      (contextValue: maprun-instance)
<Project> (no detected template)     (existing per-project grouping, unchanged)
├─ <pipeline>
└─ <pipeline>
```

- Clicking the **template** entry opens `MapRunDiffPanel` exactly as before — this is "only
  the template is available for mapping": instances never get their own diff panel.
- Clicking an **instance** runs `cf-migrate.explainInstance`, which shows an info message
  pointing back to the template's mapping and offers to open it.
- Right-clicking (or the inline icon on) a **template group** runs
  `cf-migrate.generateCallerWorkflows`.

## 3. Variable diffing

**File:** `packages/extension/src/generation/ReusableCallerGenerator.ts`

`diffPipelineVariablesRaw(templateYaml, instanceYaml)` parses both CF pipeline YAMLs and
recursively compares their `spec` trees (not `metadata` — pipeline name/project/tags are
identity, not variables), collecting every leaf scalar that differs at the same path.

Two carve-outs keep the result meaningful instead of noisy:

1. **Free-text array elements are opaque by default.** A `commands:`/`environment:` array of
   shell strings is not recursed into — diffing two arbitrary shell command strings character
   by character produces a diff nobody can read. The one named exception:
   **`KEY=value` / `cf_export KEY=value`** lines are pattern-matched on both sides; if the key
   matches and the value differs, that's a named diff (this is how `ECR_REPO` and
   `HELM_RELEASE_NAME` survive being inside `commands:` blocks).
2. **Names must be assigned once, globally.** `assignVariableNames(rawDiffs)` takes the union
   of every instance's raw diffs in the group and assigns one name per distinct path. Doing
   this per-instance was an early bug: the same path (e.g. `deploy_to_staging.set.replicaCount`
   vs `deploy_to_production.set.replicaCount`) would collide on the bare name `replicaCount`,
   and which instance happened to disambiguate first depended on what else differed in *that*
   instance's diff — different instances could end up assigning different names to the same
   path, and worse, a same-name collision within one instance's `with:` block silently
   **overwrote one variable's value with the other's**. Naming is now computed once over the
   full corpus of diffs from every instance, so a given path always gets the same name, and
   collisions are disambiguated using the nearest non-structural ancestor (typically the step
   name: `deploy_to_staging_replicaCount` vs `deploy_to_production_replicaCount`).

## 4. Generation

**File:** `packages/extension/src/commands/generateCallerWorkflows.ts`

Two distinct write operations, deliberately kept separate:

1. **`ensureWorkflowCallTrigger`** (template only) — purely textual. Finds the `on:` line and
   its indentation, splices a `workflow_call:` sibling key with one `inputs:` entry per
   detected variable (defaulting to the template's own value), and leaves every other line —
   jobs, steps, comments, existing TODOs — untouched. **Idempotent**: if `workflow_call:`
   already exists, the file is returned unchanged. This is additive and safe.

   Explicitly **not** attempted: rewriting the job/step bodies to replace the template's
   hardcoded values with `${{ inputs.X }}`. Guessing which occurrence of a value to replace
   from a textual match is exactly the kind of silent-wrong-guess this tool avoids elsewhere
   (see `MANUAL_REVIEW` steps in the generated GHA YAML) — each declared input carries a
   `description:` noting it needs to be wired in manually.

2. **`buildCallerWorkflow`** (per instance) — fully deterministic. Writes
   `<instance-slug>.caller.yml` next to the template's workflow file:

   ```yaml
   name: <instance name>
   on:
     workflow_dispatch: {}
     push:
       branches: [main]
   jobs:
     call-template:
       uses: ./<template workflow filename>
       with:
         <VAR>: "<instance's own value>"
         ...
       secrets: inherit
   ```

   This is pure data — the instance's own variable values passed through — so there's no
   guessing involved and it's safe to write outright every time the command runs (it
   overwrites the caller file, since it's fully derived and has no hand-edits to preserve).

---

## Out of scope / explicit non-goals

- **Body rewriting.** The template's job/step bodies are never edited to consume the new
  inputs — see §4. A human still has to decide where `${{ inputs.X }}` belongs.
- **Real Codefresh `kind: template` pipelines.** Detection here is purely structural
  (identical mapping shape), not based on a CF API `templateId`/`kind: template` field —
  those don't appear anywhere in this codebase's discovery layer today. If/when discovery
  gains that signal, it would be an additional, stronger detection path feeding into the same
  `TemplateGroup` model, not a replacement for this one.
- **Threading through the LLM analyse/plan/generate pipeline.** This feature operates purely
  on Map Run tree data (`*.map.json` + CF source YAML) that's already been produced. It does
  not change `AnalysisAgent`, `PlanningAgent`, or `GenerationAgent`.
