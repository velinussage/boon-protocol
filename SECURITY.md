# Security Policy

Boon is live on Base mainnet and unaudited. Use small amounts until the audit posture is stronger.

## Reporting vulnerabilities

Please do not open a public issue for exploitable vulnerabilities. Send a private report to the maintainer with:

1. affected surface (`contracts/`, `packages/normalize/`, `cli/`, `app/`, `docs/`, or `skill/`)
2. impact summary
3. reproduction steps or proof of concept
4. affected addresses, transactions, or public URLs if relevant

## In scope for this public repo

- `contracts/Boon.sol` and tests
- canonical handle normalization
- CLI signing/approval guardrails
- app-side transaction construction and claim/send UX
- agent skill safety rules
- docs that could mislead senders, recipients, or agents

## Out of scope here

Operational issues for hosted services should still be reported privately, but their implementation source is not in this public repository.
