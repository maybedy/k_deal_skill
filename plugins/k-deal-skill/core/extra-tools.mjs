/** Additional read-only OpenDART and KRX tools: corp code lookup, company outline, report catalog, filing text and
 * term search, XBRL note search, KRX catalog.
 * Keys come only from the env passed by the gateway; responses never echo them.
 */
import { DART_REPORTS, KRX_APIS } from './catalog/source-apis.mjs';
import { readZip, isZip } from './zip.mjs';
import { DEFAULT_NOTE_TERMS, parseTerms, findPassages, parseLabels, searchXbrl } from './dart-xbrl.mjs';
import { STATEMENTS, pickAuditReport, parseStatementTable, findStatementSections } from './dart-audit.mjs';

const DART_BASE = 'https://opendart.fss.or.kr/api/';
const KRX_BASE = 'https://data-dbg.krx.co.kr/svc/apis/';
const MAX_BYTES = 40 * 1024 * 1024;
const CORP_LIST_TTL_MS = 24 * 3600 * 1000;
const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const REPORT_BY_ID = new Map(DART_REPORTS.map(r => [r.id, r]));
const KRX_BY_ID = new Map(KRX_APIS.map(a => [a.id, a]));
const ymd = { type: 'string', pattern: '^[0-9]{8}$' };
const corpCode = { type: 'string', pattern: '^[0-9]{8}$', description: 'DART 고유번호 8자리 (dart_corp_search로 확인)' };

const SJ_DIV = ['BS1', 'BS2', 'BS3', 'BS4', 'IS1', 'IS2', 'IS3', 'IS4', 'CIS1', 'CIS2', 'CIS3', 'CIS4',
  'DCIS1', 'DCIS2', 'DCIS3', 'DCIS4', 'DCIS5', 'DCIS6', 'DCIS7', 'DCIS8', 'CF1', 'CF2', 'CF3', 'CF4', 'SCE1', 'SCE2'];
const termsSchema = { type: 'string', minLength: 1, maxLength: 300 };
const reportList = ['periodic', 'financial', 'ownership', 'event', 'filing', 'taxonomy'].map(group => {
  const label = { periodic: '정기보고서 주요정보(bsns_year·reprt_code 필요)', financial: '정기보고서 재무정보(bsns_year·reprt_code 필요)', ownership: '지분공시(corp_code만)', event: '주요사항보고서(bgn_de·end_de 필요)', filing: '증권신고서(bgn_de·end_de 필요)', taxonomy: 'XBRL 표준계정과목(sj_div만, corp_code 없음)' }[group];
  return `${label}: ${DART_REPORTS.filter(r => r.group === group).map(r => `${r.id}=${r.name}`).join(', ')}`;
}).join(' / ');

