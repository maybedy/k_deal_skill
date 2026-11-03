/** Read-only Korean source adapters. No filesystem, local settings, or implicit env access. */

const DART_BASE = 'https://opendart.fss.or.kr/api/';
const KRX_BASE = 'https://data-dbg.krx.co.kr/svc/apis/sto/';
const ENDPOINTS = Object.freeze({
  dart_disclosures: `${DART_BASE}list.json`,
  dart_financials: `${DART_BASE}fnlttSinglAcntAll.json`,
  fsc_outline: 'https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2',
  fsc_financials: 'https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2',
  fsc_affiliates: 'https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getAffiliate_V2',
  customs_trade: 'https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList',
  customs_country: 'https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList',
});
const KRX_ROUTES = Object.freeze({
  krx_trade: { KOSPI: 'stk_bydd_trd', KOSDAQ: 'ksq_bydd_trd', KONEX: 'knx_bydd_trd' },
  krx_base: { KOSPI: 'stk_isu_base_info', KOSDAQ: 'ksq_isu_base_info', KONEX: 'knx_isu_base_info' },
});
const ALLOWED_ENDPOINTS = new Set([
  ...Object.values(ENDPOINTS),
  ...Object.values(KRX_ROUTES).flatMap(routes => Object.values(routes).map(route => KRX_BASE + route)),
]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const READ_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const dateSchema = { type: 'string', pattern: '^[0-9]{8}$', description: '실제 달력 기준 YYYYMMDD' };
const corpSchema = { type: 'string', pattern: '^[0-9]{8}$', description: 'DART 법인 고유번호' };
const crnoSchema = { type: 'string', pattern: '^[0-9]{13}$', description: '법인등록번호' };
const pageProperties = { page_no: { type: 'integer', minimum: 1, maximum: 1000, default: 1 }, num_rows: { type: 'integer', minimum: 1, maximum: 100, default: 100 } };
const marketProperties = {
  market: { type: 'string', enum: ['KOSPI', 'KOSDAQ', 'KONEX'] },
  date: dateSchema,
  codes: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[0-9A-Z]{6}$' } },
};
function define(name, description, properties, required) {
  return Object.freeze({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: READ_ANNOTATIONS });
}

export const TOOL_DEFINITIONS = Object.freeze([
  define('dart_disclosures', 'DART 공시 목록 한 페이지 조회(최대 100건). corp_code가 있으면 그 법인의 최대 366일, 없으면 전체 시장의 최대 3개월(시작일과 같은 날짜의 3개월 뒤까지)을 찾습니다. type(A 정기, B 주요사항, C 발행, D 지분, E 기타, F 외부감사, G 펀드, H 자산유동화, I 거래소, J 공정위)이나 detail_type(예: A001 사업보고서, A002 반기, A003 분기, B001 주요사항보고서, C001 증권신고 지분증권, D001 대량보유, D002 임원·주요주주 소유, F001 감사보고서, F002 연결감사보고서, I001 수시공시)으로 좁힙니다. report_name_contains는 받은 페이지 안에서만 보고서명을 거릅니다. 전체 목록 완료 여부를 구분합니다.', {
    corp_code: corpSchema, begin: dateSchema, end: dateSchema, ...pageProperties,
    type: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] },
    detail_type: { type: 'string', pattern: '^[A-J][0-9]{3}$', description: 'OpenDART pblntf_detail_ty. type과 함께 쓰면 첫 글자가 같아야 합니다' },
    corp_cls: { type: 'string', enum: ['Y', 'K', 'N', 'E'], description: 'Y 유가증권, K 코스닥, N 코넥스, E 기타' },
    sort: { type: 'string', enum: ['date', 'crp', 'rpt'], default: 'date', description: 'date 접수일, crp 회사명, rpt 보고서명' },
    sort_order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
    report_name_contains: { type: 'string', minLength: 1, maxLength: 50, description: '보고서명에 들어간 글자로 이 페이지의 행만 거르기(예: 전환사채권발행결정)' },
    last_report_only: { type: 'boolean', default: false },
  }, ['begin', 'end']),
  define('dart_financials', 'OpenDART 전체계정 재무제표. 연도·보고서·연결/별도 기준을 명시하며 자동 기준 변경이나 추정을 하지 않습니다.', {
    corp_code: corpSchema, year: { type: 'integer', minimum: 2000, maximum: 2100 },
    report: { type: 'string', enum: ['11011', '11012', '11013', '11014'] },
    fs_div: { type: 'string', enum: ['CFS', 'OFS'] },
  }, ['corp_code', 'year', 'report', 'fs_div']),
  define('krx_base', 'KRX 시장별·기준일별 종목 기본정보. 종목코드 최대 50개이며 일별 자료입니다.', marketProperties, ['market', 'date', 'codes']),
  define('krx_trade', 'KRX 시장별·기준일별 가격·거래량·시가총액. 실시간 시세가 아니며 빈 결과를 휴장일로 단정하지 않습니다.', marketProperties, ['market', 'date', 'codes']),
  define('fsc_outline', '금융위원회 기업개요 한 페이지 조회. 법인등록번호 또는 법인명 중 하나만 지정합니다.', {
    crno: crnoSchema, corp_name: { type: 'string', minLength: 1, maxLength: 100 }, ...pageProperties,
  }, []),
  define('fsc_financials', '금융위원회 사업연도별 요약재무 한 페이지 조회. 원자료의 연결/별도 구분과 기준일을 보존합니다.', {
    crno: crnoSchema, year: { type: 'integer', minimum: 2000, maximum: 2100 }, ...pageProperties,
  }, ['crno', 'year']),
  define('fsc_affiliates', '금융위원회 계열회사 한 페이지 조회. 선택한 기준일 또는 실제 응답 기준일을 표시합니다.', {
    crno: crnoSchema, base_date: dateSchema, ...pageProperties,
  }, ['crno']),
  define('customs_trade', '관세청 HS 품목별 수출입. 국가 선택 가능, 최대 12개월. 합계·상세행을 보존하고 중복 집계 주의를 표시합니다.', {
    hs: { type: 'string', pattern: '^[0-9]{2,10}$' },
    start_ym: { type: 'string', pattern: '^[0-9]{6}$' }, end_ym: { type: 'string', pattern: '^[0-9]{6}$' },
    country: { type: 'string', pattern: '^[A-Z]{2}$' },
  }, ['hs', 'start_ym', 'end_ym']),
]);
const DEFINITIONS = new Map(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));

