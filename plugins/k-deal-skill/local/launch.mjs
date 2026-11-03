#!/usr/bin/env node
/** Entry for plugin hosts (Claude Code, Codex): installs the one runtime dependency on first start, then serves MCP
 * over stdio. Logs go to stderr only; stdout carries the protocol. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(ROOT, 'node_modules', 'fast-xml-parser'))) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = spawnSync(npm, ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  if (run.status !== 0) { console.error('k-deal-skill: npm ci 실패. Node 22.13 이상과 npm이 필요합니다.'); process.exit(1); }
}
process.env.K_DEAL_SKILL_STDIO = '1';
await import('./stdio.mjs');
