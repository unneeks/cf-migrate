---
id: slack-notification
title: Slack Notification on Finish
type: snippet
cfConstructs:
  - step.freestyle
  - hooks
ghaConstructs:
  - slackapi/slack-github-action@v1
tags: [slack, notification, hooks, alerting]
confidence: 0.89
usageCount: 0
lastUpdated: "2026-01-15T00:00:00.000Z"
authors: [seed]
description: Post a Slack message on workflow success/failure using the official Slack action.
edgeNotes: >-
  Use `if: always()` to run the step regardless of earlier failures. `${{ job.status }}`
  resolves to `success`, `failure`, `cancelled`, or `skipped`. For workflow-level hooks
  that replicate CF's `hooks.on_success` / `hooks.on_fail`, attach this step as the last
  step with a conditional.
variables:
  - name: SLACK_WEBHOOK_SECRET
    description: Name of the secret holding the Slack webhook URL
    type: string
    required: false
    default: "SLACK_WEBHOOK_URL"
    example: "SLACK_PROD_WEBHOOK"
  - name: CHANNEL
    description: Slack channel (if using bot token mode)
    type: string
    required: false
    default: ""
    example: "#ci-notifications"
  - name: MESSAGE
    description: Message template (supports GHA expressions)
    type: gha-expression
    required: false
    default: "Workflow ${{ github.workflow }} finished with status ${{ job.status }}"
    example: "Deploy to prod: ${{ job.status }} — ${{ github.sha }}"
---

## Slack notification (webhook mode)

```yaml
- name: Notify Slack
  if: always()
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {
        "text": "{{MESSAGE}}"
      }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.{{SLACK_WEBHOOK_SECRET}} }}
    SLACK_WEBHOOK_TYPE: INCOMING_WEBHOOK
```
