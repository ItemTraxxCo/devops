# ItemTraxx DevOps Hub

Private automation hub for the ItemTraxxCo organization. This repo owns the
**orchestration layer**: reusable GitHub Actions workflows, composite actions,
shared scripts, AI prompt packs, shared policy, and org runbooks.

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
  probes/            Config-driven synthetic HTTP probe runner
prompts/             AI prompt templates (PR risk, failure triage, deploy impact)
config/              Shared policy + default probe configs
docs/
  runbooks/          Incident / deploy / kill-switch / secrets runbooks
  architecture/      Hub-and-spoke design notes
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
| `reusable-dependency-promotion.yml` | Labels Dependabot patch/minor PRs as `safe-merge-candidate`; optional auto-merge |

All AI features degrade gracefully: without `AI_API_KEY` the workflows
fall back to deterministic output and never fail the caller for a missing key.

## Calling from a spoke repo

```yaml
jobs:
  triage:
    uses: ItemTraxxCo/devops/.github/workflows/reusable-ci-triage.yml@main
    with:
      run_id: ${{ github.event.workflow_run.id }}
      workflow_name: ${{ github.event.workflow_run.name }}
    secrets:
      AI_API_KEY: ${{ secrets.AI_API_KEY }}
      SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

This repo must remain accessible to org repositories:
Settings → Actions → General → Access →
"Accessible from repositories in the ItemTraxxCo organization".

## Secrets consumed (provided by callers)

| Secret | Used by | Required |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | failure/status notify, ci-triage | optional |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` | status notify (threaded updates) | optional |
| `INCIDENT_IO_WEBHOOK_URL` / `INCIDENT_IO_WEBHOOK_TOKEN` | incident alerts | optional |
| `AI_API_KEY` | ci-triage, pr-risk-review, deploy-evidence AI summaries | optional |

See [docs/runbooks/secrets.md](docs/runbooks/secrets.md) for the full matrix.

## Versioning

Spokes reference `@main`. Treat `main` as the release channel: every merge to
`main` is immediately live for all callers. Hub CI (`hub-ci.yml`) lints all
workflows with actionlint and syntax-checks all scripts on every push/PR.
