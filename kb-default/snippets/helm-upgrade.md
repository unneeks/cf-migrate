---
id: helm-upgrade
title: Helm Upgrade / Install Deploy
type: snippet
cfConstructs:
  - step.deploy
  - step.helm
ghaConstructs:
  - azure/setup-helm@v4
  - azure/k8s-set-context@v4
tags: [helm, kubernetes, deploy]
confidence: 0.91
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Deploy a Helm chart via `helm upgrade --install` using an injected KUBECONFIG.
edgeNotes: >-
  Prefer OIDC-based cluster credentials (e.g. AWS IAM roles for EKS, GCP WIF for GKE,
  federated creds for AKS) over long-lived KUBECONFIG secrets. `--atomic` rolls back on
  failed upgrade; `--wait` blocks until the release is ready.
variables:
  - name: HELM_VERSION
    description: Helm CLI version to install
    type: string
    required: false
    default: "v3.14.4"
    example: "v3.15.0"
  - name: RELEASE_NAME
    description: Helm release name
    type: string
    required: true
    example: "my-service"
  - name: CHART_PATH
    description: Path to chart directory or chart reference (repo/name)
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
    description: Path to the values file
    type: string
    required: false
    default: "./values.yaml"
    example: "./env/prod.values.yaml"
  - name: TIMEOUT
    description: Helm wait timeout
    type: string
    required: false
    default: "10m"
    example: "15m"
---

## Helm upgrade / install

```yaml
- name: Install Helm
  uses: azure/setup-helm@v4
  with:
    version: {{HELM_VERSION}}

- name: Set KUBECONFIG
  run: |
    mkdir -p "$HOME/.kube"
    echo "${{ secrets.KUBECONFIG }}" | base64 -d > "$HOME/.kube/config"
    chmod 600 "$HOME/.kube/config"

- name: Helm upgrade
  run: |
    helm upgrade --install {{RELEASE_NAME}} {{CHART_PATH}} \
      --namespace {{NAMESPACE}} \
      --create-namespace \
      --values {{VALUES_FILE}} \
      --atomic \
      --wait \
      --timeout {{TIMEOUT}}
```
