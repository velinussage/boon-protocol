---
title: Status and disclaimers
description: Current Boon release posture, safety limits, and operational caveats.
---

# Status and disclaimers

## Current public state

| Surface | State |
|---|---|
| App | `boonprotocol.com` and `www.boonprotocol.com` are live. |
| API | `api.boonprotocol.com` is live. |
| Boon settlement | BoonV3 on Base mainnet at `0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF`; see [contract addresses](/resources/contract-addresses/). |
| BoonGratitudeAttestation | BoonGratitudeAttestationV3 soulbound ERC-721 / ERC-5192 proof contract at `0xC53160EEedb119670A7c13CC7C3709CdE6c9b469`; see [contract addresses](/resources/contract-addresses/). |
| `$BOON` token | Base token at `0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3`; see [$BOON tokenomics](/tokenomics/). |
| Private tips / attestations | Fixed `500,000 $BOON` burn for privacy, fixed `3,000,000 $BOON` burn for attestation, fixed `$1 USDC` x402 unlock price. |
| Agent recipients | `agent:N` is the canonical handle form for ERC-8004 agent recipients. |
| Subgraph | Goldsky-backed reads cover board, points, profile, receipt, attestation, and graph data. |
| OAuth | Public Worker has GitHub and X OAuth routes configured. Agents do not OAuth claim. |
| x402 | Paid graph routes settle to the Boon Safe; third-party private-tip unlocks settle to the original tipper. |
| CLI | OWS-funded agent wallet mode supports public tips, claim-help, and private-tip execution. |

## Safety posture

- Boon is live on Base mainnet but unaudited.
- Use small amounts only.
- Boon is non-custodial software, not a payment processor.
- Operators are responsible for their own legal, tax, and compliance obligations.
- Recipient claim/help must stay free.
- Do not send private keys to Boon, agents, or support channels.
- `$BOON` is a fixed-burn utility for private-tip and attestation actions, not a holder-tier, staking, revenue-share, emissions, or governance product.

## Known product boundaries

- USDC settlement on Base only.
- Recipient handles are `github:`, `x:`, or `agent:N`.
- Public tips include handle, amount, sender, and note in public Boon data.
- Private tips hide note and display amount from Boon's public read path, but not from all chain analysis.
- Attestations are public, soulbound proof cards and may reveal a tipper/recipient relationship.
- No public chronological feed; detailed graph reads are x402-paid.
- No self-serve relink in the public claim UI.
