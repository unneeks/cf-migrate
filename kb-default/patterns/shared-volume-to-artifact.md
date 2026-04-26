---
id: shared-volume-to-artifact
title: CF Shared Volume → GHA Artifacts
type: pattern
cfConstructs:
  - volumes.shared
ghaConstructs:
  - actions/upload-artifact@v4
  - actions/download-artifact@v4
tags: [artifact, volume, fan-out, fan-in]
confidence: 0.94
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF's implicit `/codefresh/volume` shared disk with explicit artifact upload + download between jobs.
edgeNotes: >-
  Artifacts are pay-per-GB-month. For large build outputs that only need to live within
  a single workflow run, consider the GHA `actions/cache@v4` with a run-id-scoped key, or
  use a job-level `container:` to share a single runner. For small outputs, prefer `outputs:`
  via `GITHUB_OUTPUT` — it's free and inline.
---

## Pattern: CF `volumes.shared` → upload/download artifacts

### Before

```yaml
steps:
  build:
    image: node:20
    commands:
      - npm ci && npm run build
      # dist/ is automatically available to later steps

  test:
    image: node:20
    commands:
      - npm test  # Reads dist/ from shared volume
```

### After

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: dist/
          retention-days: 7
          if-no-files-found: error

  test:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: build-output
          path: dist/
      - run: npm ci && npm test
```

### Why

GHA jobs run on separate runners with no shared disk. Data flow between jobs MUST be
explicit — artifacts for files, `outputs:` for small string values. This pattern surfaces
the implicit CF dependency as an explicit artifact contract.
