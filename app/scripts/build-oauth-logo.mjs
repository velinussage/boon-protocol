#!/usr/bin/env node
/**
 * Build the 1024×1024 OAuth logo for boonprotocol.com.
 *
 * GitHub and X OAuth consent screens display a square logo when a user
 * authorizes the app. They expect ≥200×200 PNG; 1024×1024 keeps it crisp
 * at every render size.
 *
 * Scale of `app/public/favicon.svg`:
 *  · warm-paper rounded square ground
 *  · olive seal dot, ~31% of the square diameter
 *
 * The PNG is written to `public/oauth-logo.png` and shipped to
 * `https://boonprotocol.com/oauth-logo.png`. After deploy, set that URL as
 * the logo in the GitHub OAuth app settings and the X developer portal.
 *
 * Pipeline: hand-rolled SVG → resvg-js (SVG → PNG) → disk.
 * Runs as `prebuild`, so every `vite build` regenerates the asset from
 * the current token values. If the olive or paper tokens shift, the
 * OAuth logo stays in sync.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SIZE = 1024;
const RADIUS = 192;
const DOT_R = 160;
const PAPER = "#faf9f5";
const OLIVE = "#6b7a45";

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="${PAPER}"/>
  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${DOT_R}" fill="${OLIVE}"/>
</svg>`;

const resvg = new Resvg(svg, {
  background: "rgba(0,0,0,0)",
  fitTo: { mode: "width", value: SIZE },
});

const png = resvg.render().asPng();
const out = join(ROOT, "public/oauth-logo.png");
writeFileSync(out, png);
console.log(`✓ wrote public/oauth-logo.png (${SIZE}×${SIZE}, ${png.length} bytes)`);
