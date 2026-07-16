---
title: Quickstart
description: Send your first Boon in 30 seconds, then claim, CLI, and API paths.
---

# Quickstart

Send your first Boon in 30 seconds. A public send needs only USDC on Base.
`$BOON` is not required.

## Send your first Boon

1. Open [boonprotocol.com/send](https://boonprotocol.com/send).
2. Type who you are thanking: `github:alice`, `x:bob`, or `agent:42`.
3. Enter a USDC amount and a short note saying what they did. Tips to a
   GitHub or X handle that has not joined Boon yet must be at least `$0.10`.
4. Connect a wallet (Coinbase, MetaMask, or WalletConnect). If it is short on
   Base USDC, the Coinbase Onramp prompt funds it.
5. Send. The wallet signs one transaction and the Boon is public immediately.

If the recipient has not joined Boon, the USDC waits as a pending tip until
they claim it. Nothing expires if they take months.

Want the optional extras (a private tip or a soulbound attestation card)?
Those burn fixed amounts of `$BOON`, covered below.

## Claim a Boon someone sent you

1. Open [boonprotocol.com/claim](https://boonprotocol.com/claim).
2. Sign in with the GitHub or X account that received the Boon.
3. Review the proven handle and the claimable amount.
4. Pick a receiving wallet (Coinbase, MetaMask, or WalletConnect).
5. Confirm the permanent handle-to-wallet link. Claiming is free.

Agents do not claim by OAuth. `agent:N` recipients resolve through ERC-8004
and receive funds directly at send time.

## Private tips and attestations need $BOON

`$BOON` exists for two fixed burn mechanics: keeping a tip's note and amount
private (`500,000 $BOON`) and minting a soulbound attestation card to the
recipient (`3,000,000 $BOON`). The token address on Base:

```text
0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3
```

Use the app's Buy `$BOON` button or the
[Base Uniswap route](https://app.uniswap.org/swap?outputCurrency=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3&chain=base).
Read [$BOON tokenomics](/tokenomics/) before buying. `$BOON` does not provide
holder tiers, staking, revenue share, or governance.

## Agent and CLI path

Use this when an agent proposes Boons and an operator approves them. Dry-run
first, no funds move:

```bash
export BOON_ACTIVE_CONTRACT=v3
export BOON_V3_CONTRACT=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF
export BOON_TOKEN_ADDRESS=0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3

boon doctor
boon wallet connect ows --wallet boon-agent
boon tip --dry-run github:alice 2 "pr:owner/repo#42: helpful review"
boon tip-private github:alice --amount 2 --note "local approval memo; revealable text is app-only" --dry-run
```

Live CLI sends require a connected, funded OWS wallet and either an
interactive approval prompt or `--yes --approval-id <human-approved-plan-id>`.
See [agent sends](/guides/tip-from-agent/) and
[agent wallet setup](/guides/wallet-ows-setup/).

## Agent integrations and the hosted API

- **ACP flows:** the [ACP recognition interface](/integrations/acp/) returns
  post-service recognition suggestions, reputation summaries, and graph reads.
- **A2A discovery:** the [Agent Card](https://api.boonprotocol.com/.well-known/agent-card.json)
  advertises the same skills. Details on the [A2A page](/integrations/a2a/).
- **Hosted API:** OAuth, claims, onramp sessions, profile and receipt reads,
  and the x402-paid graph live at `https://api.boonprotocol.com`. See the
  [API overview](/api-reference/overview/).

## Install the CLI

```bash
npm install --global @velinussage/boon-cli
boon --version
```

The npm package is scoped, but it installs the `boon` executable.

## Verify the public API is up

```bash
curl https://api.boonprotocol.com/health
curl https://api.boonprotocol.com/api/v1/points/policy
curl https://api.boonprotocol.com/api/v1/handles/github:alice/points
```

The detailed per-handle boon list is x402-paid:

```bash
curl -i 'https://api.boonprotocol.com/api/v1/handles/github:alice/boons?limit=1'
```

An unpaid request should return `402 Payment Required` with a
`PAYMENT-REQUIRED` challenge.

## Verify a public checkout

```bash
git clone --recurse-submodules https://github.com/velinussage/boon-protocol
cd boon-protocol
pnpm install
forge test -vvv
pnpm --filter @boon/normalize test
pnpm --filter @velinussage/boon-cli test
pnpm --filter boon-app typecheck
pnpm --filter boon-app build
```

Contract tests, EIP-712 vectors, handle normalization, and CLI dry-runs run
self-contained from the public checkout with a Base RPC. The hosted product
flows (OAuth, relayed claims, onramp, x402 reads) use `api.boonprotocol.com`.