export class SourceToolError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceToolError'; this.code = code; }
}
function fail(code, message) { throw new SourceToolError(code, message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function digits(value, length, label) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9]{${length}}$`).test(value)) fail('invalid_input', `${label} must contain ${length} digits.`);
  return value;
}
function integer(value, min, max, label, fallback) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected < min || selected > max) fail('invalid_input', `${label} is outside its permitted integer range.`);
  return selected;
}
function calendarDate(value, label) {
  digits(value, 8, label);
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2100 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) fail('invalid_input', `${label} is not a supported calendar date.`);
  return value;
}
function monthIndex(value, label) {
  digits(value, 6, label);
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4));
  if (year < 1900 || year > 2100 || month < 1 || month > 12) fail('invalid_input', `${label} is not a supported calendar month.`);
  return year * 12 + month - 1;
}
function allowedChoice(value, choices, label) {
  if (!choices.includes(value)) fail('invalid_input', `${label} is not supported.`);
  return value;
}
function cleanArgs(name, args) {
  const definition = DEFINITIONS.get(name);
  if (!definition) fail('unknown_tool', 'This source tool is not available.');
  if (!isObject(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))) fail('invalid_input', 'Only documented tool inputs are accepted.');
  for (const required of definition.inputSchema.required) if (args[required] === undefined) fail('invalid_input', 'A required tool input is missing.');
  return args;
}
function credential(env, names) {
  for (const name of names) if (typeof env?.[name] === 'string' && env[name].trim()) return env[name].trim();
  fail('not_connected', 'The required source credential is not configured for this server.');
}
function publicDataKey(env) {
  const encoded = typeof env?.DATA_GO_KR_KEY_ENC === 'string' ? env.DATA_GO_KR_KEY_ENC.trim() : '';
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { fail('invalid_credential_format', 'The configured public-data key has invalid encoding.'); }
  }
  return credential(env, ['DATA_GO_KR_KEY']);
}
function nowIso(options) {
  const value = options.now ? options.now() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
function providerCount(value, label, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    fail('invalid_response', `The provider omitted ${label}.`);
  }
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[0-9]+$/.test(String(value))) fail('invalid_response', `The provider returned invalid ${label}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail('invalid_response', `The provider returned invalid ${label}.`);
  return number;
}

