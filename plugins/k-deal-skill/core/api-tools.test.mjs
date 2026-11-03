import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, dispatchTool, parsePublicDataResponse, marketWideEnd } from './api-tools.mjs';

const now = () => new Date('2026-10-23T02:00:00.000Z');
const env = { DART_API_KEY: 'DART-TEST-ONLY', KRX_API_KEY: 'KRX-TEST-ONLY', DATA_GO_KR_KEY: 'PUBLIC+TEST/ONLY=' };
const financialArgs = { corp_code: '00126380', year: 2025, report: '11011', fs_div: 'CFS' };
const disclosureArgs = { corp_code: '00126380', begin: '20260101', end: '20260930' };
const krxArgs = { market: 'KOSPI', date: '20261021', codes: ['005930'] };
const customsArgs = { hs: '3304', start_ym: '202601', end_ym: '202609' };
function json(value, init) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init }); }
function publicEnvelope(items = [], total = items.length, code = '00') {
  return { response: { header: { resultCode: code, resultMsg: 'NORMAL' }, body: { items: { item: items }, totalCount: total } } };
}
function fixture(response) {
  const calls = [];
  return { calls, options: { now, fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return typeof response === 'function' ? response() : response; } } };
}
function absentSecrets(value, secrets = Object.values(env)) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
}

test('the published tool contract exposes exactly bounded read-only source operations', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map(tool => tool.name), ['dart_disclosures', 'dart_financials', 'krx_base', 'krx_trade', 'fsc_outline', 'fsc_financials', 'fsc_affiliates', 'customs_trade']);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'api_key'), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'url'), false);
  }
});

test('DART full-account financial requests preserve basis, receipt IDs and source strings', async () => {
  for (const fs_div of ['CFS', 'OFS']) {
    const row = { rcept_no: '20260318000001', account_id: 'ifrs-full_Revenue', thstrm_amount: '001,234', fs_div };
    const f = fixture(json({ status: '000', list: [row] }));
    const result = await dispatchTool('dart_financials', { ...financialArgs, fs_div, report: '11014' }, env, f.options);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.data, [row]);
    const request = f.calls[0];
    assert.equal(request.url.origin, 'https://opendart.fss.or.kr');
    assert.equal(request.url.pathname, '/api/fnlttSinglAcntAll.json');
    assert.equal(request.url.searchParams.get('fs_div'), fs_div);
    assert.equal(request.url.searchParams.get('reprt_code'), '11014');
    assert.equal(request.url.searchParams.get('bsns_year'), '2025');
    assert.equal(request.url.searchParams.get('crtfc_key'), env.DART_API_KEY);
    assert.deepEqual(result.metadata.receipt_numbers, ['20260318000001']);
    assert.equal(result.metadata.source_asof.basis, fs_div);
    assert.equal(result.metadata.fetched_at, now().toISOString());
    absentSecrets(result);
  }
});

test('DART disclosures fetch only the requested page and flag incomplete inventories', async () => {
  const f = fixture(json({ status: '000', total_page: 3, total_count: 5, list: [{ rcept_no: '20260102000001', rcept_dt: '20260102' }, { rcept_no: '20260103000001', rcept_dt: '20260103' }] }));
  const result = await dispatchTool('dart_disclosures', { ...disclosureArgs, page_no: 2, num_rows: 2, last_report_only: true, type: 'A' }, env, f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url.searchParams.get('page_no'), '2');
  assert.equal(f.calls[0].url.searchParams.get('page_count'), '2');
  assert.equal(f.calls[0].url.searchParams.get('last_reprt_at'), 'Y');
  assert.equal(result.status, 'partial');
  assert.equal(result.metadata.pagination.complete, false);
  assert.equal(result.metadata.pagination.auto_pagination, false);
  assert.deepEqual(result.metadata.source_asof.observed_filing_dates, ['20260102', '20260103']);
});

