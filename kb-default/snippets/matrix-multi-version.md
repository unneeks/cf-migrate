---
id: matrix-multi-version
title: Matrix Strategy for Multi-Version Testing
type: snippet
cfConstructs:
  - step.parallel
ghaConstructs:
  - strategy.matrix
  - strategy.fail-fast
tags: [matrix, parallel, test, fan-out]
confidence: 0.95
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF `parallel` over homogeneous steps with a GHA matrix strategy.
edgeNotes: >-
  `fail-fast: false` lets all matrix shards finish even if one fails — useful for diagnosing
  flaky cross-version issues. Use `include:` to add extra dimensions, `exclude:` to skip
  specific combinations. Matrix produces `N = product(dimensions)` jobs.
variables:
  - name: DIMENSION_NAME
    description: Name of the matrix dimension
    type: string
    required: true
    default: "node"
    example: "python"
  - name: DIMENSION_VALUES
    description: Flow-style YAML list of values
    type: string
    required: true
    example: "[18, 20, 22]"
  - name: FAIL_FAST
    description: Whether to cancel other shards on first failure
    type: string
    required: false
    default: "false"
    example: "true"
---

## Matrix strategy

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: {{FAIL_FAST}}
      matrix:
        {{DIMENSION_NAME}}: {{DIMENSION_VALUES}}
    steps:
      - uses: actions/checkout@v4
      - name: Setup {{DIMENSION_NAME}}
        run: echo "Testing on {{DIMENSION_NAME}} ${{ matrix.{{DIMENSION_NAME}} }}"
      - name: Run tests
        run: npm test
```
