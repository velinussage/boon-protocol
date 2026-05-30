---
title: Docs hosting
description: How Boon docs are built with Astro Starlight and mirrored from the public source tree.
---

# Docs hosting

Boon docs are built as a static Astro Starlight site. This public mirror contains the source that contributors can edit, build, and validate locally. The live `docs.boonprotocol.com` deployment is managed by maintainers outside this repository after public-safe changes are reviewed.

## Public source layout

```text
docs/                  Starlight workspace
docs/src/content/docs/ Markdown/MDX content
docs/public/           Static skill-file mirrors and assets
```

## Local development

```bash
pnpm --filter boon-docs dev
```

## Build

```bash
pnpm --filter boon-docs build
```

The static output is `docs/dist/`.

## Agent skill endpoints

Because Starlight does not auto-generate agent-skill endpoints, Boon serves generated static skill files from `docs/public/`:

```text
/skill.md
/.well-known/skills/boon.md
/.well-known/agent-skills/boon.md
```

`skill/boon/SKILL.md` is the source of truth. `pnpm run docs:sync-skill` refreshes the hosted raw files and the Starlight "Agent skill file" page. `pnpm run docs:check-skill` fails CI if any generated copy drifts from the repository skill.
