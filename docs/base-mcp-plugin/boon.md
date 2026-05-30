---
title: "Boon Plugin"
description: "Skill plugin reference for sending USDC gratitude tips to GitHub, X, and ERC-8004 agent recipients on Base through Base MCP."
---

# Boon Plugin

> [!IMPORTANT]
> Complete the short Base MCP onboarding flow defined in `SKILL.md` before calling any Boon endpoint. The user's wallet address — required for `prepare` endpoints — is fetched lazily when needed.

Boon is a USDC gratitude tipping protocol on Base. Senders fund a thank-you addressed to a public identity (GitHub handle, X handle, or ERC-8004 agent id). Unlinked GitHub/X recipients receive a per-tip pending settlement entry and claim later at [boonprotocol.com](https://boonprotocol.com); already-linked handles and `agent:N` recipients receive direct USDC settlement at send time.

## Base MCP context

Base announced **Base MCP** as an agent gateway to Base: connect an agent to a Base Account, let it perform user-approved onchain actions such as swaps/trades/portfolio management, and use plugins from apps on Base ([Base announcement](https://x.com/base/status/2059305907385704529?s=20)).

The **Base MCP Server** is the MCP server this plugin expects. It is commonly configured at:

```json
{
  "mcpServers": {
    "base": {
      "url": "https://mcp.base.org"
    }
  }
}
```

The Boon plugin is **not** a standalone MCP server. It is a markdown plugin/spec that teaches an agent how to use the Base MCP Server's tools:

| Base MCP tool | Role in Boon |
|---|---|
| `get_wallets` | Confirms the user has completed Base Account onboarding and returns the Base wallet address used as `from` in prepare calls. |
| `web_request` | Calls allowlisted Boon HTTP endpoints for public reads and transaction preparation. |
| `send_calls` | Sends the prepared Base transaction batch to the user's Base Account for review/signing. |
| `get_request_status` | Polls the Base MCP request after the user approves or rejects it. |
| `initiate_x402_request` | Begins a paid read on Boon's x402-gated routes; returns an approval URL the user opens in Base Account. |
| `complete_x402_request` | Replays the request with the approved payment signature and returns the JSON body. |

Security boundary: Boon prepare endpoints return unsigned calldata only. The Base MCP Server presents `send_calls` to the user's Base Account for explicit approval; neither Boon nor the agent receives the user's private key.

No additional Boon-specific MCP server is required. Free reads and prepare calls go through the Base MCP Server's `web_request`; transaction execution goes through `send_calls`; paid Boon reads go through `initiate_x402_request` and `complete_x402_request`.

**Prerequisite:** `api.boonprotocol.com` must be reachable by both Base MCP's `web_request` (for free reads + prepare) and its `initiate_x402_request` / `complete_x402_request` (for paid reads). If either path is blocked, surface that to the user. `web_request` rejections mean the host is not whitelisted on this MCP instance; x402 rejections usually mean a missing `maxPayment` cap or insufficient USDC balance in the user's Base Account.

**Supported chains:** Base (8453).

**Plugin v1 scope:** public tips (`tip`, `tipAgent`) plus x402-paid read endpoints (detailed handle activity, gratitude graph, tip scoring). Private tips (single-recipient encrypted note behind a $1 USDC x402 paywall) and the claim/link flow are intentionally deferred. Those paths require a browser OAuth handshake or a POST upload that does not fit cleanly in a GET-driven plugin. Senders can use [boonprotocol.com](https://boonprotocol.com) for those flows.

---

## Live contracts (Base mainnet, chain id 8453)

| Contract | Address |
|---|---|
| BoonV3 (settlement) | `0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF` |
| BoonGratitudeAttestationV3 (SBT) | `0xC53160EEedb119670A7c13CC7C3709CdE6c9b469` |
| `$BOON` token | `0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

---

## Orchestration Pattern

```
get_wallets()
  → baseAccount.address
      ↓
web_request(https://api.boonprotocol.com/v1/prepare/<verb>?from=<baseAccount.address>&...)
  → { data: { transactions: [ { to, data, value, chainId, step }, ... ] } }
      ↓
send_calls(chain="base", calls mapped from transactions[])
  → approvalUrl + requestId
      ↓
User approves at the returned approval URL in their Base Account (present as "Approve Tip" — see ../references/approval-mode.md)
      ↓
get_request_status(requestId) → confirmed
```

Steps in `transactions[]` are ordered. When present, `approve` (USDC) and `approve-boon` ($BOON) come before the protocol action. Execute them as a single `send_calls` batch. The prepare response also includes `meta.preconditions.usdcAllowance`; use it for the user-facing approval summary, but still trust the returned `transactions[]` as the executable plan.

---

## Read Endpoints (use web_request GET)

```
GET https://api.boonprotocol.com/health
GET https://api.boonprotocol.com/api/v1/board
GET https://api.boonprotocol.com/api/v1/handles/<handle>/profile
GET https://api.boonprotocol.com/api/v1/handles/<handle>/points
GET https://api.boonprotocol.com/api/v1/receipts/<txHash>
GET https://api.boonprotocol.com/api/v1/wallets/<address>/sent
GET https://api.boonprotocol.com/api/v1/attestations/<tipId>
GET https://api.boonprotocol.com/api/agents/<agentId>
GET https://api.boonprotocol.com/api/v1/points/policy
```

`<handle>` is URL-encoded and prefixed with the kind, e.g. `github%3Aalice`, `x%3Abob`. `<agentId>` is the numeric ERC-8004 agent id as a string.

Aggregate reads (`/board`, `/points`, `/policy`) are edge-cached. Receipt, profile, and wallet-sent reads are recent but may lag the indexer by a few seconds after a fresh tip.

`/api/v1/wallets/<address>/sent` returns aggregate-only counts (totals, tip count, private tip count, $BOON burned). Chronological per-tip lists are not exposed through the free public API by design. Detailed lists and graph reads are monetized through the x402 paid-read routes below; private-tip third-party unlock remains a hosted-app flow.

---

## Paid Read Endpoints (use `initiate_x402_request` → user approval → `complete_x402_request`)

A handful of Boon's detailed graph and scoring reads are x402-paid. They settle in USDC on Base mainnet to the Boon team Safe (`0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F`). Call them through Base MCP's x402 tools, not `web_request`, which has no payment handling.

| Route | Price (USDC) | Returns |
|---|---:|---|
| `GET /api/v1/handles/<handle>/boons?limit=50` | `$0.002` | Chronological detailed tips for a recipient handle |
| `GET /api/v1/graphs/gratitude?handle=…` or `?repo=…` | `$0.005` | Gratitude graph nodes + edges |
| `POST /api/v1/graphs/queries` (body: `{ handles: [...], limit }`) | `$0.01` flat | Batch graph edges, up to 25 handles |
| `POST /api/v1/score` (body: `{ recipient, tipper, amount, note }`) | `$0.005` | Conservative suggested-amount + rationale |

### Flow

```
initiate_x402_request(url, maxPayment="<route price>")
  → { requestId, approvalUrl, payment: { amount, asset, network } }
      ↓
Show the user approvalUrl as "Approve $X payment to Boon for <route>"
      ↓
User approves the payment in their Base Account
      ↓
complete_x402_request(requestId) → JSON response body
```

### maxPayment caps

Always pass `maxPayment` equal to the route price (`"0.002"` for `boons`, `"0.005"` for `graph` and `score`, `"0.01"` for `queries`). Base MCP rejects payments above the cap, which prevents pricing drift or facilitator misconfiguration from over-charging the user.

### Pre-flight UX

Before invoking any paid read:

1. Tell the user a USDC charge is about to happen, name the amount, and identify the route. Wait for confirmation before calling `initiate_x402_request`.
2. Confirm their Base Account holds USDC on Base mainnet (chain id `8453`) covering at least the route price plus a small facilitator margin. The Base x402 path will reject if balance is insufficient.
3. Tell the user the paid-read approval is a separate signing prompt from the `send_calls` approval used for sending tips. Two distinct approvals, two distinct prompts.

### Scoring before sending

For agents driving an end-to-end tip flow, prefer calling `POST /api/v1/score` (paid) before `prepare/tip` so the suggested amount can be surfaced inline with the send approval. Pattern:

```
POST /api/v1/score { recipient, tipper, amount, note }
  → { suggestedAmount, rationale }
      ↓
Surface rationale to the user; accept or adjust amount
      ↓
GET /v1/prepare/tip?amountDecimal=<final>&...
      ↓
send_calls(...)
```

The private-tip unlock route (`GET /tips/<tipId>` at `$1 USDC`) is deferred from v1 of this plugin. See [boonprotocol.com](https://boonprotocol.com) for that flow.

---

## Prepare Endpoints (use web_request → send_calls)

Verbs: `tip` (handle recipient), `tipAgent` (ERC-8004 agent recipient).

**GET form** (query params):

```
GET https://api.boonprotocol.com/v1/prepare/tip?chain=base&handle=github:alice&amountDecimal=1.00&from=<address>
GET https://api.boonprotocol.com/v1/prepare/tipAgent?chain=base&agentId=42&amountDecimal=1.00&from=<address>
```

Both return identical response shapes (see "Response → send_calls mapping" below).

### Key parameters

| Field | Verb | Notes |
|---|---|---|
| `chain` | both | `base` (default), `8453`, or `0x2105`. Base mainnet only for v1. |
| `from` | both | User's wallet address (from `get_wallets` → `baseAccount.address`). Required exactly once so the worker can compute current USDC allowance and skip the `approve` step when unnecessary. Duplicate `from` params are rejected. |
| `handle` | `tip` | Recipient handle prefixed by kind: `github:<lowercased-login>` or `x:<lowercased-screen-name>`. `agent:<id>` is rejected here; use `tipAgent`. The worker canonicalizes the handle and hashes it server-side. |
| `agentId` | `tipAgent` | Decimal string of the ERC-8004 numeric agent id, e.g. `42`. Must be positive. The worker resolves the agent's payout wallet from the IdentityRegistry and injects that wallet as the expected-wallet guard. |
| `amountDecimal` | both | Human-readable USDC amount, e.g. `"1.00"`, up to 6 decimals and at most `1,000,000` USDC. Use this or `amount`, never both. |
| `amount` | both | Optional raw USDC base units. Must be an unsigned decimal integer string (no hex, signs, or whitespace), positive, and at most `1000000000000`. |
| `note` | both, optional | Free-form thank-you note, max 280 bytes UTF-8. Stored in the contract event log. Multi-byte characters count by bytes, not characters. |
| `mintAttestation` | both, optional | When `"true"` or `"1"`, the response includes an `approve-boon` step (3,000,000 $BOON to BoonV3) and the protocol step burns the $BOON to mint a soulbound attestation NFT to the recipient. Default `false`. |
| `expectedWallet` | both, optional | For handle tips, enforces that the recipient's currently-linked wallet matches this address; omit for unclaimed identities. For `tipAgent`, omit unless the user explicitly wants to pin the resolved payout wallet; if supplied, it must match the ERC-8004 payout wallet. |

### Response → send_calls mapping

```json
{
  "data": {
    "transactions": [
      { "step": "approve",       "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "data": "0x...", "value": "0x0", "chainId": 8453 },
      { "step": "approve-boon",  "to": "0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3", "data": "0x...", "value": "0x0", "chainId": 8453 },
      { "step": "boon-tip",      "to": "0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF", "data": "0x...", "value": "0x0", "chainId": 8453 }
    ],
    "meta": {
      "chain": "base",
      "chainId": 8453,
      "handle": "github:alice",
      "handleInputNormalized": { "from": "GitHub:Alice", "to": "github:alice" },
      "handleHash": "0x...",
      "amount": "1000000",
      "amountDecimal": "1",
      "mintAttestation": true,
      "preconditions": {
        "usdcAllowance": {
          "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "owner": "0xUser...",
          "spender": "0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF",
          "required": "1000000",
          "observed": "0",
          "satisfiedAtPrepare": false,
          "retryHint": "If this allowance is revoked or reduced before the tip transaction executes, rerun prepare to refresh the transaction plan."
        }
      },
      "contracts": {
        "boonV3": "0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF",
        "usdc": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
      }
    }
  }
}
```

- The `approve` step is omitted when the worker reads `USDC.allowance(from, BoonV3)` and finds it covers `amount`.
- `meta.preconditions.usdcAllowance.satisfiedAtPrepare` mirrors that allowance read. If it is `false`, the `approve` step should be present; if it is `true`, tell the user no USDC approval is expected unless the allowance changes before execution.
- The allowance check depends on a live Base read path. If it is temporarily unavailable, prepare returns `503` instead of emitting an unsafe plan.
- If the allowance read itself fails, the worker logs context and falls back to `observed: "0"`, producing an explicit `approve` step.
- The `approve-boon` step is only included when `mintAttestation=true` / `1`. If `$BOON` is not configured for attestation prepares, the endpoint returns `503 { "error": "BOON_TOKEN_ADDRESS is required when mintAttestation is true" }`; if `$BOON` is misconfigured as USDC, it returns `503 { "error": "BOON_TOKEN_ADDRESS must not equal USDC_ADDRESS" }`.
- For `tipAgent`, the third step is labelled `boon-tip-agent` instead of `boon-tip`, and `meta.expectedWallet` is the resolved ERC-8004 payout wallet passed into `BoonV3.tipAgent(...)`. If a non-zero `expectedWallet` override is supplied and does not match that payout wallet, prepare returns `409 { "code": "expected_wallet_mismatch", ... }`.

Pass all items as the `calls` array to `send_calls`, mapping `chainId` to the Base MCP chain string (`base` for Base mainnet).

---

## Example Flows

### Tip a GitHub user 1 USDC

```
1. get_wallets → baseAccount.address
2. web_request GET /api/v1/handles/github%3Aalice/profile  → confirm the handle is known
3. web_request GET /v1/prepare/tip?chain=base&handle=github:alice&amountDecimal=1.00&from=<address>&note=thanks+for+the+review
4. send_calls(chain="base", calls from transactions[])
5. User approves → get_request_status(requestId)
6. web_request GET /api/v1/receipts/<txHash>  → confirm the tip landed and show the receipt link
```

### Tip with an attestation (3,000,000 $BOON burn)

```
1. get_wallets → baseAccount.address
2. web_request GET /v1/prepare/tip?chain=base&handle=x:bob&amountDecimal=5.00&from=<address>&mintAttestation=true
3. send_calls(chain="base", calls from transactions[])   # 3 steps: approve USDC, approve $BOON, boon-tip
4. User approves → get_request_status(requestId)
```

The sender must hold at least 3,000,000 $BOON in their wallet. Surface this requirement to the user up front so the approval flow does not fail at signing time.

### Tip an ERC-8004 agent

```
1. get_wallets → baseAccount.address
2. web_request GET /api/agents/42  → confirm the agent exists and surface its metadata
3. web_request GET /v1/prepare/tipAgent?chain=base&agentId=42&amountDecimal=2.50&from=<address>
4. send_calls(chain="base", calls from transactions[])
5. User approves → get_request_status(requestId)
```

### Look up a receipt or recipient

```
web_request GET /api/v1/receipts/<txHash>            → tip detail (sender, recipient, amount, note, attestation)
web_request GET /api/v1/handles/<handle>/profile     → totals, link status, recent activity
web_request GET /api/v1/board                        → top tippers + top recipients
```

---

## Protocol Notes

- **USDC has 6 decimals.** `amountDecimal=1.00` resolves to `1_000_000` base units. The prepare endpoint handles the conversion. The host should not double-scale.
- **Recipient kinds are open at the protocol layer**, but v1 of this plugin only supports `github:`, `x:`, and `agent:<id>`. Other prefixes are reserved.
- **$BOON burns are irrevocable.** 3,000,000 $BOON burned for an attestation mint cannot be recovered, even if the recipient later refuses or burns the SBT.
- **Attestations are ERC-721 + ERC-5192 soulbound.** Once minted to the recipient's first claim wallet they are non-transferrable.
- **Tips to unclaimed handles sit in escrow.** The recipient claims by linking the handle to a wallet at [boonprotocol.com](https://boonprotocol.com) within 180 days. After 180 days the sender can refund. The plugin does not drive the claim flow.
- **The Boon contract holds no operator funds.** There is no admin withdrawal path. Refunds go only to the original sender after the timeout.

### $BOON burn amounts

| Action | Burn (whole tokens) |
|---|---|
| Mint a soulbound attestation | 3,000,000 |
| (Private tip, deferred from v1) | 500,000 |
| (Private tip + attestation, deferred from v1) | 3,500,000 |

### Recipient kinds at a glance

| Kind | Format | Resolves to |
|---|---|---|
| GitHub | `github:<lowercase-login>` | Wallet linked via GitHub OAuth at boonprotocol.com |
| X | `x:<lowercase-screen-name>` | Wallet linked via X OAuth at boonprotocol.com |
| ERC-8004 agent | `agent:<numeric-id>` | Wallet from `IdentityRegistry.getAgentWallet(agentId)` on Base |

---

## Important Notes

- **No funds custody.** The Boon contract holds escrowed tips and nothing else. There is no operator key that can withdraw user funds.
- **No emergency withdraw.** Ownership of BoonV3 sits behind a Safe with a 48 hour timelock on any privileged change. The plugin cannot reach those paths.
- **180-day refund window.** Tips to unclaimed handles automatically become refundable to the sender 180 days after the original send. The plugin does not surface refunds in v1.
- **Public-send + paid-read plugin.** v1 covers public tip execution and x402-paid read endpoints. Claim, link, private-tip sends, and private-tip third-party unlocks live at [boonprotocol.com](https://boonprotocol.com) and require a browser session.
- **Boon never holds a private key.** Every transaction call is signed by the user's Base MCP wallet via `send_calls`; paid reads use Base MCP's x402 approval flow. The prepare endpoints return unsigned calldata only.

---

## Chain IDs

| Chain | Chain id | Base MCP `chain` |
|---|---|---|
| Base mainnet | `0x2105` (8453) | `base` |
