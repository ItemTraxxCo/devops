# Workflow Failure Triage Runbook

When a monitored workflow in `itemtraxx-code` fails, the `CI Triage` spoke
workflow fires (`workflow_run` trigger) and calls
`reusable-ci-triage.yml` in this repo.

## What the automation does

1. Pulls the failed run's job list and the logs of up to 3 failed jobs.
2. Classifies the likely ownership area deterministically
   (`scripts/alerts/ownership.mjs`): Cloudflare Worker, Supabase Functions,
   Vite app, E2E, env/config drift, kill-switch state, security tooling, or
   database.
3. If `ANTHROPIC_API_KEY` is configured, asks the model for a root-cause
   hypothesis, files to inspect, and a flaky-vs-real verdict
   (`prompts/workflow-failure-triage.md`).
4. Publishes the triage to the run's step summary, uploads it as an artifact
   (`ci-triage-<run_id>`, 14-day retention), and posts to Slack when
   `SLACK_WEBHOOK_URL` is set.

## Human follow-up

1. Open the triage summary (step summary of the CI Triage run, or Slack post).
2. **401 vs 503 confusion:** a 503 from production usually means the kill
   switch or a Worker outage; a 401 means auth guards are working. Check
   `https://edge.itemtraxx.com/functions/system-status` first.
3. **Env drift:** run `bash scripts/check-env-parity.sh` in itemtraxx-code and
   compare `.env.example` vs `.github/required-env.txt`.
4. **Worker ingress:** inspect `cloudflare/edge-proxy/` and recent Worker
   deploys; confirm CORS allowlist and function routing.
5. **Function auth guards:** check `supabase/functions/_shared/` helpers and
   the specific function's auth handling.
6. If the triage says "likely flaky", re-run the failed jobs once before
   digging deeper. Two consecutive failures are never treated as flaky.

## Tuning

- Add/adjust ownership rules in `scripts/alerts/ownership.mjs`.
- Adjust monitored workflows in `itemtraxx-code/.github/workflows/ci-triage.yml`
  (the `workflow_run.workflows` list matches workflow `name:` fields exactly).