async function readBounded(response, maxBytes) {
  const length = response.headers?.get('content-length');
  if (length && /^[0-9]+$/.test(length) && Number(length) > maxBytes) fail('response_too_large', 'The source response exceeds the permitted size; narrow the query.');
  if (!response.body?.getReader) fail('invalid_response', 'The source did not provide a readable response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0, finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      total += value.byteLength;
      if (total > maxBytes) fail('response_too_large', 'The source response exceeds the permitted size; narrow the query.');
      chunks.push(value);
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('invalid_response', 'The source returned an unreadable text response.'); }
}

async function request(endpoint, params, auth, options) {
  if (!ALLOWED_ENDPOINTS.has(endpoint)) fail('invalid_endpoint', 'This source endpoint is not allowed.');
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  const headers = { Accept: 'application/json, application/xml', 'User-Agent': 'market-research-source-tools/0.1' };
  if (auth.queryName) url.searchParams.set(auth.queryName, auth.value);
  if (auth.headerName) headers[auth.headerName] = auth.value;
  const timeoutMs = integer(options.timeoutMs, 1, 60000, 'timeoutMs', 25000);
  const maxBytes = integer(options.maxResponseBytes, 1, MAX_RESPONSE_BYTES, 'maxResponseBytes', MAX_RESPONSE_BYTES);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('runtime_unavailable', 'The Fetch runtime is unavailable.');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new SourceToolError('timeout', 'The source request timed out; no result was inferred.')); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url.toString(), { method: 'GET', headers, redirect: 'error', signal: controller.signal });
      if (!response || !Number.isInteger(response.status)) fail('invalid_response', 'The source returned an invalid HTTP response.');
      if (response.status >= 300 && response.status < 400) fail('redirect_rejected', 'The source attempted an unsupported redirect.');
      if (response.status < 200 || response.status >= 300) fail(`http_${response.status}`, 'The source rejected the HTTP request; check service access and availability.');
      return await readBounded(response, maxBytes);
    })()]);
  } catch (error) {
    if (error instanceof SourceToolError) throw error;
    fail(controller.signal.aborted ? 'timeout' : 'transport_error', controller.signal.aborted ? 'The source request timed out; no result was inferred.' : 'The source network request failed; no result was inferred.');
  } finally { clearTimeout(timer); controller.abort(); }
}
function parseJson(raw) {
  try { return JSON.parse(raw); } catch { fail('invalid_response', 'The source returned invalid JSON.'); }
}
function records(rows) {
  if (!Array.isArray(rows) || rows.some(row => !isObject(row))) fail('invalid_response', 'The source returned an invalid record list.');
  return rows;
}
function observed(rows, field) {
  return [...new Set(rows.map(row => row[field]).filter(value => typeof value === 'string' && value.trim()))].sort();
}
function result(provider, endpoint, params, sourceAsOf, rows, options, extras = {}) {
  const partial = extras.partial === true;
  return {
    status: partial ? 'partial' : rows.length ? 'ok' : 'no_data', data: rows,
    metadata: {
      provider, source_url: endpoint, request: params, source_asof: sourceAsOf,
      fetched_at: nowIso(options), returned_count: rows.length, partial,
      freshness: 'Source reporting period and retrieval time are distinct; latest upstream release is not verified.',
      ...extras,
    },
  };
}

