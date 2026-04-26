---
id: reusable-workflow-skeleton
title: Reusable Workflow Skeleton
type: template
cfConstructs:
  - templates
  - step.freestyle
ghaConstructs:
  - on.workflow_call
  - inputs
  - secrets.inherit
tags: [reusable, workflow-call, template, composition]
confidence: 0.9
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: A callable reusable workflow skeleton — inputs, secrets, outputs — that other workflows invoke via `uses:`.
edgeNotes: >-
  Reusable workflows are the GHA answer to CF templates. They must live under
  `.github/workflows/` (same as top-level workflows) — typing the filename with `_` prefix
  is a common convention. Callers need `permissions:` at the caller site that covers the
  callee's needs (GHA does NOT escalate).
variables:
  - name: WORKFLOW_NAME
    description: Human-readable name
    type: string
    required: true
    example: "Build + test reusable"
  - name: INPUT_NAME
    description: Name of the primary input
    type: string
    required: false
    default: "environment"
    example: "artifact-name"
  - name: INPUT_DESC
    description: Description of the primary input
    type: string
    required: false
    default: "Environment to target"
    example: "Artifact to publish"
---

## Reusable workflow (callee)

```yaml
# .github/workflows/_build.yml
name: {{WORKFLOW_NAME}}

on:
  workflow_call:
    inputs:
      {{INPUT_NAME}}:
        description: "{{INPUT_DESC}}"
        required: true
        type: string
    outputs:
      image_tag:
        description: "Resulting image tag"
        value: ${{ jobs.build.outputs.image_tag }}
    secrets:
      REGISTRY_TOKEN:
        required: false

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image_tag: ${{ steps.compute.outputs.image_tag }}
    steps:
      - uses: actions/checkout@v4
      - id: compute
        run: echo "image_tag=${{ inputs.{{INPUT_NAME}} }}-$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
      - run: echo "Building for ${{ inputs.{{INPUT_NAME}} }}"
```

## Caller example

```yaml
# .github/workflows/ci.yml
name: CI
on: [push]

jobs:
  call-build:
    uses: ./.github/workflows/_build.yml
    with:
      {{INPUT_NAME}}: staging
    secrets: inherit
```
