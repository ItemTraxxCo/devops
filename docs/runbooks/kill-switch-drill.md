# Kill Switch Drill Runbook

The ItemTraxx kill switch (Cloudflare KV flag served via
`system-status`) suppresses scheduled CI work and intentionally 503s
production endpoints during maintenance.

## How automation respects it

- `reusable-kill-switch-preflight.yml` (and the local copy in itemtraxx-code)
  checks `https://edge.itemtraxx.com/functions/system-status` and outputs
  `active` + `message`. Preflight **fails open**: if the check itself errors,
  scheduled work runs normally.
- Synthetic probes (`scripts/probes/run-probes.mjs`) mark a probe `skipped`
  instead of `fail` when it returns 503 while the kill switch is active and
  the probe sets `allowKillSwitchSkip: true`.
- Deploy/health workflows in itemtraxx-code skip their main job and post a
  "intentionally skipped" Slack status when preflight reports active.

## Drill procedure (quarterly)

1. Announce the drill in Slack; pick a low-traffic window.
2. Enable the kill switch via the `Manage Kill Switch` workflow in
   itemtraxx-code.
3. Verify within 15 minutes:
   - `system-status` returns `kill_switch.enabled: true`
   - Public site returns the maintenance response
   - The next scheduled `Deployment Health` / `Synthetic Journeys` runs
     report **skipped**, not failed, and Slack shows the "intentionally
     skipped" message with the kill-switch text
   - `Synthetic Probes (Hub)` run shows probes as ⏭️ skipped
4. Disable the kill switch via `Manage Kill Switch`.
5. Verify recovery: next scheduled runs pass; `system-status` shows
   `enabled: false`; site serves normally.
6. Record outcome + timings in the drill log (below).

## Failure modes to watch

- Probes reporting **fail** during a drill means kill-switch detection broke
  (check `statusUrl` reachability and the 503 body shape).
- incident.io alerts firing during a drill means a suppression path regressed
  (`incident_alerts_enabled: false` should apply to intentional skips).

## Drill log

| Date | Operator | Result | Notes |
| --- | --- | --- | --- |
| _none yet_ | | | |
