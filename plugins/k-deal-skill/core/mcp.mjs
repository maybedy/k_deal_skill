/** Shared MCP request handling for the Market Research server and the self-hosted k-deal-skill: tool registry,
 * initialize instructions and tools/list/tools/call. The server adds its gateway (tokens, limits, cache) on top. */
import { TOOL_DEFINITIONS, dispatchTool } from './api-tools.mjs';
import { LAW_TOOL_DEFINITIONS, ALL_LAW_TOOL_DEFINITIONS, dispatchLawTool } from './law-tools.mjs';
import { EXTRA_TOOL_DEFINITIONS, EXTRA_TOOL_NAMES, dispatchExtraTool } from './extra-tools.mjs';
import { COMPANY_TOOL_DEFINITIONS, COMPANY_TOOL_NAMES, dispatchCompanyTool } from './company-tools.mjs';
import { DATAGO_TOOL_DEFINITIONS, DATAGO_TOOL_NAMES, dispatchDatagoTool } from './datago-tools.mjs';
import { GatewayDenied } from './errors.mjs';

export const ALL_TOOLS = Object.freeze([...COMPANY_TOOL_DEFINITIONS, ...TOOL_DEFINITIONS, ...EXTRA_TOOL_DEFINITIONS, ...DATAGO_TOOL_DEFINITIONS, ...ALL_LAW_TOOL_DEFINITIONS]);
const LAW_NAMES = new Set(ALL_LAW_TOOL_DEFINITIONS.map(tool => tool.name));
export const dispatchAll = (name, args, env) => LAW_NAMES.has(name) ? dispatchLawTool(name, args, env)
  : EXTRA_TOOL_NAMES.has(name) ? dispatchExtraTool(name, args, env)
  : COMPANY_TOOL_NAMES.has(name) ? dispatchCompanyTool(name, args, env)
  : DATAGO_TOOL_NAMES.has(name) ? dispatchDatagoTool(name, args, env) : dispatchTool(name, args, env);

