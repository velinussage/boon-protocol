import { createConfig, fallback, http } from "wagmi";
import { base } from "wagmi/chains";
import { coinbaseWallet, injected, metaMask, walletConnect } from "wagmi/connectors";

/*
 * Wagmi config for the boon app.
 *
 * `preference` uses the OBJECT form (`{ options: "smartWalletOnly" }`).
 * The string-only form (`preference: "smartWalletOnly"`) is deprecated
 * since wagmi 2.12.33 / @coinbase/wallet-sdk v4 and produces a runtime
 * warning. Keep the object form even if the only key today is `options`.
 *
 * The quick-send and recipient claim paths are wallet-agnostic: MetaMask,
 * Rabby, another injected wallet, WalletConnect, or a Coinbase Smart Wallet can
 * approve/send or receive USDC.
 * Register MetaMask explicitly before the generic injected connector so the
 * "existing wallet" CTA does not accidentally route through a Coinbase-injected
 * provider when multiple extensions are installed.
 *
 * WalletConnect is only registered when VITE_WC_PROJECT_ID is set. The Project
 * ID is public client metadata from the Reown/WalletConnect dashboard, not a
 * secret, but builds without it should not render a dead "Other wallet" modal.
 *
 * NOTE: browser wallets can call tip / tipAgent / tipPrivate directly from
 * this SPA. The CLI + OWS path is for autonomous-agent-to-agent loops, not
 * a precondition for sending to an ERC-8004 agent recipient.
 */

const DEFAULT_BASE_RPC_URLS = [
  "https://base-mainnet.g.alchemy.com/public",
  "https://1rpc.io/base",
  "https://base-rpc.publicnode.com",
] as const;

function splitRpcUrls(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

const configuredBaseRpcUrls = [
  ...splitRpcUrls(import.meta.env.VITE_BASE_RPC_URL as string | undefined),
  ...splitRpcUrls(import.meta.env.VITE_BASE_RPC_FALLBACK_URL as string | undefined),
  ...splitRpcUrls(import.meta.env.VITE_BASE_RPC_FALLBACK_URLS as string | undefined),
];

const baseRpcUrls = Array.from(new Set([...configuredBaseRpcUrls, ...DEFAULT_BASE_RPC_URLS]));

const baseTransport =
  baseRpcUrls.length > 1
    ? fallback(
        baseRpcUrls.map((url, index) =>
          http(url, {
            key: `base-rpc-${index}`,
            retryCount: 1,
            timeout: 10_000,
          }),
        ),
        { rank: true, retryCount: 1 },
      )
    : http(baseRpcUrls[0]);

const walletConnectProjectId = (import.meta.env.VITE_WC_PROJECT_ID as string | undefined)?.trim();
const walletConnectConnector = walletConnectProjectId
  ? walletConnect({
      projectId: walletConnectProjectId,
      metadata: {
        name: "Boon",
        description: "Onchain USDC thank-yous for the people who helped you.",
        url: "https://boonprotocol.com",
        icons: ["https://boonprotocol.com/favicon.svg"],
      },
      showQrModal: true,
    })
  : null;

export const config = createConfig({
  chains: [base],
  connectors: [
    metaMask(),
    injected({ shimDisconnect: true }),
    ...(walletConnectConnector ? [walletConnectConnector] : []),
    coinbaseWallet({
      appName: "boon",
      preference: { options: "smartWalletOnly" },
    }),
  ],
  transports: {
    [base.id]: baseTransport,
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
