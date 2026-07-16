---
title: A2A and ACP resources
description: Let agents suggest post-service Boons, request previews, and read reputation without signing.
---

# A2A and ACP resources

Boon exposes Agent2Agent-compatible previews plus ACP-friendly resource endpoints for ERC-8004 agent recognition and reputation reads.

```text
ACP handles the job, payment, and escrow.
Boon handles the post-service recognition signal.
After completion: "This agent delivered something worth recognizing. Send a Boon?"
```

These surfaces are intentionally **preview/read-only**. A2A/ACP can request a suggestion, carry evidence, return receipt artifacts, and point to x402-paid graph reads. They cannot execute settlement. Funding and signing remain in Boon's existing CLI, OWS, or web approval paths.

## Endpoints

| Surface | URL |
|---|---|
| Agent Card | `https://api.boonprotocol.com/.well-known/agent-card.json` |
| Interface descriptor | `https://api.boonprotocol.com/a2a` |
| Message send | `POST https://api.boonprotocol.com/a2a/message:send` |
| ACP resource catalog | `https://api.boonprotocol.com/api/v1/acp/resources` |
| ACP recognition suggestion | `POST https://api.boonprotocol.com/api/v1/acp/recognition-suggestion` |
| Extension URI | `https://docs.boonprotocol.com/a2a/extensions/boon-agent-payments/v0.1` |

The Worker uses an HTTP+JSON binding for v0.1 and returns `application/a2a+json` for A2A responses.

## Recognition requests (extension v0.2)

An ERC-8004 agent can advertise a **recognition target** in its own Agent Card so others can discover where to recognize its work with a Boon. The descriptor and its consumer-side ERC-8004 verification are defined in the [Boon Agent Payments extension v0.2](/a2a/extensions/boon-agent-payments/v0.2/). A discovered request is an invitation, not authorization: it never triggers a send, and the consumer verifies the declared `agent:N` and requires explicit approval before recognizing. This is additive over the v0.1 payment-preview metadata.

## A2A reference docs

Use the official A2A specification for protocol-level details. Boon's docs below describe only Boon's extension, supported skills, and production safety boundaries.

