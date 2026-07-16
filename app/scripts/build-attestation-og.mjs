#!/usr/bin/env node
/**
 * Build the base 1200×630 OG / social image for Boon Gratitude Attestations.
 *
 * This is the static "hero" card used as a base for SBT metadata images.
 * It follows the exact same visual system as the claim and receipt cards
 * (paper + olive register, Fraunces, two-column layout, subtle illustration).
 *
 * Motif: "Sealed Proof" — a warm paper certificate with an olive wax seal.
 * Distinct from the envelope (claim) and torn receipt, but clearly siblings.
 *
 * Pipeline: satori → resvg-js → disk.
 * Regenerate with: pnpm --filter boon-app build:attestation-og
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

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

// Sealed proof / wax seal illustration.
// A simple certificate with a stamped olive seal in the corner.
// Kept deliberately flat and geometric like the other cards.
const SEAL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 280" width="400" height="280">
  <!-- Main paper -->
  <rect x="30" y="25" width="340" height="230" rx="8" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="3"/>
  
  <!-- Subtle inner frame -->
  <rect x="50" y="45" width="300" height="190" rx="4" fill="none" stroke="${COLORS.faint}" stroke-width="1"/>
  
  <!-- Wax seal (olive circle with subtle stamp mark) -->
  <circle cx="310" cy="70" r="28" fill="${COLORS.oliveDeep}"/>
  <circle cx="310" cy="70" r="20" fill="${COLORS.olive}"/>
  <!-- Small "B" or check mark inside the seal -->
  <path d="M302 70 L308 76 L320 62" fill="none" stroke="${COLORS.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  
  <!-- Decorative lines suggesting text / proof -->
  <rect x="70" y="100" width="160" height="5" rx="2" fill="${COLORS.faint}"/>
  <rect x="70" y="120" width="200" height="5" rx="2" fill="${COLORS.faint}"/>
  <rect x="70" y="140" width="140" height="5" rx="2" fill="${COLORS.faint}"/>
  
  <!-- Bottom signature line -->
  <rect x="70" y="180" width="100" height="4" rx="2" fill="${COLORS.olive}" opacity="0.6"/>
</svg>`;

const SEAL_DATAURL = `data:image/svg+xml;base64,${Buffer.from(SEAL_SVG).toString("base64")}`;

const tree = {
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
      // Top row: wordmark + eyebrow
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
                children: "gratitude attestation · boonprotocol.com",
              },
            },
          ],
        },
      },

      // Main content row
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
            // Left column — headline + description
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "32px",
                  flex: "1.4",
                  maxWidth: "640px",
                },
                children: [
                  {
                    type: "div",
                    props: {
                      style: {
                        display: "flex",
                        fontSize: "72px",
                        lineHeight: 0.98,
                        letterSpacing: "-0.025em",
                        color: COLORS.ink,
                      },
                      children: "A permanent record of thanks.",
                    },
                  },
                  {
                    type: "div",
                    props: {
                      style: {
                        display: "flex",
                        fontSize: "26px",
                        lineHeight: 1.4,
                        color: COLORS.inkSoft,
                        letterSpacing: "-0.005em",
                      },
                      children:
                        "Soulbound proof of a funded Boon on Base. A public attestation of private or public gratitude.",
                    },
                  },
                ],
              },
            },

            // Right column — seal illustration
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

      // Bottom strap
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
                  fontSize: "22px",
                  color: COLORS.muted,
                  letterSpacing: "-0.005em",
                },
                children: "Onchain USDC tipping for the people who helped you.",
              },
            },
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  fontSize: "22px",
                  color: COLORS.oliveDeep,
                  letterSpacing: "0.02em",
                  fontWeight: 500,
                },
                children: "View onchain →",
              },
            },
          ],
        },
      },
    ],
  },
};

const svg = await satori(tree, {
  width: 1200,
  height: 630,
  fonts: [
    {
      name: "Fraunces",
      data: fraunces,
      weight: 400,
      style: "normal",
    },
  ],
});

const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
const png = resvg.render().asPng();
const outPath = join(ROOT, "public/attestation-og-image.png");
writeFileSync(outPath, png);

const kb = (png.byteLength / 1024).toFixed(1);
console.log(`✓ wrote ${outPath} (${kb} KB, 1200×630)`);