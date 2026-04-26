---
id: composition-to-services
title: CF Composition → GHA Service Containers
type: pattern
cfConstructs:
  - step.composition
ghaConstructs:
  - jobs.<id>.services
  - jobs.<id>.container
tags: [composition, services, integration-test, docker-compose]
confidence: 0.78
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Translate CF `composition` (docker-compose-style) into GHA job `services:` containers for integration-test scenarios.
edgeNotes: >-
  GHA `services:` is the first-class replacement for simple multi-container setups
  (database + app). For complex compose graphs, run `docker compose up -d` directly in
  a step instead. Service containers share the runner's docker network and are reachable
  by their service key as hostname (`services.postgres` → host `postgres`).
  Tier-C: review the migrated output carefully — network topology subtleties often require tweaks.
---

## Pattern: CF `composition` → GHA `services:`

### Before

```yaml
steps:
  integration_tests:
    type: composition
    composition:
      version: "3"
      services:
        postgres:
          image: postgres:15
          environment:
            POSTGRES_PASSWORD: test
        redis:
          image: redis:7
    composition_candidates:
      test_runner:
        image: node:20
        working_dir: /app
        command: npm run test:integration
        environment:
          - DATABASE_URL=postgres://postgres:test@postgres:5432/postgres
          - REDIS_URL=redis://redis:6379
```

### After

```yaml
jobs:
  integration-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd="pg_isready -U postgres"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
      redis:
        image: redis:7
        ports:
          - 6379:6379
    env:
      DATABASE_URL: postgres://postgres:test@localhost:5432/postgres
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test:integration
```

### Why

GHA `services:` covers the common pattern (app + DB + cache for integration tests)
without pulling in docker-compose as a runtime dependency. Note the host changes from
service-key to `localhost` (since the step runs on the runner, not inside a container,
by default).
