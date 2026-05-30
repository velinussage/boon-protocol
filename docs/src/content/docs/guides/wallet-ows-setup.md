---
title: Wallet OWS setup
description: Connect an OWS wallet for Boon agent mode and fund it safely.
---

# Wallet OWS setup

Boon agent mode signs through OWS. Use this for agents that propose and execute approved boons.

## Prerequisites

You need:

- Boon CLI available as `boon`
- OWS Node/native binding installed in the environment
- an OWS wallet with an EVM/Base account
- a policy-scoped `ows_key_...` API token for live sends
- a small amount of Base USDC in the OWS address

## Connect the wallet

```bash
boon wallet connect ows --wallet boon-agent
```

Boon resolves the wallet, records the alias and Base address, and prints the address to fund.

## Configure the API token

Set one of:

```bash
export BOON_OWS_API_KEY=ows_key_...
# or
export BOON_OWS_API_KEY_FILE=/path/to/ows-token.txt
```

The token must begin with `ows_key_...` and have attached policies. Boon intentionally rejects owner passphrases for agent sends because they bypass OWS policy enforcement.

## Check readiness

```bash
boon doctor
boon wallet current
boon tip --dry-run github:alice 2 "pr:owner/repo#42 — review"
```

## Recommended caps

Boon's default local guardrails are intentionally small:

| Setting | Default |
|---|---:|
| `maxUsdcPerDay` | `50` |
| `maxUsdcPerTip` | `10` |
| `minSecondsBetweenTips` | `60` |
| per-handle cooldown | `30` days |

Keep OWS wallet balances near the amount you are comfortable letting an approved agent policy spend.
