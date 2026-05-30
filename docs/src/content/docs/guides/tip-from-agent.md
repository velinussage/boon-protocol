---
title: Tip from an agent
description: Use the Boon CLI with dry-run preflight and an OWS-funded agent wallet.
---

# Tip from an agent

Agent mode is a proposal-and-approval loop. No funds move until an exact row is approved and the CLI executes with a connected OWS wallet. Agents can send public USDC tips, private tips, and private tips with optional soulbound attestations when the wallet has enough USDC, gas, and `$BOON`.

## 1. Inspect readiness

```bash
boon doctor
boon wallet current
```

If no wallet is selected, connect one. Current sends should target BoonV3:

```bash
export BOON_ACTIVE_CONTRACT=v3
export BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF
export BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3

boon wallet connect ows --wallet boon-agent
```

The command prints the OWS address. Fund it with a small Base USDC balance, gas headroom, and `$BOON` if the approved rows include private tips or attestations.

## 2. Draft a proposal

A good agent proposal includes canonical handle, amount, note, evidence, and status:

```text
Boons proposal for week of 2026-05-25:
  1. github:alice — 10 USDC
     note: "pr:owner/repo#42 — caught race in bundler"
     why: concrete review prevented a production bug
     evidence: https://github.com/owner/repo/pull/42
     status: ready
Total: 10 / 50 USDC review budget.
Next: approve, edit, or skip. No funds move until you approve exact rows.
```

Mark uncertain identity or weak evidence as `needs_check` instead of guessing.

## 3. Dry-run the approved row

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
boon tip --dry-run github:alice 10 "pr:owner/repo#42 — caught race in bundler"
```

The dry-run validates canonicalization, guardrails, connected OWS wallet, balance, and calldata without moving funds.

For a private row, dry-run the private command instead:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3 \
boon tip-private github:alice --amount 10 --note "local approval memo" --dry-run

BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3 \
boon tip-private agent:42 --amount 10 --note "local approval memo" --mint-attestation --dry-run
```

Private tips burn `500,000 $BOON`; adding an attestation burns `3,000,000 $BOON` more. The current CLI redacts the local `--note` before hosted blob upload, so use the web app when the recipient needs revealable private note text. Third-party reveals use the fixed `$1 USDC` x402 price paid to the original tipper.

## 4. Execute after approval

Interactive mode prompts before sending:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
boon tip github:alice 10 "pr:owner/repo#42 — caught race in bundler"
```

Automation must include the human-approved plan id:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
boon tip --yes --approval-id weekly-2026-05-25-row-1 github:alice 10 "pr:owner/repo#42 — caught race in bundler"
```

The CLI ensures USDC allowance if needed, then calls `BoonV3.tip(...)` through OWS. For private rows, use `boon tip-private ... --yes --approval-id <id>`; the CLI handles encrypted blob upload, `$BOON` approvals, and `BoonV3.tipPrivate(...)` / `BoonV3.tipPrivateAgent(...)`.

## 5. Review history

```bash
boon history
boon history github:alice
```

The local ledger is a guardrail and operator aid. The chain and subgraph remain the public source of truth.
