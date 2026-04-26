---
id: multi-env-promotion
title: Multi-Environment Promotion Workflow
type: template
cfConstructs:
  - step.deploy
  - step.parallel
  - when.manual
ghaConstructs:
  - environment
  - jobs.<id>.needs
  - jobs.<id>.if
tags: [deploy, promotion, multi-env, gate, template]
confidence: 0.87
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Staged dev → staging → production deployment with environment gates, each promotion requiring the previous stage to succeed.
edgeNotes: >-
  Production gating (required reviewers) is configured in repo Settings → Environments.
  Each environment can have its own secret scope, which is the recommended way to keep
  prod creds separated from staging. The `if: ${{ success() }}` on prod is redundant with
  `needs:` but makes the intent explicit.
variables:
  - name: AWS_REGION
    description: AWS region
    type: string
    required: false
    default: "us-east-1"
    example: "ap-south-1"
  - name: AWS_ROLE_ARN
    description: OIDC role ARN (shared across envs or override per job)
    type: string
    required: true
    example: "arn:aws:iam::123456789012:role/gha-deploy-role"
---

## Multi-environment promotion

```yaml
name: Deploy Pipeline

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image_tag: ${{ steps.tag.outputs.image_tag }}
    steps:
      - uses: actions/checkout@v4
      - id: tag
        run: echo "image_tag=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
      - run: echo "Build for tag ${{ steps.tag.outputs.image_tag }}"

  deploy-dev:
    needs: [build]
    runs-on: ubuntu-latest
    environment:
      name: dev
      url: https://dev.example.com
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: {{AWS_ROLE_ARN}}
          aws-region: {{AWS_REGION}}
      - run: echo "Deploying ${{ needs.build.outputs.image_tag }} to dev"

  deploy-staging:
    needs: [deploy-dev]
    if: ${{ success() }}
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://staging.example.com
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: {{AWS_ROLE_ARN}}
          aws-region: {{AWS_REGION}}
      - run: echo "Deploying ${{ needs.build.outputs.image_tag }} to staging"

  deploy-production:
    needs: [deploy-staging]
    if: ${{ success() }}
    runs-on: ubuntu-latest
    environment:
      name: production   # gated by required reviewers in repo settings
      url: https://example.com
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: {{AWS_ROLE_ARN}}
          aws-region: {{AWS_REGION}}
      - run: echo "Deploying ${{ needs.build.outputs.image_tag }} to production"
```
