---
title: Troubleshooting
description: Common Boon send, claim, OAuth, OWS, relayer, and x402 failure modes.
---

# Troubleshooting

Boon should fail loudly when identity, wallet, relayer, or policy state is uncertain. Use this page to decide whether to retry, switch surfaces, or ask for operator help.

## Sender cannot send

### Wallet is short on Base USDC

Use Coinbase Onramp or transfer Base USDC to the sender wallet. The app funds the wallet; it does not atomically call `BoonV3.tip()` through Onramp.

### Approval or send transaction failed

Check that the wallet is on Base mainnet, has ETH for gas, and approves only the exact USDC amount being sent. Do not retry with a different token, chain, or contract.

### Handle is rejected

Handles must canonicalize to `github:<user>` or `x:<user>`. Normalize before hashing. If the intended recipient is ambiguous, stop and confirm the handle.

## Recipient cannot claim

### OAuth verification fails

The recipient must sign in with the same provider that received the boon. A tip to `github:alice` cannot be claimed through X, and a tip to `x:alice` cannot be claimed through GitHub.

### Wallet link fails

Retry after confirming the connected wallet address is the intended receiving wallet. The public link is effectively permanent for normal users; recovery uses the operator-assisted `relink()` path and only affects future direct tips.

### Handle already linked to a different wallet

If the Worker returns `409 already_linked_to_different_wallet`, the on-chain `linkedWallet[handleHash]` is already set to a wallet that is not the one currently in use. The response carries the linked address so both surfaces can show it. Two common ways to land here, and what to do in each.

**Web first, then CLI** — recipient already claimed via `/claim` into a browser wallet (MetaMask, Coinbase Smart Wallet, etc.) and is now running `boon claim <handle>` from an agent CLI whose default recipient is a different OWS wallet.

- The single-line fix: rerun the CLI with `--recipient` set to the linked wallet.
  ```bash
  boon claim x:alice --recipient 0xAAAA...BBBB
  ```
  The relayer-sponsored claim still works when the recipient matches the wallet that owns pending claim rights. The CLI's OWS wallet is then a pass-through that never receives funds.
- If the agent is intended to own future tips, send USDC from the browser wallet to the OWS wallet after each claim, or use operator-assisted `relink()` (out of scope for end users).

**CLI first, then web** — recipient already claimed via `boon claim <handle>` into an OWS-controlled wallet and is now trying to claim from the web `/claim` page with a different browser wallet.

- The cheapest fix: connect the browser wallet to the **OWS address** if possible. OWS keys may be exportable depending on the local OWS binding. **Treat the private key like any other live key**: in a hardware-isolated browser profile, never paste into untrusted UIs, and prefer transferring the USDC out via a one-shot `boon tip` or contract `transfer` instead.
- The safer fix: leave the OWS wallet as the canonical linked wallet, and have the OWS wallet send the USDC over to MetaMask after each claim. The OWS adapter at `cli/src/ows.ts` already signs sends; the agent can run `boon tip <handle> <usdc> "consolidating"` against your own MetaMask handle, or you can use any wallet UI that imports OWS sessions.
- Operator-assisted `relink()` is the third option. It only affects future tips — already-pushed USDC stays at the OWS address.

**What's NOT recommended**

- Do not paste OWS API tokens into MetaMask. OWS keys are designed to live in a policy-enforcing vault; bypassing that loses the spend policies, expiry, and rotation guarantees.
- Do not assume a `relink()` will recover already-pushed funds. It changes the on-chain `linkedWallet` mapping for future tips only; already-settled funds and pending first-claim rights cannot be retroactively rerouted.

**For the agent**: when this error fires, the CLI prints both options and the `--recipient <linked-wallet>` retry hint inline. The web `/claim` UI shows the linked wallet (full address) and links back here.

### Relayer is down or disabled

The UI should say so instead of pretending gasless claim is live. The recipient should wait for relayer recovery or follow maintainer-provided manual transaction guidance.

### Claim shows no funds

Possible causes:

- the boon was sent to a different provider prefix (`github:` vs `x:`)
- the sender used a typo or different username
- the subgraph has not indexed the latest block yet (see [Data looks stale](#data-looks-stale))
- the handle was already linked and the boon pushed directly to that linked wallet

For the normal recipient path, see [Claim a boon](/guides/claim-a-boon/). If the hosted claim flow differs from that guide, stop and ask the sender or operator rather than retrying.

## Agent / CLI failures

### `boon doctor` fails

Run:

```bash
boon wallet current
boon doctor --json
```

Common fixes are selecting an OWS wallet, funding the OWS address with Base USDC and gas headroom, setting a reachable RPC URL, or lowering the requested tip below the local guardrails.

### OWS policy rejects the send

Treat this as a stop condition. The operator should either approve a new explicit policy/plan id or reduce the tip to fit the existing policy. Do not bypass OWS policy checks or use raw private keys.

### `--yes` fails without an approval id

This is expected. Agent sends require:

```bash
boon tip --yes --approval-id <human-approved-policy-or-plan-id> <handle> <amount> "<note>"
```

### Cooldown or cap rejects the tip

Boon keeps local spend and cooldown guardrails under `~/.boon/`. If a tip exceeds the configured cap or cooldown, return a proposal marked `needs_check` instead of sending.

### CLI claim code expires

Run the claim again:

```bash
boon claim x:alice
```

Device codes are intentionally short-lived. No funds move until the phone-side
approval and relayer claim complete.

### CLI claim says provider or handle mismatch

The phone sign-in must prove the exact canonical handle printed by the CLI. A
claim started for `x:alice` cannot be completed with GitHub or with a different
X account. Start a fresh claim and sign in as the displayed handle.

### `boon claim status` cannot settle

This is expected. Status reads the public user code stored in
`~/.boon/device-session.json`; it does not store the secret device code or claim
session token. Only the original `boon claim <handle>` process can receive the
one-time token and submit `/claim/complete`.

## API and x402 issues

### Free endpoint works but paid endpoint fails

Detailed graph reads use x402. Confirm the client understands the `402 Payment Required` response, can pay on Base, and retries with the payment proof. Claiming and recipient help must not require x402.

### Data looks stale

The app and API depend on subgraph indexing. Compare the latest transaction
block to the indexed subgraph block before assuming contract state is wrong.
The [Data layer concept](/concepts/data-layer/) explains the entity model
and the `_meta { block { number } }` check for diagnosing index lag.

## Safety stop conditions

Stop instead of retrying when:

- a user provides a private key in chat
- the chain is not Base mainnet
- the asset is not Base USDC
- the contract address differs from the documented Boon deployment
- the recipient identity is ambiguous
- an agent wants to send without explicit approval or policy coverage
