---
id: parallel-to-sibling-jobs
title: CF Parallel Step → GHA Sibling Jobs
type: pattern
cfConstructs:
  - step.parallel
ghaConstructs:
  - jobs
  - jobs.<id>.needs
tags: [parallel, jobs, fan-out]
confidence: 0.91
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Convert a CF `parallel` block of heterogeneous steps into multiple sibling jobs that share a `needs:` predecessor.
edgeNotes: >-
  Each sibling job runs on its own runner and does NOT share disk with other jobs. Any
  intermediate files the parallel steps produced into `/codefresh/volume` must be passed
  via artifacts or job outputs. Downstream jobs converge using `needs: [job1, job2, ...]`.
---

## Pattern: CF `parallel` (heterogeneous) → GHA sibling jobs

### Before

```yaml
steps:
  after_build:
    type: parallel
    steps:
      lint:
        image: node:20
        commands:
          - npm run lint
      security_scan:
        image: aquasec/trivy
        commands:
          - trivy fs .
      unit_tests:
        image: node:20
        commands:
          - npm test -- --coverage
```

### After

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci

  lint:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint

  security_scan:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aquasecurity/trivy-action@0.24.0
        with:
          scan-type: fs
          scan-ref: .

  unit_tests:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test -- --coverage
```

### Why

When parallel steps have distinct images or purposes, each becomes its own GHA job.
Fan-in is expressed via shared `needs:` relationships on a downstream aggregation job.
