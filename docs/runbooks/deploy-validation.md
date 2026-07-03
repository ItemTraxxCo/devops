# Deploy Validation Runbook

## Automated evidence

Every successful `Deploy Supabase Functions` or `Deploy Cloudflare Worker`
run in itemtraxx-code triggers the `Deploy Evidence` spoke workflow, which
calls `reusable-deploy-evidence.yml` here. It produces an artifact
(`deploy-evidence-<run_id>`, 90-day retention) containing:

- `evidence.json` — commit SHA, run timing/conclusion, changed files,
  post-deploy health-probe result, optional AI impact summary
- `evidence.md` — the same, human-readable (also in the run's step summary)

This is the release evidence bundle: when someone asks "what shipped and was
it healthy?", pull the artifact for that run.

## Manual validation checklist (any production deploy)

1. **Kill switch state:** `system-status` should be 200 with
   `kill_switch.enabled: false` (unless maintenance is intended).
2. **Auth behavior:** a protected function should return **401** without a
   token — a **503** means ingress/kill-switch trouble, not auth.
3. **Synthetic probes:** run the `Synthetic Probes (Hub)` workflow manually
   (workflow_dispatch) for an immediate 6-probe sweep of public site, login,
   checkout route, system-status, and contact-sales validation.
4. **Worker deploys:** confirm the Worker version changed
   (`wrangler deployments list` or Cloudflare dashboard) and CORS still rejects
   disallowed origins.
5. **Function deploys:** spot-check one changed function route through the
   edge proxy, not directly, to validate the full ingress path.

## Rollback

- **SPA:** revert via Vercel deployment rollback (instant).
- **Worker:** `npm run deploy:cloudflare:worker` from the previous commit, or
  Cloudflare dashboard rollback.
- **Functions:** redeploy previous commit's functions
  (`workflow_dispatch` on Deploy Supabase Functions accepts a function list).
- **Schema coupling:** if `supabase/sql/` changed in the same release, check
  whether functions depend on the new schema before rolling only one side back.
