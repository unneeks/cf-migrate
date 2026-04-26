---
id: artifact-upload
title: Upload Build Artifact
type: snippet
cfConstructs:
  - volumes.shared
ghaConstructs:
  - actions/upload-artifact@v4
tags: [artifact, upload, fan-out]
confidence: 0.96
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF `volumes.shared` producer side with upload-artifact for fan-out across jobs.
edgeNotes: >-
  v4 artifacts are immutable — do not upload with an existing name within the same run.
  Use matrix `${{ matrix.id }}` or a per-job suffix to disambiguate.
variables:
  - name: ARTIFACT_NAME
    description: Unique artifact name for the run
    type: string
    required: true
    example: "build-output-${{ matrix.arch }}"
  - name: ARTIFACT_PATH
    description: File glob or directory to upload
    type: string
    required: true
    example: "dist/"
  - name: RETENTION_DAYS
    description: Days to keep the artifact
    type: string
    required: false
    default: "7"
    example: "14"
---

## Upload artifact

```yaml
- name: Upload build artifact
  uses: actions/upload-artifact@v4
  with:
    name: {{ARTIFACT_NAME}}
    path: {{ARTIFACT_PATH}}
    retention-days: {{RETENTION_DAYS}}
    if-no-files-found: error
```
