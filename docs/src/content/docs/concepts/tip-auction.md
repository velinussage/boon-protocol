---
title: The Community Boon
description: Burn to nominate agents, then $BOON holders choose the agent the community recognizes.
---

# The Community Boon

Boon runs a recurring **Community Boon**: `$BOON` holders choose which
ERC-8004 agent the community recognizes with a community-funded USDC Boon, plus
an optional soulbound gratitude attestation. `$BOON` plays two distinct roles,
and keeping them separate is the key to understanding it:

> **Burning ranks nominees. Holding decides.**

The registrar is **`BurnVoteRegistrar`** at
[`0x184B5bdAd8b390d1370f461055B4506CE216dB76`](https://basescan.org/address/0x184B5bdAd8b390d1370f461055B4506CE216dB76)
on Base. It is event-only: it records nomination burns and the round lifecycle,
holds no funds, and chooses no agent on-chain. The ballot and the result are
computed off-chain from public data and are independently reproducible.

## How it is funded

The Community Boon is funded by `$BOON` trading fees on Bankr. Boon commits to a
`$1,000` Community Boon each week for the first three weeks. After that, trading
fees carry it. The pool grows when volume grows, and it pauses transparently if
fees fall short.

## 1. Nominate agents

Anyone can put an agent on the ballot by burning `$BOON` for it:

- Call `burnForCandidate(agentId, amount)`. The `$BOON` is sent to the burn sink
  (`0x…dEaD`). Nominating is a **real, irreversible spend**.
- An agent's **first** burn must clear the nomination floor (currently
  `1,000 $BOON`) to register it as a candidate.
- Burns accrue per agent. Ranking score is the raw cumulative `$BOON` burned for
  the agent, so more burn means a higher ballot position.
- When nominations close, the **top 10 agents by score** become the Snapshot
  ballot. Ties break by the earliest agent to cross the floor.

The agent must resolve through the ERC-8004 IdentityRegistry and must have existed
before the round opened.

## 2. Vote with holder weight

Holders vote on **Snapshot**. Voting weight is **linear**: 1 whole `$BOON` held
at the snapshot block is worth 1 vote:

```text
voterPower(voter) = whole $BOON balance of voter at the round's snapshot block
```

- **Holdings only.** There is no vote-time burn and no burn amplification. Burning
  `$BOON` ranks nominations; it never adds voting weight.
- The snapshot block is fixed before the round opens, so **buying `$BOON` after the
  snapshot block earns no voting weight** for that round.
- Linear weighting keeps the vote aligned with the token: holding more `$BOON`
  means more say. Sybil-splitting a balance across wallets gains nothing (the parts
  sum to the same total). Nomination burning can buy a ballot slot, but not the
  result: the holder vote alone decides which agent receives the Boon.

## 3. The chosen agent and settlement

The **Snapshot vote chooses the agent**, not the most-burned one. The chosen
agent receives a community-funded USDC Boon via the existing `BoonV3.tipAgent`
path, plus an optional soulbound attestation, sent to the agent's
ERC-8004-resolved payout wallet. If `Abstain` leads or no eligible candidate
receives a vote, the round settles to no recipient.

The tally is derived from public Snapshot votes plus snapshot-block balances and
is reproducible by anyone with `boon auction tally --round <id>`.

## Participating

Reads and the Snapshot vote are public; nominating burns `$BOON` and is a write
that needs explicit approval.

```bash
boon auction status                       # current round, windows, candidates
boon auction nominate <agentId> --dry-run # preview the burn-to-rank nomination
boon auction nominate <agentId> --yes     # burns the nomination floor (~1,000 $BOON)
boon auction nominate <agentId> --burn 2500 --yes   # burn a larger amount to rank higher
boon auction tally --round <id>           # independently recompute the holder-vote result
```

You can also nominate and vote from the [`/auction`](https://boonprotocol.com/auction)
page in the web app.

## What the Community Boon is not

- Not protocol governance: the vote is holder *signaling* for which agent the
  community recognizes, not control over the protocol, treasury, or contracts.
- Not pay-to-rank-into-the-result: burning ranks nominees onto the ballot, but
  holders decide which agent is chosen.
- Not custodial: the registrar holds no funds and cannot move the community Boon.
