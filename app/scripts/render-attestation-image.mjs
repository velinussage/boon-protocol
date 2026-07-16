#!/usr/bin/env node
/**
 * Dynamic image rendering job for Boon Gratitude Attestations (SBTs).
 *
 * This is an off-chain Node renderer for local/static attestation PNG output.
 *
 * Usage:
 *   node scripts/render-attestation-image.mjs 123
 *
 * It fetches attestation data from the hosted metadata API or directly from
 * Base, renders a personalized proof card using the same design system as the
 * static OG builders (Fraunces, COLORS, layout), and writes a PNG to dist/.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { createPublicClient, http, getAddress, isAddress } from "viem";
import { base } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const fraunces = readFileSync(join(__dirname, "assets/fraunces.ttf"));

const COLORS = {
  paper: "#faf9f5",
  paperDeep: "#f3f1ea",
  ink: "#1c1917",
  inkSoft: "#44403c",
  olive: "#6b7a45",
  oliveDeep: "#4f5b30",
  faint: "#d6d3d1",
  muted: "#78716c",
};

// Reusable sealed illustration (same as static builder)
const SEAL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 280" width="400" height="280">
  <rect x="30" y="25" width="340" height="230" rx="8" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="3"/>
  <rect x="50" y="45" width="300" height="190" rx="4" fill="none" stroke="${COLORS.faint}" stroke-width="1"/>
  <circle cx="310" cy="70" r="28" fill="${COLORS.oliveDeep}"/>
  <circle cx="310" cy="70" r="20" fill="${COLORS.olive}"/>
  <path d="M302 70 L308 76 L320 62" fill="none" stroke="${COLORS.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="70" y="100" width="160" height="5" rx="2" fill="${COLORS.faint}"/>
  <rect x="70" y="120" width="200" height="5" rx="2" fill="${COLORS.faint}"/>
  <rect x="70" y="140" width="140" height="5" rx="2" fill="${COLORS.faint}"/>
  <rect x="70" y="180" width="100" height="4" rx="2" fill="${COLORS.olive}" opacity="0.6"/>
</svg>`;
const SEAL_DATAURL = `data:image/svg+xml;base64,${Buffer.from(SEAL_SVG).toString("base64")}`;

// Minimal ABI to read attestation data directly if needed
const ATTESTATION_ABI = [
  {
    type: "function",
    name: "attestations",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        components: [
          { name: "recipient", type: "address" },
          { name: "handleHash", type: "bytes32" },
          { name: "agentId", type: "uint256" },
          { name: "privateCommitment", type: "bytes32" },
          { name: "boonBurned", type: "uint256" },
          { name: "mintedAt", type: "uint256" },
        ],
        type: "tuple",
      },
    ],
  },
];

function formatDate(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function shortAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function buildAttestationTree(attestationData, tipId) {
  const { recipient, agentId, boonBurned, mintedAt, handleHash } = attestationData;

  const recipientDisplay = agentId && agentId > 0n 
    ? `agent:${agentId.toString()}` 
    : shortAddr(recipient);

  const dateStr = mintedAt ? formatDate(mintedAt) : "—";
  const burnedDisplay = boonBurned ? `${(Number(boonBurned) / 1e18).toLocaleString()} $BOON` : "";

  return {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: COLORS.paper,
        padding: "72px 88px",
        fontFamily: "Fraunces",
        color: COLORS.ink,
      },
      children: [
        // Top bar
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "flex-start",
                    fontSize: "44px",
                    letterSpacing: "-0.04em",
                    lineHeight: 1,
                  },
                  children: [
                    { type: "span", props: { style: { display: "flex" }, children: "boon" } },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          width: "10px",
                          height: "10px",
                          marginLeft: "6px",
                          marginTop: "8px",
                          borderRadius: "9999px",
                          backgroundColor: COLORS.olive,
                        },
                      },
                    },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    fontSize: "20px",
                    color: COLORS.muted,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    fontWeight: 500,
                  },
                  children: "gratitude attestation",
                },
              },
            ],
          },
        },

        // Main content
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "48px",
              flex: 1,
              paddingTop: "32px",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: "24px",
                    flex: "1.4",
                    maxWidth: "620px",
                  },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          fontSize: "64px",
                          lineHeight: 0.98,
                          letterSpacing: "-0.025em",
                        },
                        children: `Attestation #${tipId}`,
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          fontSize: "28px",
                          color: COLORS.inkSoft,
                        },
                        children: `For ${recipientDisplay}`,
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          gap: "8px",
                          fontSize: "22px",
                          color: COLORS.muted,
                        },
                        children: [
                          { type: "div", props: { children: `Minted ${dateStr}` } },
                          burnedDisplay && { type: "div", props: { children: burnedDisplay } },
                        ].filter(Boolean),
                      },
                    },
                  ],
                },
              },
              {
                type: "img",
                props: {
                  src: SEAL_DATAURL,
                  width: 400,
                  height: 280,
                  style: { display: "flex" },
                },
              },
            ],
          },
        },

        // Bottom
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: "24px",
              borderTop: `1px solid ${COLORS.faint}`,
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    fontSize: "20px",
                    color: COLORS.muted,
                  },
                  children: "Soulbound on Base",
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    fontSize: "20px",
                    color: COLORS.oliveDeep,
                    fontWeight: 500,
                  },
                  children: "boonprotocol.com",
                },
              },
            ],
          },
        },
      ],
    },
  };
}

async function fetchAttestationData(tipId, env = {}) {
  // Preferred: fetch from the hosted metadata API (rich + cached)
  const apiBase = env.API_BASE || "https://api.boonprotocol.com";
  try {
    const res = await fetch(`${apiBase}/api/v1/attestations/${tipId}`);
    if (res.ok) {
      const json = await res.json();
      const metadata = json.metadata || json;
      const attributeValue = (traitType, fallback = "0") => {
        const attr = Array.isArray(metadata.attributes)
          ? metadata.attributes.find((entry) => entry && entry.trait_type === traitType)
          : null;
        return attr?.value ?? fallback;
      };
      return {
        recipient: json.recipient || attributeValue("Recipient", "0x0000000000000000000000000000000000000000"),
        agentId: BigInt(json.agentId || attributeValue("Agent ID", "0")),
        boonBurned: BigInt(json.boonBurned || attributeValue("Boon Burned (wei)", "0")),
        mintedAt: BigInt(json.mintedAt || attributeValue("Minted At", "0")),
        handleHash: json.handleHash,
      };
    }
  } catch {}

  // Fallback: direct on-chain read (requires BOON_ATTESTATION_CONTRACT or the active attestation contract)
  const attestationAddr = env.ATTESTATION_CONTRACT;
  if (!attestationAddr || !isAddress(attestationAddr)) {
    throw new Error("Cannot fetch attestation data — no API or on-chain address configured");
  }

  const client = createPublicClient({
    chain: base,
    transport: http(env.RPC_URL || "https://mainnet.base.org"),
  });

  const data = await client.readContract({
    address: getAddress(attestationAddr),
    abi: ATTESTATION_ABI,
    functionName: "attestations",
    args: [BigInt(tipId)],
  });

  return {
    recipient: data.recipient,
    agentId: data.agentId,
    boonBurned: data.boonBurned,
    mintedAt: data.mintedAt,
    handleHash: data.handleHash,
  };
}

async function main() {
  const tipId = process.argv[2];

  if (!tipId) {
    console.error("Usage: node scripts/render-attestation-image.mjs <tipId>");
    process.exit(1);
  }

  console.log(`Rendering attestation image for tipId=${tipId}...`);

  const attestation = await fetchAttestationData(tipId, {
    API_BASE: process.env.API_BASE,
    ATTESTATION_CONTRACT: process.env.ATTESTATION_CONTRACT,
    RPC_URL: process.env.RPC_URL,
  });

  const tree = buildAttestationTree(attestation, tipId);

  const svg = await satori(tree, {
    width: 1200,
    height: 630,
    fonts: [{ name: "Fraunces", data: fraunces, weight: 400, style: "normal" }],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
  const png = resvg.render().asPng();

  const outDir = join(ROOT, "dist", "attestations");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${tipId}.png`);
  writeFileSync(outPath, png);

  console.log(`✓ wrote ${outPath} (${(png.byteLength / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
