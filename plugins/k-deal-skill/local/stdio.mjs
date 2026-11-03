/** Self-hosted MCP over stdio: one JSON-RPC message per line in, one per line out. Uses the same handler and lookup
 * modules as the hosted Market Research server, with the user's own keys from the environment and no gateway. */
import { createInterface } from 'node:readline';
import { createHandler, ALL_TOOLS } from '../core/mcp.mjs';
import { COMPANY_TOOL_NAMES } from '../core/company-tools.mjs';

/** Company-finder tools read a public-data snapshot database the hosted server keeps; offered only when one is set. */
export function localTools(env = process.env) {
  return env.MRM_DATAGO_DB ? ALL_TOOLS : ALL_TOOLS.filter(tool => !COMPANY_TOOL_NAMES.has(tool.name));
}

export async function handleLine(handler, line, env = process.env) {
  const text = line.trim();
  if (!text) return null;
  const response = await handler(new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }), env);
  if (response.status === 202) return null;  // notification: no reply
  return (await response.text()).trim();
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain || process.env.K_DEAL_SKILL_STDIO === '1') {
  const handler = createHandler({ tools: localTools(), local: true });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on('line', line => {
    queue = queue.then(async () => {
      try { const out = await handleLine(handler, line); if (out) process.stdout.write(out + '\n'); }
      catch (error) { console.error('k-deal-skill:', error?.message ?? error); }
    });
  });
}
