---
title: "$BOON tokenomics and mechanics"
description: Public $BOON launch metadata, supply evidence, fixed burn mechanics, and private-tip utility.
---

# $BOON tokenomics and mechanics

Boon is a USDC gratitude protocol. `$BOON` is used for fixed burn-based protocol actions around private tips and optional attestations. It does not create holder tiers, staking rights, revenue share, emissions, or governance rights.

## Live launch evidence

| Item | Value | Evidence |
| --- | --- | --- |
| `$BOON` token address | `0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3` | [BaseScan token page](https://basescan.org/token/0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3) |
| Launch transaction | `0xb94436afbc1806b002c51ab8b8e9e43eeba64b9bbfcb78e7584e9938cb3175ef` | [BaseScan transaction](https://basescan.org/tx/0xb94436afbc1806b002c51ab8b8e9e43eeba64b9bbfcb78e7584e9938cb3175ef) |
| Network | Base | [BaseScan token page](https://basescan.org/token/0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3) |
| Name / symbol | `Boon` / `BOON` | Public contract reads after launch |
| Total supply | `100,000,000,000 BOON` | `totalSupply() = 100000000000000000000000000000`, `decimals() = 18` |
| Decimals | `18` | Public contract read after launch |
| Bankr/Doppler pool ID | `0x2d63586bc4515a5de13e2006469a72a439533d8b90e55157a00084bfa25ab556` | Bankr live deploy response |
| Fee distribution returned by Bankr | Creator `9,500 bps`; protocol `500 bps` | Bankr live deploy response |
| Creator fee recipient | `0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F` | [BaseScan address](https://basescan.org/address/0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F) |
| Protocol fee recipient | `0x21e2ce70511e4fe542a97708e89520471daa7a66` | [BaseScan address](https://basescan.org/address/0x21e2ce70511e4fe542a97708e89520471daa7a66) |
| Creator allocation | `0 BOON` to the creator-fee Safe at immediate post-launch verification | `balanceOf(0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F) = 0` |
| Liquidity / launch control | Pool reported locked; token owner read as `0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12` | `isPoolUnlocked() = false`, `currentYearStart() = 0`, [`owner` address](https://basescan.org/address/0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12) |

The launch evidence above is the public mechanics record, not investment advice or a promise of market behavior.

## Fixed Boon mechanics

| Mechanic | Launch value | User-visible effect |
| --- | ---: | --- |
| Private-tip burn | `500,000 $BOON` | The tipper burns a fixed amount of `$BOON` to make a funded USDC tip private. |
| Optional attestation burn | `3,000,000 $BOON` | The tipper may burn a fixed amount of `$BOON` to request a soulbound gratitude attestation. |
| Third-party private-tip reveal price | `$1 USDC` | A third party pays the fixed visible x402 price to unlock an eligible private-tip note/amount. |
| Recipient read price | Free after auth | The recipient can read their own private tips after proving recipient control. |
| Tipper read price | Free after auth | The original tipper can read their own private tips after proving tipper control. |

Public tips do not require `$BOON`. `$BOON` burns are only for private tips and optional recipient-proof actions.

## BoonV3 burn behavior

BoonV3 keeps the fixed burn schedule above. What changes in v3 is the settlement
timing for walletless recipients:

- a walletless private tip burns `500,000 $BOON` immediately when the sender
  creates the tip, even though the recipient claims the USDC later;
- a walletless tip with a requested gratitude attestation burns `3,000,000
  $BOON` immediately and mints the soulbound proof card when the recipient's
  first claim wallet is known;
- a private walletless tip with an attestation combines both burns for a total
  of `3,500,000 $BOON`;
- public USDC-only tips still do not burn `$BOON`.

Burns are irrevocable. If an abandoned walletless entry becomes refundable after
the 180-day refund window, only the escrowed USDC returns to the sender; burned
`$BOON` remains burned.

## How private tips work

A public Boon tip records a USDC transfer and public tip metadata. A private Boon tip still settles USDC onchain, but the private note and display amount are kept out of the public Boon event payload and public subgraph view.

For a private tip:

1. The tipper sends the funded USDC tip.
2. The tipper burns the fixed private-tip amount of `$BOON`.
3. Boon stores encrypted private-tip metadata for authorized reads.
4. The recipient and original tipper can read the private details for free after authentication.
5. A third party can reveal an eligible private tip only by paying the fixed x402 unlock price in USDC.
6. Paid unlocks settle directly to the original tipper, not to Boon as a protocol treasury.

Privacy is scoped: private tips hide the note and display amount from the Boon event/subgraph path. They do not hide token-transfer traces, wallet activity, timing, or other public blockchain data.

## What $BOON does not do

`$BOON` does **not** provide:

- holder tiers or balance-threshold access;
- staking, yield, emissions, or revenue share;
- governance rights;
- per-tip private unlock pricing;
- unlock caps or time-based unlock promises;
- a presale allocation, treasury reserve, or creator allocation.

The mechanic is intentionally narrow: fixed burns for private-tip/attestation actions, fixed x402 reveal pricing for third-party unlocks, and free authenticated reads for the recipient and tipper.
