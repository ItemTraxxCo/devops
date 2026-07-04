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

**Constraint:** this hub is PRIVATE and `ItemTraxxCo/ItemTraxx-App` is
PUBLIC. GitHub forbids public repos from calling reusable workflows or
actions that live in private repos (`uses: ItemTraxxCo/devops/...@main`
fails at run startup with zero jobs). Two integration paths exist:

**Public spokes (ItemTraxx-App) — PAT checkout:**

```
spoke workflow (thin)
  ├─ guard step: skip everything if DEVOPS_HUB_TOKEN is unset
  ├─ actions/checkout  repository: ItemTraxxCo/devops
  │                    token: secrets.DEVOPS_HUB_TOKEN  path: devops-hub
  └─ uses: ./devops-hub/actions/<composite>
       └─ node scripts/<area>/<script>.mjs  (resolved via github.action_path)
```

`DEVOPS_HUB_TOKEN` is a fine-grained PAT with **Contents: Read** on
`ItemTraxxCo/devops` only. See runbooks/secrets.md.

**Private spokes (future) — workflow_call:**

```
spoke workflow (thin)
  └─ uses: ItemTraxxCo/devops/.github/workflows/reusable-*.yml@main
       └─ uses: ItemTraxxCo/devops/actions/<composite>@main
```

All logic lives in the **composite actions** (single source of truth); the
reusable workflows are thin wrappers over them. Hub-internal references pin
`@main` deliberately: main is the release channel, one place to fix bugs,
immediately live everywhere.

## Access

For private-spoke workflow_call to work, this repo must stay:
Settings → Actions → General → Access →
"Accessible from repositories in the ItemTraxxCo organization".
This setting does NOT help public spokes — only the PAT checkout path does.

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
  `AI_API_KEY` is missing; AI output is additive.
- **Untrusted input discipline:** PR titles/bodies/logs only flow through
  files and `env:` variables, never interpolated into `run:` scripts.
- **Numeric input validation:** `run_id`/`pr_number` are regex-validated
  before use in API paths.
- **Dependabot promotion is label-first:** auto-merge is opt-in per spoke
  (`enable_automerge: true`) and still requires branch-protection checks.
