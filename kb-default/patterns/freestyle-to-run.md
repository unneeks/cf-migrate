---
id: freestyle-to-run
title: CF Freestyle Step → GHA `run` Step
type: pattern
cfConstructs:
  - step.freestyle
ghaConstructs:
  - steps.run
  - jobs.<id>.steps
tags: [freestyle, run, basic, core]
confidence: 0.98
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Map a CF `freestyle` step (image + commands) onto a GHA `run:` step with `shell:` and `working-directory:` where relevant.
edgeNotes: >-
  CF freestyle steps run inside the pipeline's `image`. GHA runs on the job runner directly.
  If the freestyle step depends on tools only present in a container image, wrap the run
  step inside a container-qualified job (`container: image: ...`) or set up the tool via
  a dedicated setup-* action.
---

## Pattern: CF freestyle → GHA run

### Before (Codefresh)

```yaml
steps:
  install_deps:
    title: Install dependencies
    image: node:20
    working_directory: ${{main_clone}}
    commands:
      - npm ci --prefer-offline
      - npm run build
    environment:
      - NODE_ENV=production
```

### After (GHA)

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    container: node:20
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        working-directory: ${{ github.workspace }}
        env:
          NODE_ENV: production
        run: |
          npm ci --prefer-offline
          npm run build
```

### Mapping

| CF field                   | GHA equivalent                   |
|----------------------------|----------------------------------|
| `image`                    | `container:` on the job          |
| `working_directory`        | `working-directory:` on the step |
| `commands:` (array)        | `run:` with `\|` multiline block  |
| `environment:` (array)     | `env:` (map) on step or job      |
| `${{main_clone}}` variable | `${{ github.workspace }}`        |

### Why

CF freestyle is a general-purpose shell step. It maps cleanly to GHA's `run:` step in 95%+
of cases and is a Tier-A deterministic construct. The only judgment call is where to host
the tooling (job `container:`, setup-* action, or plain runner).
