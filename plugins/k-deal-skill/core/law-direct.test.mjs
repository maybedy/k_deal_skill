import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchLawTool } from './law-tools.mjs';
import { joCode, buildRequest, redactOc, rankLaws } from './law-direct.mjs';

function fakeFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); };
  return { calls, fetchImpl };
}

test('article numbers map to DRF JO codes', () => {
  assert.equal(joCode('제750조'), '075000');
  assert.equal(joCode('제10조의2'), '001002');
  assert.equal(joCode('10조'), '001000');
  assert.equal(joCode('부칙'), null);
});

test('decision domains map to DRF targets; nts has no direct body', () => {
  assert.deepEqual(buildRequest('law_decisions_search', { domain: 'tax_tribunal', query: 'x', display: 5, page: 1 }).params.target, 'ttSpecialDecc');
  assert.equal(buildRequest('law_decision_text', { domain: 'constitutional', id: '123' }).params.target, 'detc');
  assert.throws(() => buildRequest('law_decision_text', { domain: 'nts', id: '1' }), /국세청/);
});

test('with LAW_OC the 법제처 API is called directly and OC never appears in output', async () => {
  const { calls, fetchImpl } = fakeFetch({ LawSearch: { totalCnt: '1', law: [{ 법령명한글: '상법', 법령상세링크: '/DRF/lawService.do?OC=myoc-secret&target=law&MST=1' }] } });
  const out = await dispatchLawTool('law_search', { query: '상법', display: 3 }, { LAW_OC: 'myoc-secret' }, { fetchImpl });
  assert.equal(out.status, 'ok');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.origin + url.pathname, 'https://www.law.go.kr/DRF/lawSearch.do');
  assert.equal(url.searchParams.get('target'), 'law');
  assert.equal(url.searchParams.get('type'), 'JSON');
  assert.equal(out.metadata.credential_mode, 'law_oc_direct');
  assert.ok(!JSON.stringify(out).includes('myoc-secret'));
});

test('law_text sends MST, JO and efYd as DRF expects', async () => {
  const { calls, fetchImpl } = fakeFetch({ 법령: { 기본정보: {} } });
  await dispatchLawTool('law_text', { mst: '281865', article: '제382조', date: '20260101' }, { LAW_OC: 'abcdef' }, { fetchImpl });
  const p = new URL(calls[0]).searchParams;
  assert.deepEqual([p.get('target'), p.get('MST'), p.get('JO'), p.get('efYd')], ['eflaw', '281865', '038200', '20260101']);
});

test('DRF rejection envelopes and HTML pages are errors, not empty results', async () => {
  const rejected = await dispatchLawTool('law_search', { query: 'x' }, { LAW_OC: 'abcdef' }, fakeFetch({ result: '사용자 정보 검증에 실패하였습니다.', msg: 'OC 확인' }));
  assert.equal(rejected.status, 'error');
  assert.equal(rejected.metadata.error.code, 'law_api_rejected');
  const html = await dispatchLawTool('law_search', { query: 'x' }, { LAW_OC: 'abcdef' }, fakeFetch('<html>점검중</html>'));
  assert.equal(html.metadata.error.code, 'law_api_non_json');
});

test('without LAW_OC the lookup is refused', async () => {
  const { calls, fetchImpl } = fakeFetch({});
  const out = await dispatchLawTool('law_search', { query: 'x' }, {}, { fetchImpl });
  assert.equal(out.metadata.error.code, 'not_connected');
  assert.equal(calls.length, 0);
});

test('redaction removes OC query values', () => {
  assert.equal(redactOc('a?OC=dy&x=1', 'dy'), 'a?OC=[REDACTED]&x=1');
});

test('law_search ranks the exact law name first and trims to the requested size', async () => {
  const laws = ['국가배상법', '공무원 재해보상법', '상법 시행령', '상법시행법', '상법', '기상법'].map(n => ({ 법령명한글: n }));
  assert.deepEqual(rankLaws(laws, '상법').map(l => l.법령명한글), ['상법', '상법 시행령', '상법시행법', '국가배상법', '공무원 재해보상법', '기상법']);
  const { calls, fetchImpl } = fakeFetch({ LawSearch: { totalCnt: '6', law: laws } });
  const out = await dispatchLawTool('law_search', { query: '상법', display: 2 }, { LAW_OC: 'abcdef' }, { fetchImpl });
  assert.equal(new URL(calls[0]).searchParams.get('display'), '100');
  assert.deepEqual(out.data.LawSearch.law.map(l => l.법령명한글), ['상법', '상법 시행령']);
  assert.match(out.metadata.ranking, /일치도/);
});

test('when the 법제처 API fails, no other server is contacted', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ result: '검증 실패', msg: 'IP 미등록' }));
  };
  const out = await dispatchLawTool('law_search', { query: '상법' }, { LAW_OC: 'secret-oc-123' }, { fetchImpl });
  assert.equal(out.status, 'error');
  assert.equal(out.metadata.error.code, 'law_api_rejected');
  assert.ok(seen.length >= 1 && seen.every(url => url.startsWith('https://www.law.go.kr/')));
  assert.ok(!JSON.stringify(out).includes('secret-oc-123'));
});

test('article notation variants map to the same JO code', () => {
  for (const text of ['제750조제1항', '제750조 제1항 제2호', '第750條', '075000', '750조']) assert.equal(joCode(text), '075000');
  assert.equal(joCode('제10조-2'), '001002');
  assert.equal(joCode('제0조'), null);
});

