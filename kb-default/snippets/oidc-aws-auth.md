---
id: oidc-aws-auth
title: OIDC AWS Authentication
type: snippet
cfConstructs:
  - spec.contexts
ghaConstructs:
  - aws-actions/configure-aws-credentials@v4
tags: [aws, oidc, security, credentials]
confidence: 0.95
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace static AWS credentials in CF contexts with keyless OIDC federation.
edgeNotes: >-
  Requires an IAM role with a trust policy that trusts token.actions.githubusercontent.com
  for your `repo:OWNER/REPO:*` subject claim. Pair with `permissions.id-token: write`.
variables:
  - name: AWS_ROLE_ARN
    description: Full ARN of the IAM role to assume via OIDC
    type: string
    required: true
    example: "arn:aws:iam::123456789012:role/github-actions-role"
  - name: AWS_REGION
    description: AWS region
    type: string
    required: true
    default: us-east-1
    example: ap-south-1
---

## OIDC AWS Authentication

Replaces static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in CF contexts with keyless OIDC federation.

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - name: Configure AWS credentials
    uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: {{AWS_ROLE_ARN}}
      aws-region: {{AWS_REGION}}
      audience: sts.amazonaws.com
```
