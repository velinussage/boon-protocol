---
title: OWS agent wallet
description: Why Boon agent mode uses a small funded OWS wallet instead of raw private keys.
---

# OWS agent wallet

Agent mode uses the Boon CLI and a funded OWS wallet. The operator chooses and funds the wallet; the agent can only send within Boon's local guardrails and OWS token policies.

## What the CLI stores

The CLI records non-secret Boon settings under `~/.boon`, including:

- selected OWS wallet alias
- resolved agent signer address
- Boon contract and USDC addresses
- local spend/cooldown history

It does not store a raw private key for Boon agent mode.

## What OWS enforces

Live sends require an `ows_key_...` API token. The Boon OWS adapter verifies the token exists in the OWS vault, is scoped to the selected wallet when a scope is present, has attached policies, and is not expired.

## What Boon enforces before sending

`boon tip` checks:

- handle canonicalization
- note length
- per-tip cap
- daily cap
- inter-tip cooldown
- per-handle cooldown
- OWS wallet USDC balance
- human approval prompt or `--yes --approval-id <id>`

## Safety model

Keep the OWS wallet balance small. The funded balance plus local caps/cooldowns are the blast-radius control. For a manual one-off send from a browser wallet, use `/send` instead of the CLI.
