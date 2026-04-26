---
id: docker-buildkit-cache
title: Docker Build with BuildKit GHA Cache
type: snippet
cfConstructs:
  - step.build
  - step.push
ghaConstructs:
  - docker/setup-buildx-action@v3
  - docker/build-push-action@v5
  - docker/login-action@v3
tags: [docker, buildkit, cache, registry]
confidence: 0.95
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF `build` + `push` with docker/build-push-action using BuildKit GHA cache for layer reuse.
edgeNotes: >-
  `cache-from`/`cache-to` `type=gha` requires `actions-toolkit` scope — available by default
  on GitHub-hosted runners. For self-hosted, prefer `type=registry,ref=...` instead.
  Multi-platform builds need `platforms:` and a QEMU setup step.
variables:
  - name: REGISTRY
    description: Container registry host
    type: string
    required: true
    default: "docker.io"
    example: "ghcr.io"
  - name: IMAGE_NAME
    description: Full image name including registry path
    type: string
    required: true
    example: "ghcr.io/my-org/my-service"
  - name: DOCKERFILE
    description: Path to the Dockerfile
    type: string
    required: false
    default: "./Dockerfile"
    example: "./build/Dockerfile"
  - name: BUILD_CONTEXT
    description: Docker build context path
    type: string
    required: false
    default: "."
    example: "./service"
  - name: TAG
    description: Image tag expression
    type: gha-expression
    required: false
    default: "${{ github.sha }}"
    example: "v${{ github.run_number }}"
  - name: PUSH
    description: Whether to push the image after build
    type: string
    required: false
    default: "true"
    example: "true"
---

## Docker build + push with BuildKit cache

```yaml
- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v3

- name: Log in to registry
  uses: docker/login-action@v3
  with:
    registry: {{REGISTRY}}
    username: ${{ secrets.REGISTRY_USERNAME }}
    password: ${{ secrets.REGISTRY_PASSWORD }}

- name: Build and push
  uses: docker/build-push-action@v5
  with:
    context: {{BUILD_CONTEXT}}
    file: {{DOCKERFILE}}
    push: {{PUSH}}
    tags: {{IMAGE_NAME}}:{{TAG}}
    cache-from: type=gha
    cache-to: type=gha,mode=max
```
