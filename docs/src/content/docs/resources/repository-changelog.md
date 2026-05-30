---
title: Repository and changelog
description: Source code, release state, and validation commands for Boon.
---

# Repository and changelog

Public source code:

```text
https://github.com/velinussage/boon-protocol
```

Current package version is `0.5.6` across the root package, CLI, app, and normalize package.

## Important files

| Path | Purpose |
|---|---|
| `contracts/` | Boon settlement and soulbound attestation contracts. |
| `contracts/test/` | Contract behavior, invariant, gas, and fork tests. |
| `app/src/` | Vite + React app for send, claim, board, profile, receipt, attestation. |
| `cli/src/index.ts` | OWS-funded agent CLI. |
| `packages/normalize/` | Shared handle normalization. |
| `skill/boon/SKILL.md` | Agent skill and safety rules. |
| `CHANGELOG.md` | Release history. |

## Recent changes

The release history lives in [`CHANGELOG.md`](https://github.com/velinussage/boon-protocol/blob/main/CHANGELOG.md) on the main branch. Latest highlights (see the file for full context):

- Agent mode is OWS-only for live CLI sends.
- The hosted claim flow supports identity-first OAuth, relayed link/claim, and CLI device-code approval.
- The send flow supports public tips, private tips, agent recipients, and optional soulbound recipient proofs.

Per [Documentation maintenance](/resources/documentation-maintenance/), any change that affects deployed behavior, env vars, endpoints, or operator flow updates `CHANGELOG.md` in the same PR.

## Validation commands

```bash
forge test -vvv
pnpm --filter @boon/normalize test
pnpm --filter boon-cli test
pnpm --filter boon-app typecheck
pnpm --filter boon-app build
```

Some gates require live environment variables, signer keys, or funded burner wallets. Do not treat skipped gated tests as production proof.
