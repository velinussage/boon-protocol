---
title: Gratitude attestations
description: Optional soulbound Boon proof cards for recipients who want portable proof without exposing the private note or amount.
---

# Gratitude attestations

A gratitude attestation is an optional soulbound token minted when the tipper wants the recipient to have portable proof that a funded Boon happened.

It is a public artifact. Tippers should mint one only when they want the recipient to be able to show that proof outside the Boon app.

## What the SBT proves

A Boon gratitude attestation proves:

- a real Boon tip was created;
- the attestation was minted by the Boon attestation contract;
- the token is locked and non-transferable;
- the recipient wallet received the proof;
- a fixed amount of `$BOON` was burned for the attestation.

Launch attestation burn:

```text
3,000,000 $BOON
```

The attestation page at `boonprotocol.com/attestations/:tipId` displays the SBT image, tip ID, recipient wallet, agent ID when present, `$BOON` burned, mint time, and public links.

## What it does not reveal

The attestation metadata does not include the private note, the private amount, or the tipper's identity.

Specifically, the SBT image and metadata show only the recipient handle, mint date, token ID, and a sealed-status badge. The tipper's GitHub or X handle never appears in the public SBT. The tipper's wallet address is still observable via the on-chain `PrivateTip` event regardless of the SBT, so this is image-and-metadata privacy, not full pseudonymity.

For private tips, this means the recipient gets a portable proof card without turning the private message into a public Boon board row. However, the attestation is still public and refers to a Boon tip ID. Observers may correlate it with contract reads, events, token-transfer traces, and timing.

That is the tradeoff: more portable proof, less anonymity.

## How the image and metadata resolve

The attestation contract returns `tokenURI(tipId) = metadataBaseURI + tipId` for every minted token, where `metadataBaseURI` is set exactly once at deploy and then permanently locked. The Worker serves ERC-721 JSON at the configured metadata path, and per-token PNG images at `https://boonprotocol.com/attestations/{tipId}.png`.

Because the base URI is locked at the contract level, the resolver path cannot be silently redirected by an admin later. Copy the current BoonGratitudeAttestationV3 address from [contract addresses](/resources/contract-addresses/) and verify with:

```bash
SBT=0xC53160EEedb119670A7c13CC7C3709CdE6c9b469
RPC=https://mainnet.base.org

cast call $SBT \
  'metadataBaseURI()(string)' \
  --rpc-url $RPC
cast call $SBT \
  'metadataBaseURILocked()(bool)' \
  --rpc-url $RPC
```

## Soulbound behavior

Boon attestations use ERC-721 plus ERC-5192-style soulbound locking. They are intended to stay with the recipient wallet that received them.

They cannot be transferred, approved, or sold as normal NFTs. They are proof cards, not collectible claims on protocol revenue or governance.

## Recipient binding

BoonV3 supports attestations for both linked and walletless social recipients.

- For linked GitHub or X recipients, the SBT mints to the linked wallet at tip time.
- For unlinked GitHub or X recipients, the sender can still request the proof card. Boon records the proof intent with the pending settlement entry, burns the fixed attestation amount at send time, and mints the SBT to the first claim wallet when the recipient proves the handle and claims.
- For `agent:N` recipients, the SBT mints to the resolved agent payout wallet at tip time.
- If the agent owner or wallet changes before execution, the guarded tip reverts instead of minting to a stale wallet.

There is no separate recipient-paid `claimAttestation` action. Walletless social proofs finalize as part of the Worker-driven link/claim path, and recipients still do not pay to receive the SBT when the hosted relayer is available.

## When to use it

Use an attestation when the recipient benefits from public, wallet-held proof: agent marketplaces, public portfolios, contribution records, or reputation surfaces.

Skip it when the sender wants maximum privacy. A private tip without an attestation still lets the recipient read the note and amount for free after auth.
