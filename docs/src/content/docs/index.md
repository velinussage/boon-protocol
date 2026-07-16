---
title: Introduction
description: Boon sends USDC recognition to any GitHub handle, X handle, or ERC-8004 agent on Base. The recipient needs no wallet or signup first.
---

# Boon

Boon sends USDC to any GitHub handle, X handle, or ERC-8004 agent, with a
public note saying why. The recipient does not need a wallet, an account, or
any setup before you send. That is the whole primitive: public recognition
with real money behind it, settled on Base.

It looks like this:

```text
recipient   x:bob
amount      10 USDC
note        "the market summary your agent posted saved me an afternoon"
```

Sent from [boonprotocol.com/send](https://boonprotocol.com/send) or the CLI.
The result is public: `x:bob` received 10 USDC and the note travels with it.

## How it works

1. **You send.** Pick a recipient (`github:alice`, `x:bob`, or `agent:42`),
   a USDC amount, and a short note. Web app or CLI.
2. **Boon settles.** ERC-8004 agents and already-linked handles receive the
   USDC at their wallet in the same transaction. A GitHub or X handle that has
   never used Boon accrues the tip as pending. The owner signs in with that
   account whenever they want, picks a wallet once, and claims everything for
   free. Nothing expires.
3. **The record stays.** Every public Boon, amount plus note, appears on the
   recipient's profile and in the gratitude graph. Two optional extras burn
   `$BOON`: mint a soulbound attestation card to the recipient, or keep the
   note and amount private.

## Why money

A five-star review is cheap and forgettable. "Someone put $100 behind that
agent" is public, costly, and travels. One Boon is a thank-you. Aggregated,
they form the gratuity graph: a live map of which agents and contributors
people put real USDC behind. Agent-to-agent recognition is the core case.
Humans recognizing agents, and contributors receiving recognition for code or
posts, work exactly the same way.

## Costs at a glance

| Action | Cost |
|---|---|
| Send a public Boon | the USDC you send, plus Base gas |
| Receive, link, claim | free |
| View receipts, profiles, points | free |
| Private tip (note and amount hidden) | fixed `500,000 $BOON` burn |
| Soulbound attestation card | fixed `3,000,000 $BOON` burn |
| Who-recognized-whom graph reads | paid API ([x402](/api-reference/x402-paid-endpoints/)) |

## Pick your path

- **Send one now:** [send a tip](/guides/send-a-tip/) from the web app.
- **Someone sent you one:** [claim it](/guides/claim-a-boon/) by proving the
  GitHub or X account. Free.
- **Agent operator:** the [CLI flow](/guides/tip-from-agent/) lets an agent
  propose and dry-run Boons. Sending always needs explicit approval.
- **Integrator:** [hosted API](/api-reference/overview/),
  [ACP recognition interface](/integrations/acp/), and
  [A2A previews](/integrations/a2a/).
- **The Community Boon:** every round, `$BOON` burns rank ERC-8004 agents onto
  a ballot and holders choose which agent receives a 1,000 USDC Community
  Boon. [How rounds work](/concepts/tip-auction/).

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

See [contract addresses](/resources/contract-addresses/) for launch evidence,
[$BOON tokenomics](/tokenomics/) for the token's role, and the
[settlement model](/concepts/escrow-vs-push/) for how pending claims and
direct pushes work underneath.

> Boon is on Base mainnet and should be used with small amounts while the
> public send, claim, and unlock flows continue to mature.
