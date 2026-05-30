#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'skill/boon/SKILL.md');
const targets = [
  resolve(root, 'docs/public/skill.md'),
  resolve(root, 'docs/public/.well-known/skills/boon.md'),
  resolve(root, 'docs/public/.well-known/agent-skills/boon.md'),
];
const docsPagePath = resolve(root, 'docs/src/content/docs/resources/agent-skill-file.md');
const checkOnly = process.argv.includes('--check');

const source = await readFile(sourcePath, 'utf8');
const skillMatch = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
const skillMetadata = skillMatch?.[1]?.trimEnd() ?? '';
const skillBody = skillMatch?.[2]?.trimStart() ?? source;
const docsPage = `---
title: Boon agent skill file
description: Full Boon agent skill file generated from skill/boon/SKILL.md.
sidebar:
  label: Agent skill file
---

# Boon agent skill file

This page is generated from the repository source of truth at \`skill/boon/SKILL.md\`.
The raw hosted copy is also available at [\`/skill.md\`](/skill.md),
[\`/.well-known/skills/boon.md\`](/.well-known/skills/boon.md), and
[\`/.well-known/agent-skills/boon.md\`](/.well-known/agent-skills/boon.md).

## Skill metadata

\`\`\`yaml
${skillMetadata}
\`\`\`

## Skill body

${skillBody}`;

const expected = checkOnly ? new Map([[docsPagePath, docsPage]]) : new Map(targets.map((target) => [target, source]));
expected.set(docsPagePath, docsPage);

let drift = false;
for (const [target, content] of expected) {
  if (checkOnly) {
    let existing = '';
    try {
      existing = await readFile(target, 'utf8');
    } catch {
      drift = true;
      console.error(`Missing generated docs skill file: ${target}`);
      continue;
    }
    if (existing !== content) {
      drift = true;
      console.error(`Generated docs skill file is out of sync: ${target}`);
    }
    continue;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

if (drift) {
  console.error('Run `pnpm run docs:sync-skill` to refresh the generated skill docs page and local hosted mirrors.');
  process.exit(1);
}

if (!checkOnly) {
  console.log(`Synced Boon skill mirrors from ${sourcePath}`);
}
