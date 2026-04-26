---
id: build-push-to-action
title: CF `build` + `push` → docker/build-push-action
type: pattern
cfConstructs:
  - step.build
  - step.push
ghaConstructs:
  - docker/build-push-action@v5
  - docker/setup-buildx-action@v3
  - docker/login-action@v3
tags: [docker, build, push, registry]
confidence: 0.95
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Consolidate CF's separate `build` and `push` steps into a single `docker/build-push-action@v5` invocation with BuildKit caching.
edgeNotes: >-
  If the CF pipeline produced an image and later steps did `docker run my-image` assuming
  it's in a local docker daemon, you need to either (a) push to a registry and pull back,
  or (b) set `load: true` on `docker/build-push-action` to load into the local daemon
  (incompatible with `push: true` unless you use a multi-platform workaround).
---

## Pattern: CF build + push → docker/build-push-action

### Before

```yaml
steps:
  build:
    type: build
    image_name: my-org/my-service
    dockerfile: ./Dockerfile
    tags:
      - "${{CF_REVISION}}"
      - "latest"
  push:
    type: push
    candidate: ${{build}}
    registry: ghcr
    image_name: my-org/my-service
    tags:
      - "${{CF_REVISION}}"
      - "latest"
```

### After

```yaml
jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile
          push: true
          tags: |
            ghcr.io/my-org/my-service:${{ github.sha }}
            ghcr.io/my-org/my-service:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Why

The separate CF build + push phases are a CF artifact — in Docker they're really one
operation. Consolidating cuts one full `docker push` round-trip and unlocks BuildKit
layer caching across runs via `type=gha`.