test('DART market-wide disclosures drop corp_code, keep the three-month limit and filter a page by report name', async () => {
  const rows = [
    { rcept_no: '20261028000001', rcept_dt: '20261028', report_nm: '주요사항보고서(전환사채권발행결정)' },
    { rcept_no: '20261028000002', rcept_dt: '20261028', report_nm: '[기재정정]주요사항보고서(유상증자결정)' },
  ];
  const f = fixture(json({ status: '000', total_page: 3, total_count: 215, list: rows }));
  const args = { begin: '20261027', end: '20261102', type: 'B', detail_type: 'B001', corp_cls: 'K', sort: 'rpt', sort_order: 'asc', report_name_contains: '전환사채권 발행결정' };
  const result = await dispatchTool('dart_disclosures', args, env, f.options);
  const sent = f.calls[0].url.searchParams;
  assert.equal(sent.has('corp_code'), false);
  assert.equal(sent.get('pblntf_ty'), 'B');
  assert.equal(sent.get('pblntf_detail_ty'), 'B001');
  assert.equal(sent.get('corp_cls'), 'K');
  assert.equal(sent.get('sort'), 'rpt');
  assert.equal(sent.get('sort_mth'), 'asc');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data.map(row => row.rcept_no), ['20261028000001']);
  assert.deepEqual(result.metadata.report_name_filter, { contains: '전환사채권 발행결정', page_rows: 2, kept_rows: 1, note: 'Applied to this page only; read the other pages before concluding a filing is absent.' });
  assert.equal(result.metadata.source_asof.scope, 'market_wide');
  absentSecrets(result);

  assert.equal(marketWideEnd('20260802'), '20261102');
  assert.equal(marketWideEnd('20261130'), '20270228');
  const ok = fixture(json({ status: '000', total_page: 0, total_count: 0, list: [] }));
  assert.notEqual((await dispatchTool('dart_disclosures', { begin: '20260802', end: '20261102' }, env, ok.options)).status, 'error');
  for (const bad of [
    { begin: '20260801', end: '20261102' },
    { begin: '20261027', end: '20261102', type: 'A', detail_type: 'B001' },
    { begin: '20261027', end: '20261102', detail_type: 'B1' },
    { begin: '20261027', end: '20261102', corp_cls: 'X' },
    { begin: '20261027', end: '20261102', sort: 'name' },
    { begin: '20261027', end: '20261102', report_name_contains: ' ' },
  ]) {
    const none = fixture(json({ status: '000' }));
    const refused = await dispatchTool('dart_disclosures', bad, env, none.options);
    assert.equal(refused.status, 'error', JSON.stringify(bad));
    assert.equal(refused.error.code, 'invalid_input');
    assert.equal(none.calls.length, 0);
  }
  // A single company still allows a full year.
  const year = fixture(json({ status: '000', total_page: 0, total_count: 0, list: [] }));
  assert.notEqual((await dispatchTool('dart_disclosures', disclosureArgs, env, year.options)).status, 'error');
});

test('DART no-data is distinct from credential, quota and malformed-response errors', async () => {
  for (const tool of ['dart_financials', 'dart_disclosures']) {
    const args = tool === 'dart_financials' ? financialArgs : disclosureArgs;
    let result = await dispatchTool(tool, args, env, fixture(json({ status: '013', message: 'No data' })).options);
    assert.equal(result.status, 'no_data');
    for (const status of ['010', '020', '800']) {
      result = await dispatchTool(tool, args, env, fixture(json({ status, message: `bad ${env.DART_API_KEY} https://signed.invalid/?signature=never-show` })).options);
      assert.equal(result.error.code, `dart_${status}`);
      assert.equal(JSON.stringify(result).includes('never-show'), false);
      absentSecrets(result);
    }
  }
  for (const reply of [{ status: '000' }, { status: '013', list: [{ amount: '5' }] }, { status: '013', list: {} }, { status: '000', list: 'broken' }]) {
    const result = await dispatchTool('dart_financials', financialArgs, env, fixture(json(reply)).options);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'invalid_response');
  }
});

test('DART provider pagination inconsistencies cannot appear complete', async () => {
  for (const reply of [
    { status: '000', total_count: 1, total_page: 1, list: [{}, {}] },
    { status: '000', total_count: 'not-a-number', total_page: 1, list: [{}] },
    { status: '000', total_count: 0, total_page: 1, list: [] },
  ]) {
    const result = await dispatchTool('dart_disclosures', disclosureArgs, env, fixture(json(reply)).options);
    assert.equal(result.error.code, 'invalid_response');
  }
});

