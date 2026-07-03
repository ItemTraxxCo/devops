# Hub-and-Spoke Automation Architecture

## Model

- **Hub (this repo, `ItemTraxxCo/devops`):** reusable workflows, composite
  actions, shared scripts, AI prompt packs, shared policy, runbooks.
- **Spokes (app repos, currently `itemtraxx-code`):** thin workflow
  entrypoints that pass repo-specific inputs/secrets into hub workflows.

## Boundary rule

Anything that inspects a repo's local code shape stays in that repo:

- `invokeEdgeFunction` caller-to-function coverage checks
- edge contract drift detection (`generate-edge-schemas.mjs` etc.)
- SQL/function coupling analysis
- perf budgets, E2E specs, Deno tests

The hub owns cross-repo concerns: notification/alert formatting, failure
triage, PR risk classification, deploy evidence, probe orchestration,
dependency promotion policy. Source-aware checks may *report* through hub
workflows but must not be implemented here.

## Wiring

```
itemtraxx-code workflow (thin)
  └─ uses: ItemTraxxCo/devops/.github/workflows/reusable-*.yml@main
       └─ uses: ItemTraxxCo/devops/actions/<composite>@main
            └─ node scripts/<area>/<script>.mjs  (whole repo ships with the action)
```

- Hub-internal references pin `@main` deliberately: main is the release
  channel, one place to fix bugs, immediately live everywhere.
- GitHub allows 4 levels of nested workflows. Deepest current chain:
  spoke caller (1) → spoke shim (2) → hub reusable (3) → hub incident-alert (4).
  Do not add another nesting level; use composite actions instead.
- Composite actions receive the full repo checkout at `github.action_path`,
  which is how `scripts/` and `prompts/` and `config/` travel with them —
  no cross-repo checkout token needed.

## Access

This repo must stay: Settings → Actions → General → Access →
"Accessible from repositories in the ItemTraxxCo organization".
Without it, every spoke call fails with "workflow was not found".

## Onboarding a new spoke repo

1. Add the thin entrypoints you need (copy from itemtraxx-code):
   `ci-triage.yml`, `pr-risk-review.yml`, `deploy-evidence.yml`,
   `dependabot-promotion.yml`.
2. Set the repo secrets the features need (see runbooks/secrets.md).
3. Adjust the `workflow_run.workflows` name lists to that repo's workflows.
4. For probes: pass a repo-specific `probes_config` JSON or add a
   `config/<repo>-probes.json` here.

## Design decisions

- **Graceful AI degradation:** no hub workflow fails because
  `ANTHROPIC_API_KEY` is missing; AI output is additive.
- **Untrusted input discipline:** PR titles/bodies/logs only flow through
  files and `env:` variables, never interpolated into `run:` scripts.
- **Numeric input validation:** `run_id`/`pr_number` are regex-validated
  before use in API paths.
- **Dependabot promotion is label-first:** auto-merge is opt-in per spoke
  (`enable_automerge: true`) and still requires branch-protection checks.
