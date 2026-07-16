import { fileURLToPath } from "node:url";

const fromHere = (path) => fileURLToPath(new URL(path, import.meta.url));

export default {
  resolve: {
    alias: {
      "@boon/claim-types": fromHere("../packages/claim-types/src/index.ts"),
      "@boon/normalize": fromHere("../packages/normalize/src/index.ts"),
      "@boon/x402-route": fromHere("../packages/x402-route/src/index.ts"),
    },
  },
  build: {
    target: "node20",
    ssr: fromHere("./src/index.ts"),
    outDir: fromHere("./dist"),
    // Keep the ordinary tsc module outputs used by the CLI's focused tests and
    // public programmatic imports. Vite overwrites only the executable entry
    // with a self-contained bundle so npm consumers do not need private
    // workspace packages at runtime.
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      external: [
        "@open-wallet-standard/core",
        "@x402/core/client",
        "@x402/core/http",
        "@x402/evm",
        "@x402/extensions/offer-receipt",
        "commander",
        "viem",
        "viem/chains",
      ],
      output: {
        entryFileNames: "index.js",
      },
    },
  },
};
