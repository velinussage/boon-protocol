# Public release memory

## Stable baseline

- Reviewed public root: `f62624bec833ae2306797667a22c68a420e16c47`.
- Future releases use ordinary child commits. Routine updates do not rewrite the
  root or previously published history.
- The repository stays self-contained. Public commands must run from this tree
  or call documented public APIs.

## Guardrails that preserve append-only history

- `.githooks/pre-commit` validates every staged path and text blob.
- `.githooks/pre-push` validates each pushed target tree and every new commit,
  so adding sensitive material in one commit and deleting it in the next still
  fails.
- `pnpm run public:validate` scans the current tree plus every commit after the
  reviewed root.
- CI checks out full history and runs the same validator.
- `pnpm install` activates the repository hooks. Repair them with
  `pnpm run hooks:install` and verify with `git config --get core.hooksPath`.

## Safe update model

Carry public-facing changes by file and review their dependency closure. Keep
contracts, app, CLI, documentation, shared packages, and skill artifacts in sync
when the user-facing behavior requires it. Do not bring along service runtime,
index runtime, deployment, operator, audit, repro, log, secret, or environment
artifacts.

Before pushing:

```bash
pnpm run public:validate
pnpm run docs:check-skill
git diff --check
git status --short --branch
```

If the validator fails, do not bypass it. Fix every local commit containing the
finding. If a prohibited blob is already remote, stop normal release work and
handle it as a history incident.
