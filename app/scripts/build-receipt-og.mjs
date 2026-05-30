#!/usr/bin/env node
/**
 * Build the 1200×630 OG image for boonprotocol.com/b/:txHash.
 *
 * Receipt links are the artifact a sender shares with their recipient
 * ("here's the boon I left for you"). The card mirrors the /claim
 * card's Letter motif — same envelope + warm paper register — but
 * picks up a "receipt" framing so the social preview reads as
 * proof rather than instruction.
 *
 * Meta tag copy set on /b/*:
 *   <title>          Someone said thank you · boon
 *   og:title         Someone said thank you.
 *   og:description   A boon receipt on Base — USDC tied to your account
 *                    on GitHub or X. No wallet needed up front.
 *
 * Pipeline: satori → resvg-js → disk.
 * Regenerate with: pnpm --filter boon-app build:receipt-og
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

// "Receipt note" silhouette — a slip of paper with a hairline tear edge
// and a stamped corner. Visually echoes the /claim envelope but reads
// as a torn-off receipt rather than a sealed envelope.
const RECEIPT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 280" width="400" height="280"><rect x="40" y="30" width="320" height="220" rx="6" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="3"/><path d="M40 30 L60 50 L40 70 L60 90 L40 110 L60 130 L40 150 L60 170 L40 190 L60 210 L40 230 L40 250" fill="none" stroke="${COLORS.ink}" stroke-width="3" stroke-linejoin="round"/><circle cx="320" cy="80" r="22" fill="${COLORS.oliveDeep}"/><path d="M310 80 L317 87 L330 73" fill="none" stroke="${COLORS.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><rect x="80" y="140" width="180" height="6" rx="3" fill="${COLORS.faint}"/><rect x="80" y="160" width="220" height="6" rx="3" fill="${COLORS.faint}"/><rect x="80" y="180" width="140" height="6" rx="3" fill="${COLORS.faint}"/><rect x="80" y="210" width="100" height="14" rx="3" fill="${COLORS.olive}" opacity="0.55"/></svg>`;
const RECEIPT_DATAURL = `data:image/svg+xml;base64,${Buffer.from(RECEIPT_SVG).toString("base64")}`;

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
                  {
                    type: "span",
                    props: { style: { display: "flex" }, children: "boon" },
                  },
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
                children: "boon receipt · boonprotocol.com",
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
                        fontSize: "92px",
                        lineHeight: 0.98,
                        letterSpacing: "-0.025em",
                        color: COLORS.ink,
                      },
                      children: "Someone said thank you.",
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
                        "A USDC boon on Base, tied to your GitHub or X account. Open the receipt to claim it.",
                    },
                  },
                ],
              },
            },
            {
              type: "img",
              props: {
                src: RECEIPT_DATAURL,
                width: 400,
                height: 280,
                style: { display: "flex" },
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
                children: "View the receipt →",
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
const outPath = join(ROOT, "public/receipt-og-image.png");
writeFileSync(outPath, png);

const kb = (png.byteLength / 1024).toFixed(1);
console.log(`✓ wrote ${outPath} (${kb} KB, 1200×630)`);