/** Latest end date OpenDART accepts for a market-wide list.json search: the same day three months later, clamped to
 * the month end. Checked 2026-11-03: 20260802~20261102 accepted, 20260801~20261102 refused with status 100. */
export function marketWideEnd(begin) {
  const year = Number(begin.slice(0, 4)), month = Number(begin.slice(4, 6)) - 1 + 3, day = Number(begin.slice(6));
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10).replaceAll('-', '');
}

async function dartTool(name, args, env, options) {
  const marketWide = name === 'dart_disclosures' && args.corp_code === undefined;
  const params = marketWide ? {} : { corp_code: digits(args.corp_code, 8, 'corp_code') };
  let asof, nameFilter;
  if (name === 'dart_disclosures') {
    params.bgn_de = calendarDate(args.begin, 'begin'); params.end_de = calendarDate(args.end, 'end');
    const dateNumber = value => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6)));
    const span = (dateNumber(args.end) - dateNumber(args.begin)) / 86400000;
    if (span < 0 || span > 365) fail('invalid_input', 'A disclosure query must cover an ordered range of at most 366 days.');
    if (marketWide && args.end > marketWideEnd(args.begin)) fail('invalid_input', `Without corp_code DART searches at most three months; end must be on or before ${marketWideEnd(args.begin)}.`);
    params.page_no = integer(args.page_no, 1, 1000, 'page_no', 1);
    params.page_count = integer(args.num_rows, 1, 100, 'num_rows', 100);
    if (args.type !== undefined) params.pblntf_ty = allowedChoice(args.type, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], 'type');
    if (args.detail_type !== undefined) {
      if (typeof args.detail_type !== 'string' || !/^[A-J][0-9]{3}$/.test(args.detail_type)) fail('invalid_input', 'detail_type must be a letter A-J and three digits.');
      if (args.type !== undefined && args.detail_type[0] !== args.type) fail('invalid_input', 'detail_type must belong to the selected type.');
      params.pblntf_detail_ty = args.detail_type;
    }
    if (args.corp_cls !== undefined) params.corp_cls = allowedChoice(args.corp_cls, ['Y', 'K', 'N', 'E'], 'corp_cls');
    if (args.sort !== undefined) params.sort = allowedChoice(args.sort, ['date', 'crp', 'rpt'], 'sort');
    if (args.sort_order !== undefined) params.sort_mth = allowedChoice(args.sort_order, ['asc', 'desc'], 'sort_order');
    if (args.report_name_contains !== undefined) {
      if (typeof args.report_name_contains !== 'string' || !args.report_name_contains.trim() || args.report_name_contains.length > 50) fail('invalid_input', 'report_name_contains must be 1 to 50 characters.');
      nameFilter = args.report_name_contains.trim();
    }
    if (args.last_report_only !== undefined && typeof args.last_report_only !== 'boolean') fail('invalid_input', 'last_report_only must be a boolean.');
    params.last_reprt_at = args.last_report_only ? 'Y' : 'N';
    asof = { filing_date_begin: args.begin, filing_date_end: args.end, scope: marketWide ? 'market_wide' : 'single_company' };
  } else {
    params.bsns_year = String(integer(args.year, 2000, 2100, 'year'));
    params.reprt_code = allowedChoice(args.report, ['11011', '11012', '11013', '11014'], 'report');
    params.fs_div = allowedChoice(args.fs_div, ['CFS', 'OFS'], 'fs_div');
    asof = { business_year: params.bsns_year, report_code: params.reprt_code, basis: params.fs_div };
  }
  const endpoint = ENDPOINTS[name];
  const payload = parseJson(await request(endpoint, params, { queryName: 'crtfc_key', value: credential(env, ['DART_API_KEY', 'OPENDART_API_KEY']) }, options));
  if (!isObject(payload) || typeof payload.status !== 'string') fail('invalid_response', 'DART returned no valid status.');
  if (payload.status === '013') {
    if ((payload.list !== undefined && (!Array.isArray(payload.list) || payload.list.length > 0)) || (payload.total_count !== undefined && providerCount(payload.total_count, 'record count') !== 0)) fail('invalid_response', 'DART returned inconsistent no-data metadata.');
    return result('OpenDART', endpoint, params, asof, [], options, { provider_status: '013', total_count: 0 });
  }
  if (payload.status !== '000') {
    const code = /^[0-9]{3}$/.test(payload.status) ? payload.status : 'unrecognized';
    fail(`dart_${code}`, 'DART rejected the request; check authentication, quota and requested scope.');
  }
  const rows = records(payload.list);
  if (name === 'dart_disclosures') {
    const total = providerCount(payload.total_count, 'record count');
    const pages = providerCount(payload.total_page, 'page count');
    if (total < rows.length || rows.length > params.page_count || (total === 0 && pages !== 0)) fail('invalid_response', 'DART returned inconsistent pagination metadata.');
    const complete = params.page_no === 1 && total === rows.length;
    const kept = nameFilter ? rows.filter(row => typeof row.report_nm === 'string' && row.report_nm.replaceAll(' ', '').includes(nameFilter.replaceAll(' ', ''))) : rows;
    return result('OpenDART', endpoint, params, { ...asof, observed_filing_dates: observed(kept, 'rcept_dt') }, kept, options, {
      provider_status: '000', total_count: total, partial: !complete,
      pagination: { page_no: params.page_no, page_count: params.page_count, total_pages: pages, complete, auto_pagination: false },
      ...(nameFilter ? { report_name_filter: { contains: nameFilter, page_rows: rows.length, kept_rows: kept.length, note: 'Applied to this page only; read the other pages before concluding a filing is absent.' } } : {}),
    });
  }
  return result('OpenDART', endpoint, params, asof, rows, options, { provider_status: '000', receipt_numbers: observed(rows, 'rcept_no') });
}

