---
id: helm-deploy
title: Helm Deploy Workflow Template
type: template
cfConstructs:
  - step.deploy
  - step.helm
ghaConstructs:
  - azure/setup-helm@v4
  - aws-actions/configure-aws-credentials@v4
  - environment
tags: [helm, deploy, k8s, template]
confidence: 0.88
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Deploy a Helm chart to a Kubernetes cluster, gated by a GHA environment with OIDC-based cluster credentials.
edgeNotes: >-
  Defaults to AWS EKS. For GKE swap `configure-aws-credentials` → `google-github-actions/auth`
  + `google-github-actions/get-gke-credentials`. For AKS swap to `azure/login` + `azure/aks-set-context`.
  The `environment:` block triggers required-reviewer gating if configured in repo settings.
variables:
  - name: ENV_NAME
    description: GHA environment name
    type: string
    required: true
    default: "production"
    example: "staging"
  - name: AWS_REGION
    description: AWS region of the EKS cluster
    type: string
    required: true
    default: "us-east-1"
    example: "eu-west-1"
  - name: AWS_ROLE_ARN
    description: IAM role for OIDC federation
    type: string
    required: true
    example: "arn:aws:iam::123456789012:role/gha-deploy-role"
  - name: CLUSTER_NAME
    description: EKS cluster name
    type: string
    required: true
    example: "prod-east"
  - name: RELEASE_NAME
    description: Helm release name
    type: string
    required: true
    example: "my-service"
  - name: CHART_PATH
    description: Chart path or repo reference
    type: string
    required: true
    example: "./charts/my-service"
  - name: NAMESPACE
    description: Kubernetes namespace
    type: string
    required: true
    default: "default"
    example: "production"
  - name: VALUES_FILE
    description: Values file path
    type: string
    required: false
    default: "./values.yaml"
    example: "./env/prod.values.yaml"
---

## Helm deploy workflow

```yaml
name: Deploy

on:
  workflow_dispatch:
  push:
    tags: ["v*"]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: {{ENV_NAME}}
      url: https://{{ENV_NAME}}.example.com
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: {{AWS_ROLE_ARN}}
          aws-region: {{AWS_REGION}}

      - name: Update kubeconfig
        run: aws eks update-kubeconfig --name {{CLUSTER_NAME}} --region {{AWS_REGION}}

      - name: Install Helm
        uses: azure/setup-helm@v4
        with:
          version: v3.14.4

      - name: Helm upgrade
        run: |
          helm upgrade --install {{RELEASE_NAME}} {{CHART_PATH}} \
            --namespace {{NAMESPACE}} \
            --create-namespace \
            --values {{VALUES_FILE}} \
            --atomic \
            --wait \
            --timeout 10m
```
