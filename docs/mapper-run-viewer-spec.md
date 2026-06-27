# Map Run Viewer — Feature Specification

## Overview

The Map Run Viewer scans the open workspace for `.map.json` files produced by the CF→GHA mapper tool (typically found under `**/mapperruns/` or `**/artifacts/mapperruns/`). It surfaces these files in a dedicated tree view in the CF Migrate activity bar panel. Clicking a file opens a rich side-by-side diff panel that visually links each Codefresh pipeline step to its mapped GitHub Actions counterpart, with confidence color-coding and an interactive rationale panel.

---

## 1. Map Run File Format

A `.map.json` file has this top-level shape:

```json
{
  "version": "1",
  "meta": {
    "pipeline_name": "IDAP.BNPB.NONPROD/crm-deployment",
    "pipeline_id": "698ab19f426376c9578bffd5",
    "project": "IDAP.BNPB.NONPROD",
    "source_file": "codefresh/migration-db/workflow-imports/IDAP_BNPB_NONPROD_crm-deployment.yml",
    "mapping_source": "mapping_data/cf_gha_mappings.yaml",
    "target_workflow": "artifacts/mapperruns/IDAP_BNPB_NONPROD_crm-deployment.suggested.yml",
    "generated_at": "2026-06-21",
    "total_steps": 19,
    "stats": { "mapped": 6, "fallback": 1, "manual_review": 12 }
  },
  "mappings": [
    {
      "seq": 1,
      "cf_step": "set_default_variables",
      "cf_type": "freestyle",
      "cf_stage": "prepare",
      "cf_title": "Set Default Variables",
      "gha_job": "prepare",
      "gha_step": "Set default variables",
      "rule_id": "freestyle-fallback-manual-review",
      "action": "run:",
      "status": "fallback",
      "confidence": "low",
      "pattern_matched": null,
      "rationale": "Pure shell exports and cf_export calls; no command pattern in mapping data matched."
    }
  ]
}
```

### Status values
| Value | Meaning |
|---|---|
| `mapped` | Deterministic pattern matched with high confidence |
| `fallback` | A generic fallback rule was used; needs review |
| `manual_review` | No automated mapping possible; must be done manually |

### Confidence values
| Value | Meaning |
|---|---|
| `high` | ≥ 0.85 match score |
| `medium` | 0.50–0.84 match score |
| `low` | < 0.50 or fallback |

---

## 2. Map Run Scanner

**Trigger:** Called when the Map Run tree view is first revealed and on demand via a refresh command.

**Algorithm:**
1. For each workspace folder, use `vscode.workspace.findFiles` with glob `**/*.map.json` (excluding `**/node_modules/**`).
2. Parse each file as JSON; validate the presence of `version`, `meta`, and `mappings[]`.
3. Collect valid entries as `MapRunEntry` objects (file path + workspace folder + parsed data).
4. Return sorted by `meta.generated_at` descending, then by `meta.pipeline_name` alphabetically.

---

## 3. Map Run Tree View

**View ID:** `cf-migrate.mapRuns`  
**Display Name:** "Map Runs"  
**Location:** Inside the `cf-migrate` activity-bar container, below the existing KB view.

### Tree structure

```
Map Runs
├─ [Refresh button in view/title]
├─ IDAP.BNPB.NONPROD                       ← project group node
│   └─ crm-deployment  ·  6↗ 1⚠ 12✗      ← entry node
│       2026-06-21 · 19 steps
└─ ANOTHER.PROJECT
    └─ build-pipeline  ·  12↗ 3⚠ 4✗
```

### Node types

| Kind | Label | Description | Icon |
|---|---|---|---|
| `project` | `meta.project` | Groups entries by project | `$(folder)` |
| `entry` | `meta.pipeline_name` (last segment) | One `.map.json` file | `$(list-tree)` |
| `empty` | "No .map.json files found" | Shown when scan returns nothing | `$(info)` |

**Entry node description line:** `{mapped}↗ {fallback}⚠ {manual_review}✗`  
**Entry node tooltip:** Full `meta.pipeline_name`, `source_file`, `generated_at`

**Command on entry click:** `cf-migrate.openMapRun` — opens the diff panel.

**Refresh command:** `cf-migrate.refreshMapRuns` — re-runs the scanner and fires the tree change event.

---

## 4. Map Run Diff Panel

**Command:** `cf-migrate.openMapRun`  
**Panel type:** `vscode.WebviewPanel`, `ViewColumn.Active`  
**Title:** `Map Run — {meta.pipeline_name}`  
**Options:** `{ enableScripts: true, retainContextWhenHidden: true }`

### Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ HEADER: pipeline_name | project | date  │  6 mapped  1 fallback    │
│          source_file → target_workflow  │  12 manual_review        │
├──────────────────────────────┬──────────────────────────────────────┤
│ CODEFRESH (source_file)      │ GITHUB ACTIONS (target_workflow)    │
├──────────────────────────────┼──────────────────────────────────────┤
│ [stage badge] step title     │ [job badge] step name               │
│  cf_type · cf_step           │  action                             │
│──────────────────────────────│──────────────────────────────────────│
│ ... one row per mapping ...  │                                      │
├────────────────────────────────────────────────────────────────────┤
│ RATIONALE PANEL                                                    │
│  #1 — Set Default Variables                                        │
│  Rule: freestyle-fallback-manual-review                            │
│  "Pure shell exports and cf_export calls; no command pattern..."   │
└────────────────────────────────────────────────────────────────────┘
```

### Step row layout

Each mapping produces one row spanning both columns. Rows are grouped visually by `cf_stage` (left) and `gha_job` (right).

**Left cell (CF):**
- Stage badge (small pill): `cf_stage`
- Bold: `cf_title`
- Muted: `cf_type · cf_step`

**Connector cell (centre, narrow):**
- `mapped` → `→` arrow in the confidence color
- `fallback` → `⚠` in amber
- `manual_review` → `✗` in red

**Right cell (GHA):**
- Job badge (small pill): `gha_job`
- Bold: `gha_step`
- Muted: `action`

### Color coding

| Status + Confidence | Row left-border color | Row background |
|---|---|---|
| `mapped` + `high` | `#3cc878` (green) | transparent |
| `mapped` + `medium` | `#e6b43c` (amber) | transparent |
| `mapped` + `low` | `#e89c3c` (orange) | `rgba(232,156,60,0.05)` |
| `fallback` (any) | `#e89c3c` (orange) | `rgba(232,156,60,0.05)` |
| `manual_review` (any) | `#dc5050` (red) | `rgba(220,80,80,0.10)` |

### Interaction

- **Click a row** → highlights that row (selected state), populates the Rationale Panel below with the full details of that mapping. The row stays highlighted until another is clicked.
- **Hover a row** → subtle background highlight.
- **Rationale Panel** (always visible, updates on row click):
  - Title: `#seq — cf_title → gha_step`
  - Badges: status badge + confidence badge
  - Rule: `rule_id`
  - Pattern: `pattern_matched` (or "none")
  - Rationale text (full `rationale` field)
  - Default text: "Click any step row to see its mapping rationale."

### Source file links (optional / best-effort)

If the `source_file` path resolves to a readable file within the workspace, the CF panel header shows a clickable link that opens that file in a VS Code editor tab (via a `jumpToSource` webview → extension message).

Similarly for `target_workflow`.

---

## 5. TypeScript Types (`packages/core/src/types/maprun.ts`)

```typescript
export type MappingStatus = 'mapped' | 'fallback' | 'manual_review';
export type MappingConfidence = 'high' | 'medium' | 'low';

export interface MapRunStats {
  mapped: number;
  fallback: number;
  manual_review: number;
}

export interface MapRunMeta {
  pipeline_name: string;
  pipeline_id: string;
  project: string;
  source_file: string;
  mapping_source: string;
  target_workflow: string;
  generated_at: string;
  total_steps: number;
  stats: MapRunStats;
}

export interface MapRunMapping {
  seq: number;
  cf_step: string;
  cf_type: string;
  cf_stage: string;
  cf_title: string;
  gha_job: string;
  gha_step: string;
  rule_id: string;
  action: string;
  status: MappingStatus;
  confidence: MappingConfidence;
  pattern_matched: string | null;
  rationale: string;
}

export interface MapRunFile {
  version: string;
  meta: MapRunMeta;
  mappings: MapRunMapping[];
}
```

---

## 6. File Structure

```
packages/
  core/src/types/
    maprun.ts                         ← NEW: types (exported from types/index.ts)

  extension/src/
    scanners/
      MapRunScanner.ts                ← NEW: workspace scan → MapRunEntry[]
    views/
      MapRunTreeProvider.ts           ← NEW: tree data provider
    webviews/
      MapRunDiffPanel.ts              ← NEW: side-by-side webview panel
    extension.ts                      ← UPDATED: register view + commands

packages/extension/
  package.json                        ← UPDATED: view, commands, activation event
```

---

## 7. Commands Added

| Command ID | Title | Icon | Where |
|---|---|---|---|
| `cf-migrate.openMapRun` | Open Map Run Diff | `$(diff)` | `view/item/context` on `maprun-entry` |
| `cf-migrate.refreshMapRuns` | Refresh Map Runs | `$(refresh)` | `view/title` on `cf-migrate.mapRuns` |

---

## 8. Activation Event Addition

```json
"workspaceContains:**/*.map.json"
```

Added to `activationEvents` so the extension activates when a `.map.json` is present in the workspace, even without a Codefresh pipeline.
