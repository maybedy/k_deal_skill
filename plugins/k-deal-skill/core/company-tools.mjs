/** Company data layer over the local public-data snapshot (datago.sqlite) and the DART corp code list:
 * search any business including unlisted ones, look up industry codes, and list companies by industry.
 * Snapshot tables: nps (국민연금 가입 사업장, 3인 이상), tsp (공정위 통신판매사업자 신고), hs (관세청 HS부호).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { loadCorpList, normalizeName } from './extra-tools.mjs';

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const bizno = { type: 'string', pattern: '^[0-9]{3}-?[0-9]{2}-?[0-9]{5}$', description: '사업자등록번호 10자리' };
function define(name, description, properties, required) {
  return Object.freeze({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: READ });
}

export const COMPANY_TOOL_DEFINITIONS = Object.freeze([
  define('company_search', '비상장을 포함한 회사·사업장 찾기. 회사명이나 사업자등록번호로 DART 등록 회사(상장 여부·고유번호), 국민연금 가입 사업장(가입자 수·업종·주소·자료월), 통신판매 신고(사업자번호·취급품목·도메인)를 한 번에 찾습니다. 찾은 corp_code는 dart_* 도구, 사업자번호는 biz_status·datago_api로 이어서 조회합니다.', {
    query: { type: 'string', minLength: 1, maxLength: 60, description: '회사명 (예: 삼성전자, 비바리퍼블리카)' },
    bizno,
    include_closed: { type: 'boolean', default: false, description: 'true면 국민연금 탈퇴·통신판매 폐업 사업장도 포함' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
  }, []),
  define('industry_codes', '업종 이름으로 국민연금 업종코드(6자리)를 찾습니다. 업종별 회사 리스트(industry_companies)를 뽑기 전에 코드를 확인합니다. 사업장 수와 가입자 합계를 함께 보여줍니다.', {
    keyword: { type: 'string', minLength: 1, maxLength: 40, description: '예: 화장품, 반도체, 소프트웨어, 헤어' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  }, ['keyword']),
  define('industry_companies', '업종별 회사 리스트. 국민연금 가입 사업장(전국, 3인 이상)을 업종코드 앞자리나 업종명으로 뽑아 가입자 수(고용 규모 대용) 순으로 보여줍니다. 지역·법인 여부·규모로 거르고, unlisted_only로 비상장만 볼 수 있습니다(상장 여부는 DART 회사명 대조로 판단한 근사치).', {
    code_prefix: { type: 'string', pattern: '^[0-9]{2,6}$', description: '국민연금 업종코드 앞자리 (industry_codes로 확인)' },
    keyword: { type: 'string', maxLength: 40, description: '업종명 포함 검색 (code_prefix 대신)' },
    region: { type: 'string', maxLength: 30, description: '주소 포함 검색 (예: 서울특별시 강남구, 경기도)' },
    min_members: { type: 'integer', minimum: 0, maximum: 1000000 },
    max_members: { type: 'integer', minimum: 0, maximum: 1000000 },
    corp_only: { type: 'boolean', default: false, description: '법인 사업장만' },
    unlisted_only: { type: 'boolean', default: false, description: '상장사로 확인된 회사 제외' },
    sort: { type: 'string', enum: ['members_desc', 'members_asc', 'growth_desc', 'name'], default: 'members_desc', description: 'growth_desc=당월 신규취득-상실 순' },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
  }, []),
  define('mailorder_search', '공정위 통신판매사업자 신고 명부(전국 약 231만 건) 검색. 상호·도메인(판매 채널) 키워드나 사업자번호 목록으로 온라인 판매 사업자를 찾습니다. 취급품목은 종합몰, 의류/패션/잡화/뷰티, 건강/식품 같은 큰 분류만 있어 개별 상품명으로는 찾을 수 없습니다. 브랜드 운영사·D2C 사업자 확인용.', {
    keyword: { type: 'string', maxLength: 60, description: '상호·도메인·취급품목 분류에 포함된 말 (예: 무신사, 쿠팡, 뷰티)' },
    bizno_list: { type: 'array', items: { type: 'string', pattern: '^[0-9-]{10,12}$' }, maxItems: 500, description: '사업자등록번호 목록' },
    region: { type: 'string', maxLength: 20, description: '시도 (예: 서울)' },
    corp_only: { type: 'boolean', default: false },
    include_closed: { type: 'boolean', default: false },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
  }, []),
  define('hs_search', '관세청 HS부호(HSK 10단위) 검색. 코드 앞자리나 한글 품명으로 찾고, customs_trade 조회에 쓸 HS 코드를 확인합니다.', {
    query: { type: 'string', minLength: 1, maxLength: 60, description: '예: 851631, 헤어드라이어, 화장품' },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
  }, ['query']),
]);
export const COMPANY_TOOL_NAMES = new Set(COMPANY_TOOL_DEFINITIONS.map(d => d.name));

class CompanyError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new CompanyError(code, message); };

const connections = new Map();
function db(env) {
  const path = env?.MRM_DATAGO_DB;
  if (!path || !existsSync(path)) fail('not_connected', '서버에 공공데이터 스냅샷 DB(MRM_DATAGO_DB)가 설정되지 않았습니다.');
  if (!connections.has(path)) connections.set(path, new DatabaseSync(path, { readOnly: true }));
  return connections.get(path);
}
function snapshotInfo(d) {
  const nps = d.prepare('SELECT MIN(자료월) AS a, MAX(자료월) AS b FROM nps').get();
  return { nps_data_month: nps.a === nps.b ? nps.a : `${nps.a}~${nps.b}`, note: '국민연금 자료월 기준 스냅샷입니다. 이후 변동은 datago_api의 국민연금 실시간 조회로 확인하세요.' };
}
function cleanBizno(value) { return String(value).replace(/-/g, ''); }

/** DART listed-name lookup for the 'listed' flag. Name-based and therefore approximate. */
async function listedNames(env) {
  try {
    const { list } = await loadCorpList(env);
    const map = new Map();
    for (const c of list) {
      const key = canonicalName(c.corp_name);
      const entry = map.get(key) ?? { listed: false, corp_codes: [] };
      entry.corp_codes.push(c.corp_code);
      if (c.stock_code) { entry.listed = true; entry.stock_code = c.stock_code; }
      map.set(key, entry);
    }
    return map;
  } catch { return null; }
}
// Group names written in Hangul in one register and Latin in the other (엘지생활건강 vs LG생활건강).
const LATIN_ALIASES = [['에이치디', 'hd'], ['에스케이', 'sk'], ['엘에스', 'ls'], ['씨제이', 'cj'], ['지에스', 'gs'], ['케이티', 'kt'], ['엘지', 'lg'], ['디비', 'db'], ['비지에프', 'bgf'], ['에이케이', 'ak'], ['케이씨씨', 'kcc'], ['에스디', 'sd']];
/** Canonical company name for matching: NFKC (full-width → half-width), no legal-form marks, branch suffixes or bracketed text. */
export function canonicalName(name) {
  let s = String(name ?? '').normalize('NFKC').toLowerCase()
    .replace(/\(주\)|주식회사|㈜|\(유\)|유한회사|\(재\)|재단법인|\(사\)|사단법인/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/\s*(본사|본점|지점|지사|공장|연구소|사업장|영업소|센터|물류센터)\S*$/u, '')
    .replace(/[\s.,·&'`-]/g, '');
  for (const [ko, en] of LATIN_ALIASES) if (s.startsWith(ko)) { s = en + s.slice(ko.length); break; }
  return s;
}
const workplaceName = canonicalName;

const BRANCH = /(본사|본점|지점|지사|공장|연구소|사업장|영업소|센터)/u;
/** Exact canonical match; for branch sites (청양공장 등) also the longest company-name prefix, trimming at most 6 characters. */
function findListed(names, rawName) {
  if (!names) return null;
  const key = workplaceName(rawName);
  if (names.has(key)) return names.get(key);
  if (!BRANCH.test(String(rawName))) return null;
  for (let k = key.length - 1; k >= Math.max(3, key.length - 6); k--) if (names.has(key.slice(0, k))) return names.get(key.slice(0, k));
  return null;
}
function npsRow(r, names) {
  const match = findListed(names, r.사업장명);
  return {
    사업장명: r.사업장명, 사업자번호앞6: r.사업자번호6, 법인여부: r.법인여부 === '1' ? '법인' : '개인', 업종코드: r.업종코드, 업종명: r.업종명,
    가입자수: r.가입자수, 당월고지금액: r.고지금액, 신규취득: r.신규취득, 상실: r.상실, 상태: r.상태 === 1 ? '등록' : '탈퇴', 주소: r.주소, 자료월: r.자료월,
    ...(names ? { dart_match: match ? { listed: match.listed, stock_code: match.stock_code ?? null, corp_codes: match.corp_codes.slice(0, 3) } : null } : {}),
  };
}
function tspRow(r) {
  return { 상호: r.상호, 사업자번호: r.사업자번호, 법인여부: r.법인여부, ...(r.법인여부 === '법인' ? { 대표자: r.대표자 } : {}),
    신고일자: r.신고일자, 시도: r.시도, 업소상태: r.업소상태, 취급품목: r.취급품목, 도메인: r.도메인 };
}

async function run(name, args, env) {
  if (name === 'company_search') {
    if (!args.query && !args.bizno) fail('invalid_input', 'query 또는 bizno 중 하나가 필요합니다.');
    const d = db(env);
    const limit = args.limit ?? 15;
    const result = { dart: [], nps: [], mailorder: [] };
    if (args.bizno) {
      const b = cleanBizno(args.bizno);
      result.mailorder = d.prepare('SELECT * FROM tsp WHERE 사업자번호=? LIMIT ?').all(b, limit).map(tspRow);
      result.nps = d.prepare(`SELECT * FROM nps WHERE 사업자번호6=? ${args.include_closed ? '' : 'AND 상태=1'} ORDER BY 가입자수 DESC LIMIT ?`).all(b.slice(0, 6), limit).map(r => npsRow(r));
    }
    if (args.query) {
      const q = `%${args.query.trim()}%`;
      try {
        const { list } = await loadCorpList(env);
        const { searchCorps } = await import('./extra-tools.mjs');
        result.dart = searchCorps(list, args.query, { limit }).map(c => ({ corp_code: c.corp_code, corp_name: c.corp_name, stock_code: c.stock_code || null, listed: !!c.stock_code }));
      } catch { result.dart_note = 'DART 회사 목록을 불러오지 못했습니다.'; }
      result.nps = d.prepare(`SELECT * FROM nps WHERE 사업장명 LIKE ? ${args.include_closed ? '' : 'AND 상태=1'} ORDER BY 가입자수 DESC LIMIT ?`).all(q, limit).map(r => npsRow(r));
      result.mailorder = d.prepare(`SELECT * FROM tsp WHERE 상호 LIKE ? ${args.include_closed ? '' : "AND 업소상태 LIKE '%정상%'"} LIMIT ?`).all(q, limit).map(tspRow);
    }
    return { status: 'ok', data: result, metadata: { ...snapshotInfo(d), sources: { dart: 'OpenDART 고유번호 목록(상장·비상장 등록 회사)', nps: '국민연금 가입 사업장(3인 이상, 사업자번호는 앞 6자리만 공개)', mailorder: '공정위 통신판매사업자 신고 명부' },
      next: 'corp_code → dart_company·dart_report·dart_disclosures, 사업자번호 10자리 → biz_status(휴폐업), 법인등록번호 → fsc_outline·fsc_financials' } };
  }
  if (name === 'industry_codes') {
    const d = db(env);
    const rows = d.prepare(`SELECT 업종코드, 업종명, COUNT(*) AS 사업장수, SUM(가입자수) AS 가입자합계, SUM(법인여부='1') AS 법인사업장수
      FROM nps WHERE 상태=1 AND 업종명 LIKE ? GROUP BY 업종코드, 업종명 ORDER BY 가입자합계 DESC LIMIT ?`).all(`%${args.keyword.trim()}%`, args.limit ?? 30);
    return { status: 'ok', data: rows, metadata: { ...snapshotInfo(d), note: '국민연금 업종코드는 국민연금공단 분류(6자리)로 통계청 KSIC와 자릿수·체계가 다를 수 있습니다.' } };
  }
  if (name === 'industry_companies') {
    if (!args.code_prefix && !args.keyword) fail('invalid_input', 'code_prefix 또는 keyword가 필요합니다.');
    const d = db(env);
    const where = ['상태=1'], params = [];
    if (args.code_prefix) { where.push('업종코드 LIKE ?'); params.push(`${args.code_prefix}%`); }
    if (args.keyword) { where.push('업종명 LIKE ?'); params.push(`%${args.keyword.trim()}%`); }
    if (args.region) { where.push('주소 LIKE ?'); params.push(`%${args.region.trim()}%`); }
    if (args.min_members !== undefined) { where.push('가입자수 >= ?'); params.push(args.min_members); }
    if (args.max_members !== undefined) { where.push('가입자수 <= ?'); params.push(args.max_members); }
    if (args.corp_only) where.push("법인여부='1'");
    const order = { members_desc: '가입자수 DESC', members_asc: '가입자수 ASC', growth_desc: '(신규취득-상실) DESC, 가입자수 DESC', name: '사업장명' }[args.sort ?? 'members_desc'];
    const total = d.prepare(`SELECT COUNT(*) AS n, SUM(가입자수) AS m FROM nps WHERE ${where.join(' AND ')}`).get(...params);
    const names = await listedNames(env);
    const limit = args.limit ?? 100, offset = args.offset ?? 0;
    // unlisted_only filters after the DART match, so read ahead to fill the page.
    const raw = d.prepare(`SELECT * FROM nps WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, args.unlisted_only ? limit * 3 : limit, offset);
    // next_offset points just past the last row actually consumed, so filtered paging never skips rows.
    const rows = [];
    let consumed = 0;
    for (const r of raw) {
      if (rows.length >= limit) break;
      consumed++;
      const row = npsRow(r, names);
      if (args.unlisted_only && row.dart_match?.listed) continue;
      rows.push(row);
    }
    const nextOffset = offset + consumed < total.n ? offset + consumed : null;
    return { status: nextOffset !== null ? 'partial' : 'ok', data: rows, metadata: { ...snapshotInfo(d), total_workplaces: total.n, total_members: total.m, offset, returned: rows.length,
      next_offset: nextOffset, listed_flag: names ? 'DART 회사명 대조 근사치(동명 회사·지점명 차이로 틀릴 수 있음)' : 'DART 목록을 불러오지 못해 상장 여부 미표시',
      note: '한 회사가 여러 사업장(본사·공장·지점)으로 나뉘어 나올 수 있습니다. 가입자 수는 고용 규모 대용치이며 매출과 다릅니다.' } };
  }
  if (name === 'mailorder_search') {
    if (!args.keyword && !args.bizno_list?.length) fail('invalid_input', 'keyword 또는 bizno_list가 필요합니다.');
    const d = db(env);
    const where = [], params = [];
    if (args.keyword) { where.push('(상호 LIKE ? OR 취급품목 LIKE ? OR 도메인 LIKE ?)'); const k = `%${args.keyword.trim()}%`; params.push(k, k, k); }
    if (args.bizno_list?.length) { const list = args.bizno_list.map(cleanBizno); where.push(`사업자번호 IN (${list.map(() => '?').join(',')})`); params.push(...list); }
    if (args.region) { where.push('시도 LIKE ?'); params.push(`%${args.region}%`); }
    if (args.corp_only) where.push("법인여부='법인'");
    if (!args.include_closed) where.push("업소상태 LIKE '%정상%'");
    const rows = d.prepare(`SELECT * FROM tsp WHERE ${where.join(' AND ')} LIMIT ?`).all(...params, args.limit ?? 50).map(tspRow);
    return { status: 'ok', data: rows, metadata: { source: '공정위 통신판매사업자 신고 명부 (공공데이터포털 파일, 서버 스냅샷)', returned: rows.length, note: '개인 사업자의 대표자명은 표시하지 않습니다.' } };
  }
  if (name === 'hs_search') {
    const d = db(env);
    const q = args.query.trim();
    const rows = d.prepare(`SELECT HS부호, 한글품목명, 영문품목명, 적용시작일자, 적용종료일자, 한국표준무역분류명 FROM hs
      WHERE HS부호 LIKE ? OR 한글품목명 LIKE ? OR 영문품목명 LIKE ? LIMIT ?`).all(`${q}%`, `%${q}%`, `%${q}%`, args.limit ?? 30);
    return { status: 'ok', data: rows, metadata: { source: '관세청 HS부호 (공공데이터포털 파일, 서버 스냅샷)', returned: rows.length } };
  }
  fail('unknown_tool', 'This tool is not available.');
}

function validate(name, args) {
  const def = COMPANY_TOOL_DEFINITIONS.find(d => d.name === name);
  if (!def) fail('unknown_tool', 'This tool is not available.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid_input', 'Arguments must be an object.');
  for (const [key, v] of Object.entries(args)) {
    const schema = def.inputSchema.properties[key];
    if (!schema) fail('invalid_input', `Unknown input: ${key}`);
    if (schema.type === 'string' && (typeof v !== 'string' || (schema.maxLength && v.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(v)))) fail('invalid_input', `${key} 형식이 맞지 않습니다.`);
    if (schema.type === 'integer' && (!Number.isInteger(v) || v < schema.minimum || v > schema.maximum)) fail('invalid_input', `${key} 범위가 맞지 않습니다.`);
    if (schema.type === 'boolean' && typeof v !== 'boolean') fail('invalid_input', `${key}는 true/false입니다.`);
    if (schema.enum && !schema.enum.includes(v)) fail('invalid_input', `${key} 값이 허용되지 않습니다.`);
    if (schema.type === 'array' && (!Array.isArray(v) || v.length > schema.maxItems || !v.every(x => typeof x === 'string' && new RegExp(schema.items.pattern).test(x)))) fail('invalid_input', `${key} 형식이 맞지 않습니다.`);
  }
  for (const key of def.inputSchema.required) if (args[key] === undefined) fail('invalid_input', `Missing input: ${key}`);
  return args;
}

export async function dispatchCompanyTool(name, args = {}, env = {}) {
  try { return await run(name, validate(name, args), env); }
  catch (error) {
    if (error instanceof CompanyError) return { status: 'error', error: { code: error.code, message: error.message } };
    return { status: 'error', error: { code: 'internal_error', message: '조회를 완료하지 못했습니다.' } };
  }
}
