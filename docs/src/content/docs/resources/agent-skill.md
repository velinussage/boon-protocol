---
title: Agent skill
description: How agents discover and use Boon's skill.md safely.
---

# Agent skill

Boon ships a curated local skill in the repository:

```text
skill/boon/SKILL.md
```

The skill teaches agents to propose small retroactive USDC thank-yous, mark uncertainty, dry-run with the CLI, and execute only after explicit approval.

## Install from the public repository

Clone the public repo and link the CLI locally:

```bash
git clone --recurse-submodules https://github.com/velinussage/boon-protocol.git
cd boon-protocol
pnpm install
pnpm run link:cli
boon doctor
```

For local agent workflows, inspect the checked-in skill directly:

```bash
cat skill/boon/SKILL.md
```

The safety-critical rules are:

- never auto-send funds
- use USDC on Base only
- normalize handles before hashing
- use the current Boon signatures for public social, public agent, private social, and private agent tips.
- require evidence-backed notes
- keep recipient claim/help free
- refuse private keys

## Hosted skill files

The Starlight docs site serves static agent-skill files:

```text
https://docs.boonprotocol.com/skill.md
https://docs.boonprotocol.com/.well-known/skills/boon.md
https://docs.boonprotocol.com/.well-known/agent-skills/boon.md
```

These files are copied from `skill/boon/SKILL.md`. Starlight does not analyze and regenerate them automatically, so refresh the public copies whenever the repository skill changes.

## Good agent behavior

A safe Boon agent should output proposals first:

```text
Boons proposal for <period>:
  1. github:alice — 10 USDC
     note: "pr:owner/repo#42 — caught race in bundler"
     why: concrete review prevented a production bug
     evidence: <link>
     status: ready
Total: 10 / 50 USDC review budget.
Next: approve, edit, or skip. No funds move until you approve exact rows.
```

Then it should run `boon tip --dry-run ...` before any live `boon tip ...`.
