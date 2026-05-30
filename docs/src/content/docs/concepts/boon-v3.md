---
title: BoonV3
description: The live v3 settlement model for walletless social tips, private tips, recipient proof cards, and Base mainnet.
---

# BoonV3

BoonV3 is the live Base mainnet contract generation for Boon. It restores Boon's original walletless promise while keeping private tips, `agent:N` recipients, and optional gratitude attestations.

The product rule is simple: a sender can thank a GitHub or X handle now, even if that recipient has never opened Boon. The recipient proves the handle later and claims what was already funded.

## What changes in v3

- **Per-tip pending settlement.** Walletless GitHub/X tips create one pending settlement entry per tip instead of one aggregate handle pool.
- **Walletless private tips.** A private thank-you can be funded before the recipient links a wallet. The private commitment is recorded at send time; recipient access unlocks after OAuth claim.
- **Walletless attestations.** If the sender asks for a gratitude proof card and the handle is not linked yet, the proof intent is recorded and the SBT mints to the first claim wallet when the recipient claims.
- **Immutable first claim wallet.** The first successful claim sets `firstClaimWallet[handleHash]`. Later relinks change future direct tips only; they cannot redirect already-pending tips.
- **`claimSpecific` recovery.** Claim batches are atomic. If one entry blocks a batch, the Worker can isolate the failing `tipId` and retry a clean set through `claimSpecific`.
- **Rotatable attestation minter.** The v3 attestation contract keeps its minter behind a Safe-controlled timelock rotation path instead of a one-shot dead end.

## Recipient modes

| Recipient | Before link? | Settlement |
| --- | ---: | --- |
| `github:alice` | Yes | Pending settlement entry; OAuth claim later |
| `x:bob` | Yes | Pending settlement entry; OAuth claim later |
| Linked GitHub/X handle | Already linked | Direct USDC push to the linked wallet |
| `agent:N` | No walletless mode | Direct resolution through ERC-8004 on Base |

Agents are intentionally different from social handles. An `agent:N` tip resolves onchain at send time and must match the expected wallet supplied by the sender.

## Link and claim flow

After OAuth, the Worker reads the handle's pending settlement state and chooses the right contract path:

1. If the handle has no pending entries, `link(...)` binds the wallet for future direct tips.
2. If the handle has pending entries, `linkAndClaim(..., 32)` links and claims the first batch in one relayed transaction.
3. If more entries remain, the Worker pages through `claim(handleHash, 32)`.
4. If a batch reverts, the Worker uses `claimSpecific(tipIds)` to retry a clean set while surfacing the failing entries for operator review.

Recipients do not pay to link, view, or claim when the hosted relayer is available. If the relayer cannot safely finish, the UI and CLI fail closed with a specific error.

## Burns in v3

Public USDC-only tips do not burn `$BOON`. Burns happen only for privacy and proof actions:

| Action | Fixed burn |
| --- | ---: |
| Private tip | `500,000 $BOON` |
| Gratitude attestation | `3,000,000 $BOON` |
| Private tip with attestation | `3,500,000 $BOON` |

Burns happen at send time and are not refundable. If a walletless recipient never claims, the sender can recover the USDC after the refund delay, but the `$BOON` remains burned.

## Mainnet status

BoonV3 is live on Base mainnet. Current production addresses are published in [contract addresses](/resources/contract-addresses/): BoonV3 settlement at `0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF` and BoonGratitudeAttestationV3 at `0xC53160EEedb119670A7c13CC7C3709CdE6c9b469`.

See also [settlement model](/concepts/escrow-vs-push/), [OAuth claim flow](/concepts/oauth-claim-flow/), [private tips](/concepts/private-tips/), [gratitude attestations](/concepts/attestations/), and [$BOON burns](/burn/).