function define(name, description, properties, required) {
  return Object.freeze({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: READ });
}
export const EXTRA_TOOL_DEFINITIONS = Object.freeze([
  define('dart_corp_search', '회사명 또는 종목코드로 DART 고유번호(corp_code)를 찾습니다. 다른 DART 도구를 쓰기 전에 먼저 호출합니다. 정확히 같은 이름, 그 이름으로 시작, 포함 순으로 정렬합니다. 비상장사도 포함됩니다.', {
    query: { type: 'string', minLength: 1, maxLength: 100, description: '회사명(예: 삼성전자, 카카오) 또는 6자리 종목코드' },
    listed_only: { type: 'boolean', default: false, description: 'true면 상장사(종목코드 있음)만' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  }, ['query']),
  define('dart_company', 'DART 기업개황: 정식 회사명, 영문명, 대표자, 법인구분, 법인·사업자등록번호, 주소, 홈페이지, 업종코드, 설립일, 결산월.', { corp_code: corpCode }, ['corp_code']),
  define('dart_report', `OpenDART 보고서 항목 조회. api로 항목을 고릅니다. ${reportList}. reprt_code: 11011 사업보고서, 11012 반기, 11013 1분기, 11014 3분기. idx_cl_code: M210000 수익성, M220000 안정성, M230000 성장성, M240000 활동성. fnlttMultiAcnt·fnlttCmpnyIndx는 corp_code를 쉼표로 최대 100개 받습니다. Ver 2.0 보수 API는 2026년 5월 이후 제출 보고서, 기존 API는 그 이전 보고서용입니다. sj_div: BS1~4 재무상태표, IS1~4 손익계산서, CIS1~4 포괄손익계산서, DCIS1~8 단일 포괄손익계산서, CF1~4 현금흐름표, SCE1~2 자본변동표(홀수 연결, 짝수 별도).`, {
    api: { type: 'string', enum: DART_REPORTS.map(r => r.id) },
    corp_code: { type: 'string', pattern: '^[0-9]{8}(,[0-9]{8}){0,99}$', description: 'DART 고유번호. 다중회사 API만 쉼표로 최대 100개. xbrlTaxonomy는 넣지 않음' },
    bsns_year: { type: 'integer', minimum: 2015, maximum: 2100 },
    reprt_code: { type: 'string', enum: ['11011', '11012', '11013', '11014'] },
    idx_cl_code: { type: 'string', enum: ['M210000', 'M220000', 'M230000', 'M240000'] },
    bgn_de: ymd, end_de: ymd,
    sj_div: { type: 'string', enum: SJ_DIV, description: 'xbrlTaxonomy 재무제표 구분' },
  }, ['api']),
  define('dart_document', 'DART 공시 원문 텍스트. 접수번호(rcept_no, dart_disclosures 결과)로 공시서류 원본을 받아 표·본문을 텍스트로 풀어 반환합니다. 길면 offset으로 이어서 읽습니다. 문서가 max_chars보다 길면 첫 페이지에 목차(toc: 장·절 id, 제목, 위치, 글자 수)를 함께 주고, toc=true면 목차만 줍니다. section_id(목차의 id)를 주면 그 장·절만 읽으며 offset은 그 안의 위치입니다. pattern을 주면 본문 대신 단어가 나온 구간(앞뒤 context_chars자)과 위치, 속한 장·절을 돌려주므로, 그 start 값을 offset으로 다시 불러 해당 주석부터 읽습니다.', {
    rcept_no: { type: 'string', pattern: '^[0-9]{14}$' },
    offset: { type: 'integer', minimum: 0, default: 0, description: '문서 전체(section_id가 있으면 그 장·절) 안의 시작 글자 위치' },
    max_chars: { type: 'integer', minimum: 1000, maximum: 200000, default: 60000 },
    toc: { type: 'boolean', default: false, description: 'true면 본문 없이 목차만' },
    section_id: { type: 'string', pattern: '^[0-9]{1,3}\\.[0-9A-Za-z_-]{1,20}$', description: '목차의 id(예: 0.4). 다른 접수번호의 id는 쓰지 않음' },
    pattern: { ...termsSchema, description: '찾을 단어를 |로 구분(예: 우발부채|지급보증|담보). 정규식이 아니며 대소문자를 구분하지 않습니다. 최대 20개' },
    context_chars: { type: 'integer', minimum: 50, maximum: 2000, default: 300, description: 'pattern 결과의 앞뒤 글자 수' },
    max_matches: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
  }, ['rcept_no']),
  define('dart_xbrl', `정기보고서 XBRL 재무제표 원본(fnlttXbrl)에서 주석 항목을 단어로 찾습니다. 계정·주석 항목의 한글 라벨, 차원(구성요소) 라벨, 문장형 주석 값에서 단어를 찾아 값·단위·기간·연결/별도 구분·차원과 원본 파일의 줄 번호를 돌려줍니다. 원본 zip은 돌려주지 않습니다. pattern 기본값: ${DEFAULT_NOTE_TERMS}. 사업보고서·반기·분기보고서의 rcept_no와 그 보고서의 reprt_code가 필요합니다. 이 값은 XBRL 태그에서 뽑은 값이므로 보고서 표와 대조하기 전에는 파생값으로 표시합니다.`, {
    rcept_no: { type: 'string', pattern: '^[0-9]{14}$', description: '정기보고서 접수번호 (dart_disclosures 결과)' },
    reprt_code: { type: 'string', enum: ['11011', '11012', '11013', '11014'] },
    pattern: { ...termsSchema, description: '찾을 단어를 |로 구분(예: 리스부채|지급보증). 정규식이 아니며 최대 20개' },
    basis: { type: 'string', enum: ['CFS', 'OFS', 'all'], default: 'all', description: 'CFS 연결, OFS 별도' },
    max_facts: { type: 'integer', minimum: 1, maximum: 300, default: 60, description: '숫자 값과 문장형 값 각각의 최대 건수' },
    context_chars: { type: 'integer', minimum: 50, maximum: 1000, default: 300 },
  }, ['rcept_no', 'reprt_code']),
  define('dart_audit_financials', '감사보고서 재무제표(비상장 외감 법인용). 사업보고서를 내지 않는 외부감사 대상 법인은 dart_financials가 비어 있으므로, DART에 제출된 감사보고서(또는 연결감사보고서) 원문에서 재무상태표·손익계산서·현금흐름표·자본변동표 표를 읽어 계정·계정코드·기간별 금액·단위로 돌려줍니다. corp_code와 year(회계연도)로 그 해 감사보고서를 찾거나 rcept_no를 직접 줍니다.', {
    corp_code: corpCode,
    year: { type: 'integer', minimum: 2000, maximum: 2100, description: '회계연도. 감사보고서 이름의 (YYYY.MM) 연도' },
    rcept_no: { type: 'string', pattern: '^[0-9]{14}$', description: '감사보고서 접수번호. 주면 corp_code·year 검색을 건너뜀' },
    consolidated: { type: 'boolean', default: false, description: 'true면 연결감사보고서의 연결재무제표' },
    statements: { type: 'array', maxItems: 4, items: { type: 'string', pattern: '^(bs|is|cf|ce)$' }, description: 'bs 재무상태표, is 손익계산서, cf 현금흐름표, ce 자본변동표. 기본 bs·is·cf' },
  }, []),
  define('krx_daily', `KRX Open API 일별 자료(지수·주식·ETF/ETN/ELW·채권·파생·금/석유/배출권·ESG). api마다 KRX에서 별도 이용신청·승인이 필요하며 승인되지 않은 API는 not_approved로 거절됩니다. 목록: ${KRX_APIS.map(a => `${a.id}=${a.name}`).join(', ')}.`, {
    api: { type: 'string', enum: KRX_APIS.map(a => a.id) },
    date: { ...ymd, description: '기준일 YYYYMMDD (익영업일 오전 8시 갱신, 당일 실시간 없음)' },
    codes: { type: 'array', items: { type: 'string', pattern: '^[A-Z0-9]{1,12}$' }, maxItems: 50, description: '종목코드로 거르기 (ISU_CD·ISU_SRT_CD 일치)' },
    name_contains: { type: 'string', maxLength: 50, description: '이름(ISU_NM·IDX_NM 등)에 포함된 글자로 거르기' },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  }, ['api', 'date']),
]);

class ExtraError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new ExtraError(code, message); };
const credential = (env, names) => names.map(n => env?.[n]).find(v => typeof v === 'string' && v.trim())?.trim() ?? null;
const nowIso = options => new Date(options.now ? options.now() : Date.now()).toISOString();