async function krxTool(name, args, env, options) {
  const market = allowedChoice(args.market, ['KOSPI', 'KOSDAQ', 'KONEX'], 'market');
  const date = calendarDate(args.date, 'date');
  if (!Array.isArray(args.codes) || args.codes.length < 1 || args.codes.length > 50 || args.codes.some(code => typeof code !== 'string' || !/^[0-9A-Z]{6}$/.test(code))) fail('invalid_input', 'Provide one to fifty exact six-character KRX short codes.');
  const codes = [...new Set(args.codes)];
  const endpoint = KRX_BASE + KRX_ROUTES[name][market];
  const payload = parseJson(await request(endpoint, { basDd: date }, { headerName: 'AUTH_KEY', value: credential(env, ['KRX_API_KEY']) }, options));
  if (!isObject(payload)) fail('invalid_response', 'KRX returned an invalid envelope.');
  const allRows = records(payload.OutBlock_1);
  const codeField = name === 'krx_base' ? 'ISU_SRT_CD' : 'ISU_CD';
  if (allRows.some(row => typeof row[codeField] !== 'string')) fail('invalid_response', 'KRX returned an unexpected security-code schema.');
  const requested = new Set(codes), rows = allRows.filter(row => requested.has(row[codeField]));
  const returned = new Set(rows.map(row => row[codeField]));
  const unmatched = codes.filter(code => !returned.has(code));
  return result('KRX Open API', endpoint, { basDd: date, market, codes }, { requested_date: date, observed_dates: observed(rows, 'BAS_DD') }, rows, options, {
    partial: rows.length > 0 && unmatched.length > 0,
    coverage: { provider_row_count: allRows.length, unmatched_codes: unmatched },
    empty_result_note: rows.length ? null : 'No matching records were returned; this does not establish a holiday or a zero value.',
  });
}

