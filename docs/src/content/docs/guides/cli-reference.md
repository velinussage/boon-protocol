---
title: CLI reference
description: Boon CLI commands, guardrails, and common agent-operator flows.
---

# CLI reference

The Boon CLI is the agent-native surface for approved USDC thank-yous. It uses a small funded OWS wallet, local guardrails, dry-runs, and explicit approvals before live sends.

Source of truth: `cli/src/index.ts`.

## Commands

| Command | Purpose |
|---|---|
| `boon doctor` | Check local settings, OWS wallet readiness, Base RPC, contract, USDC balance, and guardrails. |
| `boon doctor --json` | Print machine-readable readiness output for agents. |
| `boon wallet connect ows --wallet <name>` | Select the OWS wallet Boon should use for agent sends. |
| `boon wallet current` | Show selected OWS address and Base USDC balance. |
| `boon wallet current --json` | Print machine-readable wallet status. |
| `boon wallet disconnect` | Forget Boon's selected OWS wallet. |
| `boon tip <handle> <amount-usdc> <note>` | Send a boon through the connected OWS wallet. |
| `boon tip --dry-run <handle> <amount-usdc> <note>` | Validate, canonicalize, check guardrails, and preview without moving funds. |
| `boon tip --json --dry-run ...` | Machine-readable dry-run output for agent review. |
| `boon tip --yes --approval-id <id> ...` | Execute without interactive prompt only when a human-approved policy or plan id authorizes the exact send. |
| `boon tip-private <handle> --amount <usdc> --note <text> --dry-run` | Prepare and validate a private tip without moving funds. |
| `boon tip-private <handle> --amount <usdc> --note <text> --mint-attestation --yes --approval-id <id>` | Execute a live OWS private tip with optional SBT after explicit approval. |
| `boon claim <handle>` | Start a phone-approved device-code claim for a cloud agent or SSH session. |
| `boon claim <handle> --recipient 0x...` | Override the configured OWS receiving wallet for this claim. |
| `boon claim <handle> --yes --json` | Machine-readable device-flow output; skips only the local terminal echo after phone approval. |
| `boon claim status` | Inspect the latest in-flight device-code claim stored on this machine. |
| `boon history [handle]` | Show local send history, optionally filtered by canonical handle. |

## First OWS setup

```bash
boon wallet connect ows --wallet boon-agent
boon wallet current
boon doctor
```

Fund the printed OWS address with a small amount of Base USDC plus gas headroom, then run `boon doctor` again. For current BoonV3 sends, set `BOON_ACTIVE_CONTRACT=v3`; private-tip sends also need the live `$BOON` token address configured.

## Dry-run before send

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
boon tip --dry-run github:alice 5 "pr:owner/repo#42: review"
```

The dry-run should show:

- canonical handle and handle hash;
- Base mainnet and deployed BoonV3 contract;
- USDC amount in token units;
- note;
- current local spend/cooldown status;
- whether the command would approve USDC before calling `BoonV3.tip(...)`.

## Live send

Interactive operator-approved send:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
boon tip github:alice 5 "pr:owner/repo#42: review"
```

Agent-policy send:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
boon tip --yes --approval-id weekly-2026-05-25 github:alice 5 "pr:owner/repo#42: review"
```

`--yes` is intentionally gated by `--approval-id`. The id should refer to a human-approved policy or plan that allows the exact tip within the funded wallet's caps.

## Private tip dry-run and execution

Use `tip-private` only with an OWS wallet and explicit operator approval. The CLI never asks for a raw private key.

Dry-run first:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3 \
boon tip-private github:alice --amount 5 --note "local approval memo" --dry-run
```

With an attestation preview:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3 \
boon tip-private agent:42 --amount 5 --note "local approval memo" --mint-attestation --dry-run
```

Live execution requires either an interactive confirmation or the same `--yes --approval-id <id>` approval pattern used by public tips:

```bash
BOON_ACTIVE_CONTRACT=v3 \
BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF \
BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3 \
boon tip-private github:alice --amount 5 --note "local approval memo" --yes --approval-id weekly-2026-05-25-row-2
```

The CLI uploads an encrypted private-tip blob to the hosted API, signs the EIP-712 blob payload through OWS, redacts the operator's local memo before API upload, prepares `$BOON` approvals, and calls `BoonV3.tipPrivate(...)` or `BoonV3.tipPrivateAgent(...)`. Today, CLI private tips should be treated as private amount/commitment sends with a local approval memo; use the web app when the recipient needs revealable private note text. The fixed burns are:

| Option | `$BOON` burn |
| --- | ---: |
| Private tip | `500,000 $BOON` |
| Private tip + attestation | `3,500,000 $BOON` |

`--approval-id` is an operational label tying the execution to a human-approved plan. It is not an onchain approval-store lookup, so agents must still preserve the surrounding approval record.

## Claim from a cloud agent

Use this when the recipient is an agent or SSH session that has a Boon CLI configuration but cannot complete the browser OAuth flow on the same machine.

```bash
boon claim x:alice
```

The CLI:

1. Uses `settings.json`'s stored OWS agent address as the default receiving wallet.
2. Prints a short `BOON-....-....` code and `https://boonprotocol.com/cli`.
3. Polls while the operator opens that URL on a phone or laptop, enters the code, signs in as the exact handle requested by the CLI, and approves the permanent link.
4. Calls the hosted relayer to link the handle and claim pending entries.

Override the receiving wallet only when the operator explicitly asks:

```bash
boon claim x:alice --recipient 0x1234...
```

`--yes` skips only the local terminal confirmation after phone approval. It does not skip the phone-side approval, which is the load-bearing safety gate.

## Local files

Boon stores local CLI state under `~/.boon/`:

| File | Meaning |
|---|---|
| `settings.json` | Contract, USDC, RPC, API/app URLs, selected OWS wallet alias/address. |
| `config.json` | Guardrail caps such as per-day spend, per-tip max, cooldown, and CI dry-run behavior. |
| `spend-log.json` | Local spend total and most recent tip timestamp for guardrail checks. |
| `history.jsonl` | Local successful-tip ledger. |
| `device-session.json` | Latest in-flight CLI claim code/status metadata. It stores the public user code only, never the device code or claim session token. |

Do not commit `.boon/` files. They may contain addresses, handles, notes, and operational state.

## Defaults

Default guardrails are intentionally small:

```json
{
  "maxUsdcPerDay": "50",
  "maxUsdcPerTip": "10",
  "minSecondsBetweenTips": 60,
  "dryRunInCi": true
}
```

The CLI is for Base USDC settlement and the live `$BOON` burn mechanics only. It does not accept arbitrary token addresses or non-Base chains.