async function fetchBytes(url, headers, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { headers, redirect: 'error', signal: controller.signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) fail('response_too_large', '원천 응답이 너무 큽니다.');
    return { status: response.status, buffer };
  } catch (error) {
    if (error instanceof ExtraError) throw error;
    fail(controller.signal.aborted ? 'timeout' : 'transport_error', '원천 API 연결에 실패했습니다. 결과 없음으로 해석하지 않습니다.');
  } finally { clearTimeout(timer); }
}

const DART_STATUS = { '010': 'not_registered_key', '011': 'not_registered_key', '012': 'ip_not_allowed', '020': 'rate_limited', '021': 'too_many_companies', '100': 'invalid_input', '101': 'invalid_input', '800': 'source_maintenance', '900': 'source_error', '901': 'key_expired' };
async function dartJson(api, params, env, options) {
  const key = credential(env, ['DART_API_KEY', 'OPENDART_API_KEY']);
  if (!key) fail('not_connected', 'DART 인증키가 설정되지 않았습니다.');
  const url = new URL(`${DART_BASE}${api}.json`);
  url.searchParams.set('crtfc_key', key);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const { status, buffer } = await fetchBytes(url.toString(), { Accept: 'application/json' }, options);
  if (status !== 200) fail(`http_${status}`, 'DART가 HTTP 오류로 응답했습니다.');
  let json;
  try { json = JSON.parse(buffer.toString('utf8')); } catch { fail('invalid_response', 'DART 응답을 해석하지 못했습니다.'); }
  if (json.status === '013') return { rows: [], json, empty: true };
  if (json.status !== '000') fail(DART_STATUS[json.status] ?? 'source_error', `DART 오류 ${json.status}: ${String(json.message ?? '').slice(0, 120)}`);
  return { rows: json.list ?? null, json, empty: false };
}
/** Downloads an OpenDART zip (document.xml, fnlttXbrl.xml). DART answers errors with a small XML or JSON body. */
async function dartZip(api, params, env, options) {
  const key = credential(env, ['DART_API_KEY', 'OPENDART_API_KEY']);
  if (!key) fail('not_connected', 'DART 인증키가 설정되지 않았습니다.');
  const url = new URL(`${DART_BASE}${api}`);
  url.searchParams.set('crtfc_key', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const { status, buffer } = await fetchBytes(url.toString(), {}, options);
  if (status !== 200) fail(`http_${status}`, 'DART가 HTTP 오류로 응답했습니다.');
  if (!isZip(buffer)) {
    const body = buffer.subarray(0, 2000).toString('utf8');
    const code = /<status>(\d+)<\/status>/.exec(body)?.[1] ?? /"status"\s*:\s*"(\d+)"/.exec(body)?.[1];
    if (code === '014' || code === '013') fail('no_document', '해당 접수번호의 원본 파일이 없습니다.');
    fail(DART_STATUS[code] ?? 'source_error', `DART 오류 ${code ?? ''}`);
  }
  return buffer;
}
const termsOrFail = pattern => parseTerms(pattern) ?? fail('invalid_input', 'pattern은 |로 구분한 단어 1~20개(각 50자 이하)입니다.');
const dartMeta = (api, params, options, extra = {}) => ({ provider: 'OpenDART (금융감독원)', source_url: `${DART_BASE}${/\.(xml|json)$/.test(api) ? api : `${api}.json`}`, request: params, fetched_at: nowIso(options), ...extra });

/* ---------- corp code list ---------- */
let corpList = null;
export const normalizeName = s => String(s ?? '').replace(/\s+/g, '').replace(/^(주식회사|\(주\)|㈜)|(주식회사|\(주\)|㈜)$/g, '').toLowerCase();
export function parseCorpCodes(xml) {
  const out = [];
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const field = tag => (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(m[1])?.[1] ?? '').trim();
    out.push({ corp_code: field('corp_code'), corp_name: field('corp_name'), corp_eng_name: field('corp_eng_name'), stock_code: field('stock_code'), modify_date: field('modify_date') });
  }
  return out;
}
export function searchCorps(list, query, { listedOnly = false, limit = 10 } = {}) {
  const q = query.trim();
  if (/^[0-9]{6}$/.test(q)) return list.filter(c => c.stock_code === q).slice(0, limit);
  const nq = normalizeName(q);
  const scored = [];
  for (const c of list) {
    if (listedOnly && !c.stock_code) continue;
    const n = normalizeName(c.corp_name), e = normalizeName(c.corp_eng_name);
    const s = n === nq || e === nq ? 0 : n.startsWith(nq) ? 1 : n.includes(nq) || e.includes(nq) ? 2 : -1;
    if (s >= 0) scored.push({ c, s: s * 2 + (c.stock_code ? 0 : 1) });
  }
  return scored.sort((a, b) => a.s - b.s || a.c.corp_name.length - b.c.corp_name.length).slice(0, limit).map(x => x.c);
}
export async function loadCorpList(env, options = {}) {
  if (corpList && Date.now() - corpList.at < CORP_LIST_TTL_MS && !options.fetchImpl) return corpList;
  const key = credential(env, ['DART_API_KEY', 'OPENDART_API_KEY']);
  if (!key) fail('not_connected', 'DART 인증키가 설정되지 않았습니다.');
  const { status, buffer } = await fetchBytes(`${DART_BASE}corpCode.xml?crtfc_key=${encodeURIComponent(key)}`, {}, options);
  if (status !== 200 || !isZip(buffer)) fail('source_error', 'DART 고유번호 파일을 받지 못했습니다.');
  const file = readZip(buffer).find(e => /corpcode\.xml$/i.test(e.name));
  if (!file) fail('invalid_response', 'DART 고유번호 파일 형식이 다릅니다.');
  corpList = { at: Date.now(), list: parseCorpCodes(file.data.toString('utf8')) };
  return corpList;
}