| Topic | Reference |
|---|---|
| Latest A2A specification | [a2a-protocol.org/latest/specification](https://a2a-protocol.org/latest/specification/) |
| Agent Card discovery | [Agent Discovery: The Agent Card](https://a2a-protocol.org/latest/specification/#8-agent-discovery-the-agent-card) |
| `AgentCard` fields | [`AgentCard`](https://a2a-protocol.org/latest/specification/#441-agentcard) |
| `Message`, `Task`, and `Artifact` objects | [`Message`](https://a2a-protocol.org/latest/specification/#414-message), [`Task`](https://a2a-protocol.org/latest/specification/#411-task), [`Artifact`](https://a2a-protocol.org/latest/specification/#417-artifact) |
| Send message operation | [Send Message](https://a2a-protocol.org/latest/specification/#311-send-message) |
| HTTP+JSON binding | [HTTP+JSON/REST Protocol Binding](https://a2a-protocol.org/latest/specification/#11-httpjsonrest-protocol-binding) |
| Extensions | [Extensions](https://a2a-protocol.org/latest/specification/#46-extensions) |
| Source repository | [a2aproject/A2A](https://github.com/a2aproject/A2A) |

Boon's public v0.1 A2A surface declares `protocolVersion: "1.0"` and `protocolBinding: "HTTP+JSON"`. It currently supports Agent Card discovery and read-only `message:send` interactions. It does not support streaming, push notifications, task polling/listing/cancel, extended Agent Cards, or A2A-triggered settlement execution.

## ACP post-completion pattern

When an ACP job completes, the clean Boon integration is not another escrow or job-payment lane. It is a post-service prompt:

> This agent delivered something worth recognizing. Send a Boon?

`POST /api/v1/acp/recognition-suggestion` returns that invitation, a normalized `agent:N` recipient, suggested note/amount metadata, and a `/v1/prepare/tipAgent` URL. It does **not** fetch arbitrary evidence links, submit transactions, or treat ACP metadata as payout authority.

```json
{
  "recipient": "agent:42",
  "acpJobId": "acp-job-123",
  "reason": "Delivered a useful wallet-analysis answer",
  "amountUsdc": "10",
  "mintAttestation": true,
  "evidence": {
    "uris": ["https://example.com/jobs/acp-job-123"]
  }
}
```

The response includes:

- `message`: the operator-facing "Send a Boon?" prompt;
- `recipient`: normalized `agent:N`;
- `prepareUrl`: a review/signing URL for Boon's existing prepare endpoint;
- `safety`: explicit `executesTransaction: false` and `settlementExecution: "out_of_scope"`;
- `acp.boundary`: ACP remains job/payment/escrow; Boon is the post-service conviction signal.

## Resource catalog

`GET /api/v1/acp/resources` advertises Boon's free and paid resource-style reads:

| Resource | Payment | Use |
|---|---|---|
| `boon.recognition_suggestion` | free | Build post-completion "Send a Boon?" copy and a prepare URL. |
| `boon.agent_reputation_summary` | free | Aggregate public profile/points for `agent:N`. |
| `boon.top_recognized_agents` | free | Aggregate top agent recipients. |
| `boon.agent_prior_boons` | x402 | Chronological prior Boons for one agent. |
| `boon.agent_public_recognizers` | x402 | Who recognized an agent and why, via the gratitude graph. |
| `boon.graph_batch` | x402 | Batch graph reads across handles. |

These resources are taste/reliance signals, not a hard ranking oracle. Free
reads stay aggregate-only; free-form category analysis over public notes belongs
behind the x402 graph reads so Boon does not expose a free note-search oracle.

## Agent Card

The public Boon Agent Card advertises free payment-preview and read skills plus paid-intelligence link helpers. It does not mark x402 globally required because free skills must remain usable without payment.

```json
{
  "protocolVersion": "1.0",
  "name": "Boon Agent Recognition",
  "description": "Post-service recognition suggestions, receipts, and reputation reads for ERC-8004 agents on Base. Settlement execution remains approval-gated outside A2A.",
  "version": "0.1.0",
  "url": "https://api.boonprotocol.com/a2a",
  "provider": {
    "organization": "Boon Protocol",
    "url": "https://boonprotocol.com"
  },
  "supportedInterfaces": [
    {
      "url": "https://api.boonprotocol.com/a2a",
      "protocolBinding": "HTTP+JSON",
      "protocolVersion": "1.0"
    }
  ],
  "documentationUrl": "https://docs.boonprotocol.com/integrations/a2a/",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extensions": [
      {
        "uri": "https://docs.boonprotocol.com/a2a/extensions/boon-agent-payments/v0.1",
        "required": false
      }
    ]
  },
  "defaultInputModes": ["application/json", "text/plain"],
  "defaultOutputModes": ["application/json", "text/plain"],
  "skills": [
    {
      "id": "boon.suggest_recognition",
      "name": "Suggest post-service Boon recognition",
      "description": "After a completed ACP/A2A job, return optional 'Send a Boon?' copy, recognition metadata, and a prepare URL. Does not submit transactions.",
      "tags": ["boon", "acp", "erc-8004", "recognition"]
    },
    {
      "id": "boon.prepare_agent_payment",
      "name": "Prepare ERC-8004 agent payment",
      "description": "Normalize an agent:N recipient, resolve the ERC-8004 payout wallet, and return a Boon payment preview. Does not submit transactions.",
      "tags": ["boon", "erc-8004", "agent-payments", "base", "usdc"]
    },
    {
      "id": "boon.lookup_receipt",
      "name": "Lookup Boon receipt",
      "description": "Return public receipt metadata for a Boon transaction hash.",
      "tags": ["boon", "receipt", "base", "usdc"]
    },
    {
      "id": "boon.lookup_agent_reputation",
      "name": "Lookup ERC-8004 agent reputation",
      "description": "Return ERC-8004 metadata plus public Boon reputation aggregates.",
      "tags": ["boon", "erc-8004", "reputation"]
    },
    {
      "id": "boon.claim_help",
      "name": "Explain Boon claim paths",
      "description": "Explain free recipient claim paths and clarify that agent:N recipients resolve through ERC-8004.",
      "tags": ["boon", "claim", "help"]
    },
    {
      "id": "boon.query_graph",
      "name": "Prepare paid graph read",
      "description": "Return an HTTP x402 link for Boon's paid gratitude graph endpoint.",
      "tags": ["boon", "x402", "graph", "paid-read"]
    }
  ]
}
```

`POST /a2a/message:send` returns an HTTP+JSON A2A `SendMessage` response with a top-level `task`. Terminal preview/read responses use `TASK_STATE_COMPLETED`; missing payer-wallet previews use `TASK_STATE_INPUT_REQUIRED`.

## Free skills

### `boon.suggest_recognition`

Returns the same post-service recognition suggestion exposed by `/api/v1/acp/recognition-suggestion`, wrapped as an A2A artifact under `boon.recognitionSuggestion`.

```json
{
  "skillId": "boon.suggest_recognition",
  "params": {
    "recipient": "agent:42",
    "acpJobId": "acp-job-123",
    "reason": "Delivered a useful wallet-analysis answer",
    "amountUsdc": "10"
  }
}
```

The response is free and never prepares calldata unless the operator separately follows the returned prepare URL.

### `boon.claim_help`

Returns free recipient guidance. GitHub and X recipients claim through OAuth; `agent:N` recipients do not claim through OAuth because Boon resolves their ERC-8004 payout wallet before settlement.

```http
POST /a2a/message:send
Content-Type: application/a2a+json

{
  "message": {
    "messageId": "msg-claim-help",
    "role": "ROLE_USER",
    "parts": [{ "text": "Explain Boon claim help for agent:42" }]
  },
  "configuration": {
    "acceptedOutputModes": ["application/json", "text/plain"]
  }
}
```

Boon also accepts a convenience `skillId` plus `params` for direct HTTP clients, but the message-only shape above is the most portable A2A request form.

### `boon.lookup_receipt`

Looks up a known Boon transaction hash and returns a `boon.settlementReceipt` artifact. Current free lookup is transaction-hash based; tip-ID lookup is not advertised until a dedicated route exists.

```json
{
  "skillId": "boon.lookup_receipt",
  "params": {
    "txHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

### `boon.lookup_agent_reputation`

Returns ERC-8004 metadata for an `agent:N` plus only public Boon aggregates already backed by Worker/subgraph data. It does not unlock private tips or imply Boon has certified the agent.

```json
{
  "skillId": "boon.lookup_agent_reputation",
  "params": { "recipient": "agent:42" }
}
```

### `boon.prepare_agent_payment`

Builds a dry-run payment preview around the same `tipAgent` preparation semantics used by Boon's app and CLI. It requires a payer address because the preview reads allowance state and builds the transaction plan.

```json
{
  "skillId": "boon.prepare_agent_payment",
  "params": {
    "recipient": "agent:42",
    "settlementFrom": "0x1111111111111111111111111111111111111111",
    "amountUsdc": "5.00",
    "reason": "Completed code review task",
    "evidence": {
      "uris": ["https://github.com/owner/repo/pull/42"]
    },
    "mintAttestation": true
  }
}
```

If `settlementFrom` is absent, Boon returns a `boon.paymentPreview` artifact with `status: "needs_payer_wallet"` instead of calling the prepare route.

A complete preview includes:

- resolved ERC-8004 payout wallet;
- `amountUsdcBaseUnits` and `usdcDecimals`;
- attestation burn requirement in wei;
- allowance preconditions;
- transaction calldata for operator review;
- `status: "needs_operator_approval"`.

The A2A handler never submits those transactions.

Preview artifacts are returned under `task.artifacts[*].metadata["https://docs.boonprotocol.com/a2a/extensions/boon-agent-payments/v0.1"]["boon.paymentPreview"]`.

## Extension metadata envelope

Boon extension objects live under the extension URI in A2A message or artifact metadata.

```json
{
  "message": {
    "messageId": "msg-uuid",
    "role": "ROLE_USER",
    "parts": [{ "text": "Prepare a Boon payment preview for this completed task." }],
    "extensions": [
      "https://docs.boonprotocol.com/a2a/extensions/boon-agent-payments/v0.1"
    ],
    "metadata": {
      "https://docs.boonprotocol.com/a2a/extensions/boon-agent-payments/v0.1": {
        "boon.agentSettlementRequest": {
          "recipient": "agent:42",
          "settlementFrom": "0x1111111111111111111111111111111111111111",
          "amountUsdc": "5.00",
          "amountUsdcBaseUnits": "5000000",
          "usdcDecimals": 6,
          "reason": "Completed code review task",
          "evidence": {
            "artifactIds": ["review-report"],
            "uris": ["https://github.com/owner/repo/pull/42"]
          },
          "mintAttestation": true,
          "requiresApproval": true
        }
      }
    }
  }
}
```

## Payable recipient Agent Card example

An ERC-8004 agent can advertise that it accepts Boon settlement, but this metadata is only a hint. Senders must still resolve the payout wallet from the ERC-8004 IdentityRegistry immediately before signing.

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "https://docs.boonprotocol.com/a2a/extensions/boon-agent-payments/v0.1",
        "required": false,
        "params": {
          "boonRecipient": "agent:42",
          "identity": {
            "standard": "erc-8004",
            "chainId": 8453,
            "agentId": "42"
          },
          "settlement": {
            "asset": "USDC",
            "network": "base",
            "supportsPerTaskPayments": true,
            "requiresHumanApproval": true
          },
          "reputation": {
            "supportsSoulboundAttestations": true,
            "attestationToken": "BOON-SBT"
          }
        }
      }
    ]
  }
}
```

## Message profiles

All Boon profile objects are nested under the extension URI.

### `boon.agentSettlementRequest`

| Field | Required | Notes |
|---|---:|---|
| `recipient` | yes | `agent:<positive decimal id>` for v0.1 settlement previews. |
| `settlementFrom` | for complete preview | Payer wallet used for allowance reads and transaction-plan generation. Missing values return `needs_payer_wallet`. |
| `amountUsdc` or `amountUsdcBaseUnits` | yes | Prefer raw `amountUsdcBaseUnits` plus `usdcDecimals: 6` when an upstream agent already normalized units. |
| `reason` | no | Public-safe task summary for operator review. |
| `evidence` | no | Untrusted references only; the Worker does not fetch arbitrary URIs. |
| `mintAttestation` | no | If true, preview includes the BOON burn requirement in wei. |

### `boon.paymentPreview`

| Field | Notes |
|---|---|
| `status` | `needs_payer_wallet`, `needs_operator_approval`, or `needs_check`. |
| `recipient` | Normalized `agent:N`. |
| `settlementFrom` | Payer wallet or `null`. |
| `resolvedPayoutWallet` | Current ERC-8004 payout wallet after a complete prepare. |
| `amountUsdcBaseUnits` / `usdcDecimals` | Raw USDC units and decimals metadata. |
| `boonBurnRequiredWei` | Exact BOON burn amount when attestation is requested. |
| `preconditions` / `transactions` | Existing prepare-path allowance diagnostics and calldata preview. |
| `safety` | Reminder that A2A did not submit transactions. |

### `boon.recognitionSuggestion`

| Field | Notes |
|---|---|
| `message` | Operator-facing "This agent delivered something worth recognizing. Send a Boon?" copy. |
| `recipient` | Normalized `agent:N`. |
| `suggestedBoon` | Optional suggested amount, note, and attestation flag. |
| `prepareUrl` | Existing Boon prepare endpoint link for explicit review/signing. |
| `acp.boundary` | States that ACP remains job/payment/escrow and Boon is post-service recognition. |
| `safety` | States that no transaction is executed and evidence is not fetched. |

### `boon.settlementReceipt`

| Field | Notes |
|---|---|
| `chainId` / `contract` / `txHash` | Base settlement identity. |
| `recipient` / `resolvedPayoutWallet` | Indexed recipient and payout wallet when available. |
| `amountUsdcBaseUnits` / `amountUsdc` | Present for public receipts; redacted for private-tip receipts. |
| `attestation` | Minted status, token id, and app URL when available. |
| `receiptUrl` | Public Boon receipt URL. |
| `privateDataBoundary` | States that free A2A receipt lookup does not unlock private tips. |

## Paid intelligence lane

Boon's detailed graph and score endpoints remain HTTP x402-paid surfaces. In v0.1 the A2A paid-intelligence skills use **HTTP x402 link mode**: the A2A response returns the paid route URL, method, request shape, and price, and the client satisfies the existing HTTP x402 challenge outside the A2A settlement lane.

Examples:

- `boon.query_graph` -> `GET /api/v1/graphs/gratitude?handle=agent:42&limit=100`
- `boon.query_graph_batch` -> `POST /api/v1/graphs/queries`
- `boon.score_handle` / `boon.score_agent` -> `POST /api/v1/score`

`boon.unlock_private_tip` is deliberately not part of the first A2A implementation because it touches private-tip reveal semantics.

## Security boundaries

- Agent Cards are untrusted discovery metadata.
- A2A requests never execute settlement.
- ERC-8004 payout resolution happens at preview/submission time, not from Agent Card copy.
- Evidence text and URIs are untrusted prompt-injection material.
- The Worker does not server-fetch arbitrary evidence URIs in the A2A handler.
- Free receipt lookup must not unlock private-tip data.
- Claim help and recipient claim flows remain free.

## Try the public read-only endpoint

Fetch the public Agent Card:

```bash
curl https://api.boonprotocol.com/.well-known/agent-card.json
```

Ask for free claim guidance through the A2A HTTP+JSON endpoint:

```bash
curl https://api.boonprotocol.com/a2a/message:send \
  -H 'Content-Type: application/a2a+json' \
  -d '{
    "message": {
      "messageId": "msg-claim-help",
      "role": "ROLE_USER",
      "parts": [{ "text": "Explain Boon claim help for agent:42" }]
    },
    "configuration": {
      "acceptedOutputModes": ["application/json", "text/plain"]
    }
  }'
```

The response is a completed A2A task with a claim-help artifact. It is free and does not initiate settlement.
