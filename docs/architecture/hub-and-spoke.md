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

**History:** this hub started private, but `ItemTraxxCo/ItemTraxx-App` is
public and GitHub forbids public repos from calling reusable workflows or
actions in private repos (fails at run startup with zero jobs). The hub was
made **public** on 2026-07-04 — it contains no secrets, and the app repo's
source was already public. Secret scanning + push protection are enabled.

**Checkout integration (ItemTraxx-App uses this):**

```
spoke workflow (thin)
  ├─ actions/checkout  repository: ItemTraxxCo/devops  path: devops-hub
  └─ uses: ./devops-hub/actions/<composite>
       └─ node scripts/<area>/<script>.mjs  (resolved via github.action_path)
```

**workflow_call (also available now the hub is public):**

```
spoke workflow (thin)
  └─ uses: ItemTraxxCo/devops/.github/workflows/reusable-*.yml@<full-commit-sha>
       └─ local action resolution happens inside the pinned reusable workflow
```

All logic lives in the **composite actions** (single source of truth); the
reusable workflows are thin wrappers over them. Hub-internal workflow calls use
local relative paths, and spoke repos consume the reusable workflows through a
pinned commit SHA.

## Access

The repo is public, so both integration paths work without any access
setting or token.

Spoke repos should always pin this hub to a full commit SHA. Do not use
mutable refs such as `@main` for production workflows.

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
