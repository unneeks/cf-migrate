---
id: cf-export-to-output
title: CF `cf_export` → GHA Job Outputs
type: pattern
cfConstructs:
  - cf_export
ghaConstructs:
  - GITHUB_OUTPUT
  - jobs.<id>.outputs
  - needs
tags: [cf_export, outputs, variables, data-flow]
confidence: 0.93
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF `cf_export` (injects variables into shared CF variables namespace) with GHA `GITHUB_OUTPUT` + declared `jobs.<id>.outputs`.
edgeNotes: >-
  `cf_export` in CF is effectively a global write — any later step can read it. GHA outputs
  are scoped to a specific job and must be re-declared at each hop. For variables consumed
  by MANY downstream jobs, consider a composite pattern: one "compute" job that emits
  outputs, all consumers declare `needs: [compute]` and read via `needs.compute.outputs.X`.
---

## Pattern: CF `cf_export` → GHA job outputs

### Before

```yaml
steps:
  determine_tag:
    image: alpine
    commands:
      - export IMAGE_TAG=$(git rev-parse --short HEAD)
      - cf_export IMAGE_TAG

  build:
    image: docker
    commands:
      - docker build -t my-app:$IMAGE_TAG .

  deploy:
    image: alpine/k8s
    commands:
      - kubectl set image deploy/my-app my-app=my-app:$IMAGE_TAG
```

### After

```yaml
jobs:
  determine-tag:
    runs-on: ubuntu-latest
    outputs:
      image_tag: ${{ steps.compute.outputs.image_tag }}
    steps:
      - uses: actions/checkout@v4
      - id: compute
        run: echo "image_tag=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"

  build:
    needs: [determine-tag]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t my-app:${{ needs.determine-tag.outputs.image_tag }} .

  deploy:
    needs: [determine-tag, build]
    runs-on: ubuntu-latest
    steps:
      - run: kubectl set image deploy/my-app my-app=my-app:${{ needs.determine-tag.outputs.image_tag }}
```

### Why

CF's shared variables namespace is replaced by explicit output declarations at each job
boundary. This makes data flow visible in the YAML — a key structural improvement over CF.
