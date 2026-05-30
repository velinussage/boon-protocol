---
title: Quickstart
description: Send, claim, buy BOON, or inspect Boon in the shortest safe path.
---

# Quickstart

Pick the path that matches what you are trying to do.

## Send a boon from the web app

Use this when a human wants to send one thank-you now.

1. Open [boonprotocol.com/send](https://boonprotocol.com/send).
2. Enter a canonical recipient such as `github:alice`, `x:bob`, or `agent:42`.
3. Enter a small USDC amount and a short evidence-backed note. Unlinked GitHub/X pending tips must be at least `$0.10` USDC.
4. Choose the public path, or opt into a private tip and/or soulbound attestation.
5. Connect Coinbase, Metamask/injected, or WalletConnect.
6. If the wallet is short on Base USDC, use the Coinbase Onramp prompt.
7. If the chosen path burns `$BOON`, acquire enough `$BOON` and approve only the displayed amount.
8. Approve exactly the displayed USDC amount if needed, then send.

The browser wallet signs the transaction. The onramp funds the wallet; it does not atomically call Boon.

## Buy $BOON for private tips or attestations

`$BOON` is only needed for the fixed burn mechanics. The live token address is:

```text
0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3
```

Use the app's Buy `$BOON` button or open the Base Uniswap route directly:

```text
https://app.uniswap.org/swap?outputCurrency=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3&chain=base
```

See [$BOON tokenomics](/tokenomics/) before buying. `$BOON` does not provide holder tiers, staking, revenue share, or governance.

## Claim a boon

Use this when someone sent you a Boon receipt or told you a handle has funds waiting.

1. Open [boonprotocol.com/claim](https://boonprotocol.com/claim).
2. Sign in with the GitHub or X account that received the boon.
3. Review the proven handle and claimable amount.
4. Choose Coinbase, Metamask/injected, or WalletConnect as the receiving wallet.
5. Confirm the permanent handle-to-wallet link.
6. If the relayer is enabled, Boon submits link and claim transactions. If not, the UI fails loudly instead of pretending claim completed.

Agents do not claim by OAuth. `agent:N` recipients resolve through ERC-8004 at execution time.

## Try the CLI safely

Use this when an agent or operator wants to preview a proposed public or private tip without moving funds.

```bash
export BOON_ACTIVE_CONTRACT=v3
export BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF
export BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3

boon doctor
boon wallet connect ows --wallet boon-agent
boon tip --dry-run github:alice 2 "pr:owner/repo#42 — helpful review"
boon tip-private github:alice --amount 2 --note "local approval memo; revealable text is app-only" --dry-run
```

Live CLI sends require a connected, funded OWS wallet and either an interactive approval prompt or `--yes --approval-id <human-approved-plan-id>`.

## What requires the hosted API

The Boon contract and normalization rules are self-contained: contract tests,
EIP-712 vectors, handle normalization, CLI dry-runs, and direct settlement
transactions only need the repo dependencies, a Base RPC, and the operator's
wallet/OWS setup.

The hosted product flows use `https://api.boonprotocol.com` for OAuth,
claim-session creation, relayed claim completion, Coinbase Onramp sessions,
wallet balance reads, aggregate board/profile/receipt reads, points policy,
sender disclosure, private-tip blob upload/auth reads, attestation metadata,
and x402 graph/unlock endpoints. A self-hosted reference client needs a
compatible API at `VITE_BOON_API_URL` or the CLI's configured `apiUrl`.

## Verify public API health

```bash
curl https://api.boonprotocol.com/health
curl https://api.boonprotocol.com/api/v1/points/policy
curl https://api.boonprotocol.com/api/v1/handles/github:alice/points
```

The detailed per-handle boon list is x402-paid:

```bash
curl -i 'https://api.boonprotocol.com/api/v1/handles/github:alice/boons?limit=1'
```

An unpaid request should return `402 Payment Required` with a `PAYMENT-REQUIRED` challenge.

## Local repo smoke

```bash
git clone --recurse-submodules https://github.com/velinussage/boon-protocol
cd boon-protocol
pnpm install
forge test -vvv
pnpm --filter @boon/normalize test
pnpm --filter boon-cli test
pnpm --filter boon-app typecheck
pnpm --filter boon-app build
```

Fork tests and signer roundtrip tests require environment-specific keys or RPC settings. Hosted-API and subgraph deployments live behind `api.boonprotocol.com` and are not in the public mirror.
