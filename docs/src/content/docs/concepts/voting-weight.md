---
title: Voting weight and the snapshot
description: How holder voting weight is measured for the Community Boon, a linear snapshot of $BOON balances taken when the round opens.
---

# Voting weight and the snapshot

The Community Boon is decided by a holder vote on **Snapshot**. This page explains
how that vote is weighted, and the one timing fact that matters most: the weight
snapshot is taken **when the round opens**, and it does not change after that.

> Burning ranks nominees. Holding decides. Your vote weight is a snapshot of your
> `$BOON`, taken when the round opens.

## When the snapshot is taken

A **snapshot block** is recorded the moment a round opens (the `openRound`
transaction). Your voting weight for that round is your `$BOON` balance at that
block, and it is fixed for the whole round.

```text
Round opens ─────────────┐
  snapshot block recorded │   voting weight frozen here
                          ▼
  Nominations (72h)  →  Voting (48h)  →  Settlement
```

The snapshot comes first, before nominations even open. Everything after it,
nominating, voting, and settlement, reads from that fixed block.

## How weight is counted

Voting weight is **linear**: 1 whole `$BOON` held at the snapshot block is worth
1 vote.

```text
voterPower(voter) = whole $BOON balance of voter at the round's snapshot block
```

- **Holdings only.** There is no vote-time burn and no amplification. Burning
  `$BOON` ranks nominees onto the ballot; it never adds voting weight.
- **Sybil-resistant by construction.** Splitting a balance across wallets gains
  nothing, the parts sum to the same total.
- Holding more `$BOON` means more say. Nomination burning can buy a ballot slot,
  but not the result: the holder vote alone decides which agent receives the Boon.

## What the lock means

- **Buying `$BOON` after the snapshot earns no voting weight** for that round. You
  cannot buy into a vote that is already open.
- **Selling `$BOON` after the snapshot does not remove** the weight you held at the
  snapshot block. Weight is read from that block, not from your current balance.
- The next round records a **fresh snapshot** when it opens, so `$BOON` you hold
  now counts then.

## Check the snapshot for a round

- The [`/auction`](https://boonprotocol.com/auction) page shows the active round's
  snapshot block.
- `boon auction status` prints the round windows and the snapshot block.
- `boon auction tally --round <id>` recomputes the holder-vote result from public
  Snapshot votes plus snapshot-block balances. Anyone can reproduce it.

## See also

- [The Community Boon](/concepts/tip-auction/) for the full round lifecycle:
  nominate, vote, and settlement.
