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
| `AI_API_KEY` | spoke repo or org level | ci-triage, pr-risk-review, deploy-evidence | AI sections replaced with a "skipped" note; deterministic output still produced |
| `DEVOPS_HUB_TOKEN` | spoke repo (public spokes only) | every hub-integration workflow (checks out this private repo) | Guard step skips the whole hub job with a log message |

## Adding `DEVOPS_HUB_TOKEN`

Required because `ItemTraxx-App` is public and this hub is private — the
spoke must check the hub out with a token instead of using `workflow_call`.

1. Create a **fine-grained PAT** (github.com → Settings → Developer settings
   → Fine-grained tokens): resource owner `ItemTraxxCo`, repository access
   **only `ItemTraxxCo/devops`**, permissions **Contents: Read-only**.
   Nothing else.
2. Add it to `ItemTraxx-App` as an **Actions secret** named
   `DEVOPS_HUB_TOKEN` (Settings → Secrets and variables → Actions).
3. Also add it as a **Dependabot secret** with the same name (Settings →
   Secrets and variables → Dependabot) — workflows triggered by Dependabot
   read from the Dependabot secrets store, and the promotion workflow needs
   the hub checkout too.
4. Set a calendar reminder for the PAT expiry; rotation is: create new
   token, update both secrets, revoke old token.

## Adding `AI_API_KEY`

The hub auto-detects the provider from the key:

- **NVIDIA NIM** — key starts with `nvapi-` (from an NVIDIA developer
  account at build.nvidia.com). Default model:
  `nvidia/nemotron-3-ultra-550b-a55b`, called via the OpenAI-compatible
  endpoint `https://integrate.api.nvidia.com/v1/chat/completions`.
- **Anthropic** — any other key (console.anthropic.com). Default model:
  `claude-sonnet-5`.

Setup:

1. Add the key as an **org-level Actions secret** named `AI_API_KEY` in
   ItemTraxxCo (preferred) or as a repo secret on the spoke repo.
2. No workflow changes needed — AI features activate on the next run.
3. Overrides via Actions **variables** (not secrets) on the spoke repo:
   `ITX_AI_MODEL` for the model id, `ITX_AI_PROVIDER` (`nvidia` |
   `anthropic`) to force a provider when key-prefix detection is wrong.

## Rotation

- Slack/incident.io secrets: rotate at the provider, update the repo secret;
  no hub change required.
- AI key: rotate at the provider (build.nvidia.com for `nvapi-` keys,
  console.anthropic.com for Anthropic), update the secret. Failed AI calls
  never fail workflows — a stale key shows up as "AI triage failed" notes in
  triage summaries.

## Dependabot caveat

Workflows triggered by Dependabot use the **Dependabot secrets** store, not
Actions secrets. The dependency-promotion entrypoint uses `pull_request_target`
(no code checkout) specifically so it runs with normal Actions secrets and a
write-capable token for labeling.
