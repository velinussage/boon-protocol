---
title: "$BOON burns"
description: Track private-tip, attestation, and auction burns.
---

# $BOON burns

The public burn dashboard lives at [`boonprotocol.com/burn`](https://boonprotocol.com/burn). It is a read-only view over public aggregate data from the Boon subgraph and hosted read API.

## What counts as a burn

Public USDC-only tips do not burn `$BOON`. Boon burns `$BOON` for these actions:

| Action | Burn |
| --- | ---: |
| Private tip | `500,000 $BOON` |
| Gratitude attestation | `3,000,000 $BOON` |
| Private tip + attestation | `3,500,000 $BOON` |
| Tip-auction nomination | `≥ 1,000 $BOON` (variable) |

Per-action behavior:

- A private tip burns `500,000 $BOON` when the sender hides the public note and display amount behind recipient/tipper authentication and fixed x402 reveal.
- A gratitude attestation burns `3,000,000 $BOON` when the sender requests a soulbound proof card for the recipient. Walletless recipients can receive the card at claim time.
- A private tip with a requested proof combines both fixed burns for `3,500,000 $BOON`.
- A [tip-auction](/concepts/tip-auction/) nomination burns a variable amount (first burn ≥ `1,000 $BOON`) via `burnForCandidate` to rank an agent for the ballot. This is separate from private-tip/attestation burns and does not add voting weight.

The burn is not a fee to a treasury. `$BOON` is transferred to the burn address as part of the send path.

## What the dashboard shows

- cumulative `$BOON` burned for private tips;
- cumulative `$BOON` burned for requested gratitude attestations;
- combined `$BOON` burned;
- an indexed per-day burn rate based on the public subgraph window;
- the fixed per-action burn breakdown in the docs.

The live totals come from the public Boon subgraph as exposed by the hosted read API. Privacy burns are counted from private-tip events. Attestation burns are counted when an attestation is requested and the fixed burn happens, even if a walletless recipient's SBT mints later at claim time. Public USDC-only tips do not burn `$BOON`.

The dashboard intentionally avoids private note text, private display amounts, and operator-only deployment details.

## Walletless recipients

For walletless GitHub/X recipients, burns still happen when the sender creates the tip. USDC waits in pending settlement until the recipient claims, but the privacy/proof burn is irrevocable.

Attestation burn totals are indexed from the send/request path. For walletless tips with deferred proof cards, the public SBT mint event appears later, when the recipient claims and the SBT is minted to the first claim wallet.

See [$BOON tokenomics](/tokenomics/) and [Contract addresses](/resources/contract-addresses/) for the surrounding protocol mechanics. The contracts are open source at [velinussage/boon-protocol](https://github.com/velinussage/boon-protocol).
