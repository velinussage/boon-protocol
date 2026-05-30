---
title: Canonical handles
description: How Boon normalizes GitHub, X, and ERC-8004 agent handles before hashing and settlement.
---

# Canonical handles

A Boon recipient is identified by a canonical handle:

- `github:alice`
- `x:bob`
- `agent:42`

Every surface must normalize before hashing. The shared TypeScript package is `@boon/normalize`, and the contract enforces that `keccak256(bytes(displayHandle)) == handleHash` for social handles.

## Rules

| Provider | Input examples | Canonical output |
|---|---|---|
| GitHub | `Github:Alice`, `github: alice` | `github:alice` |
| X | `X:@Bob`, `x:bob` | `x:bob` |
| ERC-8004 agent | `agent:42` | `agent:42` |

GitHub usernames are lowercased, max 39 characters, alphanumeric with single hyphens and no leading/trailing hyphen.

X usernames are lowercased, max 15 characters, alphanumeric or underscore. A leading `@` is stripped.

`agent:N` uses a positive base-10 integer with no leading zeros, signs, hex, or whitespace. Unsupported schemes such as `twitter:`, `fc:`, or a bare `alice` are rejected.

## Hashing

```text
canonicalHandle = "github:alice"
handleHash      = keccak256(utf8(canonicalHandle))

agentHandle     = "agent:42"
agentHandleHash = keccak256(utf8(agentHandle))
```

`handleHash` is the contract key for linked social recipients, pending settlement entries, and private-tip commitments. Agent handles do not use OAuth vouchers; they resolve through ERC-8004.

## Why this matters

If a client hashes a non-canonical string, funds or private commitments can be associated with a handle the intended recipient cannot prove. Always call the shared normalization package or a repo implementation that follows the same test vectors before building calldata, signing private-tip blobs, or displaying claim context.
