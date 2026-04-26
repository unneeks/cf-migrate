---
id: retry-wrapper
title: Retry Flaky Step
type: snippet
cfConstructs:
  - step.freestyle
  - step.deploy
ghaConstructs:
  - nick-fields/retry@v3
tags: [retry, flaky, resilience]
confidence: 0.9
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Retry a shell command on failure (for flaky external calls, transient network errors).
edgeNotes: >-
  Prefer fixing root causes over retry loops where practical. Only use for genuinely flaky
  external dependencies (registries, DNS, rate-limited APIs). Pin to a specific tag — this
  is a community action, not a first-party one.
variables:
  - name: MAX_ATTEMPTS
    description: Maximum number of attempts
    type: string
    required: false
    default: "3"
    example: "5"
  - name: TIMEOUT_MINUTES
    description: Timeout per attempt, in minutes
    type: string
    required: false
    default: "10"
    example: "5"
  - name: RETRY_WAIT_SECONDS
    description: Seconds to wait between attempts
    type: string
    required: false
    default: "15"
    example: "30"
  - name: COMMAND
    description: Shell command to run with retry
    type: string
    required: true
    example: "npm ci"
---

## Retry wrapper

```yaml
- name: Run with retry
  uses: nick-fields/retry@v3
  with:
    timeout_minutes: {{TIMEOUT_MINUTES}}
    max_attempts: {{MAX_ATTEMPTS}}
    retry_wait_seconds: {{RETRY_WAIT_SECONDS}}
    command: {{COMMAND}}
```
