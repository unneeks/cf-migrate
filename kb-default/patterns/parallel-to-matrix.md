---
id: parallel-to-matrix
title: CF Parallel Step → GHA Matrix
type: pattern
cfConstructs:
  - step.parallel
ghaConstructs:
  - strategy.matrix
  - jobs.<id>.strategy
tags: [parallel, matrix, fan-out]
confidence: 0.9
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Convert a CF `parallel` block of homogeneous steps into a single GHA job with a matrix strategy.
edgeNotes: >-
  Only use matrix when the parallel steps are structurally identical differing only in one
  or two variables (version, arch, region). For heterogeneous parallel steps (different
  images, different commands), use the `parallel-to-sibling-jobs` pattern instead.
---

## Pattern: CF `parallel` (homogeneous) → GHA matrix

### Before

```yaml
steps:
  tests:
    type: parallel
    steps:
      test_node_18:
        image: node:18
        commands:
          - npm ci && npm test
      test_node_20:
        image: node:20
        commands:
          - npm ci && npm test
      test_node_22:
        image: node:22
        commands:
          - npm ci && npm test
```

### After

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci && npm test
```

### Why

A matrix produces N parallel jobs from a single definition. CF parallel blocks over
homogeneous steps are the canonical case — the migration reduces YAML volume and unifies
logs under one job template.