/* ---------- filing document text ---------- */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function documentText(xml) {
  return xml
    .replace(/<\?xml[^>]*>/g, '')
    .replace(/<(TE|TD|TH|TU)\b[^>]*>/gi, '\t')
    .replace(/<\/(TR|P|TITLE|SECTION-\d|TABLE|LIBRARY|BODY|COVER|PART|SUMMARY)>/gi, '\n')
    .replace(/<BR\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[  ]+/g, ' ').replace(/ *\t */g, '\t').replace(/\n\s*\n+/g, '\n').trim();
}
/** Table of contents of one filing XML file: each ATOC="Y" title and the SECTION-n container it opens.
 * The idea of a TOC plus a section id comes from korea-stock-mcp (MIT); this version keys sections by ATOCID because
 * AASSOCNOTE repeats across the files of one filing and is missing on some titles. */
export function documentSections(xml) {
  const stack = [], sections = [];
  let loose = null;  // a title that is not the first child of a container runs to the next title or the container end
  const close = (from, end) => {
    for (const c of stack.splice(from)) for (const sec of c.owned) sec.end ??= end;
  };
  for (const m of xml.matchAll(/<(\/?)(SECTION-\d+|LIBRARY|PART|BODY)\b[^>]*>|<TITLE\b([^>]*)>([\s\S]*?)<\/TITLE>/g)) {
    if (m[2]) {
      if (!m[1]) stack.push({ tag: m[2], start: m.index, owned: [] });
      else { const i = stack.findLastIndex(c => c.tag === m[2]); if (i >= 0) close(i, m.index + m[0].length); }
      continue;
    }
    if (!/\bATOC="Y"/.test(m[3])) continue;
    if (loose) { loose.end ??= m.index; loose = null; }
    const container = stack.at(-1);
    const own = container && !container.owned.length;
    const sec = { atocid: /\bATOCID="([^"]+)"/.exec(m[3])?.[1] ?? null, note_id: /\bAASSOCNOTE="([^"]+)"/.exec(m[3])?.[1] ?? null,
      title: documentText(m[4]).replace(/\s+/g, ' '), level: Math.max(1, stack.filter(c => c.tag.startsWith('SECTION-')).length),
      start: own ? container.start : m.index, end: null };
    if (own) container.owned.push(sec);
    else { loose = sec; container?.owned.push(sec); }
    sections.push(sec);
  }
  close(0, xml.length);
  for (const sec of sections) sec.end ??= xml.length;
  return sections;
}
/** TOC across the files of a filing, with offsets into the joined text that offset/max_chars page through. */
function filingToc(files, starts) {
  const toc = [];
  files.forEach((f, fi) => {
    const base = starts[fi] + `### ${f.name}\n`.length;
    let from = 0;
    documentSections(f.xml).forEach((sec, n) => {
      const text = documentText(f.xml.slice(sec.start, sec.end));
      const at = text ? f.text.indexOf(text.slice(0, 80), from) : -1;
      if (at >= 0) from = at;
      toc.push({ id: `${fi}.${sec.atocid ?? `n${n + 1}`}`, title: sec.title, level: sec.level, file: f.name, offset: at >= 0 ? base + at : null, chars: text.length, note_id: sec.note_id, text });
    });
  });
  return toc;
}
const tocView = toc => toc.map(({ text, ...entry }) => entry);
function decodeXml(buffer) {
  const head = buffer.subarray(0, 200).toString('latin1');
  const enc = /encoding="([^"]+)"/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  try { return new TextDecoder(enc === 'euc-kr' || enc === 'ks_c_5601-1987' ? 'euc-kr' : 'utf-8').decode(buffer); }
  catch { return buffer.toString('utf8'); }
}

