# CF Migrate — Codefresh to GitHub Actions Migration System

Intelligent migration system that analyses Codefresh pipelines and generates equivalent GitHub Actions workflows, built as a VS Code extension powered by GitHub Copilot.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| npm | ≥ 10 (bundled with Node 20) |
| VS Code | ≥ 1.96 (for Copilot / `node:sqlite` support) |
| GitHub Copilot Chat extension | latest |

---

## Project Structure

```
cf-migrate/
├── packages/
│   ├── core/           # Shared types, config, ledger, session state
│   ├── kb/             # Knowledge base storage, search, snippet rendering
│   ├── llm/            # LLM client, prompt renderer, Copilot provider
│   ├── agents/         # Analysis, planning, generation, validation agents
│   └── extension/      # VS Code extension — the main distributable
├── kb-default/         # Default KB content (patterns, snippets, templates)
│   ├── patterns/       # CF → GHA migration patterns
│   ├── snippets/       # Reusable YAML blocks
│   └── templates/      # Full workflow skeletons
└── prompt-templates/   # LLM prompt templates (per-phase system/user pairs)
```

---

## Install Dependencies

```bash
npm install
```

---

## Compile (TypeScript)

Compiles all packages in dependency order using TypeScript project references:

```bash
npx tsc -b packages/core packages/kb packages/llm packages/agents packages/extension
```

To type-check without emitting `.js` output:

```bash
npx tsc -b packages/core packages/kb packages/llm packages/agents packages/extension --noEmit
```

---

## Bundle the Extension

The extension is bundled into a single file with esbuild. This also copies
`kb-default/` and `prompt-templates/` from the monorepo root into
`packages/extension/` so they are available at runtime.

```bash
cd packages/extension
node esbuild.config.mjs
```

Output: `packages/extension/dist/extension.js`

To rebuild automatically on file changes:

```bash
# Compile TypeScript in watch mode (all packages)
npx tsc -b packages/core packages/kb packages/llm packages/agents packages/extension --watch
```

---

## Run in Development (F5 Debug)

The `.vscode/launch.json` is pre-configured to launch the Extension Development Host from the correct package directory.

1. Open the monorepo root in VS Code.
2. Press **F5** (or run **Debug: Start Debugging** from the Command Palette).
3. VS Code will bundle the extension via the `build-extension` pre-launch task, then open a new Extension Development Host window with CF Migrate loaded.
4. Open a folder containing a `codefresh.yml` in the host window.

> **Note:** VS Code 1.96+ is required. If you see `No such built-in module: node:sqlite`, update VS Code and ensure it is installed in `/Applications` (not a translocated/Downloads path on macOS).

---

## Package (.vsix)

Creates a self-contained `.vsix` installer (does **not** require a Marketplace account):

```bash
cd packages/extension
npx vsce package --no-dependencies --allow-missing-repository
```

Output: `packages/extension/cf-migrate-vscode-<version>.vsix`

---

## Install the .vsix Locally

**Via Command Palette:**

1. Open VS Code.
2. `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. Select `packages/extension/cf-migrate-vscode-0.1.0.vsix`.

**Via terminal:**

```bash
code --install-extension packages/extension/cf-migrate-vscode-0.1.0.vsix
```

---

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cfMigrate.deterministicOnly` | boolean | `false` | Skip all LLM calls and run fully deterministic analysis, planning, and generation. |
| `cfMigrate.kbPath` | string | _(bundled)_ | Override the knowledge base directory. |
| `cfMigrate.orgName` | string | — | GitHub organisation name for indexing reference repos. |
| `cfMigrate.ghaRepoPaths` | string[] | `[]` | Local clone paths of GHA reference repos. |
| `cfMigrate.runActionlint` | boolean | `true` | Run `actionlint` on generated workflows (requires `actionlint` on PATH). |
| `cfMigrate.enableHashChain` | boolean | `false` | Enable SHA-256 hash chaining on the audit ledger. |
| `cfMigrate.autoIndexOnActivation` | boolean | `true` | Auto-discover pipelines on extension activation. |

### Deterministic Mode

Set `cfMigrate.deterministicOnly: true` to migrate without any LLM calls.
The status bar shows **⚡ deterministic** when active.

- **Discovery, Analysis, Validation** — always deterministic.
- **Planning** — uses the static Tier A lookup table + heuristic fallbacks.
- **Generation** — assembles YAML from plan item metadata and KB snippet references.

Tier A constructs (git-clone, build/push, retry, hooks, triggers, fail-fast) produce
precise `uses:` steps. Tier B/C constructs produce documented `run:` TODOs with KB references.

---

## Migration Workflow

1. **Discover** — scan workspace for `codefresh.yml` files.
2. **Analyse** — detect all CF constructs, data flow, topology, and complexity.
3. **Plan** — generate a `MigrationPlan` mapping each construct to a GHA equivalent.
4. **Approve** — review plan items in the Approval Panel; approve, modify, or reject each.
5. **Generate** — produce `.github/workflows/*.yml` from the approved plan.
6. **Validate** — run schema checks, `actionlint`, and security heuristics.

---

## Knowledge Base Patterns

| Pattern | CF construct | GHA equivalent |
|---------|-------------|----------------|
| `freestyle-to-run` | `step.freestyle` | `run:` step (with `container:` if image required) |
| `build-push-to-action` | `step.build` + `step.push` | `docker/build-push-action@v5` |
| `parallel-to-matrix` | `step.parallel` (homogeneous) | `strategy.matrix` |
| `parallel-to-sibling-jobs` | `step.parallel` (heterogeneous) | sibling jobs with `needs:` |
| `shared-volume-to-artifact` | `volumes.shared` | `upload-artifact` + `download-artifact` |
| `cf-export-to-output` | `cf_export` | `$GITHUB_OUTPUT` + `jobs.<id>.outputs` |
| `deploy-to-environment` | `step.deploy` | GHA Environment-gated job |
| `context-to-secrets` | `spec.contexts` | GitHub Secrets + OIDC federation |
| `composition-to-services` | `step.composition` | GHA `services:` containers |
| `triggers-to-on-events` | `triggers` | `on: push / pull_request / schedule` |
| `hooks-to-always-steps` | `step.hooks` | `if: always()` + `needs.<job>.result` |

---

## Tech Stack

- **TypeScript** — fully typed monorepo
- **esbuild** — fast single-file bundler for the extension
- **Zod** — runtime schema validation for LLM responses
- **VS Code API** — extension platform (codelens, hovers, tree views, webviews, chat participant)
- **GitHub Copilot Chat** — LLM provider via `vscode.lm` API
