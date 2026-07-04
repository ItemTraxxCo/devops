# DevOps Hub Hardening

Minimum controls for `ItemTraxxCo/devops`:

1. Keep spoke repos pinned to a full commit SHA for every reusable workflow.
2. Require pull requests for `main` and block direct pushes except for approved maintainers.
3. Require `Hub CI` and `CodeQL` to pass before merge.
4. Keep `.github/CODEOWNERS` current so workflow and script changes always request the right reviewer.
5. Rotate org-level workflow secrets in the spoke repos, not in the hub.

Current repo-side evidence in source:

- Reusable workflow docs require full-SHA pinning.
- Hub workflows route internally through local relative paths, not mutable self-references.
- `.github/CODEOWNERS` is present for review enforcement.