function routedFetch(routes) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const u = new URL(url);
    const route = routes.find(r => r.match(u.pathname, u.searchParams));
    const body = typeof route.body === 'function' ? route.body() : route.body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: route.status ?? 200 });
  };
  return { calls, fetchImpl };
}
const article = (no, kind = '조문', branch) => ({ 조문번호: String(no), 조문여부: kind, ...(branch ? { 조문가지번호: String(branch) } : {}) });

test('law_id with a date reads the version in force on that date and keeps only the requested article', async () => {
  const versions = { LawSearch: { totalCnt: '3', law: [
    { 법령일련번호: '284415', 시행일자: '20260317', 공포일자: '20260317', 현행연혁코드: '현행', 법령명한글: '민법' },
    { 법령일련번호: '246569', 시행일자: '20230628', 공포일자: '20221227', 현행연혁코드: '연혁', 법령명한글: '민법' },
    { 법령일련번호: '198475', 시행일자: '20180201', 공포일자: '20170131', 현행연혁코드: '연혁', 법령명한글: '민법' },
  ] } };
  const { calls, fetchImpl } = routedFetch([
    { match: p => p.endsWith('lawSearch.do'), body: versions },
    { match: p => p.endsWith('lawService.do'), body: { 법령: { 기본정보: { 시행일자: '20180201' }, 조문: { 조문단위: [article(750, '전문'), article(750), article(750, '조문', 2)] } } } },
  ]);
  const out = await dispatchLawTool('law_text', { law_id: '001706', article: '제750조', date: '20200615' }, { LAW_OC: 'abcdef' }, { fetchImpl });
  assert.equal(out.status, 'ok');
  const list = new URL(calls[0]).searchParams;
  assert.deepEqual([list.get('target'), list.get('LID')], ['eflaw', '001706']);
  const body = new URL(calls[1]).searchParams;
  assert.deepEqual([body.get('target'), body.get('MST'), body.get('efYd'), body.get('JO'), body.get('ID')], ['eflaw', '198475', '20180201', '075000', null]);
  assert.deepEqual(out.metadata.version, { requested_date: '20200615', mst: '198475', effective: '20180201', promulgated: '20170131', status: '연혁', name_then: '민법', resolved_by: 'version_list' });
  assert.deepEqual(out.data.법령.조문.조문단위, [article(750)]);
});

test('a date before the first version, a missing article and empty or message-only bodies are not_found errors', async () => {
  const versions = { LawSearch: { totalCnt: '1', law: [{ 법령일련번호: '1', 시행일자: '19600101', 현행연혁코드: '연혁' }] } };
  let out = await dispatchLawTool('law_text', { law_id: '001706', date: '19500101' }, { LAW_OC: 'abcdef' }, routedFetch([{ match: () => true, body: versions }]));
  assert.equal(out.metadata.error.code, 'not_found');
  out = await dispatchLawTool('law_text', { law_id: '001706', article: '제9999조' }, { LAW_OC: 'abcdef' },
    routedFetch([{ match: () => true, body: { 법령: { 조문: { 조문단위: [article(1)] } } } }]));
  assert.match(out.metadata.error.message, /제9999조/);
  out = await dispatchLawTool('law_text', { mst: '246569', date: '20230101' }, { LAW_OC: 'abcdef' }, routedFetch([{ match: () => true, body: {} }]));
  assert.equal(out.metadata.error.code, 'not_found');
  assert.match(out.metadata.error.message, /law_id와 date/);
  out = await dispatchLawTool('law_decision_text', { domain: 'precedent', id: '99999999' }, { LAW_OC: 'abcdef' },
    routedFetch([{ match: () => true, body: { Law: '일치하는 판례가 없습니다.  판례명을 확인하여 주십시오.' } }]));
  assert.equal(out.metadata.error.code, 'not_found');
  out = await dispatchLawTool('law_decision_text', { domain: 'precedent', id: '1' }, { LAW_OC: 'abcdef' }, routedFetch([{ match: () => true, body: '' }]));
  assert.equal(out.metadata.error.code, 'law_api_empty');
  out = await dispatchLawTool('law_search', { query: '없는법' }, { LAW_OC: 'abcdef' }, routedFetch([{ match: () => true, body: { LawSearch: { totalCnt: '0' } } }]));
  assert.equal(out.status, 'ok', 'an empty search is a valid empty result');
});

test('부칙 returns only the addenda, latest first', async () => {
  const out = await dispatchLawTool('law_text', { law_id: '001702', article: '부칙' }, { LAW_OC: 'abcdef' }, routedFetch([{ match: () => true, body: { 법령: {
    기본정보: { 법령명_한글: '상법' }, 조문: { 조문단위: [article(1)] }, 개정문: 'x',
    부칙: { 부칙단위: [{ 부칙공포일자: '19620120' }, { 부칙공포일자: '20250909' }, { 부칙공포일자: '20111215' }] } } } }]));
  assert.deepEqual(Object.keys(out.data.법령), ['기본정보', '부칙']);
  assert.deepEqual(out.data.법령.부칙.부칙단위.map(u => u.부칙공포일자), ['20250909', '20111215', '19620120']);
});

test('a brief 503 is retried and then answered', async () => {
  let n = 0;
  const { calls, fetchImpl } = routedFetch([{ match: () => true, status: undefined, body: () => ({ LawSearch: { totalCnt: '0' } }) }]);
  const flaky = async url => (++n === 1 ? new Response('busy', { status: 503 }) : fetchImpl(url));
  const out = await dispatchLawTool('law_search', { query: '상법' }, { LAW_OC: 'abcdef' }, { fetchImpl: flaky, sleep: async () => {} });
  assert.equal(out.status, 'ok');
  assert.equal(n, 2);
  assert.equal(calls.length, 1);
});
