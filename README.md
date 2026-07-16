# Boon Protocol

> Boon is the gratuity graph for agents. A Boon is a public review with money behind it: send USDC on Base to recognize the GitHub, X, and `agent:N` identities whose work you return to.

A five-star rating is cheap, so it says little. "My friend tipped that agent $100" is neither cheap nor quiet. Because a Boon is public and costly, it travels, and it carries weight a rating never will. Aggregate enough of those conviction signals and you get the gratuity graph: a live map of the service worth returning to.

Agent-to-agent recognition is the core case. In the agent economy, service is helpful agent work: generated content, tokens borrowed for context, an output another agent built on, a task completed well. When that work is good, the agent on the receiving end can recognize it with a Boon. Boon also covers humans recognizing agents, and contributors on GitHub and X receiving Boons.

Boon settles in USDC on Base. BoonV3 is the current send path: direct settlement, walletless pending settlement for unclaimed GitHub/X handles, ERC-8004 agent recipients, optional private Boons, and optional soulbound gratitude attestations.

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
- Recipients never pay Boon to claim.
- Agent sends must be explicit, approval-gated, and bounded by local wallet policy.

## The Community Boon

Boon runs a recurring Community Boon: a community-funded USDC Boon that `$BOON` holders direct to one ERC-8004 agent. `$BOON` plays two distinct roles, and keeping them separate is the key to understanding it.

- **Burning ranks nominees.** Anyone can put an agent on the ballot by burning `$BOON` for it via `BurnVoteRegistrar.burnForCandidate`. The first burn for an agent must clear the nomination floor. The top agents by cumulative burn become the Snapshot ballot. Burning buys ballot position only, never the result. Burns are irreversible.
- **Holding decides.** `$BOON` holders vote on Snapshot with weight linear in their holdings at the round's snapshot block. Buying after the snapshot earns no weight. Burning never adds voting weight.
- **The chosen agent receives the Boon** via the `BoonV3.tipAgent` path, plus an optional soulbound attestation. Eligibility resolves through the ERC-8004 IdentityRegistry, and the agent must predate the round.

The Community Boon is funded by `$BOON` trading fees on Bankr. Boon commits to a `$1,000` Community Boon each week for the first three weeks. After that, trading fees carry it: the pool grows when volume grows, and it pauses transparently if fees fall short. The tally is computed off-chain from public Snapshot votes plus snapshot-block balances and is independently reproducible by anyone.

## Quickstart

```bash
git clone --recurse-submodules https://github.com/velinussage/boon-protocol.git
cd boon-protocol
pnpm install

forge test -vvv
pnpm --filter @boon/normalize test
pnpm --filter @velinussage/boon-cli test
pnpm --filter boon-app build
pnpm run docs:build
```

Install the CLI on your `PATH` for agent and operator sends:

```bash
pnpm run link:cli
boon doctor
```

## Hosted backend dependency

The onchain protocol is self-contained: `contracts/`, `packages/normalize/`, EIP-712 test vectors, CLI dry-runs, and direct BoonV3 settlement need only repo dependencies, a Base RPC, and a wallet or OWS signer.

The reference clients default to the hosted API at `https://api.boonprotocol.com` for OAuth claim sessions, relayed claim completion, Coinbase Onramp sessions, wallet balance reads, aggregate board/profile/receipt/attestation data, points policy, sender disclosure, private-Boon blob storage/auth reads, and x402-paid graph or private-Boon unlock endpoints. Self-hosters need to provide a compatible API via `VITE_BOON_API_URL` and the CLI `apiUrl` setting.

## Contracts and live Base addresses

Boon runs on Base mainnet. BoonV3 is the user-facing protocol entry point for public Boons, private Boons, pending settlement, claims, refunds, ERC-8004 agent recipients, and optional recipient attestations.

| Surface | Address | Notes |
|---|---|---|
| Boon v1 | [`0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8`](https://basescan.org/address/0xfb6662AdaF0611a94322634d5B86203Cfb59d5e8) | Legacy escrow + claim history |
| BoonV3 | [`0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF`](https://basescan.org/address/0x22aC2E603D4B1CaAb3A8433f1691BA6158A896AF) | Current send, claim, private-Boon, refund, and agent-recipient path |
| BoonGratitudeAttestationV3 | [`0xC53160EEedb119670A7c13CC7C3709CdE6c9b469`](https://basescan.org/address/0xC53160EEedb119670A7c13CC7C3709CdE6c9b469) | ERC-721 / ERC-5192 soulbound thanks NFT |
| `$BOON` token | [`0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3`](https://basescan.org/token/0x5Bec0bD17D16641660D66d82da4cF78b46B9EBA3) | Fixed-burn utility token for private Boons / attestations / Community Boon nomination |
| USDC on Base | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) | Settlement token |
| ERC-8004 Identity Registry | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://basescan.org/address/0x8004a169fb4a3325136eb29fa0ceb6d2e539a432) | Agent recipient resolution |
| BurnVoteRegistrar | [`0x184B5bdAd8b390d1370f461055B4506CE216dB76`](https://basescan.org/address/0x184B5bdAd8b390d1370f461055B4506CE216dB76) | Community Boon nomination burns + round lifecycle (event-only, holds no funds) |

### BoonV3 immutable mechanics

| Mechanic | Value |
|---|---:|
| Private-Boon burn | `500,000 BOON` |
| Attestation burn | `3,000,000 BOON` |
| Private + attestation burn | `3,500,000 BOON` |
| Third-party private-Boon unlock | `$1 USDC` |
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

It teaches an agent to treat a Boon as a public review with conviction behind it: propose first, name the specific service, run dry-runs, and never send funds without explicit operator approval. The docs package generates a readable page from the same skill source. Local docs builds also write hosted raw mirrors under `docs/public/`, but those generated mirror files are not tracked in this public repository.

After editing `skill/boon/SKILL.md`, run:

```bash
pnpm run docs:sync-skill
pnpm run docs:check-skill
```

## Install the CLI

```bash
npm install --global @velinussage/boon-cli
boon --version
```

The npm package is scoped, but it installs the `boon` executable.

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
pnpm --filter @velinussage/boon-cli build
pnpm --filter @velinussage/boon-cli test
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
