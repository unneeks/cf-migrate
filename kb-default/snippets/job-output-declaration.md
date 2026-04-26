---
id: job-output-declaration
title: Declare and Consume Job Outputs
type: snippet
cfConstructs:
  - cf_export
ghaConstructs:
  - jobs.<id>.outputs
  - GITHUB_OUTPUT
tags: [outputs, cf_export, fan-out]
confidence: 0.94
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF `cf_export` with `GITHUB_OUTPUT` + declared `jobs.<id>.outputs` consumed via `needs.<job>.outputs`.
edgeNotes: >-
  `GITHUB_OUTPUT` is per-step. To surface across jobs you MUST declare `outputs:` on the job
  and reference `needs.<job>.outputs.<name>`. For multiline values use the heredoc format
  `echo "key<<EOF\n$VAL\nEOF" >> $GITHUB_OUTPUT`.
variables:
  - name: OUTPUT_NAME
    description: Name of the variable exported from the producer job
    type: string
    required: true
    example: "image_tag"
  - name: OUTPUT_VALUE
    description: Shell expression producing the value
    type: string
    required: true
    example: "$(git rev-parse --short HEAD)"
  - name: PRODUCER_JOB_ID
    description: ID of the job that sets the output
    type: string
    required: true
    example: "build"
  - name: CONSUMER_JOB_ID
    description: ID of the downstream job consuming the output
    type: string
    required: true
    example: "deploy"
---

## Declare and consume job outputs

```yaml
jobs:
  {{PRODUCER_JOB_ID}}:
    runs-on: ubuntu-latest
    outputs:
      {{OUTPUT_NAME}}: ${{ steps.export.outputs.{{OUTPUT_NAME}} }}
    steps:
      - id: export
        name: Export value
        run: echo "{{OUTPUT_NAME}}={{OUTPUT_VALUE}}" >> "$GITHUB_OUTPUT"

  {{CONSUMER_JOB_ID}}:
    needs: [{{PRODUCER_JOB_ID}}]
    runs-on: ubuntu-latest
    steps:
      - name: Use exported value
        env:
          VALUE: ${{ needs.{{PRODUCER_JOB_ID}}.outputs.{{OUTPUT_NAME}} }}
        run: echo "Got: $VALUE"
```
