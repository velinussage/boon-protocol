---
title: Contract addresses
description: Mainnet Base addresses for BoonV3, BoonGratitudeAttestationV3, $BOON token, USDC, ERC-8004, and operator accounts.
---

# Contract addresses

Boon runs on Base mainnet. The BoonV3 settlement contract is the user-facing protocol entry point for public tips, private tips, pending settlement, claims, refunds, agent recipients, and optional recipient attestations.

## BoonV3 protocol contracts

| Name | Address | Notes |
|---|---|---|
| BoonV3 settlement contract | `0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF` | USDC tips, walletless per-tip pending settlement, private tips, agent recipients, claims, refunds, and fixed `$BOON` burns. |
| BoonGratitudeAttestationV3 | `0xC53160EEedb119670A7c13CC7C3709CdE6c9b469` | ERC-721 + ERC-5192 soulbound gratitude proof minted by BoonV3, including deferred minting for walletless recipients at claim time. |

BoonV3 addresses below are Base mainnet production addresses. Do not use a zero address or a fork/test address as a production integration target.

## Boon settlement constants

| Constant | Value | What it does |
|---|---:|---|
| `PRIVATE_TIP_BURN` | `500_000e18` $BOON | Burned to keep a tip's note + display amount out of the public Boon read path. |
| `ATTESTATION_BURN` | `3_000_000e18` $BOON | Additional burn to request a recipient soulbound proof card. |
| `UNLOCK_PRICE_USDC` | `1_000_000` (= $1.00 USDC) | Fixed price a third party pays to read a private tip's note + amount. |
| `MIN_ESCROW_USDC` | `100_000` (= $0.10 USDC) | Minimum pending settlement amount for walletless social tips. |
| `MAX_ESCROW_PER_HANDLE` | `256` | Maximum pending entries per GitHub/X handle. |
| `ESCROW_REFUND_DELAY` | `180 days` | Sender refund window for abandoned unclaimed entries. |
| `USDC` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Circle USDC on Base. Tip settlement token. |
| `BOON` | `0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3` | `$BOON` token. |
| `IDENTITY_REGISTRY` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | ERC-8004 agent identity registry on Base. |

## Roles and operator anchors

| Role | Address | What it can do |
|---|---|---|
| Owner Safe | `0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F` | Pause/unpause, rotate trusted signer, rotate escrow guardian, and transfer ownership. No USDC sweep and no `$BOON` recovery. |
| Trusted signer | `0x82A2D8C68A9a3871B574C777b6934e9127131430` | Signs OAuth social-link vouchers. |
| Escrow guardian | `0x7d97EC943D44d03Fbf4E36277bE3D3bB47Ec67a6` | Co-signs first-link operations when pending USDC exists. |

## $BOON token

| Item | Value | Link |
|---|---|---|
| `$BOON` token | `0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3` | [BaseScan token](https://basescan.org/token/0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3) |
| Launch transaction | `0xb94436afbc1806b002c51ab8b8e9e43eeba64b9bbfcb78e7584e9938cb3175ef` | [BaseScan tx](https://basescan.org/tx/0xb94436afbc1806b002c51ab8b8e9e43eeba64b9bbfcb78e7584e9938cb3175ef) |
| Bankr/Doppler pool ID | `0x2d63586bc4515a5de13e2006469a72a439533d8b90e55157a00084bfa25ab556` | Bankr live deploy response |
| Creator fee recipient (Safe) | `0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F` | [BaseScan address](https://basescan.org/address/0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F) |
| Protocol fee recipient (Doppler) | `0x21e2ce70511e4fe542a97708e89520471daa7a66` | [BaseScan address](https://basescan.org/address/0x21e2ce70511e4fe542a97708e89520471daa7a66) |
| LP-lock / migration target | `0x6ddfed58d238ca3195e49d8ac3d4cea6386e5c33` (NoOpMigrator, permanent LP lock) | [BaseScan address](https://basescan.org/address/0x6ddfed58d238ca3195e49d8ac3d4cea6386e5c33) |

Public token reads returned:

- `name() = "Boon"`
- `symbol() = "BOON"`
- `decimals() = 18`
- `totalSupply() = 100_000_000_000e18` (100B fixed supply)

## Verify Boon

```bash
BOON=0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF
RPC=https://mainnet.base.org

cast call $BOON 'owner()(address)' --rpc-url $RPC
cast call $BOON 'trustedSigner()(address)' --rpc-url $RPC
cast call $BOON 'escrowGuardian()(address)' --rpc-url $RPC
cast call $BOON 'USDC()(address)' --rpc-url $RPC
cast call $BOON 'BOON()(address)' --rpc-url $RPC
cast call $BOON 'IDENTITY_REGISTRY()(address)' --rpc-url $RPC
cast call $BOON 'ATTESTATION_CONTRACT()(address)' --rpc-url $RPC
cast call $BOON 'PRIVATE_TIP_BURN()(uint256)' --rpc-url $RPC
cast call $BOON 'ATTESTATION_BURN()(uint256)' --rpc-url $RPC
cast call $BOON 'UNLOCK_PRICE_USDC()(uint256)' --rpc-url $RPC
cast call $BOON 'ESCROW_REFUND_DELAY()(uint256)' --rpc-url $RPC
```

## Verify the attestation NFT

```bash
SBT=0xC53160EEedb119670A7c13CC7C3709CdE6c9b469
RPC=https://mainnet.base.org

cast call $SBT 'name()(string)' --rpc-url $RPC
cast call $SBT 'symbol()(string)' --rpc-url $RPC
cast call $SBT 'minter()(address)' --rpc-url $RPC
cast call $SBT 'metadataBaseURI()(string)' --rpc-url $RPC
```

Soulbound by ERC-5192: every minted token returns `locked(tokenId) = true`, and any transfer / approve call reverts.

## Function surface

```solidity
function tip(bytes32 handleHash, string displayHandle, address expectedWalletOrZero, uint256 amount, string note, bool mintAttestation, Permit permit) returns (uint256 tipId)
function tipAgent(uint256 agentId, address expectedWallet, uint256 amount, string note, bool mintAttestation, Permit permit) returns (uint256 tipId)
function tipPrivate(bytes32 handleHash, string displayHandle, address expectedWalletOrZero, uint256 amount, bytes32 privateCommitment, bool mintAttestation, Permit permit) returns (uint256 tipId)
function tipPrivateAgent(uint256 agentId, address expectedWallet, uint256 amount, bytes32 privateCommitment, bool mintAttestation, Permit permit) returns (uint256 tipId)
function link(bytes32 handleHash, address recipient, uint256 nonce, bytes workerSig)
function linkEscrowed(bytes32 handleHash, address recipient, uint256 nonce, bytes workerSig, bytes guardianSig)
function linkAndClaim(bytes32 handleHash, address recipient, uint256 nonce, bytes workerSig, bytes guardianSig, uint256 maxItems)
function claim(bytes32 handleHash, uint256 maxItems)
function claimSpecific(uint256[] tipIds)
function refund(uint256 tipId)
function relink(bytes32 handleHash, address newRecipient, uint256 nonce, bytes workerSig)
```

Concept references: [settlement model](/concepts/escrow-vs-push/), [private tips](/concepts/private-tips/), [agent recipients](/concepts/agent-recipients/), [attestations](/concepts/attestations/).
