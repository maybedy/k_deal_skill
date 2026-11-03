/** data.go.kr tools: 국세청 사업자 상태조회 (biz_status), and catalogued services (datago_catalog, datago_api).
 * The catalog (catalog/datago-apis.json) lists each service's operations and documented parameters; datago_api
 * only sends those parameters. Keys come only from the env passed by the gateway.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePublicDataResponse, SourceToolError } from './api-tools.mjs';

const CATALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'catalog', 'datago-apis.json');
const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const MAX_BYTES = 8 * 1024 * 1024;
function define(name, description, properties, required) {
  return Object.freeze({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: READ });
}

export const DATAGO_TOOL_DEFINITIONS = Object.freeze([
  define('biz_status', '국세청 사업자등록 상태조회. 사업자등록번호(최대 100개)로 계속·휴업·폐업 여부, 과세유형, 폐업일을 확인합니다. 비상장 회사·거래 상대방의 실재 여부 확인용.', {
    bizno_list: { type: 'array', items: { type: 'string', pattern: '^[0-9]{3}-?[0-9]{2}-?[0-9]{5}$' }, minItems: 1, maxItems: 100 },
  }, ['bizno_list']),
  define('datago_catalog', '서버가 제공하는 공공데이터포털(data.go.kr) 서비스와 오퍼레이션·파라미터 목록을 찾습니다(금융위 기업·재무·주식발행·자금조달 공시, 예탁결제원 기업·주식정보, 국민연금 가입 사업장, 공정위 통신판매·가맹본부, 관세청 수출입, 비상장 점검용 고용·산재보험 상시인원·특허/상표 등록원부·조달 등록업체/실적/부정당제재·공장등록·화장품/의료기기 업체·창업기업 확인 등). 승인 전 서비스는 approved=false. 찾은 service·operation을 datago_api로 실행합니다. 원천 호출 없음.', {
    query: { type: 'string', maxLength: 60, description: '서비스명·기관·오퍼레이션 검색어 (예: 주식발행, 예탁, 국민연금, 사업장)' },
    approved_only: { type: 'boolean', default: true, description: 'true면 이 서버 키로 승인된 서비스만' },
  }, []),
  define('datago_api', '공공데이터포털 서비스 오퍼레이션 실행. service·operation과 해당 오퍼레이션에 문서화된 파라미터만 받습니다(datago_catalog로 확인). serviceKey·응답형식은 서버가 채웁니다.', {
    service: { type: 'string', maxLength: 60 },
    operation: { type: 'string', maxLength: 80 },
    params: { type: 'object', additionalProperties: { type: ['string', 'integer', 'boolean'] }, description: '예: {"crno":"1101110000000","numOfRows":10}' },
  }, ['service', 'operation']),
]);
export const DATAGO_TOOL_NAMES = new Set(DATAGO_TOOL_DEFINITIONS.map(d => d.name));

class DatagoError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new DatagoError(code, message); };

let catalogCache = null;
/** True for catalogued services whose public licence forbids commercial use (공공누리 제2·4유형). */
export function isNoncommercialService(serviceId, path = CATALOG_PATH) {
  const service = loadDatagoCatalog(path).services.find(s => s.id === serviceId);
  return Boolean(service && /상업적 이용금지/.test(service.license ?? ''));
}

export function loadDatagoCatalog(path = CATALOG_PATH) {
  if (!existsSync(path)) return { services: [] };
  const mtime = statSync(path).mtimeMs;
  if (!catalogCache || catalogCache.path !== path || catalogCache.mtime !== mtime) {
    catalogCache = { path, mtime, data: JSON.parse(readFileSync(path, 'utf8')) };
  }
  return catalogCache.data;
}

function serviceKey(env) {
  const enc = env?.DATA_GO_KR_KEY_ENC?.trim();
  if (enc) return enc;
  const dec = env?.DATA_GO_KR_KEY?.trim();
  if (dec) return encodeURIComponent(dec);
  fail('not_connected', 'data.go.kr 서비스키가 설정되지 않았습니다.');
}

