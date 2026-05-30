---
title: Documentation maintenance
description: Ownership rules for Boon documentation, generated skill mirrors, and status facts.
---

# Documentation maintenance

Boon keeps the repository as the source of truth, but the public docs site is the primary learning surface for users, operators, and integrators.

## Ownership matrix

| Surface | Audience | Owns | Rule |
|---|---|---|---|
| `docs/src/content/docs/` | Public users, agent operators, API consumers | Guides, concepts, hosted API reference, troubleshooting, CLI reference | Primary authored docs surface. Update this when behavior, endpoints, commands, or public-facing flows change. |
| `README.md` | GitHub readers and clone-and-hack contributors | Project overview, current status, architecture rationale, release caveats | Keep concise but useful as a repo front door. Link to the docs site for task details. |
| `CHANGELOG.md` | Everyone | Versioned user/operator-impacting changes | Update for released behavior changes. |
| `skill/boon/SKILL.md` | Agents | Agent safety rules and execution workflow | Source of truth for generated docs skill mirrors. |

## Generated skill mirrors

The hosted files below are generated from `skill/boon/SKILL.md`:

```text
https://docs.boonprotocol.com/skill.md
https://docs.boonprotocol.com/.well-known/skills/boon.md
https://docs.boonprotocol.com/.well-known/agent-skills/boon.md
https://docs.boonprotocol.com/resources/agent-skill-file/
```

Use:

```bash
pnpm run docs:sync-skill
pnpm run docs:check-skill
```

`docs:build` refreshes the generated copies before building. CI runs `docs:check-skill` so a direct edit to a generated copy fails fast.

## Status facts

Addresses, versions, live endpoints, relayer posture, unaudited warnings, and x402 boundaries should stay synchronized across:

- `README.md`
- `docs/src/content/docs/index.md`
- `docs/src/content/docs/resources/status-disclaimers.md`
- `docs/src/content/docs/resources/contract-addresses.md`

If one of those facts changes, update all relevant surfaces in the same PR.

## Good first docs tasks

Small, well-scoped changes that improve the docs without needing deep
context:

- Update a guide's CLI command when a `boon` flag changes (run the CLI
  locally and confirm the help text matches).
- Add a missing troubleshooting entry when an issue is reported more than
  once on GitHub.
- Refresh a stale paragraph that names a removed feature or a renamed env
  var — `grep -RIn` against the docs tree is enough to find them.
- Add or correct a cross-link between Concepts, Guides, and hosted API
  reference pages. The doc site rewards small connective edits.

Open these as one-file PRs so the review is fast. CI runs
`pnpm run docs:check-skill` and `pnpm run docs:build`, which catches the
common breakages.
