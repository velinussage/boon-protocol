---
title: Introduction
description: What Boon is, who it is for, and the fastest path to a first useful tip.
---

# Boon

Boon is onchain gratitude for useful work on Base. A sender can tip a GitHub handle, X handle, or ERC-8004 `agent:N` recipient with USDC, then optionally use `$BOON` for higher-signal proof surfaces: private tips and soulbound gratitude attestations.

The default surface is human-first:

- **Senders** use [`/send`](https://boonprotocol.com/send) for a one-time wallet checkout, optional private tip, or optional gratitude attestation.
- **Recipients** use [`/claim`](https://boonprotocol.com/claim) to prove GitHub or X ownership and choose a receiving wallet.
- **Agent operators** use the Boon CLI with a small funded OWS wallet when an agent should propose and execute approved thank-yous.
- **API consumers** use free aggregate endpoints by default, x402-paid graph endpoints for detailed graph reads, and fixed-price x402 unlocks for third-party private-tip reveals.

## The 5-minute mental model

1. A recipient is canonicalized as `github:alice`, `x:bob`, or `agent:42`.
2. The sender chooses a public tip, private tip, and/or optional soulbound attestation.
3. GitHub/X tips can be sent before the recipient has joined Boon. Boon records a per-tip pending settlement entry and the recipient claims later.
4. Already-linked GitHub/X handles and `agent:N` recipients receive direct settlement at send time.
5. Public tips show the note and amount in the public Boon read path.
6. Private tips keep the note and amount out of the public Boon event/subgraph path and burn a fixed `500,000 $BOON`.
7. Optional attestations burn a fixed `3,000,000 $BOON` and mint a public, soulbound proof card to the recipient when the recipient wallet is known.
8. Recipient and tipper reads for private tips are free after auth; other viewers pay the fixed `$1 USDC` x402 reveal price to the original tipper.

## Settlement model

Boon uses one current settlement model:

- **Per-tip pending settlement** for unlinked GitHub/X handles. Each tip keeps its own amount, tipper, optional private commitment, optional attestation intent, and creation time. The recipient proves the handle later and claims the pending entries.
- **Direct push** for already-linked GitHub/X handles and for ERC-8004 agents. Funds go to the resolved payout wallet in the send transaction.
- **Free recipient claim.** Boon does not charge recipients to view, link, or claim. If the hosted relayer is unavailable, the UI fails closed instead of pretending the claim completed.

See [settlement model](/concepts/escrow-vs-push/) and [OAuth claim flow](/concepts/oauth-claim-flow/) for details.

## What stays free

Sending, viewing aggregate Boon Points, viewing a specific receipt, viewing an attestation page, linking, and claiming are free product surfaces. Boon does not put recipient claim-help or viewing pending tips behind x402.

Detailed who-paid-who graph reads are a paid API surface. Third-party private-tip reveals are a separate fixed-price x402 surface. See [x402 paid endpoints](/api-reference/x402-paid-endpoints/).

## Current anchors

| Surface | URL / address |
|---|---|
| App | [boonprotocol.com](https://boonprotocol.com) |
| API | [api.boonprotocol.com](https://api.boonprotocol.com) |
| BoonV3 settlement contract | `0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF` |
| BoonGratitudeAttestationV3 SBT | `0xC53160EEedb119670A7c13CC7C3709CdE6c9b469` |
| `$BOON` token | `0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3` |
| ERC-8004 IdentityRegistry on Base | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Base USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Repository | [github.com/velinussage/boon-protocol](https://github.com/velinussage/boon-protocol) |

See [contract addresses](/resources/contract-addresses/) and [$BOON tokenomics](/tokenomics/) for launch evidence.

> Boon is on Base mainnet and should be used with small amounts while the public end-to-end private/public send, claim, and unlock smoke posture continues to mature.

## Next steps

- New sender: [send a tip](/guides/send-a-tip/)
- Recipient: [claim a boon](/guides/claim-a-boon/)
- Agent operator: [tip from an agent](/guides/tip-from-agent/)
- Integrator: [API overview](/api-reference/overview/)
