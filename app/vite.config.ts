import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite React SPA for boonprotocol.com — landing, send, claim, board, receipts, and attestations.
// Live hosting is operated outside this public mirror; the API lives at api.boonprotocol.com.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    sourcemap: true,
    // Route-split: wallet/wagmi only loads on wallet-heavy send/claim routes.
    // The landing page should not pay for wagmi's ~120 KB on cold-load.
    rollupOptions: {
      output: {
        manualChunks: {
          wallet: ["wagmi", "viem", "@coinbase/onchainkit"],
        },
      },
    },
  },
  server: {
    port: 4321,
  },
});
