import test from 'node:test';
import assert from 'node:assert/strict';
import { LAW_TOOL_DEFINITIONS, dispatchLawTool } from './law-tools.mjs';

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url: String(url), ...options }); const next = responses.shift(); if (next instanceof Error) throw next; return next; };
  return { fetchImpl, calls };
}

test('without LAW_OC every lookup is refused before any network call', async () => {
  const fixture = mockFetch([]);
  for (const [name, args] of [['law_search', { query: '민법' }], ['law_text', { law_id: '001706' }],
    ['law_decisions_search', { domain: 'precedent', query: '손해배상' }], ['law_decision_text', { domain: 'precedent', id: '1' }], ['law_api', { api_id: 1 }]]) {
    const output = await dispatchLawTool(name, args, {}, fixture);
    assert.equal(output.metadata.error.code, 'not_connected');
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal((await dispatchLawTool('law_catalog', { query: '연혁' }, {}, fixture)).status, 'ok');
});

test('lookups go only to the 법제처 Open API and a failure stays an error', async () => {
  const boom = () => new Error('https://bad/?oc=private-key');
  const fixture = mockFetch([new Response('<html>점검중 private-key</html>'), boom(), boom(), boom()]);
  const options = { ...fixture, sleep: async () => {} };
  const html = await dispatchLawTool('law_search', { query: '민법' }, { LAW_OC: 'private-key' }, options);
  assert.equal(html.metadata.error.code, 'law_api_non_json');
  const down = await dispatchLawTool('law_search', { query: '민법' }, { LAW_OC: 'private-key' }, options);
  assert.equal(down.metadata.error.code, 'transport_error');
  for (const output of [html, down]) {
    assert.ok(!JSON.stringify(output).includes('private-key'));
    assert.equal(output.metadata.provider, '법제처 Open API');
  }
  assert.equal(fixture.calls.length, 4, 'a page is not retried, a dropped connection is retried twice');
  assert.ok(fixture.calls.every(call => call.url.startsWith('https://www.law.go.kr/DRF/')));
});

test('unknown tool, endpoints and credential arguments fail before fetching', async () => {
  const fixture = mockFetch([]);
  for (const [name, args, options] of [
    ['execute_tool', {}, {}], ['law_search', { query: '민법', endpoint: 'https://evil.test' }, {}],
    ['law_search', { query: '민법', apiKey: 'not-allowed' }, {}],
    ['law_search', { query: '민법' }, { endpoint: 'https://evil.test' }],
    ['law_search', { query: 'x'.repeat(2001) }, {}],
  ]) {
    const output = await dispatchLawTool(name, args, {}, { ...fixture, ...options });
    assert.equal(output.status, 'error');
    assert.equal(output.data, null);
  }
  assert.equal(fixture.calls.length, 0);
});

test('law identity and real dates are validated before fetching', async () => {
  const fixture = mockFetch([]);
  for (const args of [{}, { law_id: '001706', mst: '123' }, { law_id: '001706', date: '20260230' }, { mst: 'https://evil.test' }]) {
    assert.equal((await dispatchLawTool('law_text', args, {}, fixture)).metadata.error.code, 'invalid_input');
  }
  assert.equal(fixture.calls.length, 0);
});

test('published tool definitions have closed input objects and readonly annotations', () => {
  assert.deepEqual(LAW_TOOL_DEFINITIONS.map(tool => tool.name), ['law_search', 'law_text', 'law_decisions_search', 'law_catalog', 'law_api', 'law_decision_text']);
  for (const tool of LAW_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
});
