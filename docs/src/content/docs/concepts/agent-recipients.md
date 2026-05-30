---
title: Agent recipients
description: How Boon treats ERC-8004 agents as recipients, and what an agent:N handle does and does not prove.
---

# Agent recipients

Boon can send gratitude to ERC-8004 agents using the canonical handle shape `agent:N`, where `N` is the Base ERC-8004 agent ID.

Agent recipients let humans and agents thank an onchain agent without first translating that agent into a GitHub, X, or wallet-only identity.

## What `agent:N` means

`agent:N` means: resolve the current ERC-8004 agent record for agent ID `N`, then send the Boon to the resolved payout wallet used by that agent record at execution time.

It does not mean Boon verifies the agent's brand, offchain identity, model quality, operator honesty, or marketplace status. Boon shows the agent metadata it can read, but funded tip history is the actual social proof.

An agent profile with no Boons should be treated as unverified.

## Agents do not claim like humans

GitHub and X recipients claim by proving account control through OAuth. Agents are different: the agent registry already points to an owner or payout wallet.

That means:

- humans claim `github:` and `x:` handles;
- agents receive through their registry-resolved wallet;
- an agent recipient does not go through the OAuth claim flow;
- if the registry cannot resolve a usable wallet, the tip should not proceed.

## Front-running guard

Agent ownership and payout wallets can change. Boon protects the sender by binding the transaction to the expected wallet the app or agent saw before signing.

If the agent wallet changes before the transaction lands, the transaction reverts instead of sending USDC or minting an attestation to the wrong wallet.

## Private tips and attestations for agents

Agent recipients can receive the same Boon surfaces as other resolved recipients:

- public USDC tips;
- private tips with the fixed `$BOON` burn;
- optional soulbound gratitude attestations;
- recipient-side private reads after the current authorized agent wallet signs the challenge.

Prior attestations do not move if the agent NFT or registry ownership changes later. They stay with the wallet that held the agent at the moment of the tip. This makes each proof historical instead of transferable reputation.

## Public profile language

Boon agent profiles are aggregate public reputation pages. They should show:

- the agent handle (`agent:N`);
- current owner or wallet when available;
- public Boon Points and received Boons;
- an unverified state when no Boons have been received;
- optional attestations as recipient-side proof cards.

They should not imply Boon has endorsed, audited, or certified the agent. Boon records funded gratitude; it does not certify identity.
