# Boon public release instructions

Read [`.agents/memory/public-release.md`](.agents/memory/public-release.md)
before changing or publishing this repository.

## Public release boundary

This repository contains the public contracts, app, CLI, documentation, shared
packages, and agent skill. Keep changes limited to artifacts that a reader can
build, inspect, or use from this checkout.

Do not add hosted-service source, hosted index source, deployment configuration,
live-network deployment or settlement scripts, operator tooling, audit or repro
workpapers, launch logs, environment files, credentials, machine-local paths, or
internal implementation notes. The validator is the canonical enforcement list.

## Required workflow

1. Run `pnpm install`. The root `prepare` script installs `.githooks` through
   the repository-local `core.hooksPath` setting.
2. Make the smallest content-level change. Do not replay commits from another
   repository or copy directories wholesale.
3. Run the narrow tests for the changed surface.
4. Run `pnpm run public:validate` before committing.
5. Run the normal build or test gates listed in `CONTRIBUTING.md`.
6. Inspect `git diff --cached` before committing and ask before pushing.

The pre-commit hook scans staged paths and contents. The pre-push hook scans the
complete target tree and every new commit blob, including material introduced
and deleted in separate commits. CI repeats the full validation with complete
history.

## History policy

Commit `f62624bec833ae2306797667a22c68a420e16c47` is the reviewed public root.
Normal releases append commits to it. Do not amend, re-root, squash away, or
force-push this baseline for routine work.

If validation finds prohibited material in an unpushed commit, remove it from
every affected commit before pushing. If prohibited material has already reached
a remote, stop and treat it as a history incident. A later deletion does not
remove the earlier blob.