test('all six KRX routes use header authentication and preserve raw fields', async () => {
  const routes = { krx_trade: { KOSPI: 'stk_bydd_trd', KOSDAQ: 'ksq_bydd_trd', KONEX: 'knx_bydd_trd' }, krx_base: { KOSPI: 'stk_isu_base_info', KOSDAQ: 'ksq_isu_base_info', KONEX: 'knx_isu_base_info' } };
  for (const [name, markets] of Object.entries(routes)) for (const [market, route] of Object.entries(markets)) {
    const field = name === 'krx_base' ? 'ISU_SRT_CD' : 'ISU_CD';
    const row = { [field]: '005930', BAS_DD: '20261021', TDD_CLSPRC: '70,000' };
    const f = fixture(json({ OutBlock_1: [row, { [field]: '000660' }] }));
    const result = await dispatchTool(name, { ...krxArgs, market }, env, f.options);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.data, [row]);
    assert.equal(f.calls[0].url.pathname, `/svc/apis/sto/${route}`);
    assert.equal(f.calls[0].url.search, '?basDd=20261021');
    assert.equal(f.calls[0].init.headers.AUTH_KEY, env.KRX_API_KEY);
    assert.equal(result.metadata.source_asof.requested_date, '20261021');
    assert.equal(result.metadata.coverage.provider_row_count, 2);
    absentSecrets(result);
  }
});

test('KRX empty, partial security coverage and provider errors stay distinct', async () => {
  let result = await dispatchTool('krx_trade', krxArgs, env, fixture(json({ OutBlock_1: [] })).options);
  assert.equal(result.status, 'no_data');
  assert.deepEqual(result.metadata.coverage.unmatched_codes, ['005930']);
  assert.match(result.metadata.empty_result_note, /does not establish a holiday/);
  result = await dispatchTool('krx_trade', { ...krxArgs, codes: ['005930', '000660'] }, env, fixture(json({ OutBlock_1: [{ ISU_CD: '005930' }] })).options);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.metadata.coverage.unmatched_codes, ['000660']);
  for (const bad of [{ message: 'bad key' }, { OutBlock_1: [{}] }, { OutBlock_1: '' }]) {
    result = await dispatchTool('krx_trade', krxArgs, env, fixture(json(bad)).options);
    assert.equal(result.error.code, 'invalid_response');
  }
});

test('FSC routes retain identity, period, basis fields and bounded pagination', async () => {
  const cases = [
    ['fsc_outline', { corp_name: '삼성전자', page_no: 2, num_rows: 10 }, 'getCorpOutline_V2', { corpNm: '삼성전자' }],
    ['fsc_financials', { crno: '1234567890123', year: 2025 }, 'getSummFinaStat_V2', { crno: '1234567890123', bizYear: '2025' }],
    ['fsc_affiliates', { crno: '1234567890123', base_date: '20261001' }, 'getAffiliate_V2', { basDt: '20261001' }],
  ];
  for (const [name, args, suffix, expected] of cases) {
    const row = { basDt: '20261001', bizYear: '2025', fnclDcdNm: '연결', enpSaleAmt: '001234' };
    const f = fixture(json(publicEnvelope([row], 15)));
    const result = await dispatchTool(name, args, env, f.options);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.data, [row]);
    assert.ok(f.calls[0].url.pathname.endsWith(suffix));
    for (const [key, value] of Object.entries(expected)) assert.equal(f.calls[0].url.searchParams.get(key), value);
    assert.equal(result.metadata.pagination.auto_pagination, false);
    assert.deepEqual(result.metadata.source_asof.observed_dates, ['20261001']);
    absentSecrets(result);
  }
});

test('encoded and decoded public-data keys are encoded exactly once', async () => {
  for (const publicEnv of [{ DATA_GO_KR_KEY: 'A+B/C=%value' }, { DATA_GO_KR_KEY_ENC: 'A%2BB%2FC%3D%25value' }]) {
    const f = fixture(json(publicEnvelope([], 0)));
    const result = await dispatchTool('fsc_outline', { crno: '1234567890123' }, publicEnv, f.options);
    assert.equal(result.status, 'no_data');
    assert.equal(f.calls[0].url.searchParams.get('serviceKey'), 'A+B/C=%value');
    assert.equal(f.calls[0].url.toString().includes('%252B'), false);
    absentSecrets(result, Object.values(publicEnv));
  }
});

