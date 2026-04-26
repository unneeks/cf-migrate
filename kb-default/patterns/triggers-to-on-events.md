---
id: triggers-to-on-events
title: CF Triggers → GHA `on:` Events
type: pattern
cfConstructs:
  - triggers
ghaConstructs:
  - on
  - on.push
  - on.pull_request
  - on.schedule
  - on.workflow_dispatch
tags: [triggers, events, on, scheduling]
confidence: 0.92
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Map CF pipeline triggers (git-push, cron, manual, webhook) onto GHA's `on:` event table.
edgeNotes: >-
  CF triggers are defined in the Pipeline spec (runtime UI), separate from codefresh.yml.
  If you only have the codefresh.yml, the migration report should list "Trigger
  discovery required — check pipeline spec." `workflow_dispatch` replicates the CF
  "Run" button. Branch/tag filters in CF triggers map to `on.push.branches` / `.tags`.
---

## Pattern: CF triggers → GHA `on:` events

### Before (in the Pipeline Spec, not codefresh.yml)

```yaml
spec:
  triggers:
    - name: git-push
      type: git
      events:
        - push.heads
        - pull_request.opened
      branchRegex: /^(main|release/.*)$/
    - name: nightly
      type: cron
      cronExpression: "0 3 * * *"
    - name: manual
      type: manual
```

### After (in the workflow YAML)

```yaml
name: CI
on:
  push:
    branches:
      - main
      - release/**
  pull_request:
    types: [opened, synchronize, reopened]
    branches:
      - main
      - release/**
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:
    inputs:
      reason:
        description: "Why running manually"
        required: false
        type: string
```

### Why

CF packs trigger config into the Pipeline spec; GHA embeds it at the top of the workflow
YAML as a first-class `on:` field. This keeps event → workflow wiring visible in the repo,
which is an ergonomic improvement.
