import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
const require_catalog = path => readFileSync(path, 'utf8');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchCompanyTool, canonicalName } from './company-tools.mjs';
import { dispatchDatagoTool } from './datago-tools.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mrm-company-'));
const dbPath = join(dir, 'datago.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE nps (사업장명 TEXT, 사업자번호6 TEXT, 법인여부 TEXT, 업종코드 TEXT, 업종명 TEXT, 가입자수 INTEGER, 고지금액 INTEGER, 신규취득 INTEGER, 상실 INTEGER, 상태 INTEGER, 주소 TEXT, 자료월 TEXT);
  CREATE TABLE tsp (신고번호 TEXT, 신고기관 TEXT, 상호 TEXT, 사업자번호 TEXT, 법인여부 TEXT, 대표자 TEXT, 신고일자 TEXT, 소재지 TEXT, 업소상태 TEXT, 판매방식 TEXT, 취급품목 TEXT, 도메인 TEXT, 시도 TEXT);
  CREATE TABLE hs (HS부호 TEXT, 적용시작일자 TEXT, 적용종료일자 TEXT, 한글품목명 TEXT, 영문품목명 TEXT, 한국표준무역분류명 TEXT);`);
const ins = db.prepare('INSERT INTO nps VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
ins.run('（주）아모레퍼시픽', '106860', '1', '242403', '화장품 제조업', 4372, 1, 10, 5, 1, '서울특별시 용산구', '2026-06');
ins.run('(주)정성코스메틱', '123456', '1', '242403', '화장품 제조업', 570, 1, 3, 1, 1, '경기도 화성시', '2026-06');
ins.run('작은화장품', '999990', '2', '242403', '화장품 제조업', 4, 1, 0, 0, 1, '서울특별시 마포구', '2026-06');
ins.run('폐업화장품(주)', '888880', '1', '242403', '화장품 제조업', 50, 1, 0, 0, 2, '서울특별시', '2026-06');
db.prepare('INSERT INTO tsp (상호, 사업자번호, 법인여부, 대표자, 신고일자, 업소상태, 취급품목, 도메인, 시도) VALUES (?,?,?,?,?,?,?,?,?)').run('정성코스메틱', '1234567890', '법인', '홍길동', '20200101', '정상영업', '의류/패션/잡화/뷰티', 'jungsung.co.kr', '경기');
db.prepare('INSERT INTO tsp (상호, 사업자번호, 법인여부, 대표자, 신고일자, 업소상태, 취급품목, 도메인, 시도) VALUES (?,?,?,?,?,?,?,?,?)').run('개인상점', '2222222222', '개인', '김개인', '20210101', '정상영업', '기타', 'smartstore', '서울');
db.prepare('INSERT INTO hs VALUES (?,?,?,?,?,?)').run('8516310000', '20220101', '99991231', '헤어드라이어', 'Hair dryers', '가전');
db.close();
const env = { MRM_DATAGO_DB: dbPath };  // no DART key: listed flags are simply omitted

test('canonical names match across full-width marks, branches and Hangul/Latin group names', () => {
  assert.equal(canonicalName('（주）아모레퍼시픽'), '아모레퍼시픽');
  assert.equal(canonicalName('(주)엘지생활건강'), 'lg생활건강');
  assert.equal(canonicalName('LG생활건강'), 'lg생활건강');
  assert.equal(canonicalName('주식회사 이미인 오산공장'), '이미인오산', 'branch location stays; findListed trims it by prefix');
});

test('industry_companies lists active workplaces by code with size filters and paging', async () => {
  const r = await dispatchCompanyTool('industry_companies', { code_prefix: '2424', min_members: 10, limit: 1 }, env);
  assert.equal(r.status, 'partial');
  assert.equal(r.metadata.total_workplaces, 2, 'excludes the withdrawn workplace and the 4-person one');
  assert.equal(r.data[0].사업장명, '（주）아모레퍼시픽');
  assert.equal(r.metadata.next_offset, 1);
  assert.equal(r.metadata.nps_data_month, '2026-06');
  const corp = await dispatchCompanyTool('industry_companies', { keyword: '화장품', corp_only: true, region: '경기', limit: 5 }, env);
  assert.deepEqual(corp.data.map(x => x.사업장명), ['(주)정성코스메틱']);
  assert.equal((await dispatchCompanyTool('industry_companies', {}, env)).error.code, 'invalid_input');
});

test('industry_codes groups workplaces by code', async () => {
  const r = await dispatchCompanyTool('industry_codes', { keyword: '화장품' }, env);
  assert.equal(r.data[0].업종코드, '242403');
  assert.equal(r.data[0].사업장수, 3);
});

test('company_search finds workplaces and mail-order filings by name or business number, hiding individual owner names', async () => {
  const byName = await dispatchCompanyTool('company_search', { query: '정성코스메틱' }, env);
  assert.equal(byName.data.nps[0].가입자수, 570);
  assert.equal(byName.data.mailorder[0].대표자, '홍길동');
  const byNo = await dispatchCompanyTool('company_search', { bizno: '123-45-67890' }, env);
  assert.equal(byNo.data.mailorder[0].상호, '정성코스메틱');
  assert.equal(byNo.data.nps[0].사업장명, '(주)정성코스메틱', 'NPS publishes only the first 6 digits, so it matches by prefix');
  const individual = await dispatchCompanyTool('mailorder_search', { keyword: '개인상점' }, env);
  assert.equal(individual.data[0].대표자, undefined);
  const hs = await dispatchCompanyTool('hs_search', { query: '851631' }, env);
  assert.equal(hs.data[0].한글품목명, '헤어드라이어');
  assert.equal((await dispatchCompanyTool('company_search', { query: 'x' }, {})).error.code, 'not_connected');
});

test('biz_status posts business numbers to the 국세청 service and keeps the key out of the result', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ status_code: 'OK', request_cnt: 1, match_cnt: 1, data: [{ b_no: '1248100998', b_stt: '계속사업자' }] })); };
  const r = await dispatchDatagoTool('biz_status', { bizno_list: ['124-81-00998'] }, { DATA_GO_KR_KEY_ENC: 'enc%2Bkey' }, { fetchImpl });
  assert.equal(r.data[0].b_stt, '계속사업자');
  assert.deepEqual(calls[0].body, { b_no: ['1248100998'] });
  assert.match(calls[0].url, /serviceKey=enc%2Bkey/);
  assert.ok(!JSON.stringify(r).includes('enc%2Bkey'));
  const denied = await dispatchDatagoTool('biz_status', { bizno_list: ['1248100998'] }, { DATA_GO_KR_KEY_ENC: 'k' }, { fetchImpl: async () => new Response('SERVICE_KEY_IS_NOT_REGISTERED_ERROR', { status: 401 }) });
  assert.equal(denied.error.code, 'not_approved');
});

test('datago_catalog and datago_api follow the catalog and send only documented parameters', async () => {
  const catalogPath = join(dir, 'datago-apis.json');
  writeFileSync(catalogPath, JSON.stringify({ compiled_at: '2026-10-26', services: [
    { id: 'fsc_stock_issue', name: '금융위원회_주식발행정보', provider: '금융위원회', base_url: 'https://apis.data.go.kr/1160100/service/GetStocIssuInfoService_V2', method: 'GET', key_param: 'serviceKey',
      format_param: { name: 'resultType', value: 'json' }, key_status_2026_10_26: 'approved', pe_use: '발행주식 확인',
      operations: [{ id: 'getItemBasiInfo_V2', path: '/getItemBasiInfo_V2', description: '주식 기본정보', params: [{ name: 'crno', required: true, description: '법인등록번호' }, { name: 'numOfRows', required: false, description: '건수' }] }] },
    { id: 'other', name: '미승인', provider: 'x', base_url: 'https://x', key_status_2026_10_26: 'not_registered', operations: [] }] }));
  const cat = await dispatchDatagoTool('datago_catalog', { query: '주식' }, {}, { catalogPath });
  assert.deepEqual(cat.data.map(s => s.service), ['fsc_stock_issue']);
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { totalCount: 1, items: { item: [{ crno: '1' }] } } } })); };
  const ok = await dispatchDatagoTool('datago_api', { service: 'fsc_stock_issue', operation: 'getItemBasiInfo_V2', params: { crno: '1101110000000' } }, { DATA_GO_KR_KEY_ENC: 'enc%2Bkey' }, { catalogPath, fetchImpl });
  assert.equal(ok.status, 'ok');
  assert.match(calls[0], /\/getItemBasiInfo_V2\?serviceKey=enc%2Bkey&resultType=json&crno=1101110000000$/);
  const bad = await dispatchDatagoTool('datago_api', { service: 'fsc_stock_issue', operation: 'getItemBasiInfo_V2', params: { evil: 1 } }, { DATA_GO_KR_KEY_ENC: 'k' }, { catalogPath, fetchImpl });
  assert.equal(bad.error.code, 'invalid_input');
  const missing = await dispatchDatagoTool('datago_api', { service: 'fsc_stock_issue', operation: 'getItemBasiInfo_V2', params: {} }, { DATA_GO_KR_KEY_ENC: 'k' }, { catalogPath, fetchImpl });
  assert.match(missing.error.message, /crno/);
  const paging = JSON.parse(require_catalog(catalogPath));
  paging.services[0].operations[0].params.push({ name: 'pageNo', required: true, description: '페이지' });
  writeFileSync(catalogPath, JSON.stringify(paging));
  await dispatchDatagoTool('datago_api', { service: 'fsc_stock_issue', operation: 'getItemBasiInfo_V2', params: { crno: '1' } }, { DATA_GO_KR_KEY_ENC: 'k' }, { catalogPath, fetchImpl });
  assert.match(calls.at(-1), /pageNo=1/, 'required paging parameters get a default');
});

test('unlisted_only paging resumes right after the last consumed row', async () => {
  const r1 = await dispatchCompanyTool('industry_companies', { code_prefix: '2424', limit: 1, sort: 'members_asc' }, env);
  assert.equal(r1.metadata.next_offset, 1);
  const all = await dispatchCompanyTool('industry_companies', { code_prefix: '2424', limit: 10, unlisted_only: true, sort: 'members_asc' }, env);
  const page1 = await dispatchCompanyTool('industry_companies', { code_prefix: '2424', limit: 1, unlisted_only: true, sort: 'members_asc' }, env);
  const page2 = await dispatchCompanyTool('industry_companies', { code_prefix: '2424', limit: 1, unlisted_only: true, sort: 'members_asc', offset: page1.metadata.next_offset }, env);
  assert.deepEqual([page1.data[0].사업장명, page2.data[0].사업장명], all.data.slice(0, 2).map(x => x.사업장명));
});
