---
id: node-ci
title: Node.js CI Workflow Template
type: template
cfConstructs:
  - step.freestyle
  - step.parallel
ghaConstructs:
  - actions/checkout@v4
  - actions/setup-node@v4
  - actions/cache@v4
  - strategy.matrix
tags: [node, ci, test, lint, template]
confidence: 0.94
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: End-to-end Node.js CI workflow (install → lint → test → coverage) with matrix over Node versions.
edgeNotes: >-
  Assumes `package-lock.json` exists. For Yarn Berry use `enable-corepack: true` and a
  Yarn-specific cache path. The `working-directory` defaults to repo root — override per
  step for monorepo subprojects.
variables:
  - name: NODE_VERSIONS
    description: Flow-style YAML array of Node versions
    type: string
    required: false
    default: "[20, 22]"
    example: "[18, 20, 22]"
  - name: RUNNER
    description: Runner label
    type: string
    required: false
    default: "ubuntu-latest"
    example: "ubuntu-22.04"
  - name: BRANCHES
    description: Branches this workflow runs on
    type: string
    required: false
    default: "[main]"
    example: "[main, develop]"
---

## Node.js CI workflow

```yaml
name: CI

on:
  push:
    branches: {{BRANCHES}}
  pull_request:
    branches: {{BRANCHES}}

permissions:
  contents: read

jobs:
  test:
    runs-on: {{RUNNER}}
    strategy:
      fail-fast: false
      matrix:
        node: {{NODE_VERSIONS}}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node ${{ matrix.node }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - name: Install
        run: npm ci --prefer-offline --no-audit

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test -- --coverage

      - name: Upload coverage
        if: matrix.node == 20
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
          retention-days: 7
          if-no-files-found: warn
```