/* ---------- dispatch ---------- */
function clean(name, args) {
  const def = EXTRA_TOOL_DEFINITIONS.find(d => d.name === name);
  if (!def) fail('unknown_tool', 'This tool is not available.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid_input', 'Arguments must be an object.');
  for (const key of Object.keys(args)) if (!def.inputSchema.properties[key]) fail('invalid_input', `Unknown input: ${key}`);
  for (const key of def.inputSchema.required) if (args[key] === undefined) fail('invalid_input', `Missing input: ${key}`);
  for (const [key, schema] of Object.entries(def.inputSchema.properties)) {
    const v = args[key];
    if (v === undefined) continue;
    if (schema.enum && !schema.enum.includes(v)) fail('invalid_input', `${key} is not an allowed value.`);
    if (schema.pattern && (typeof v !== 'string' || !new RegExp(schema.pattern).test(v))) fail('invalid_input', `${key} has an invalid format.`);
    if (schema.type === 'integer' && (!Number.isInteger(v) || (schema.minimum !== undefined && v < schema.minimum) || (schema.maximum !== undefined && v > schema.maximum))) fail('invalid_input', `${key} is out of range.`);
    if (schema.type === 'boolean' && typeof v !== 'boolean') fail('invalid_input', `${key} must be boolean.`);
    if (schema.type === 'string' && (typeof v !== 'string' || (schema.maxLength && v.length > schema.maxLength) || (schema.minLength && v.trim().length < schema.minLength))) fail('invalid_input', `${key} has an invalid length.`);
    if (schema.type === 'array' && (!Array.isArray(v) || v.length > schema.maxItems || !v.every(x => typeof x === 'string' && new RegExp(schema.items.pattern).test(x)))) fail('invalid_input', `${key} has invalid items.`);
  }
  return args;
}