test('customs actual XML parsing preserves amounts, CDATA, namespace and total rows', async () => {
  const xml = `<?xml version="1.0"?><ns:response xmlns:ns="urn:test"><ns:header><ns:resultCode>00</ns:resultCode></ns:header><ns:body><ns:items>
    <ns:item><ns:year>총계</ns:year><ns:expDlr>001234</ns:expDlr><ns:hsNm><![CDATA[화장품 & 기타]]></ns:hsNm></ns:item>
    <ns:item><ns:year>2026.01</ns:year><ns:expDlr>000123</ns:expDlr><ns:hsNm>향수 &amp; 기타</ns:hsNm></ns:item>
    </ns:items><ns:totalCount>2</ns:totalCount></ns:body></ns:response>`;
  const f = fixture(new Response(xml, { headers: { 'content-type': 'application/xml' } }));
  const result = await dispatchTool('customs_trade', { ...customsArgs, country: 'JP' }, env, f.options);
  assert.equal(result.status, 'ok');
  assert.equal(result.data[0].expDlr, '001234');
  assert.equal(result.data[0].hsNm, '화장품 & 기타');
  assert.equal(result.data[1].hsNm, '향수 & 기타');
  assert.equal(f.calls[0].url.pathname, '/1220000/nitemtrade/getNitemtradeList');
  assert.equal(f.calls[0].url.searchParams.get('cntyCd'), 'JP');
  assert.equal(f.calls[0].url.searchParams.get('strtYymm'), '202601');
  assert.equal(result.metadata.source_asof.period_end, '202609');
  assert.match(result.metadata.aggregation_note, /중복 합산/);
  absentSecrets(result);
});

test('customs all-country route and public JSON object item are supported', async () => {
  const reply = { response: { header: { resultCode: '00' }, body: { items: { item: { year: '2026.01', impDlr: '0009' } }, totalCount: '1' } } };
  const f = fixture(json(reply));
  const result = await dispatchTool('customs_trade', customsArgs, env, f.options);
  assert.equal(f.calls[0].url.pathname, '/1220000/Itemtrade/getItemtradeList');
  assert.equal(f.calls[0].url.searchParams.has('cntyCd'), false);
  assert.equal(result.data[0].impDlr, '0009');
});

test('public-data no-data, missing payload and provider errors are not conflated', async () => {
  let result = await dispatchTool('fsc_outline', { crno: '1234567890123' }, env, fixture(json({ response: { header: { resultCode: '03' } } })).options);
  assert.equal(result.status, 'no_data');
  for (const payload of [
    { response: { header: { resultCode: '00' } } },
    publicEnvelope([{}], 0),
    publicEnvelope([{}], 1, '03'),
    { response: { header: { resultCode: '00' }, body: { items: 'unexpected', totalCount: 1 } } },
  ]) {
    result = await dispatchTool('fsc_outline', { crno: '1234567890123' }, env, fixture(json(payload)).options);
    assert.equal(result.error.code, 'invalid_response');
  }
  result = await dispatchTool('customs_trade', customsArgs, env, fixture(new Response(`<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode><errMsg>${env.DATA_GO_KR_KEY}</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`)).options);
  assert.equal(result.error.code, 'public_data_30');
  absentSecrets(result);
});

test('XML entity declarations, malformed XML and excessive nesting are rejected', async () => {
  let parserCalled = false;
  await assert.rejects(parsePublicDataResponse('<!DOCTYPE response [<!ENTITY x SYSTEM "file:///secret">]><response>&x;</response>', { parseXml: () => { parserCalled = true; } }), error => error.code === 'invalid_response');
  assert.equal(parserCalled, false);
  for (const xml of ['<response><broken></response>', '<a>'.repeat(40) + 'x' + '</a>'.repeat(40)]) {
    await assert.rejects(parsePublicDataResponse(xml), error => error.code === 'invalid_response');
  }
});

test('an empty later public-data page is no-data for that page, not a complete inventory', async () => {
  const result = await dispatchTool('fsc_outline', { crno: '1234567890123', page_no: 2 }, env, fixture(json(publicEnvelope([], 0, '03'))).options);
  assert.equal(result.status, 'no_data');
  assert.equal(result.metadata.partial, false);
  assert.equal(result.metadata.pagination.complete, false);
});

