---
id: docker-build-push
title: Docker Build + Push Workflow Template
type: template
cfConstructs:
  - step.build
  - step.push
ghaConstructs:
  - docker/setup-buildx-action@v3
  - docker/build-push-action@v5
  - docker/login-action@v3
  - docker/metadata-action@v5
tags: [docker, build, push, template, ghcr, ecr]
confidence: 0.93
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Workflow that builds a Docker image on push/tag, generates tags via metadata-action, and pushes to a registry with BuildKit GHA cache.
edgeNotes: >-
  Defaults to `ghcr.io` + `GITHUB_TOKEN` for least-friction auth. For ECR swap in
  `aws-actions/configure-aws-credentials@v4` + `aws-actions/amazon-ecr-login@v2` and drop
  `docker/login-action`. `docker/metadata-action` produces semver tags from git tags.
variables:
  - name: IMAGE_NAME
    description: Image name (without registry host)
    type: string
    required: true
    example: "my-org/my-service"
  - name: REGISTRY
    description: Registry host
    type: string
    required: false
    default: "ghcr.io"
    example: "123.dkr.ecr.us-east-1.amazonaws.com"
  - name: DOCKERFILE
    description: Path to Dockerfile
    type: string
    required: false
    default: "./Dockerfile"
    example: "./build/Dockerfile"
  - name: BUILD_CONTEXT
    description: Build context
    type: string
    required: false
    default: "."
    example: "./service"
---

## Docker build + push workflow

```yaml
name: Build and Push Image

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    branches: [main]

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Log in to registry
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: {{REGISTRY}}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Generate image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: {{REGISTRY}}/{{IMAGE_NAME}}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=sha,prefix=sha-

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: {{BUILD_CONTEXT}}
          file: {{DOCKERFILE}}
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```
