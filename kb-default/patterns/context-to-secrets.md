---
id: context-to-secrets
title: CF Context → GHA Secrets + OIDC
type: pattern
cfConstructs:
  - spec.contexts
ghaConstructs:
  - secrets
  - vars
  - permissions.id-token
tags: [secrets, context, credentials, oidc]
confidence: 0.88
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF shared context credentials (pre-attached cloud creds, registry logins) with GHA repo/org/environment secrets — preferring OIDC federation where possible.
edgeNotes: >-
  Cloud credentials (AWS/GCP/Azure) should migrate to OIDC federation, NOT to long-lived
  secret keys. Registry logins can stay as secrets but prefer short-lived tokens
  (ghcr.io: GITHUB_TOKEN; ECR: OIDC + get-login-password). Non-sensitive config belongs
  in `vars`, not `secrets`. Never emit secret VALUES into the migrated workflow — only
  references.
---

## Pattern: CF `contexts:` → GHA secrets / vars / OIDC

### Before

```yaml
version: "1.0"
stages: [deploy]

steps:
  deploy_to_aws:
    image: amazon/aws-cli
    stage: deploy
    commands:
      - aws s3 sync ./dist s3://my-bucket/
# Pipeline Spec has:
#   contexts:
#     - aws-prod-credentials   # CF context with AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
```

### After

```yaml
name: Deploy
on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy-role
          aws-region: us-east-1

      - run: aws s3 sync ./dist s3://my-bucket/
```

### Why

Static cloud keys in CF contexts are a long-term credential-exfiltration risk. GHA OIDC
federation replaces them with short-lived, per-run, scope-limited tokens. The migration
report MUST surface every CF context and classify it (OIDC-eligible vs. must-stay-secret)
for operator review.
