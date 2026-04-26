---
id: artifact-download
title: Download Build Artifact
type: snippet
cfConstructs:
  - volumes.shared
ghaConstructs:
  - actions/download-artifact@v4
tags: [artifact, download, fan-in]
confidence: 0.96
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF `volumes.shared` consumer side with download-artifact for fan-in across jobs.
edgeNotes: >-
  v4 requires exact artifact name (no glob by default). Use `pattern:` and `merge-multiple: true`
  to combine matrix shards. Artifacts produced in one run cannot be downloaded from another run
  without the `actions/download-artifact` `run-id` parameter + `GITHUB_TOKEN` perms.
variables:
  - name: ARTIFACT_NAME
    description: Exact name of the artifact to download
    type: string
    required: true
    example: "build-output-${{ matrix.arch }}"
  - name: DOWNLOAD_PATH
    description: Directory to download the artifact into
    type: string
    required: false
    default: "./"
    example: "dist/"
---

## Download artifact

```yaml
- name: Download build artifact
  uses: actions/download-artifact@v4
  with:
    name: {{ARTIFACT_NAME}}
    path: {{DOWNLOAD_PATH}}
```