async function fetchText(url, init, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: 'error', signal: controller.signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) fail('response_too_large', '응답이 너무 큽니다. 건수를 줄여 다시 조회하세요.');
    return { status: response.status, text: buffer.toString('utf8') };
  } catch (error) {
    if (error instanceof DatagoError) throw error;
    fail(controller.signal.aborted ? 'timeout' : 'transport_error', '공공데이터포털 연결에 실패했습니다. 결과 없음으로 해석하지 않습니다.');
  } finally { clearTimeout(timer); }
}
const notApproved = text => /SERVICE_KEY_IS_NOT_REGISTERED/.test(text);
const nowIso = options => new Date(options.now ? options.now() : Date.now()).toISOString();

async function run(name, args, env, options) {
  if (name === 'biz_status') {
    const list = [...new Set(args.bizno_list.map(b => b.replace(/-/g, '')))];
    const url = `https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=${serviceKey(env)}&returnType=JSON`;
    const { status, text } = await fetchText(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ b_no: list }) }, options);
    if (notApproved(text) || status === 401) fail('not_approved', '이 서버 키로 국세청 상태조회 서비스가 승인되지 않았습니다.');
    if (status !== 200) fail(`http_${status}`, '국세청 상태조회가 HTTP 오류로 응답했습니다.');
    let json;
    try { json = JSON.parse(text); } catch { fail('invalid_response', '국세청 응답을 해석하지 못했습니다.'); }
    if (json.status_code !== 'OK') fail('source_error', `국세청 응답 상태: ${String(json.status_code ?? '').slice(0, 40)}`);
    return { status: 'ok', data: json.data, metadata: { provider: '국세청 사업자등록정보 진위확인 및 상태조회 (공공데이터포털)', source_url: 'https://api.odcloud.kr/api/nts-businessman/v1/status',
      request: { count: list.length }, fetched_at: nowIso(options), request_cnt: json.request_cnt, match_cnt: json.match_cnt,
      note: 'b_stt_cd 01 계속사업자, 02 휴업자, 03 폐업자. 국세청 미등록 번호는 tax_type에 안내 문구가 옵니다.' } };
  }
  const catalog = loadDatagoCatalog(options.catalogPath);
  if (name === 'datago_catalog') {
    const terms = (args.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const approvedOnly = args.approved_only ?? true;
    const hits = catalog.services.filter(s => (!approvedOnly || s.key_status_2026_10_26 === 'approved')
      && terms.every(t => [s.id, s.name, s.provider, s.pe_use, ...s.operations.map(o => `${o.id} ${o.description}`)].join(' ').toLowerCase().includes(t)));
    return { status: 'ok', data: hits.map(s => ({ service: s.id, name: s.name, provider: s.provider, pe_use: s.pe_use, approved: s.key_status_2026_10_26 === 'approved', data_url: s.data_url,
      operations: s.operations.map(o => ({ operation: o.id, description: o.description, params: o.params.map(p => `${p.name}${p.required ? '*' : ''}: ${p.description}`) })) })),
      metadata: { catalog_compiled_at: catalog.compiled_at ?? null, total_services: catalog.services.length, matched: hits.length, note: '* 표시는 필수 파라미터. serviceKey와 응답형식은 서버가 채웁니다.' } };
  }
  if (name === 'datago_api') {
    const service = catalog.services.find(s => s.id === args.service);
    if (!service) fail('invalid_input', '없는 service입니다. datago_catalog로 확인하세요.');
    const op = service.operations.find(o => o.id === args.operation);
    if (!op) fail('invalid_input', `${service.name}에 없는 operation입니다.`);
    const allowed = new Map(op.params.map(p => [p.name, p]));
    if (args.params !== undefined && (typeof args.params !== 'object' || args.params === null || Array.isArray(args.params))) fail('invalid_input', 'params는 객체입니다.');
    // Paging parameters that the provider marks required get defaults so a first call does not fail on them.
    const PAGING_DEFAULTS = { pageNo: 1, page: 1, numOfRows: 10, perPage: 10 };
    const params = { ...args.params };
    for (const p of op.params) if (p.required && params[p.name] === undefined && PAGING_DEFAULTS[p.name] !== undefined) params[p.name] = PAGING_DEFAULTS[p.name];
    for (const [k, v] of Object.entries(params)) {
      if (!allowed.has(k)) fail('invalid_input', `${op.id}에 없는 파라미터입니다: ${k}`);
      if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 300) fail('invalid_input', `${k} 값 형식이 맞지 않습니다.`);
    }
    const missing = op.params.filter(p => p.required && params[p.name] === undefined).map(p => p.name);
    if (missing.length) fail('invalid_input', `필수 파라미터가 없습니다: ${missing.join(', ')}`);
    const key = serviceKey(env);
    const keyParam = service.key_param ?? 'serviceKey';
    const query = [`${keyParam}=${key}`];  // the encoded key is used as-is; re-encoding breaks it
    if (service.format_param?.name) query.push(`${encodeURIComponent(service.format_param.name)}=${encodeURIComponent(service.format_param.value)}`);
    const method = (op.method ?? service.method ?? 'GET').toUpperCase();
    if (method === 'GET') for (const [k, v] of Object.entries(params)) query.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    const url = `${service.base_url}${op.path ?? `/${op.id}`}?${query.join('&')}`;
    const init = method === 'GET' ? { method, headers: { accept: 'application/json, application/xml' } }
      : { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(params) };
    const { status, text } = await fetchText(url, init, options);
    if (notApproved(text)) fail('not_approved', `이 서버 키로 '${service.name}' 활용신청이 승인되지 않았습니다.`);
    if (status !== 200) fail(`http_${status}`, `${service.name}이(가) HTTP ${status}로 응답했습니다.`);
    const meta = { provider: `${service.provider} (공공데이터포털)`, service: service.id, service_name: service.name, operation: op.id,
      source_url: `${service.base_url}${op.path ?? `/${op.id}`}`, request: params, fetched_at: nowIso(options) };
    try {
      const parsed = await parsePublicDataResponse(text);
      return { status: parsed.partial ? 'partial' : 'ok', data: parsed.rows, metadata: { ...meta, total_count: parsed.total, provider_status: parsed.provider_status,
        data_status: parsed.rows.length ? 'ok' : 'no_data', pagination: { page_no: params.pageNo ?? null, num_rows: params.numOfRows ?? null } } };
    } catch (error) {
      if (!(error instanceof SourceToolError)) throw error;
      if (error.code === 'public_data_30') fail('not_approved', `이 서버 키로 '${service.name}' 활용신청이 승인되지 않았습니다.`);
      if (error.code !== 'invalid_response') fail(error.code, error.message);
      // Some services (odcloud and others) do not use the standard response/header/body envelope.
      try { return { status: 'ok', data: JSON.parse(text), metadata: { ...meta, envelope: 'non_standard' } }; }
      catch { fail('invalid_response', '응답 형식을 해석하지 못했습니다.'); }
    }
  }
  fail('unknown_tool', 'This tool is not available.');
}

