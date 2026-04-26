---
id: hooks-to-always-steps
title: CF Hooks (on_success / on_fail / on_finish) → GHA Conditional Steps
type: pattern
cfConstructs:
  - hooks
ghaConstructs:
  - steps.if
  - jobs.<id>.if
  - job.status
  - steps.<id>.outcome
tags: [hooks, notifications, cleanup, conditionals]
confidence: 0.9
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Replace CF `hooks.on_success`, `hooks.on_fail`, `hooks.on_finish` with GHA `if:` conditions on trailing steps or a trailing job using `needs` + `if: always()`.
edgeNotes: >-
  `job.status` is only available to subsequent jobs (via `needs.<job>.result`), not
  within the same job. For intra-job "on_fail" logic, use `if: failure()` on a following
  step. For workflow-wide notifications, create a dedicated notify job with
  `needs: [...all jobs...]` and `if: always()`.
---

## Pattern: CF `hooks` → GHA conditional steps / jobs

### Before

```yaml
hooks:
  on_success:
    image: alpine
    commands:
      - curl -X POST "$SLACK_WEBHOOK" -d '{"text":"Pipeline succeeded"}'
  on_fail:
    image: alpine
    commands:
      - curl -X POST "$SLACK_WEBHOOK" -d '{"text":"Pipeline FAILED"}'
  on_finish:
    image: alpine
    commands:
      - echo "Cleanup..."
```

### After

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test

  notify:
    needs: [build]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Slack success
        if: needs.build.result == 'success'
        run: curl -X POST "${{ secrets.SLACK_WEBHOOK }}" -d '{"text":"Pipeline succeeded"}'

      - name: Slack failure
        if: needs.build.result == 'failure'
        run: curl -X POST "${{ secrets.SLACK_WEBHOOK }}" -d '{"text":"Pipeline FAILED"}'

      - name: Cleanup (always)
        run: echo "Cleanup..."
```

### Why

Hook semantics map to GHA `if:` expressions. Surfacing success/fail/finish as a dedicated
trailing job (`if: always()`) keeps the main build job uncluttered and gives you a single
point of control for all notifications.