/** XML is loaded only for XML-returning providers. Pin fast-xml-parser 5.11.2. */
async function defaultXmlParser(raw) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw)) fail('invalid_response', 'XML declarations defining external or custom entities are not accepted.');
  let library;
  try { library = await import('fast-xml-parser'); }
  catch { fail('runtime_dependency_missing', 'The server XML parser dependency is not installed.'); }
  try {
    if (library.XMLValidator.validate(raw) !== true) fail('invalid_response', 'The source returned invalid XML.');
    return new library.XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false,
      parseAttributeValue: false, trimValues: true, processEntities: true, maxNestedTags: 32,
      isArray: name => name === 'item' }).parse(raw);
  } catch (error) {
    if (error instanceof SourceToolError) throw error;
    fail('invalid_response', 'The source returned unsupported XML.');
  }
}

export async function parsePublicDataResponse(raw, options = {}) {
  let payload;
  if (raw.trimStart().startsWith('<')) {
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw)) fail('invalid_response', 'XML entity declarations are not accepted.');
    try { payload = await (options.parseXml ?? defaultXmlParser)(raw); }
    catch (error) {
      if (error instanceof SourceToolError) throw error;
      fail('invalid_response', 'The source returned unsupported XML.');
    }
  } else payload = parseJson(raw);
  const envelope = payload?.response;
  const gateway = payload?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gateway) {
    const code = /^[0-9]{1,3}$/.test(String(gateway.returnReasonCode)) ? String(gateway.returnReasonCode) : 'unrecognized';
    fail(`public_data_${code}`, 'The public-data gateway rejected the request; check service approval and quota.');
  }
  if (!isObject(envelope) || !isObject(envelope.header)) fail('invalid_response', 'The public-data provider returned no valid response envelope.');
  const rawCode = envelope.header.resultCode;
  if (typeof rawCode !== 'string' && typeof rawCode !== 'number') fail('invalid_response', 'The public-data provider returned no valid status.');
  const code = String(rawCode).trim();
  if (!['0', '00', '000', '3', '03'].includes(code)) {
    const safeCode = /^[0-9]{1,3}$/.test(code) ? code : 'unrecognized';
    fail(`public_data_${safeCode}`, 'The public-data provider rejected the request; check service approval, quota and scope.');
  }
  const noData = ['3', '03'].includes(code);
  let body = envelope.body;
  if (body === undefined || body === null || body === '') body = {};
  if (!isObject(body)) fail('invalid_response', 'The public-data provider returned an invalid body.');
  if (!noData && !Object.hasOwn(body, 'items') && !Object.hasOwn(body, 'totalCount')) fail('invalid_response', 'A successful public-data response omitted its payload.');
  let items = body.items;
  if (isObject(items) && Object.hasOwn(items, 'item')) items = items.item;
  if (items === undefined || items === null || items === '' || (isObject(items) && !Object.keys(items).length)) items = [];
  else if (isObject(items)) items = [items];
  const rows = records(items);
  const total = providerCount(body.totalCount, 'total count', rows.length);
  if (total < rows.length || (noData && (total > 0 || rows.length > 0))) fail('invalid_response', 'The public-data provider returned inconsistent counts.');
  return { rows, total, provider_status: code, partial: total > rows.length };
}

