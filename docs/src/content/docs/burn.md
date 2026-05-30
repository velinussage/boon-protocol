---
title: "$BOON burn dashboard"
description: How Boon counts fixed $BOON burns for private tips and gratitude attestations.
---

# $BOON burn dashboard

The public burn dashboard lives at [`boonprotocol.com/burn`](https://boonprotocol.com/burn). It is a read-only view over public aggregate data from the Boon subgraph and hosted read API.

## What counts as a burn

Public USDC-only tips do not burn `$BOON`. Boon burns fixed amounts for two optional actions:

| Action | Burn |
| --- | ---: |
| Private tip | `500,000 $BOON` |
| Gratitude attestation | `3,000,000 $BOON` |
| Private tip + attestation | `3,500,000 $BOON` |

Per-action behavior:

- A private tip burns `500,000 $BOON` when the sender hides the public note and display amount behind recipient/tipper authentication and fixed x402 reveal.
- A gratitude attestation burns `3,000,000 $BOON` when the sender requests a soulbound proof card for the recipient. Walletless recipients can receive the card at claim time.
- A private tip with a requested proof combines both fixed burns for `3,500,000 $BOON`.

The burn is not a fee to a treasury. `$BOON` is transferred to the burn address as part of the send path.

## What the dashboard shows

- cumulative `$BOON` burned for private tips;
- cumulative `$BOON` burned for requested gratitude attestations;
- combined `$BOON` burned;
- an indexed per-day burn rate based on the public subgraph window;
- the fixed per-action burn breakdown in the docs.

The live totals come from the public Boon subgraph as exposed by the hosted read API. Privacy burns are counted from private-tip events. Attestation burns are counted when an attestation is requested and the fixed burn happens, even if a walletless recipient's SBT mints later at claim time. Public USDC-only tips do not burn `$BOON`.

The dashboard intentionally avoids private note text, private display amounts, operator-only deployment details, and non-public runbook commands.

## Walletless recipients

For walletless GitHub/X recipients, burns still happen when the sender creates the tip. USDC waits in pending settlement until the recipient claims, but the privacy/proof burn is irrevocable.

Attestation burn totals are indexed from the send/request path. For walletless tips with deferred proof cards, the public SBT mint event appears later, when the recipient claims and the SBT is minted to the first claim wallet.

See [BoonV3](/concepts/boon-v3/) and [$BOON tokenomics](/tokenomics/) for the surrounding protocol mechanics.
