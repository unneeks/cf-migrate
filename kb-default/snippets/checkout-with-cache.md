---
id: checkout-with-cache
title: Checkout + Dependency Cache
type: snippet
cfConstructs:
  - step.git-clone
ghaConstructs:
  - actions/checkout@v4
  - actions/cache@v4
tags: [checkout, cache, performance]
confidence: 0.97
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace `git-clone` + manual cache mount with actions/checkout@v4 and actions/cache@v4.
edgeNotes: >-
  Set `fetch-depth: 0` only if you need full git history (e.g. for changelog generation).
  Shallow clones are significantly faster.
variables:
  - name: FETCH_DEPTH
    description: History depth — 1 for shallow, 0 for full.
    type: string
    required: false
    default: "1"
    example: "1"
  - name: CACHE_PATH
    description: Directory to cache
    type: string
    required: false
    default: "~/.npm"
    example: "~/.cache/pip"
  - name: CACHE_KEY
    description: Cache key expression
    type: gha-expression
    required: false
    default: "${{ runner.os }}-deps-${{ hashFiles('**/package-lock.json') }}"
    example: "${{ runner.os }}-pip-${{ hashFiles('**/requirements.txt') }}"
---

## Checkout with dependency cache

```yaml
steps:
  - name: Checkout
    uses: actions/checkout@v4
    with:
      fetch-depth: {{FETCH_DEPTH}}

  - name: Cache dependencies
    uses: actions/cache@v4
    with:
      path: {{CACHE_PATH}}
      key: {{CACHE_KEY}}
      restore-keys: |
        ${{ runner.os }}-deps-
```
