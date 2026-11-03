import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, ALL_TOOLS } from '../core/mcp.mjs';
import { handleLine, localTools } from './stdio.mjs';

const rpc = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('self-hosted stdio answers initialize, lists tools and runs a call with no token or gateway', async () => {
  const env = {};
  const handler = createHandler({ tools: localTools(env), local: true });
  const init = JSON.parse(await handleLine(handler, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), env));
  assert.match(init.result.instructions, /이 PC에서 사용자 본인 API 키/);
  assert.ok(!init.result.instructions.includes('mrm_usage_status'), 'no hosted usage tool locally');
  assert.equal(await handleLine(handler, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), env), null);
  const names = JSON.parse(await handleLine(handler, rpc(2, 'tools/list'), env)).result.tools.map(t => t.name);
  assert.ok(names.includes('dart_audit_financials') && names.includes('law_applicable') && names.includes('mrm_connection_status'));
  assert.ok(!names.includes('company_search') && !names.includes('mrm_usage_status'), 'snapshot and hosted-only tools are left out');
  const status = JSON.parse(JSON.parse(await handleLine(handler, rpc(3, 'tools/call', { name: 'mrm_connection_status', arguments: {} }), env)).result.content[0].text);
  assert.deepEqual(status.keys_present, { dart: false, krx: false, datago: false, law: false });
  const dart = JSON.parse(await handleLine(handler, rpc(4, 'tools/call', { name: 'dart_corp_search', arguments: { query: '삼성전자' } }), env));
  assert.equal(dart.result.isError, true);
  assert.equal(JSON.parse(dart.result.content[0].text).error.code, 'not_connected');
});

test('company finder tools appear only with a snapshot database', () => {
  assert.equal(localTools({ MRM_DATAGO_DB: '/tmp/x.sqlite' }).length, ALL_TOOLS.length);
  assert.ok(localTools({}).length < ALL_TOOLS.length);
});
