import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { dispatchExtraTool, parseCorpCodes, searchCorps, documentText } from './extra-tools.mjs';
import { readZip } from './zip.mjs';
import { dispatchLawTool } from './law-tools.mjs';

/** Builds a one-file deflate ZIP so the reader is tested against a real archive layout. */
function makeZip(name, text) {
  const data = Buffer.from(text, 'utf8'), comp = deflateRawSync(data), nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
}
const CORPS = '<result><list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name><stock_code>005930</stock_code><modify_date>20250101</modify_date></list>'
  + '<list><corp_code>00000002</corp_code><corp_name>삼성전자서비스</corp_name><corp_eng_name></corp_eng_name><stock_code> </stock_code><modify_date>20250101</modify_date></list>'
  + '<list><corp_code>00000003</corp_code><corp_name>카카오</corp_name><corp_eng_name>KAKAO</corp_eng_name><stock_code>035720</stock_code><modify_date>20250101</modify_date></list></result>';
const env = { DART_API_KEY: 'dart-secret-key', KRX_API_KEY: 'krx-secret' };

test('zip reader inflates entries', () => {
  assert.equal(readZip(makeZip('CORPCODE.xml', CORPS))[0].data.toString('utf8'), CORPS);
});

test('corp search ranks exact names first and supports stock codes', () => {
  const list = parseCorpCodes(CORPS);
  assert.equal(list.length, 3);
  assert.deepEqual(searchCorps(list, '삼성전자').map(c => c.corp_code), ['00126380', '00000002']);
  assert.deepEqual(searchCorps(list, '005930').map(c => c.corp_name), ['삼성전자']);
  assert.deepEqual(searchCorps(list, '삼성', { listedOnly: true }).map(c => c.corp_code), ['00126380']);
});

test('dart_corp_search downloads the code list without exposing the key', async () => {
  const calls = [];
  const out = await dispatchExtraTool('dart_corp_search', { query: '카카오' }, env, { fetchImpl: async url => { calls.push(url); return new Response(makeZip('CORPCODE.xml', CORPS)); } });
  assert.equal(out.status, 'ok');
  assert.equal(out.data[0].corp_code, '00000003');
  assert.match(calls[0], /corpCode\.xml/);
  assert.ok(!JSON.stringify(out).includes('dart-secret-key'));
});

test('dart_report validates the group parameters and maps DART status codes', async () => {
  assert.equal((await dispatchExtraTool('dart_report', { api: 'hyslrSttus', corp_code: '00126380' }, env)).error.code, 'invalid_input');
  assert.equal((await dispatchExtraTool('dart_report', { api: 'nope', corp_code: '00126380' }, env)).error.code, 'invalid_input');
  const calls = [];
  const fetchImpl = async url => { calls.push(new URL(url)); return new Response(JSON.stringify({ status: '000', message: '정상', list: [{ nm: '이재용' }] })); };
  const ok = await dispatchExtraTool('dart_report', { api: 'hyslrSttus', corp_code: '00126380', bsns_year: 2024, reprt_code: '11011' }, env, { fetchImpl });
  assert.deepEqual(ok.data, [{ nm: '이재용' }]);
  assert.equal(calls[0].pathname, '/api/hyslrSttus.json');
  assert.equal(ok.metadata.report, '최대주주 현황');
  assert.ok(!JSON.stringify(ok).includes('dart-secret-key'));
  const empty = await dispatchExtraTool('dart_report', { api: 'cvbdIsDecsn', corp_code: '00126380', bgn_de: '20240101', end_de: '20241231' }, env, { fetchImpl: async () => new Response(JSON.stringify({ status: '013', message: '조회된 데이타가 없습니다.' })) });
  assert.equal(empty.metadata.data_status, 'no_data');
  const limited = await dispatchExtraTool('dart_report', { api: 'majorstock', corp_code: '00126380' }, env, { fetchImpl: async () => new Response(JSON.stringify({ status: '020', message: '사용한도 초과' })) });
  assert.equal(limited.error.code, 'rate_limited');
});

