#!/usr/bin/env node
/**
 * Build the 1200×630 OG image for boonprotocol.com.
 *
 * Renders the lowercase "boon" wordmark + olive seal dot on the warm
 * paper background — pixel-matches the live site's hero treatment.
 *
 * Pipeline: satori (React-like → SVG) → resvg-js (SVG → PNG) → disk.
 * The PNG is written to `public/og-image.png` and shipped via
 * `og:image` + `twitter:image` meta tags.
 *
 * Runs as `prebuild`, so every `vite build` regenerates the OG image
 * from the current Fraunces TTF. If anyone bumps the font or changes
 * the warm-paper / olive tokens, the OG image stays in sync.
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
  ink: "#1c1917",
  olive: "#6b7a45",
  muted: "#78716c",
};

// Satori uses a Yoga flexbox layout. We construct the React-element tree
// manually (no JSX so we don't need a build step for this script).
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
      padding: "80px 96px",
      fontFamily: "Fraunces",
      color: COLORS.ink,
    },
    children: [
      // Top eyebrow — "boonprotocol.com" small mono
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            fontSize: "22px",
            color: COLORS.muted,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontWeight: 500,
          },
          children: "boonprotocol.com",
        },
      },
      // Center — the wordmark
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
          },
          children: [
            {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  lineHeight: 1,
                  fontSize: "320px",
                  fontWeight: 400,
                  letterSpacing: "-0.04em",
                  // Satori doesn't know about Fraunces' optical-size axis
                  // so we use the default cut; render still looks correct
                  // because the TTF is variable and satori picks instance.
                },
                children: [
                  {
                    type: "span",
                    props: { style: { display: "flex" }, children: "boon" },
                  },
                  // Olive seal dot — visually aligned with the cap height
                  {
                    type: "div",
                    props: {
                      style: {
                        display: "flex",
                        width: "36px",
                        height: "36px",
                        marginLeft: "20px",
                        marginTop: "60px",
                        borderRadius: "9999px",
                        backgroundColor: COLORS.olive,
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      // Bottom tagline — same one that opens the site
      {
        type: "div",
        props: {
          style: {
            display: "flex",
            fontSize: "32px",
            lineHeight: 1.3,
            color: COLORS.ink,
            letterSpacing: "-0.01em",
            maxWidth: "900px",
          },
          children:
            "Onchain gratitude tipping. Your agent proposes, you approve, recipients claim by linking github or x.",
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
const outPath = join(ROOT, "public/og-image.png");
writeFileSync(outPath, png);

const kb = (png.byteLength / 1024).toFixed(1);
console.log(`✓ wrote ${outPath} (${kb} KB, 1200×630)`);