export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SERVER = { name: 'market-research-mcp', version: '0.3.0' };
const MAX_REQUEST_BYTES = 64 * 1024;
const STATUS_TOOL = {
  name: 'mrm_connection_status',
  description: '인증키 값 없이 Market Research 실행 환경의 원천 API 연결 설정 여부만 확인합니다. 실제 조회 성공이나 원자료 최신성을 뜻하지 않습니다.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const USAGE_TOOL = {
  name: 'mrm_usage_status',
  description: '이 연결의 오늘 사용량·남은 한도와 자료원별 남은 호출 예산을 확인합니다. 한도는 한국시간 자정에 초기화됩니다.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } });
}
function rpcError(id, code, message, status = 200) {
  return response({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);
}
function result(id, value) { return response({ jsonrpc: '2.0', id, result: value }); }
function hasCredential(...values) { return values.some(value => typeof value === 'string' && !!value.trim()); }
function connected(env, local = false) {
  if (local) return {
    execution_location: 'this computer (k-deal-skill, self-hosted)',
    note: '이 PC 환경변수에 원천 키가 있는지만 봅니다. 값은 출력하지 않습니다. 실제 조회 성공 여부는 조회해 봐야 압니다.',
    keys_present: {
      dart: hasCredential(env.DART_API_KEY, env.OPENDART_API_KEY),
      krx: hasCredential(env.KRX_API_KEY),
      datago: hasCredential(env.DATA_GO_KR_KEY_ENC, env.DATA_GO_KR_KEY),
      law: hasCredential(env.LAW_OC),
    },
    company_snapshot_db: hasCredential(env.MRM_DATAGO_DB),
  };
  return {
    execution_location: 'Market Research MCP runtime',
    // Operator default keys only. Which key a connection actually uses (customer, own, operator) is in mrm_usage_status.
    note: '운영자 기본 키 설정 여부입니다. 이 연결이 실제로 쓰는 키 종류와 남은 한도는 mrm_usage_status로 확인합니다.',
    operator_default_keys_present: {
      dart: hasCredential(env.DART_API_KEY, env.OPENDART_API_KEY),
      krx: hasCredential(env.KRX_API_KEY),
      datago: hasCredential(env.DATA_GO_KR_KEY_ENC, env.DATA_GO_KR_KEY),
      law: hasCredential(env.LAW_OC),
    },
    shared_local_database: false,
    source_freshness: 'not_checked',
    api_calls_verified: false,
  };
}
function asContent(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function userHint(message) {
  const subject = message.params?._meta?.['openai/subject'];
  return typeof subject === 'string' && subject.length <= 128 ? subject : null;
}
/** Anonymized ChatGPT organization id that ChatGPT sends with tool calls when it has one (Apps SDK reference). */
function orgHint(message) {
  const org = message.params?._meta?.['openai/organization'];
  return typeof org === 'string' && org.length <= 128 ? org : null;
}

/* Server instructions sent at initialize. Like GitHub's MCP server, a short base rule plus one section per source,
 * included only when the connection has tools from that source. Longer workflows live in the plugin skills; keep this
 * to tool order and traps, never anything beyond how to use these tools. */
const BASE_INSTRUCTIONS = 'Market Research: 한국 공식 원천(DART·KRX·법제처·data.go.kr) 읽기 전용 조회. 원천 키는 서버에 있으니 사용자에게 키를 묻지 않는다. 답에는 자료 기준일·접수번호·법령 시행일·연결/별도 기준·partial 여부를 남기고, 조회 시각을 자료 기준일로 쓰지 않는다. 오류·거절을 "자료 없음"이나 0으로 바꾸지 않는다. daily_limit·customer_daily_limit·source_budget·service_budget·source_cooldown·rate_limited·busy는 한도·보호 장치이며 mrm_usage_status로 남은 한도를 확인한다. _gateway.cache=stale은 이전 저장본이고 cached_at은 저장 시각이다.';
const LOCAL_BASE_INSTRUCTIONS = 'k-deal-skill: 한국 공식 원천(DART·KRX·법제처·data.go.kr)을 이 PC에서 사용자 본인 API 키로 읽기 전용 조회한다. 키 값을 대화에 출력하지 않는다. 답에는 자료 기준일·접수번호·법령 시행일·연결/별도 기준·partial 여부를 남기고, 조회 시각을 자료 기준일로 쓰지 않는다. 오류·거절을 "자료 없음"이나 0으로 바꾸지 않는다. not_connected는 그 원천의 키가 환경변수에 없다는 뜻이고 mrm_connection_status로 확인한다.';
const SOURCE_INSTRUCTIONS = [
  ['dart_', '## DART\n회사는 dart_corp_search(상장·DART 등록) 또는 company_search(비상장·사업자번호)로 corp_code를 먼저 확정한다. 재무: 사업보고서 제출사는 dart_financials(회사 전체는 CFS 연결 우선, 기준 명시), 결과가 no_data인 비상장 외감 법인은 dart_audit_financials. 정기보고서 항목·주요사항보고서·지분공시는 dart_report. 공시 본문은 dart_disclosures로 rcept_no를 찾은 뒤 dart_document(toc로 목차, section_id로 장·절, pattern으로 단어 검색). 주석 수치는 dart_xbrl. corp_code 없이 전체 시장 공시는 3개월 이내. 정정공시는 원 공시와 구분한다.'],
  ['krx_', '## KRX\n시세·시총·상장주식수는 krx_trade·krx_base(기준일, 종목코드 최대 50개), 지수·ETF·채권·파생은 krx_daily. 빈 결과를 휴장일로 단정하지 않는다. own_key_required는 고객사 KRX 키가 없다는 뜻이다.'],
  ['law_', '## 법령\nlaw_search로 law_id·mst를 확인한 뒤 law_text. 계약일·사건일 기준이면 date로 그날 시행본을 보고, 그 뒤 부칙의 경과조치는 law_applicable. 별표는 law_annexes, 두 시점 비교는 law_compare_dates, 인용 검증은 law_verify_citations. 판례·해석례는 law_decisions_search → law_decision_text. 노출 도구에 없는 자료는 law_catalog → law_api. 현행·과거·시행 예정본을 구분한다.'],
  ['fsc_|biz_status|company_search|industry_|mailorder_|customs_|hs_search|datago_', '## 공공데이터\n금융위 fsc_*는 법인등록번호(13자리) 기준이며 비상장사는 식별용으로만 쓴다. 국민연금 가입자 수(company_search, industry_companies)는 고용 규모 대용이지 매출이 아니고 자료월을 함께 적는다. 휴폐업은 biz_status. 수출입은 hs_search → customs_trade이며 합계행과 상세행을 더하지 않는다. 그 밖의 data.go.kr은 datago_catalog → datago_api이고, approved=false 서비스의 not_registered 오류는 자료 없음이 아니다.'],
];
export function serverInstructions(toolNames, { local = false } = {}) {
  const names = [...toolNames];
  const sections = SOURCE_INSTRUCTIONS.filter(([prefixes]) => prefixes.split('|').some(prefix => names.some(n => n.startsWith(prefix))))
    .map(([, text]) => text);
  return [local ? LOCAL_BASE_INSTRUCTIONS : BASE_INSTRUCTIONS, ...sections].join('\n\n');
}

// Without a gateway: deploy only behind Sites' authenticated dispatch and workspace access policy.
// With a gateway (self-hosted node-server.mjs): every /mcp request needs an issued bearer token.
/** MCP over HTTP (JSON-RPC POST). With a gateway every call needs an issued token and passes limits; without one,
 * `local: true` is the self-hosted mode on the user's own machine with the user's own keys, and otherwise only an
 * authenticated ChatGPT Sites dispatch is accepted. */
export function createHandler({ tools = ALL_TOOLS, dispatch = dispatchAll, gateway = null, resourceMetadataUrl = null, path = '/mcp', expectOrg = null, local = false } = {}) {
  return async function handle(request, env = {}) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Market Research API</title><style>body{font-family:system-ui;max-width:760px;margin:64px auto;padding:24px;color:#18243b;background:#f5f7fa}h1{font-size:32px}code{background:#e6ebf1;padding:3px 7px}p{line-height:1.7}</style><h1>Market Research API</h1><p>DART·KRX·공공데이터를 조회하는 읽기 전용 MCP 연결부입니다.</p><p>등록된 ChatGPT/Codex 플러그인에서 <code>/mcp</code>를 사용합니다. 원천 API 키는 서버 비밀값으로 보관하며 응답이나 화면에 표시하지 않습니다.</p><p>실제 접근 범위는 호스팅 환경의 워크스페이스 권한 설정을 따릅니다. 이 화면이 열린 사실만으로 API 인증이나 팀 공용 배포가 검증되지는 않습니다.</p></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://chatgpt.com" } });
    }
    if (url.pathname === '/healthz' && request.method === 'GET') return response({ ok: true });
    if (url.pathname !== path) return response({ error: 'not_found' }, 404);
    let principal = null;
    if (gateway) {
      principal = gateway.authenticate(request);
      if (!principal) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Market Research access token required' } }), {
        status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'www-authenticate': `Bearer realm="market-research"${resourceMetadataUrl ? `, resource_metadata="${resourceMetadataUrl(request)}"` : ''}` } });
      // Optional X-MRM-Tenant names the customer the caller expects; a token from any other customer is refused.
      const expected = request.headers.get('x-mrm-tenant')?.trim();
      if (expected && expected !== (principal.tenant_name ?? '')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Token does not belong to the customer named in X-MRM-Tenant' } }), {
          status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
    }
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
    if (!request.headers.get('content-type')?.includes('application/json')) return response({ error: 'json_required' }, 415);
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_REQUEST_BYTES) return response({ error: 'request_too_large' }, 413);
    let text;
    try {
      const reader = request.body?.getReader();
      if (!reader) return rpcError(null, -32700, 'Empty JSON request', 400);
      const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_REQUEST_BYTES) { await reader.cancel(); return response({ error: 'request_too_large' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { return rpcError(null, -32700, 'Unreadable JSON request', 400); }
    let message;
    try { message = JSON.parse(text); } catch { return rpcError(null, -32700, 'Invalid JSON', 400); }
    if (!message || Array.isArray(message) || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(null, -32600, 'Invalid JSON-RPC request', 400);
    const { id, method } = message;
    if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid request ID', 400);
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (id === undefined) return rpcError(null, -32600, 'Request ID required', 400);
    if (method === 'server/discover') return result(id, { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} } });
    if (method === 'initialize') {
      const proposed = message.params?.protocolVersion;
      return result(id, { protocolVersion: SUPPORTED_VERSIONS.includes(proposed) ? proposed : SUPPORTED_VERSIONS[0], capabilities: { tools: {} }, serverInfo: SERVER,
        instructions: serverInstructions(tools.map(tool => tool.name), { local }) });
    }
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') {
      if (!gateway) return result(id, { tools: [STATUS_TOOL, ...tools] });
      return result(id, { tools: [STATUS_TOOL, USAGE_TOOL, ...tools.filter(tool => gateway.allows(principal, tool.name))] });
    }
    if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    // A workspace route pinned to one ChatGPT organization refuses tool calls from any other organization.
    const org = orgHint(message);
    if (expectOrg && org && org !== expectOrg) return rpcError(id, -32001, 'This connection belongs to another ChatGPT organization', 403);
    // Sites injects this identity only after checking access to the Site.
    if (!gateway && !local && !request.headers.get('oai-authenticated-user-id')) return rpcError(id, -32001, 'Authenticated Market Research connection required', 401);
    const args = message.params?.arguments ?? {};
    const name = message.params?.name;
    if (typeof name !== 'string' || !args || Array.isArray(args) || typeof args !== 'object') return rpcError(id, -32602, 'Invalid tool call');
    if (name === STATUS_TOOL.name) {
      if (Object.keys(args).length) return rpcError(id, -32602, 'This status tool takes no arguments');
      return result(id, asContent(connected(env, local)));
    }
    if (gateway && name === USAGE_TOOL.name) {
      if (Object.keys(args).length) return rpcError(id, -32602, 'This status tool takes no arguments');
      return result(id, asContent(gateway.usageSnapshot(principal)));
    }
    if (!tools.some(tool => tool.name === name)) return rpcError(id, -32602, 'Unknown tool');
    try {
      const data = gateway
        ? await gateway.call(principal, name, args, { userHint: userHint(message), orgHint: org, dispatch: sourceEnv => dispatch(name, args, sourceEnv) })
        : await dispatch(name, args, env);
      const content = asContent(data);
      if (data?.status === 'error') content.isError = true;
      return result(id, content);
    }
    catch (error) {
      if (error instanceof GatewayDenied) {
        return result(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code: error.code, message: error.message } }) }] });
      }
      const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'source_request_failed';
      return result(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: { code, message: '원자료 조회에 실패했습니다. 입력·인증·API 승인·연결 상태를 확인하세요.' } }) }] });
    }
  };
}
