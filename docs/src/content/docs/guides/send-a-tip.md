---
title: Send a tip
description: Use the web app to send public tips, private tips, and optional soulbound attestations.
---

# Send a tip

Use `/send` for normal human sends. The sender wallet signs the transaction directly.

## Before you start

You need:

- a recipient handle such as `github:alice`, `x:bob`, or `agent:42`;
- a small USDC amount on Base; unlinked GitHub/X pending tips must be at least `$0.10` USDC;
- a short note with concrete context;
- Coinbase, Metamask/injected, or WalletConnect;
- `$BOON` only if you choose a private tip or recipient attestation.

Good notes include an artifact:

```text
pr:owner/repo#42 — caught race in bundler
x:2055825024901378483 — useful risk warning
review:owner/repo#42 — security notes
```

## Choose the send mode

| Mode | What moves | Public read path |
| --- | --- | --- |
| Public tip | USDC only | Note and amount are public Boon receipt/subgraph data. |
| Private tip | USDC + fixed `500,000 $BOON` burn | Public receipt shows a private commitment; note and display amount require auth or x402 unlock. |
| Public tip + attestation | USDC + fixed `3,000,000 $BOON` burn | Recipient receives a public soulbound proof card when the receiving wallet is known. |
| Private tip + attestation | USDC + fixed `3,500,000 $BOON` total burn | Note/display amount stay private in Boon; the public SBT proves a Boon happened. |

For GitHub and X recipients, all four modes can be sent before the recipient has joined Boon. If the handle is not linked yet, Boon records a per-tip pending settlement entry and the recipient claims later. `agent:N` recipients resolve through ERC-8004 and must resolve at send time.

## Steps

1. Open [boonprotocol.com/send](https://boonprotocol.com/send).
2. Enter the handle, amount, and note.
3. Choose whether the tip should be public, private, and/or attested.
4. Connect your wallet.
5. If your Base USDC balance is short, use the Coinbase Onramp session.
6. If the selected mode burns `$BOON`, make sure the same wallet has enough `$BOON`.
7. Return to Boon and recheck balances.
8. Approve exactly the displayed USDC and `$BOON` amounts if needed.
9. Confirm the transaction.
10. Save or share the receipt URL when the transaction confirms.

## What happens next

- Public tips to an unlinked GitHub/X handle wait as per-tip pending settlement entries until the recipient claims.
- Public tips to a linked GitHub/X handle push immediately to the linked wallet.
- Agent tips resolve the ERC-8004 payout wallet and push immediately.
- Private tips store encrypted detail in the hosted API and reveal it only to the tipper, recipient, or a third-party x402 payer.
- Attestations mint to the recipient wallet when the wallet is known and cannot be transferred.

## Limits

Boon is for small retroactive thank-yous, not payroll, invoices, holder-tier access, governance, yield, or hidden settlement. Private tips hide the note and display amount from Boon's public read path; they do not hide token-transfer traces on Base.
