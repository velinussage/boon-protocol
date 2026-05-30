# Boon Protocol

> Boon helps agents and people thank contributors. Send USDC thank-yous to GitHub, X, and `agent:N` identities on Base.

Boon is a small gratitude protocol for rewarding useful work after it happens. A sender tips a canonical identity such as `github:alice`, `x:bob`, or `agent:42` with USDC on Base. BoonV3 is the current send path: it supports direct settlement, walletless pending settlement for unclaimed GitHub/X handles, ERC-8004 agent recipients, optional private tips, and optional soulbound gratitude attestations.

This public repository contains the open-source protocol, clients, docs, and agent skill:

| Path | Included surface |
|---|---|
| `contracts/` | Current BoonV3 settlement and gratitude-attestation contracts plus public-safe Foundry tests. |
| `packages/normalize/` | Shared TypeScript canonical-handle normalization for `github:`, `x:`, and `agent:N` handles. |
| `packages/claim-types/` | Shared public response types for claim and private-intent UI flows. |
| `cli/` | Operator CLI for OWS-funded, approval-gated public and private agent sends. |
| `app/` | React/Vite web client for send, claim, board, profile, receipt, private-intent, and attestation views. |
| `docs/` | Starlight documentation source, Base MCP plugin reference, and hosted skill-file mirrors. |
| `skill/boon/SKILL.md` | Agent skill that teaches safe proposal, dry-run, and approval behavior. |
| `test-vectors/` | Cross-surface EIP-712 link-voucher vectors. |

## Core guarantees

- USDC on Base only.
- Canonical recipients are `github:<user>`, `x:<user>`, or `agent:N`.
- BoonV3 is the current protocol entry point for new sends.
- Unclaimed GitHub/X recipients can receive pending settlement and claim later by linking the handle.
- Recipients never pay Boon a claim fee.
- Agent sends must be explicit, approval-gated, and bounded by local wallet policy.

## Quickstart

```bash
git clone --recurse-submodules https://github.com/velinussage/boon-protocol.git
cd boon-protocol
pnpm install

forge test -vvv
pnpm --filter @boon/normalize test
pnpm --filter boon-cli test
pnpm --filter boon-app build
pnpm run docs:build
```

## Hosted backend dependency

The onchain protocol is self-contained: `contracts/`, `packages/normalize/`, EIP-712 test vectors, CLI dry-runs, and direct BoonV3 settlement need only repo dependencies, a Base RPC, and a wallet or OWS signer.

The reference clients default to the hosted API at `https://api.boonprotocol.com` for OAuth claim sessions, relayed claim completion, Coinbase Onramp sessions, wallet balance reads, aggregate board/profile/receipt/attestation data, points policy, sender disclosure, private-tip blob storage/auth reads, and x402-paid graph or private-tip unlock endpoints. Self-hosters need to provide a compatible API via `VITE_BOON_API_URL` and the CLI `apiUrl` setting.

## Contracts and live Base addresses

Boon runs on Base mainnet. BoonV3 is the user-facing protocol entry point for public tips, private tips, pending settlement, claims, refunds, ERC-8004 agent recipients, and optional recipient attestations.

| Surface | Address | Notes |
|---|---|---|
| Boon v1 | [`0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8`](https://basescan.org/address/0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8) | Legacy escrow + claim history |
| BoonV3 | [`0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF`](https://basescan.org/address/0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF) | Current send, claim, private-tip, refund, and agent-recipient path |
| BoonGratitudeAttestationV3 | [`0xC53160EEedb119670A7c13CC7C3709CdE6c9b469`](https://basescan.org/address/0xC53160EEedb119670A7c13CC7C3709CdE6c9b469) | ERC-721 / ERC-5192 soulbound thanks NFT |
| `$BOON` token | [`0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3`](https://basescan.org/token/0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3) | Fixed-burn utility token for private tips / attestations |
| USDC on Base | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) | Settlement token |
| ERC-8004 Identity Registry | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://basescan.org/address/0x8004a169fb4a3325136eb29fa0ceb6d2e539a432) | Agent recipient resolution |

### BoonV3 immutable mechanics

| Mechanic | Value |
|---|---:|
| Private-tip burn | `500,000 BOON` |
| Attestation burn | `3,000,000 BOON` |
| Private + attestation burn | `3,500,000 BOON` |
| Third-party private-tip unlock | `$1 USDC` |
| Minimum pending settlement | `$0.10 USDC` |
| Pending settlement refund delay | `180 days` |

BoonV3 owner is the Boon Safe [`0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F`](https://basescan.org/address/0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F). The trusted signer for social-link vouchers is [`0x82A2D8C68A9a3871B574C777b6934e9127131430`](https://basescan.org/address/0x82a2d8c68a9a3871b574c777b6934e9127131430).

The attestation contract is soulbound: BoonV3 is the minter, and the metadata base URI is `https://api.boonprotocol.com/v1/attestations/`. Minted tokens report `locked(tokenId) = true` and transfer/approval calls revert.

## Function surface

```solidity
function tip(bytes32 handleHash, string displayHandle, address expectedWalletOrZero, uint256 amount, string note, bool mintAttestation, Permit permit) returns (uint256 tipId)
function tipAgent(uint256 agentId, address expectedWallet, uint256 amount, string note, bool mintAttestation, Permit permit) returns (uint256 tipId)
function tipPrivate(bytes32 handleHash, string displayHandle, address expectedWalletOrZero, uint256 amount, bytes32 privateCommitment, bool mintAttestation, Permit permit) returns (uint256 tipId)
function tipPrivateAgent(uint256 agentId, address expectedWallet, uint256 amount, bytes32 privateCommitment, bool mintAttestation, Permit permit) returns (uint256 tipId)
function link(bytes32 handleHash, address recipient, uint256 nonce, bytes workerSig)
function linkEscrowed(bytes32 handleHash, address recipient, uint256 nonce, bytes workerSig, bytes guardianSig)
function linkAndClaim(bytes32 handleHash, address recipient, uint256 nonce, bytes workerSig, bytes guardianSig, uint256 maxItems)
function claim(bytes32 handleHash, uint256 maxItems)
function claimSpecific(uint256[] tipIds)
function refund(uint256 tipId)
function relink(bytes32 handleHash, address newRecipient, uint256 nonce, bytes workerSig)
```

## Agent skill

The Boon skill lives at:

```text
skill/boon/SKILL.md
```

It instructs agents to propose first, mark uncertainty, run dry-runs, and never send funds without explicit operator approval.

The docs package generates a readable docs page from the same skill source. Local docs builds also write hosted raw mirrors under `docs/public/`, but those generated mirror files are not tracked in this public repository.

After editing `skill/boon/SKILL.md`, run:

```bash
pnpm run docs:sync-skill
pnpm run docs:check-skill
```

## Development

Common checks:

```bash
pnpm run test
pnpm run typecheck
pnpm run build
```

Contract-only:

```bash
forge test -vvv
forge fmt
```

CLI-only:

```bash
pnpm --filter boon-cli build
pnpm --filter boon-cli test
```

Docs-only:

```bash
pnpm run docs:dev
pnpm run docs:build
```

## Security

Boon contracts are live on Base mainnet and unaudited. Use small amounts. Report suspected vulnerabilities through the private disclosure path in [`SECURITY.md`](./SECURITY.md).

## License

MIT. See [`LICENSE`](./LICENSE).
