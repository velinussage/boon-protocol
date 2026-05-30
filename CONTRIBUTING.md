# Contributing to Boon Protocol

Boon is live on Base mainnet and unaudited. Keep changes small, explicit, and easy to verify.

## Local setup

```bash
git clone --recurse-submodules https://github.com/velinussage/boon-protocol.git
cd boon-protocol
pnpm install
```

Build artifacts such as `out/`, `cache/`, `broadcast/`, and `app/dist/` are gitignored; run `git clean -fdx` if you want a pristine tree before committing.

## Validation before opening a PR

Run the narrowest checks for your change, then the full set before merge:

```bash
forge test -vvv
pnpm --filter @boon/normalize test
pnpm --filter boon-cli test
pnpm --filter boon-app typecheck
pnpm --filter boon-app build
pnpm run docs:check-skill
pnpm run docs:build
```

Useful aggregate commands:

```bash
pnpm run test
pnpm run typecheck
pnpm run build
```

## Change guidelines

- Do not charge protocol fees on sends or claims.
- Keep the contract API boring and minimal.
- Preserve explicit approval for agent sends.
- Keep handle normalization consistent across contract tests, `@boon/normalize`, CLI, app, docs, and the skill.
- When `skill/boon/SKILL.md` changes, run `pnpm run docs:sync-skill` and commit the refreshed hosted skill mirrors.
- Update docs when a change affects commands, contract behavior, public app behavior, or agent safety rules.

## Pull requests

Use the PR template and include:

- what changed
- why it changed
- which checks passed
- whether docs and generated skill mirrors were updated or are not applicable
