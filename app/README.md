# boon-app

`boonprotocol.com` — landing, send, claim, board, profile, receipt, and attestation pages. Vite + React SPA. The public mirror builds the static app; live hosting is managed by maintainers outside this repository.

## What's here

| Route | What it does |
|---|---|
| `/` | Landing page. Explains one-time send first, with agent mode handled by the OWS-funded CLI. |
| `/send` | Primary sender flow: recipient handle + amount + note, connect Coinbase, injected, or WalletConnect, add USDC through Coinbase Onramp if needed, then approve/send. Uses BoonV3 for current direct, private, pending-settlement, agent, and attested sends; keeps v1 config only for legacy-compatible surfaces. |
| `/claim` | Legacy v1 recipient flow: prove GitHub/X by OAuth, review aggregate claimable amount, connect wallet, and complete `link()` + `claim()` through the hosted API when relaying is enabled. |
| `/board` | Leaderboard for top senders and most-thanked recipients backed by `/api/leaderboard`. |
| `/p/:handle` | Aggregate-only Boon Points profile backed by `/api/v1/handles/:handle/profile`. |
| `/b/:txHash` | Single-boon receipt backed by `/api/v1/receipts/:txHash`. |
| `/attestations/:tipId` | Soulbound gratitude attestation detail page backed by `/v1/attestations/:tipId`. |
| `/logo` | Token/logo image route served as a static asset by the deployed app. |
| `/feed` | Removed-feed hint. Boon no longer ships a public chronological who-paid-who feed. |

## Stack

- **Vite 5** — SPA/static build for the public routes above
- **React 19** — interactive widgets
- **Tailwind CSS 4** — CSS-based config in `src/styles/global.css`
- **Fraunces** (variable serif) + **Geist Mono** — typography
- **wagmi/viem + Coinbase, injected, and WalletConnect connectors** — sender + recipient wallet selection; OnchainKit remains available for Coinbase UI helpers
- **Node image scripts** — deterministic Open Graph / attestation PNG generation from `app/scripts/`

## Design

Sober technical-correspondence aesthetic. Warm off-white surface, warm-black ink, single olive accent (`#6b7a45`). No crypto neon, no purple-on-white, no dashboard chrome. Asymmetric layouts on `/send` and `/claim` (narrative left, action card right). All numbers in tabular Geist Mono.

See `src/styles/global.css` for tokens and the component primitives (`.wordmark`, `.btn`, `.card`, `.pill`, `.chip`).

## Backend dependency boundary

The reference app can render locally as a Vite SPA. Browser wallets can sign public Boon transactions against the deployed Base contracts, but the default product UX depends on the hosted API for:

- GitHub/X OAuth and legacy claim sessions
- relayed v1 `link()` / `claim()` completion
- Coinbase Onramp sessions
- wallet USDC / `$BOON` balance and allowance reads used by the send form
- aggregate board, profile, receipt, points-policy, disclosure, and attestation reads
- private-tip blob upload/auth reads

Set `VITE_BOON_API_URL` to a compatible hosted API if you are not using `https://api.boonprotocol.com`. The SPA does not call x402-gated detailed graph endpoints directly; those are for paid agents/apps.

## Run locally

```bash
pnpm install
pnpm --filter boon-app dev    # http://localhost:4321
```

## API assumptions

The app is wired for current BoonV3 sends plus legacy v1 claim/receipt compatibility.

Send:
1. `GET /wallet/:address/usdc-balance` returns USDC balance and allowance context for the connected wallet.
2. `POST /onramp/session` with `{ destinationAddress, purchaseAmount, paymentCurrency?, redirectUrl?, partnerUserRef? }` returns `{ onrampUrl, quote?, destinationAddress, purchaseCurrency, destinationNetwork }` for USDC on Base.
3. `GET /v1/handles/:handle/profile` prechecks social-recipient claim status before enabling attestation minting for unlinked GitHub/X recipients.
4. `POST /private-tip/blob` stores the encrypted/private tip metadata before the wallet signs `tipPrivate(...)`.
5. After funding, `/send` rechecks balances, approves only the exact USDC and `$BOON` amounts needed, then calls the selected BoonV3 send function.

Claim:
1. `POST /auth/{github,x}/start` with `{ returnTo }` and no `recipient` returns `{ authorizeUrl }`.
2. OAuth callback redirects to `/claim#mode=claim_session&sessionId=...&sessionToken=...&claimableUrl=...`.
3. `GET /api/claim/sessions/:sessionId/claimable` with the session token returns aggregate legacy escrowed USDC, linked wallet, and tip count for the proven handle. Per-tip note/sender context is not currently returned by this endpoint. Legacy `GET /api/claimable?handle=...` is tolerated only for old API deployments.
4. After wallet creation/connection, the user confirms the permanent v1 link.
5. `POST /claim/complete` with `{ sessionId, recipient, confirmPermanentLink: true }` asks the hosted relayer to submit `Boon.link(...)` and `Boon.claim(...)`. If hosted relaying is not enabled, the UI fails loudly instead of asking the recipient for gas.

Boon Points / receipts / attestations:
1. `GET /api/v1/handles/:handle/profile` powers `/p/:handle` with aggregate points only.
2. `GET /api/v1/receipts/:txHash` powers `/b/:txHash` for a single-boon receipt.
3. `GET /v1/attestations/:tipId` powers `/attestations/:tipId` and ERC-721 metadata reads.
4. The SPA intentionally does **not** call x402-gated detailed graph endpoints; those are for paid agents/apps.
5. `/feed` is retained only as a removed-page hint for old links, not as a public feed.

## Build

```bash
pnpm --filter boon-app build
pnpm --filter boon-app render:attestation -- --tip-id 1 --out /tmp/attestation.png
```

Live deployment configuration is maintained outside this public mirror. Public contributors should validate static builds here and rely on the hosted `https://boonprotocol.com` / `https://api.boonprotocol.com` endpoints for production behavior.
