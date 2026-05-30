#!/usr/bin/env node
/**
 * Build the 1200×630 OG image for boonprotocol.com/claim.
 *
 * Design — "Letter" motif:
 * The page H1 is "Someone left you a thank-you." The verb "left" is
 * already correspondence vocabulary, so the card pairs that headline
 * with a stamped-envelope silhouette in the right column. Sober warm
 * paper + single olive accent — same brand register as the landing OG,
 * different rhythm so the two cards read as siblings, not duplicates.
 *
 * Meta tag copy this card supports on /claim:
 *   <title>          Someone left you a thank-you · boon
 *   og:title         Someone left you a thank-you.
 *   og:description   Open your boon on boonprotocol.com — claim with
 *                    GitHub or X, no wallet needed up front.
 *   twitter:*        same
 *
 * Pipeline: satori (React-like → SVG) → resvg-js (SVG → PNG) → disk.
 * Regenerate with: pnpm --filter boon-app build:claim-og
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

// Stamped-envelope SVG path — flat geometry, no fill gradients. Lives in a
// 400×280 viewBox; we drop it in as raw SVG via a `<svg>`-like element node.
const ENVELOPE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 280" width="400" height="280"><rect x="20" y="50" width="360" height="210" rx="8" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="3"/><path d="M 20 50 L 200 175 L 380 50" fill="none" stroke="${COLORS.ink}" stroke-width="3" stroke-linejoin="round"/><rect x="290" y="70" width="70" height="80" rx="3" fill="${COLORS.paperDeep}" stroke="${COLORS.oliveDeep}" stroke-width="2" stroke-dasharray="3 3"/><circle cx="325" cy="110" r="14" fill="${COLORS.olive}"/><rect x="50" y="200" width="180" height="6" rx="3" fill="${COLORS.faint}"/><rect x="50" y="220" width="130" height="6" rx="3" fill="${COLORS.faint}"/></svg>`;
const ENVELOPE_DATAURL = `data:image/svg+xml;base64,${Buffer.from(ENVELOPE_SVG).toString("base64")}`;

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
      // Top eyebrow — wordmark + olive seal + URL
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
            // boon wordmark + dot (small — same as nav)
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
            // Right-side mono eyebrow
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
                children: "for recipients · boonprotocol.com/claim",
              },
            },
          ],
        },
      },
      // Body — two-column: headline left, envelope right
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
            // Left — headline + lede
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
                      children: "Someone left you a thank-you.",
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
                        "Claim USDC on Base by signing in with GitHub or X. No wallet needed up front.",
                    },
                  },
                ],
              },
            },
            // Right — envelope illustration (base64-embedded SVG)
            {
              type: "img",
              props: {
                src: ENVELOPE_DATAURL,
                width: 400,
                height: 280,
                style: { display: "flex" },
              },
            },
          ],
        },
      },
      // Bottom strap — hairline + CTA
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
                children: "Open the claim →",
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

const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
});
const png = resvg.render().asPng();
const outPath = join(ROOT, "public/claim-og-image.png");
writeFileSync(outPath, png);

const kb = (png.byteLength / 1024).toFixed(1);
console.log(`✓ wrote ${outPath} (${kb} KB, 1200×630)`);