test('invalid, unbounded and injected inputs fail before any network access', async () => {
  const cases = [
    ['fetch_url', { url: 'https://arbitrary.invalid' }],
    ['dart_financials', { ...financialArgs, endpoint: 'https://arbitrary.invalid' }],
    ['dart_financials', { ...financialArgs, fs_div: undefined }],
    ['dart_disclosures', { ...disclosureArgs, begin: '20260230' }],
    ['dart_disclosures', { ...disclosureArgs, begin: '20240101' }],
    ['dart_disclosures', { ...disclosureArgs, num_rows: 101 }],
    ['krx_trade', { ...krxArgs, market: 'ALL' }],
    ['krx_trade', { ...krxArgs, codes: Array(51).fill('005930') }],
    ['fsc_outline', { crno: '1234567890123', corp_name: '삼성전자' }],
    ['fsc_outline', {}],
    ['fsc_outline', { corp_name: ' ' }],
    ['fsc_financials', { crno: '123', year: 2025 }],
    ['customs_trade', { ...customsArgs, start_ym: '202501' }],
    ['customs_trade', { ...customsArgs, start_ym: '202610' }],
    ['customs_trade', { ...customsArgs, country: 'JPN' }],
    ['customs_trade', { ...customsArgs, hs: '3304&key=bad' }],
  ];
  let calls = 0;
  for (const [name, args] of cases) {
    const result = await dispatchTool(name, args, env, { fetchImpl: async () => { calls++; throw new Error('must not execute'); } });
    assert.equal(result.status, 'error', name);
    assert.ok(['invalid_input', 'unknown_tool'].includes(result.error.code), `${name}: ${result.error.code}`);
  }
  assert.equal(calls, 0);
});

test('missing and malformed source credentials do not execute requests', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw new Error('unexpected'); } };
  for (const [name, args] of [['dart_financials', financialArgs], ['krx_trade', krxArgs], ['customs_trade', customsArgs]]) {
    const result = await dispatchTool(name, args, {}, options);
    assert.equal(result.error.code, 'not_connected');
  }
  const result = await dispatchTool('customs_trade', customsArgs, { DATA_GO_KR_KEY_ENC: '%invalid' }, options);
  assert.equal(result.error.code, 'invalid_credential_format');
  assert.equal(calls, 0);
});

test('all requests are GET over fixed HTTPS endpoints with redirects disabled', async () => {
  const f = fixture(new Response(null, { status: 302, headers: { location: 'https://foreign.invalid' } }));
  const result = await dispatchTool('dart_financials', financialArgs, env, f.options);
  assert.equal(result.error.code, 'redirect_rejected');
  assert.equal(f.calls[0].url.protocol, 'https:');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.redirect, 'error');
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  absentSecrets(result);
});

test('HTTP errors and thrown transport errors never reveal URLs, bodies or keys', async () => {
  const privateUrl = `https://private.invalid/?signature=do-not-show&key=${env.DART_API_KEY}`;
  const cases = [
    { fetchImpl: async () => new Response(`${privateUrl} ${env.DART_API_KEY}`, { status: 403 }) },
    { fetchImpl: async () => { throw new Error(privateUrl); } },
    { fetchImpl: async () => new Response(privateUrl) },
  ];
  for (const options of cases) {
    const result = await dispatchTool('dart_financials', financialArgs, env, options);
    assert.equal(result.status, 'error');
    const text = JSON.stringify(result);
    assert.equal(text.includes('private.invalid'), false);
    assert.equal(text.includes('do-not-show'), false);
    absentSecrets(result);
  }
});

test('timeouts are enforced even when an injected fetch ignores abort', async () => {
  let signal;
  const result = await dispatchTool('dart_financials', financialArgs, env, { timeoutMs: 10, fetchImpl: (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  assert.equal(result.error.code, 'timeout');
  assert.equal(signal.aborted, true);
});

test('response byte limits are enforced for headers and streamed bodies', async () => {
  for (const response of [new Response('x', { headers: { 'content-length': '99' } }), new Response('x'.repeat(33))]) {
    const result = await dispatchTool('dart_financials', financialArgs, env, { ...fixture(response).options, maxResponseBytes: 32 });
    assert.equal(result.error.code, 'response_too_large');
  }
});

test('OPENDART_API_KEY alias works without reading process environment', async () => {
  const f = fixture(json({ status: '013' }));
  const result = await dispatchTool('dart_financials', financialArgs, { OPENDART_API_KEY: 'alias-only' }, f.options);
  assert.equal(result.status, 'no_data');
  assert.equal(f.calls[0].url.searchParams.get('crtfc_key'), 'alias-only');
  absentSecrets(result, ['alias-only']);
});