function validate(name, args) {
  const def = DATAGO_TOOL_DEFINITIONS.find(d => d.name === name);
  if (!def) fail('unknown_tool', 'This tool is not available.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('invalid_input', 'Arguments must be an object.');
  for (const key of Object.keys(args)) if (!def.inputSchema.properties[key]) fail('invalid_input', `Unknown input: ${key}`);
  for (const key of def.inputSchema.required) if (args[key] === undefined) fail('invalid_input', `Missing input: ${key}`);
  if (name === 'biz_status' && (!Array.isArray(args.bizno_list) || !args.bizno_list.length || args.bizno_list.length > 100
    || !args.bizno_list.every(b => typeof b === 'string' && /^[0-9]{3}-?[0-9]{2}-?[0-9]{5}$/.test(b)))) fail('invalid_input', '사업자등록번호 10자리 목록(최대 100개)이 필요합니다.');
  for (const key of ['query', 'service', 'operation']) if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > 80)) fail('invalid_input', `${key} 형식이 맞지 않습니다.`);
  return args;
}

export async function dispatchDatagoTool(name, args = {}, env = {}, options = {}) {
  try { return await run(name, validate(name, args), env, options); }
  catch (error) {
    if (error instanceof DatagoError) return { status: 'error', error: { code: error.code, message: error.message } };
    return { status: 'error', error: { code: 'internal_error', message: '조회를 완료하지 못했습니다. 결과 없음으로 해석하지 않습니다.' } };
  }
}
