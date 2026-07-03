# Secrets Runbook

The hub never stores secrets. Every reusable workflow declares the secrets it
accepts via `workflow_call`, and spoke repos pass them explicitly. All secrets
are optional at the hub level — features degrade instead of failing.

## Matrix

| Secret | Where defined | Consumed by | Behavior when missing |
| --- | --- | --- | --- |
| `SLACK_WEBHOOK_URL` | spoke repo (itemtraxx-code) | notify-failure, notify-status (fallback), ci-triage | Notification steps log and skip |
| `SLACK_BOT_TOKEN` | spoke repo | notify-status (threaded start/finish messages) | Falls back to webhook |
| `SLACK_CHANNEL_ID` | spoke repo | notify-status | Falls back to webhook |
| `INCIDENT_IO_WEBHOOK_URL` | spoke repo | incident-alert | Alert step logs and skips |
| `INCIDENT_IO_WEBHOOK_TOKEN` | spoke repo | incident-alert | Alert step logs and skips |
| `ANTHROPIC_API_KEY` | spoke repo or org level | ci-triage, pr-risk-review, deploy-evidence | AI sections replaced with a "skipped" note; deterministic output still produced |

## Adding `ANTHROPIC_API_KEY`

1. Create an API key at console.anthropic.com (scope: Messages API only).
2. Add as an **org-level Actions secret** in ItemTraxxCo (preferred, visible to
   private repos) or as a repo secret on `itemtraxx-code`.
3. No workflow changes needed — AI features activate on the next run.
4. Model default is `claude-sonnet-5`; override per-repo with an
   `ITX_AI_MODEL` Actions variable if cost tuning is needed.

## Rotation

- Slack/incident.io secrets: rotate at the provider, update the repo secret;
  no hub change required.
- Anthropic key: rotate at console.anthropic.com, update the secret. Failed AI
  calls never fail workflows — a stale key shows up as "AI triage failed" notes
  in triage summaries.

## Dependabot caveat

Workflows triggered by Dependabot use the **Dependabot secrets** store, not
Actions secrets. The dependency-promotion entrypoint uses `pull_request_target`
(no code checkout) specifically so it runs with normal Actions secrets and a
write-capable token for labeling.