async function publicTool(name, args, env, options) {
  const params = { resultType: 'json' };
  let endpoint = ENDPOINTS[name], asof;
  if (name === 'customs_trade') {
    if (typeof args.hs !== 'string' || !/^[0-9]{2,10}$/.test(args.hs)) fail('invalid_input', 'HS code must contain two to ten digits.');
    const start = monthIndex(args.start_ym, 'start_ym'), end = monthIndex(args.end_ym, 'end_ym');
    if (end < start || end - start >= 12) fail('invalid_input', 'Customs queries require an ordered range of at most twelve months.');
    params.strtYymm = args.start_ym; params.endYymm = args.end_ym; params.hsSgn = args.hs;
    if (args.country !== undefined) {
      if (typeof args.country !== 'string' || !/^[A-Z]{2}$/.test(args.country)) fail('invalid_input', 'Country must be a two-letter uppercase code.');
      params.cntyCd = args.country; endpoint = ENDPOINTS.customs_country;
    }
    asof = { period_begin: args.start_ym, period_end: args.end_ym };
  } else {
    params.pageNo = integer(args.page_no, 1, 1000, 'page_no', 1);
    params.numOfRows = integer(args.num_rows, 1, 100, 'num_rows', 100);
    if (name === 'fsc_outline') {
      if ((args.crno !== undefined) === (args.corp_name !== undefined)) fail('invalid_input', 'Specify exactly one of crno or corp_name.');
      if (args.crno !== undefined) params.crno = digits(args.crno, 13, 'crno');
      else {
        if (typeof args.corp_name !== 'string' || !args.corp_name.trim() || args.corp_name.length > 100 || /[\u0000-\u001f\u007f]/.test(args.corp_name)) fail('invalid_input', 'corp_name must be a nonempty name of at most 100 characters.');
        params.corpNm = args.corp_name.trim();
      }
      asof = {};
    } else {
      params.crno = digits(args.crno, 13, 'crno');
      if (name === 'fsc_financials') { params.bizYear = String(integer(args.year, 2000, 2100, 'year')); asof = { business_year: params.bizYear }; }
      else { if (args.base_date !== undefined) params.basDt = calendarDate(args.base_date, 'base_date'); asof = { requested_date: params.basDt ?? null }; }
    }
  }
  const raw = await request(endpoint, params, { queryName: 'serviceKey', value: publicDataKey(env) }, options);
  const parsed = await parsePublicDataResponse(raw, options);
  if (params.numOfRows !== undefined && parsed.rows.length > params.numOfRows) fail('invalid_response', 'The public-data provider exceeded the requested row limit.');
  const partial = parsed.partial || (params.pageNo !== undefined && params.pageNo > 1 && parsed.rows.length > 0);
  const complete = !parsed.partial && (params.pageNo === undefined || params.pageNo === 1);
  return result(name === 'customs_trade' ? 'Korea Customs Service / data.go.kr' : 'Financial Services Commission / data.go.kr', endpoint, params,
    { ...asof, observed_dates: observed(parsed.rows, 'basDt'), observed_business_years: observed(parsed.rows, 'bizYear'), observed_period_labels: observed(parsed.rows, 'year') },
    parsed.rows, options, {
      provider_status: parsed.provider_status, total_count: parsed.total, partial,
      pagination: { page_no: params.pageNo ?? null, num_rows: params.numOfRows ?? null, complete, auto_pagination: false },
      ...(name === 'customs_trade' ? { aggregation_note: '총계/합계와 상세 HS·월별 행을 중복 합산하지 마세요. 동일 기간·국가·HS 범위에서 하나의 집계 기준을 선택하세요.' } : {}),
    });
}

/** Returns normalized data or a safe structured error; never forwards raw exceptions. */
export async function dispatchTool(name, args = {}, env = {}, options = {}) {
  try {
    cleanArgs(name, args);
    if (name.startsWith('dart_')) return await dartTool(name, args, env, options);
    if (name.startsWith('krx_')) return await krxTool(name, args, env, options);
    return await publicTool(name, args, env, options);
  } catch (error) {
    if (error instanceof SourceToolError) return { status: 'error', error: { code: error.code, message: error.message } };
    return { status: 'error', error: { code: 'internal_error', message: 'The source operation could not be completed; no result was inferred.' } };
  }
}