test('dart_document turns the filing archive into paged text', async () => {
  const xml = '<?xml version="1.0" encoding="utf-8"?><DOCUMENT><TITLE>사업보고서</TITLE><P>본문 &amp; 내용</P><TABLE><TR><TD>매출</TD><TD>100</TD></TR></TABLE></DOCUMENT>';
  const out = await dispatchExtraTool('dart_document', { rcept_no: '20250311001085', max_chars: 1000 }, env, { fetchImpl: async () => new Response(makeZip('20250311001085.xml', xml)) });
  assert.equal(out.status, 'ok');
  assert.match(out.data.text, /사업보고서\n본문 & 내용/);
  assert.match(out.data.text, /매출\t100/);
  const missing = await dispatchExtraTool('dart_document', { rcept_no: '20250311001085' }, env, { fetchImpl: async () => new Response('<result><status>014</status></result>') });
  assert.equal(missing.error.code, 'no_document');
  assert.equal(documentText('<P>a&#x41;b</P>'), 'aAb');
});

test('krx_daily filters rows and reports unapproved APIs plainly', async () => {
  const rows = [{ ISU_CD: 'A', ISU_NM: 'KODEX 200' }, { ISU_CD: 'B', ISU_NM: 'TIGER 200' }];
  const out = await dispatchExtraTool('krx_daily', { api: 'etp/etf_bydd_trd', date: '20261023', name_contains: 'KODEX' }, env, { fetchImpl: async (url, init) => { assert.equal(init.headers.AUTH_KEY, 'krx-secret'); return new Response(JSON.stringify({ OutBlock_1: rows })); } });
  assert.deepEqual(out.data.map(r => r.ISU_CD), ['A']);
  assert.equal(out.metadata.rows_total, 2);
  const denied = await dispatchExtraTool('krx_daily', { api: 'idx/kospi_dd_trd', date: '20261023' }, env, { fetchImpl: async () => new Response('{"respCode":"401"}', { status: 401 }) });
  assert.equal(denied.error.code, 'not_approved');
});

test('law_catalog finds APIs locally and law_api only sends documented parameters', async () => {
  const cat = await dispatchLawTool('law_catalog', { query: '신구법', kind: 'body' }, {});
  assert.ok(cat.data.some(a => a.target === 'oldAndNew'));
  const calls = [];
  const fetchImpl = async url => { calls.push(new URL(url)); return new Response(JSON.stringify({ OldAndNewService: {} })); };
  const id = cat.data.find(a => a.target === 'oldAndNew').api_id;
  const ok = await dispatchLawTool('law_api', { api_id: id, params: { MST: '273629' } }, { LAW_OC: 'abcdef' }, { fetchImpl });
  assert.equal(ok.status, 'ok');
  assert.equal(calls[0].searchParams.get('target'), 'oldAndNew');
  const bad = await dispatchLawTool('law_api', { api_id: id, params: { evil: 'x' } }, { LAW_OC: 'abcdef' }, { fetchImpl });
  assert.equal(bad.metadata.error.code, 'invalid_input');
  const noKey = await dispatchLawTool('law_api', { api_id: id, params: { MST: '1' } }, {}, { fetchImpl });
  assert.equal(noKey.metadata.error.code, 'not_connected');
});

test('ministry interpretations are searchable as direct-only domains', async () => {
  const calls = [];
  const out = await dispatchLawTool('law_decisions_search', { domain: 'moefCgmExpc', query: '부가가치세' }, { LAW_OC: 'abcdef' }, { fetchImpl: async url => { calls.push(new URL(url)); return new Response(JSON.stringify({ CgmExpcSearch: {} })); } });
  assert.equal(out.status, 'ok');
  assert.equal(calls[0].searchParams.get('target'), 'moefCgmExpc');
  const noKey = await dispatchLawTool('law_decisions_search', { domain: 'moefCgmExpc', query: 'x' }, {});
  assert.equal(noKey.metadata.error.code, 'not_connected');
});
