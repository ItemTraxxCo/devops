# ItemTraxx DevOps Hub

Private automation hub for the ItemTraxxCo organization. This repo owns the
**orchestration layer**: reusable GitHub Actions workflows, composite actions,
shared scripts, AI prompt packs, shared policy, and org runbooks.
Internal hub documentation and runbooks live in the private
`ItemTraxxCo/itemtraxx-internal-docs` repository under `docs/devops/`.

App repos (spokes) keep thin workflow entrypoints that call the reusable
workflows here via `workflow_call`. Source-aware checks (edge contract drift,
`invokeEdgeFunction` coverage, SQL/function coupling, perf budgets, E2E specs)
stay in the app repos.

## Layout

```
.github/workflows/   Reusable workflows (workflow_call entrypoints)
actions/             Composite actions (wrap scripts for cross-repo use)
scripts/
  ai/                Anthropic API client + PR risk review + failure triage
  deploy/            Deploy evidence bundle collection
  alerts/            Deterministic ownership classification for failures
  monitors/          Telemetry-backed monitors (edge gateway-error rate)
  probes/            Config-driven synthetic HTTP probe runner
prompts/             AI prompt templates (PR risk, failure triage, deploy impact)
config/              Shared policy + default probe configs
```

## Reusable workflows

| Workflow | Purpose |
| --- | --- |
| `reusable-slack-notify-failure.yml` | Slack failure alert + incident.io fallback |
| `reusable-slack-notify-status.yml` | Slack start/finish status messages (bot token with webhook fallback) |
| `reusable-incident-alert.yml` | incident.io alert-source webhook event |
| `reusable-kill-switch-preflight.yml` | Checks ItemTraxx kill switch; outputs `active` + `message` |
| `reusable-ci-triage.yml` | On workflow failure: pulls failing job logs, deterministic ownership classification, optional AI root-cause triage, optional Slack post |
| `reusable-pr-risk-review.yml` | Classifies PR risk (auth / tenant-boundary / edge-ingress / legal / deploy-config / frontend-only), labels the PR, upserts a review comment; AI narrative when `AI_API_KEY` is present |
| `reusable-deploy-evidence.yml` | After a deploy: collects commit + run + health-probe evidence into an artifact bundle, optional AI deploy-impact summary |
| `reusable-synthetic-probes.yml` | Runs config-driven synthetic HTTP probes (kill-switch aware) |
| `reusable-edge-error-monitor.yml` | Alerts on Cloudflare edge gateway errors (502/504) seen by real client traffic, read from the log bridge |
| `reusable-dependency-promotion.yml` | Labels Dependabot patch/minor PRs as `safe-merge-candidate`; optional auto-merge |

All AI features degrade gracefully: without `AI_API_KEY` the workflows
fall back to deterministic output and never fail the caller for a missing key.
The edge error monitor degrades the same way: without PostHog credentials it
skips cleanly.

### Why the edge needs a monitor and not just probes

Cloudflare's managed firewall challenges non-browser clients, so a probe run
from a GitHub-hosted runner receives `403 cf-mitigated: challenge` from the
edge before the edge would serve an application response. A challenge proves
only that the edge answered the runner — it says nothing about what real
clients receive, and a probe suite cannot assert past it.

That blind spot is not hypothetical. A zone-wide edge fault served gateway
errors to real clients for roughly a day while every scheduled check stayed
green: the probe suite was pointed at the origin, and the public-route checks
were challenged on every URL and treated an all-challenged run as a pass.

Two changes follow from that:

- `run-probes.mjs` reports `challenged` as its own outcome. Challenges do not
  fail a run (they are the normal case from CI), but a run where nothing was
  verified is labelled inconclusive instead of reading as a clean pass.
- `reusable-edge-error-monitor.yml` watches the edge from the only vantage
  point that sees real client outcomes: the Cloudflare request records the log
  bridge already ships to PostHog. It alerts when gateway errors breach both a
  count and a rate threshold, **and** when the feed delivers nothing at all —
  an absent signal is not a healthy one.

## Calling from a spoke repo

This repo is **public**, so any spoke can check it out and use the
composite actions (the pattern ItemTraxx-App uses):

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          repository: ItemTraxxCo/devops
          path: devops-hub
          persist-credentials: false
      - uses: ./devops-hub/actions/ci-triage
        with:
          run_id: ${{ github.event.workflow_run.id }}
          repository: ${{ github.repository }}
          github_token: ${{ github.token }}
          ai_api_key: ${{ secrets.AI_API_KEY }}
          slack_webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Spokes can also use the reusable workflow wrappers directly:

```yaml
jobs:
  triage:
    uses: ItemTraxxCo/devops/.github/workflows/reusable-ci-triage.yml@4685d5bf81e6311b8a9c09e71d83e1e544ca5fdb
    with:
      run_id: ${{ format('{0}', github.event.workflow_run.id) }}
    secrets:
      AI_API_KEY: ${{ secrets.AI_API_KEY }}
      SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Pin reusable workflows and actions to a full commit SHA in spoke repos. Do not
consume this hub via a mutable branch ref such as `@main`.

For the private-spoke path this repo must remain accessible to org
repositories: Settings → Actions → General → Access →
"Accessible from repositories in the ItemTraxxCo organization".

## Secrets consumed (provided by callers)

| Secret | Used by | Required |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | failure/status notify, ci-triage | optional |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` | status notify (threaded updates) | optional |
| `INCIDENT_IO_WEBHOOK_URL` / `INCIDENT_IO_WEBHOOK_TOKEN` | incident alerts | optional |
| `AI_API_KEY` | ci-triage, pr-risk-review, deploy-evidence AI summaries | optional |
| `POSTHOG_API_KEY` / `POSTHOG_PROJECT_ID` | edge gateway-error monitor | optional |

See the private internal docs repo at
`ItemTraxxCo/itemtraxx-internal-docs/docs/devops/runbooks/secrets.md` for the
full matrix.

## Versioning

Spokes should reference a pinned commit SHA. Update the pinned SHA as part of a
normal hub rollout after validation. Hub CI (`hub-ci.yml`) lints all workflows
with actionlint, syntax-checks all scripts, and runs the script unit tests
(`node --test 'scripts/**/*.test.mjs'`) on every push/PR.
