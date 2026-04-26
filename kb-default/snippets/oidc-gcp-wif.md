---
id: oidc-gcp-wif
title: GCP Workload Identity Federation
type: snippet
cfConstructs:
  - spec.contexts
ghaConstructs:
  - google-github-actions/auth@v2
tags: [gcp, oidc, security, wif, credentials]
confidence: 0.93
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace GCP service account JSON keys with keyless Workload Identity Federation.
edgeNotes: >-
  Requires a Workload Identity Pool and Provider configured in the GCP project with the
  GitHub OIDC provider trusted. The `service_account` must have `roles/iam.workloadIdentityUser`.
variables:
  - name: WIF_PROVIDER
    description: Full resource name of the Workload Identity Provider
    type: string
    required: true
    example: "projects/123/locations/global/workloadIdentityPools/github/providers/github"
  - name: SERVICE_ACCOUNT
    description: Service account email to impersonate
    type: string
    required: true
    example: "ci@my-project.iam.gserviceaccount.com"
---

## GCP Workload Identity Federation

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - name: Authenticate to Google Cloud
    uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: {{WIF_PROVIDER}}
      service_account: {{SERVICE_ACCOUNT}}
      token_format: access_token
```
