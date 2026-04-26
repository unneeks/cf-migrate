---
id: environment-deploy-gate
title: Environment-Gated Deployment
type: snippet
cfConstructs:
  - step.deploy
  - step.freestyle
ghaConstructs:
  - environment
  - environment.url
tags: [environment, approval, deploy, gate]
confidence: 0.93
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Gate a deployment job behind a GHA Environment with optional required reviewers and URL.
edgeNotes: >-
  Environment protection rules (required reviewers, wait timer, branch restrictions) are
  configured in the repo Settings → Environments UI — they cannot be set purely from YAML.
  The workflow can *reference* an environment; actual gating rules live in settings.
variables:
  - name: ENV_NAME
    description: Name of the GHA environment
    type: string
    required: true
    default: "production"
    example: "staging"
  - name: ENV_URL
    description: URL shown in the deployments panel
    type: gha-expression
    required: false
    default: "https://example.com"
    example: "https://app.${{ github.event.inputs.env }}.example.com"
  - name: DEPLOY_JOB_ID
    description: Job ID for the deploy job
    type: string
    required: false
    default: "deploy"
    example: "deploy-prod"
---

## Environment-gated deploy

```yaml
jobs:
  {{DEPLOY_JOB_ID}}:
    runs-on: ubuntu-latest
    environment:
      name: {{ENV_NAME}}
      url: {{ENV_URL}}
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        run: ./deploy.sh
```
