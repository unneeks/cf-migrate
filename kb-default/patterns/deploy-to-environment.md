---
id: deploy-to-environment
title: CF Deploy → GHA Environment-Gated Job
type: pattern
cfConstructs:
  - step.deploy
ghaConstructs:
  - environment
  - jobs.<id>.if
  - github.event.ref
tags: [deploy, environment, gate, approval]
confidence: 0.9
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Map a CF deploy step to a GHA deploy job gated by an Environment (with optional required reviewers, wait timer, branch restrictions).
edgeNotes: >-
  The YAML can only reference the environment name and URL. Actual gating policy
  (required reviewers, wait timers, branch patterns) must be configured in the repo
  Settings → Environments UI. Surface this in the migration report so operators don't
  miss it.
---

## Pattern: CF deploy → GHA environment-gated job

### Before

```yaml
steps:
  deploy_staging:
    image: alpine/k8s
    when:
      branch:
        only: [main]
    commands:
      - kubectl apply -f k8s/staging/

  deploy_prod:
    image: alpine/k8s
    when:
      branch:
        only: [main]
      manual: true
    commands:
      - kubectl apply -f k8s/prod/
```

### After

```yaml
jobs:
  deploy-staging:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://staging.example.com
    steps:
      - uses: actions/checkout@v4
      - run: kubectl apply -f k8s/staging/

  deploy-prod:
    needs: [deploy-staging]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: production        # required_reviewers configured in repo settings
      url: https://example.com
    steps:
      - uses: actions/checkout@v4
      - run: kubectl apply -f k8s/prod/
```

### Why

CF's `manual: true` prompts for explicit run approval inside the CF UI. The GHA
equivalent is an Environment with required reviewers configured — this gives policy
enforcement at the repo level instead of per-pipeline.