async function run(name, args, env, options) {
  if (name === 'dart_corp_search') {
    const { list, at } = await loadCorpList(env, options);
    const rows = searchCorps(list, args.query, { listedOnly: args.listed_only, limit: args.limit ?? 10 });
    return { status: 'ok', data: rows, metadata: dartMeta('corpCode.xml', { query: args.query }, options, { total_companies: list.length, list_loaded_at: new Date(at).toISOString(), data_status: rows.length ? 'ok' : 'no_match' }) };
  }
  if (name === 'dart_company') {
    const { json } = await dartJson('company', { corp_code: args.corp_code }, env, options);
    const { status, message, ...company } = json;
    return { status: 'ok', data: company, metadata: dartMeta('company', { corp_code: args.corp_code }, options) };
  }
  if (name === 'dart_report') {
    const spec = REPORT_BY_ID.get(args.api);
    if (spec.group === 'taxonomy') {
      if (args.corp_code !== undefined) fail('invalid_input', 'xbrlTaxonomy는 corp_code 없이 sj_div만 받습니다.');
      if (!args.sj_div) fail('invalid_input', 'sj_div가 필요합니다.');
      const { rows, empty } = await dartJson(args.api, { sj_div: args.sj_div }, env, options);
      return { status: 'ok', data: rows ?? [], metadata: dartMeta(args.api, { sj_div: args.sj_div }, options, { report: spec.name, group: spec.group, data_status: empty ? 'no_data' : 'ok' }) };
    }
    if (!args.corp_code) fail('invalid_input', 'corp_code가 필요합니다.');
    const multi = args.api === 'fnlttMultiAcnt' || args.api === 'fnlttCmpnyIndx';
    if (!multi && args.corp_code.includes(',')) fail('invalid_input', '이 API는 고유번호 하나만 받습니다.');
    const params = { corp_code: args.corp_code };
    if (spec.group === 'periodic' || spec.group === 'financial') {
      if (!args.bsns_year || !args.reprt_code) fail('invalid_input', 'bsns_year와 reprt_code가 필요합니다.');
      Object.assign(params, { bsns_year: args.bsns_year, reprt_code: args.reprt_code });
      if (args.api.endsWith('Indx')) { if (!args.idx_cl_code) fail('invalid_input', 'idx_cl_code가 필요합니다.'); params.idx_cl_code = args.idx_cl_code; }
    }
    if (spec.group === 'event' || spec.group === 'filing') {
      if (!args.bgn_de || !args.end_de) fail('invalid_input', 'bgn_de와 end_de가 필요합니다.');
      Object.assign(params, { bgn_de: args.bgn_de, end_de: args.end_de });
    }
    const { rows, json, empty } = await dartJson(args.api, params, env, options);
    const data = rows ?? Object.fromEntries(Object.entries(json).filter(([k]) => !['status', 'message'].includes(k)));
    return { status: 'ok', data, metadata: dartMeta(args.api, params, options, { report: spec.name, group: spec.group, data_status: empty ? 'no_data' : 'ok' }) };
  }
  if (name === 'dart_document') {
    const words = args.pattern === undefined ? null : termsOrFail(args.pattern);
    if ([words, args.toc || undefined, args.section_id].filter(v => v !== undefined && v !== null).length > 1) fail('invalid_input', 'pattern, toc, section_id는 하나만 씁니다.');
    const buffer = await dartZip('document.xml', { rcept_no: args.rcept_no }, env, options);
    const files = readZip(buffer).map(e => { const xml = decodeXml(e.data); return { name: e.name, xml, text: documentText(xml) }; });
    const starts = [];
    let full = '';
    files.forEach((f, i) => { if (i) full += '\n\n'; starts.push(full.length); full += `### ${f.name}\n${f.text}`; });
    const viewer_url = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${args.rcept_no}`;
    const fileList = files.map(f => ({ name: f.name, chars: f.text.length }));
    const offset = args.offset ?? 0, max = args.max_chars ?? 60000;
    const meta = extra => dartMeta('document.xml', { rcept_no: args.rcept_no }, options, { total_chars: full.length, ...extra, viewer_url });
    if (args.toc) {
      const toc = filingToc(files, starts);
      return { status: 'ok', data: { toc: tocView(toc), files: fileList }, metadata: meta({ sections: toc.length, data_status: toc.length ? 'ok' : 'no_toc',
        read_hint: 'section_id=<id>로 그 장·절을, offset=<offset>으로 그 위치부터 문서를 읽습니다.' }) };
    }
    if (args.section_id) {
      const toc = filingToc(files, starts);
      const sec = toc.find(entry => entry.id === args.section_id) ?? fail('invalid_input', `이 공시에 section_id ${args.section_id}가 없습니다. toc=true로 목차를 확인하세요.`);
      const text = sec.text.slice(offset, offset + max);
      const more = offset + max < sec.text.length;
      return { status: more ? 'partial' : 'ok', data: { text, section: { ...tocView([sec])[0] }, files: fileList },
        metadata: meta({ section_id: sec.id, section_chars: sec.text.length, offset, returned_chars: text.length, next_offset: more ? offset + max : null }) };
    }
    if (words) {
      // Offsets index the same joined text that offset/max_chars page through.
      const fileAt = at => files[starts.findLastIndex(start => start <= at)]?.name ?? null;
      const toc = filingToc(files, starts).filter(entry => entry.offset !== null);
      const sectionAt = at => { const hit = toc.filter(e => e.offset <= at && at < e.offset + e.chars).at(-1); return hit ? { id: hit.id, title: hit.title } : null; };
      const found = findPassages(full, words, { contextChars: args.context_chars ?? 300, maxPassages: args.max_matches ?? 30 });
      return { status: found.total > found.passages.length ? 'partial' : 'ok',
        data: { matches: found.passages.map(p => ({ file: fileAt(p.offset), section: sectionAt(p.offset), ...p })), term_counts: found.term_counts, files: fileList },
        metadata: dartMeta('document.xml', { rcept_no: args.rcept_no }, options, { terms: words, total_chars: full.length, matches_total: found.total, matches_returned: found.passages.length,
          data_status: found.total ? 'ok' : 'no_match', read_hint: '본문은 pattern 없이 offset=<start>로 다시 불러 읽습니다. 단어가 없다는 결과는 이 공시서류 원문에 한정됩니다.', viewer_url }) };
    }
    const text = full.slice(offset, offset + max);
    const more = offset + max < full.length;
    // A long filing's first page also carries the TOC so the next call can jump to a section.
    const toc = more && offset === 0 ? tocView(filingToc(files, starts)) : undefined;
    return { status: more ? 'partial' : 'ok', data: { text, files: fileList, ...(toc ? { toc } : {}) },
      metadata: meta({ offset, returned_chars: text.length, next_offset: more ? offset + max : null, ...(toc ? { read_hint: 'toc의 section_id로 장·절만 읽거나 offset으로 이어 읽습니다.' } : {}) }) };
  }
  if (name === 'dart_xbrl') {
    const words = termsOrFail(args.pattern ?? DEFAULT_NOTE_TERMS);
    const params = { rcept_no: args.rcept_no, reprt_code: args.reprt_code };
    const buffer = await dartZip('fnlttXbrl.xml', params, env, options);
    const names = [];
    const files = readZip(buffer, n => { names.push(n); return /\.xbrl$/i.test(n) || /_lab-ko\.xml$/i.test(n); });
    const instance = files.find(f => /\.xbrl$/i.test(f.name)), labelFile = files.find(f => /_lab-ko\.xml$/i.test(f.name));
    if (!instance) fail('invalid_response', 'XBRL 묶음에 인스턴스(.xbrl) 파일이 없습니다.');
    const labels = labelFile ? parseLabels(decodeXml(labelFile.data)) : new Map();
    const found = searchXbrl({ instanceName: instance.name, instance: decodeXml(instance.data), labels }, words,
      { basis: args.basis ?? 'all', maxFacts: args.max_facts ?? 60, contextChars: args.context_chars ?? 300 });
    const c = found.counts;
    return { status: c.facts_matched > c.facts_returned || c.text_matched > c.text_returned ? 'partial' : 'ok',
      data: { facts: found.facts, text_matches: found.text_matches, concepts: found.concepts.slice(0, 200) },
      metadata: dartMeta('fnlttXbrl.xml', params, options, { terms: words, basis: args.basis ?? 'all', ...c, concepts_total: found.concepts.length, files: names, label_file: labelFile?.name ?? null,
        data_status: c.facts_matched + c.text_matched ? 'ok' : 'no_match',
        note: 'XBRL 태그에서 뽑은 값입니다. value는 원본 그대로(부호 포함, decimals=-6은 백만 원 단위 반올림)이며, 보고서 본문 표와 대조하기 전에는 파생값으로 표시합니다. 단어가 없다는 결과는 XBRL에 태그된 항목에 한정됩니다.',
        viewer_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${args.rcept_no}` }) };
  }
  if (name === 'dart_audit_financials') {
    const consolidated = args.consolidated ?? false;
    let rceptNo = args.rcept_no, report = null, calls = 0;
    if (!rceptNo) {
      if (!args.corp_code || !args.year) fail('invalid_input', 'corp_code와 year, 또는 rcept_no가 필요합니다.');
      // A fiscal year's audit report is filed in the following calendar year, or the same year for an early year end.
      for (const y of [args.year + 1, args.year]) {
        const { rows } = await dartJson('list', { corp_code: args.corp_code, bgn_de: `${y}0101`, end_de: `${y}1231`, pblntf_ty: 'F', page_count: 100 }, env, options);
        calls++;
        report = pickAuditReport(rows ?? [], { year: args.year, consolidated });
        if (report) break;
      }
      if (!report) return { status: 'ok', data: null, metadata: dartMeta('list', { corp_code: args.corp_code, year: args.year, pblntf_ty: 'F' }, options, { upstream_calls: calls, data_status: 'no_audit_report',
        note: `${args.year}년 ${consolidated ? '연결' : ''}감사보고서를 DART 외부감사관련 공시에서 찾지 못했습니다. 상장사는 dart_financials, 감사 대상이 아니면 공시가 없습니다.` }) };
      rceptNo = report.rcept_no;
    }
    const buffer = await dartZip('document.xml', { rcept_no: rceptNo }, env, options);
    calls++;
    const wanted = args.statements?.length ? [...new Set(args.statements)] : ['bs', 'is', 'cf'];
    const statements = {}, missing = [];
    for (const e of readZip(buffer)) {
      const xml = decodeXml(e.data);
      const sections = findStatementSections(xml, { consolidated });
      for (const key of wanted) {
        if (statements[key] || !sections[key]) continue;
        const table = parseStatementTable(xml.slice(sections[key].start, sections[key].end));
        if (table?.rows.length) statements[key] = { name: STATEMENTS[key].name, title: sections[key].title, file: e.name, ...table };
      }
    }
    for (const key of wanted) if (!statements[key]) missing.push(STATEMENTS[key].name);
    return { status: missing.length && Object.keys(statements).length ? 'partial' : 'ok', data: Object.keys(statements).length ? { report: report ?? { rcept_no: rceptNo }, statements } : null,
      metadata: dartMeta('document.xml', { rcept_no: rceptNo }, options, { upstream_calls: calls, consolidated, statements_found: Object.keys(statements), statements_missing: missing,
        data_status: Object.keys(statements).length ? 'ok' : 'no_statement_table',
        note: '감사보고서 원문 표에서 읽은 값입니다. values는 원문 금액(단위는 unit, multiplier를 곱하면 원)이며 괄호는 음수로 바꿨습니다. 계정 체계는 회사마다 다르므로 합계 계정(code·level)을 확인하고, 중요한 숫자는 viewer_url 원문과 대조합니다.',
        viewer_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}` }) };
  }
  if (name === 'krx_daily') {
    const key = credential(env, ['KRX_API_KEY']);
    if (!key) fail('not_connected', 'KRX 인증키가 설정되지 않았습니다.');
    const spec = KRX_BY_ID.get(args.api);
    const { status, buffer } = await fetchBytes(`${KRX_BASE}${args.api}?basDd=${args.date}`, { AUTH_KEY: key, Accept: 'application/json' }, options);
    if (status === 401) fail('not_approved', `KRX에서 '${spec.name}' API 이용신청·승인이 필요합니다.`);
    if (status !== 200) fail(`http_${status}`, 'KRX가 HTTP 오류로 응답했습니다.');
    let json;
    try { json = JSON.parse(buffer.toString('utf8')); } catch { fail('invalid_response', 'KRX 응답을 해석하지 못했습니다.'); }
    let rows = Array.isArray(json.OutBlock_1) ? json.OutBlock_1 : [];
    const total = rows.length;
    if (args.codes?.length) rows = rows.filter(r => args.codes.includes(r.ISU_CD) || args.codes.includes(r.ISU_SRT_CD));
    if (args.name_contains) rows = rows.filter(r => Object.entries(r).some(([k, v]) => /_NM$/.test(k) && String(v).includes(args.name_contains)));
    const limit = args.limit ?? 100;
    return { status: rows.length > limit ? 'partial' : 'ok', data: rows.slice(0, limit), metadata: { provider: 'KRX Data Marketplace OPEN API', source_url: `${KRX_BASE}${args.api}`, api_name: spec.name,
      request: { api: args.api, basDd: args.date }, fetched_at: nowIso(options), rows_total: total, rows_matched: rows.length, rows_returned: Math.min(limit, rows.length),
      data_status: total ? 'ok' : 'no_data_or_holiday', note: '빈 결과를 휴장일로 단정하지 않습니다. 자료는 익영업일 오전 8시 갱신.' } };
  }
  fail('unknown_tool', 'This tool is not available.');
}

export async function dispatchExtraTool(name, args = {}, env = {}, options = {}) {
  try { return await run(name, clean(name, args), env, options); }
  catch (error) {
    if (error instanceof ExtraError) return { status: 'error', error: { code: error.code, message: error.message } };
    return { status: 'error', error: { code: 'internal_error', message: '조회를 완료하지 못했습니다. 결과 없음으로 해석하지 않습니다.' } };
  }
}
export const EXTRA_TOOL_NAMES = new Set(EXTRA_TOOL_DEFINITIONS.map(d => d.name));
