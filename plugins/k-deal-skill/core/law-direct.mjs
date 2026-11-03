/** Direct client for the 법제처 국가법령정보 공동활용 Open API (www.law.go.kr/DRF). Needs an OC issued at open.law.go.kr.
 * 국세청·재정경제부 해석 본문은 법제처 API에 없어 국세법령정보시스템(taxlaw.nts.go.kr) 공개 조회로 받는다.
 * Decision domain → DRF target mapping follows korean-law-mcp (MIT, https://github.com/chrisryugj/korean-law-mcp).
 */
import LAW_CATALOG from './catalog/law-apis.json' with { type: 'json' };

const DRF_BASE = 'https://www.law.go.kr/DRF/';
const CATALOG = new Map(LAW_CATALOG.apis.map(api => [api.id, api]));
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
export const DECISION_TARGETS = Object.freeze({
  precedent: 'prec', interpretation: 'expc', tax_tribunal: 'ttSpecialDecc', customs: 'kcsCgmExpc', nts: 'ntsCgmExpc',
  moel: 'moelCgmExpc', mois: 'moisCgmExpc', constitutional: 'detc', admin_appeal: 'decc', ftc: 'ftc', pipc: 'ppc', nlrc: 'nlrc',
  iaciac: 'iaciac', eiac: 'eiac', acr: 'acr', appeal_review: 'adapSpecialDecc', acr_special: 'acrSpecialDecc',
  school: 'school', public_corp: 'public', public_inst: 'pi', treaty: 'trty', english_law: 'elaw',
});
// Decision-like targets beyond the named domains (committees, 39 ministries' interpretations, special tribunals).
// They are addressed by their DRF target code and are served only by the direct 법제처 API.
const KNOWN_TARGETS = new Set(Object.values(DECISION_TARGETS));
export const DIRECT_ONLY_DOMAINS = Object.freeze([...new Set(LAW_CATALOG.apis
  .filter(api => api.kind === 'list' && /결정문|법령해석|특별행정심판/.test(api.name) && !KNOWN_TARGETS.has(api.target))
  .map(api => api.target))]);
export const DOMAIN_LABELS = Object.freeze(Object.fromEntries(DIRECT_ONLY_DOMAINS.map(target =>
  [target, LAW_CATALOG.apis.find(api => api.target === target && api.kind === 'list').name.replace(/ 목록 조회$/, '')])));
// lawService.do has no body for these targets; the text is on 국세법령정보시스템 under an 18-digit ntstDcmId.
export const TAXLAW_TARGETS = new Set(['ntsCgmExpc', 'moefCgmExpc']);
const TAXLAW_ACTION = 'https://taxlaw.nts.go.kr/action.do';
const TAXLAW_DETAIL = 'https://taxlaw.nts.go.kr/qt/USEQTA002P.do';

export class LawDirectError extends Error {
  constructor(code, message) { super(message); this.name = 'LawDirectError'; this.code = code; }
}
function fail(code, message) { throw new LawDirectError(code, message); }

/** 제750조 → 075000, 제10조의2·제10조-2 → 001002, 第750條 → 075000, 075000 → 075000. 항·호·목은 떼고 조 단위로 본다.
 * Anything else (부칙 등) returns null. */
export function joCode(article) {
  const text = String(article ?? '').trim().replace(/第/g, '제').replace(/條/g, '조');
  if (/^\d{6}$/.test(text)) return text;
  const match = /^제?\s*(\d{1,4})\s*조(?:\s*(?:의|-)\s*(\d{1,2}))?(?:\s*(?:제\s*)?\d{1,3}\s*(?:항|호|목).*)?$/.exec(text);
  if (!match || Number(match[1]) === 0) return null;
  return match[1].padStart(4, '0') + (match[2] ?? '0').padStart(2, '0');
}

export function redactOc(text, oc) {
  let out = text.replace(/([?&]OC=)[^&"'\s<>]+/gi, '$1[REDACTED]');
  if (oc && oc.length >= 6) out = out.split(oc).join('[REDACTED]');
  return out;
}

/** Builds the DRF request for an already validated law tool input (see law-tools.mjs toolArgs). */
export function buildRequest(name, input) {
  // DRF returns law-name matches in name order, so a short name like 상법 can sit far down the list.
  // Fetch the maximum page and rank by name match before trimming to the requested size.
  if (name === 'law_search') return { endpoint: 'lawSearch.do', params: { target: 'law', query: input.query, display: 100 }, keep: input.display };
  if (name === 'law_text') {
    // A dated version is addressed by MST plus its exact 시행일; lawDirect resolves a law ID and as-of date to that pair.
    const params = input.efYd ? { target: 'eflaw', MST: input.mst, efYd: input.efYd } : { target: 'law', ...(input.mst ? { MST: input.mst } : { ID: input.lawId }) };
    const addenda = String(input.jo ?? '').trim() === '부칙';
    const jo = input.jo && !addenda ? joCode(input.jo) : null;
    if (jo) params.JO = jo;
    return { endpoint: 'lawService.do', params, jo, addenda,
      note: input.jo && !jo && !addenda ? '조문 번호 형식이 아니어서 전체 본문을 조회했습니다.' : null };
  }
  const target = DECISION_TARGETS[input.domain] ?? (DIRECT_ONLY_DOMAINS.includes(input.domain) ? input.domain : null);
  if (!target) fail('invalid_input', 'The decision domain is not supported.');
  if (name === 'law_decisions_search') return { endpoint: 'lawSearch.do', params: { target, query: input.query, display: input.display, page: input.page } };
  if (TAXLAW_TARGETS.has(target)) {
    if (!/^\d{18}$/.test(input.id)) fail('invalid_input', '국세청·재정경제부 해석 본문은 검색 결과의 ntstDcmId(18자리)로 조회합니다. 법제처 일련번호로는 본문이 없습니다.');
    return { taxlaw: true, target, id: input.id };
  }
  return { endpoint: 'lawService.do', params: { target, ID: input.id } };
}

/** Exact name or short name first, then its 시행령·시행규칙, then names starting with or containing the query. */
export function rankLaws(list, query) {
  const q = query.replace(/\s+/g, '');
  const name = item => String(item?.법령명한글 ?? '').replace(/\s+/g, '');
  const score = item => {
    const n = name(item), short = String(item?.법령약칭명 ?? '').replace(/\s+/g, '');
    if (n === q || short === q) return 0;
    if (n === `${q}시행령` || n === `${q}시행규칙`) return 1;
    if (n.startsWith(q)) return 2;
    if (n.includes(q)) return 3;
    return 4;
  };
  return list.map((item, index) => ({ item, index, s: score(item) })).sort((a, b) => a.s - b.s || a.index - b.index).map(x => x.item);
}

const RETRY_STATUS = new Set([404, 429, 502, 503, 504]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One DRF GET with the OC. DRF answers bursts with short-lived 404/5xx, so those and transport errors get two quick
 * retries inside the overall timeout. Returns parsed JSON with the OC removed from every string. */
export async function drfGet(endpoint, params, oc, options = {}) {
  const url = new URL(endpoint, DRF_BASE);
  url.searchParams.set('OC', oc);
  url.searchParams.set('type', 'JSON');
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? wait;
  const deadline = Date.now() + (options.timeoutMs ?? 25000);
  let text;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let retryable = false;
    try {
      const response = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'market-research-mcp-law/1.1' }, redirect: 'error', signal: controller.signal });
      if (response.status < 200 || response.status >= 300) {
        retryable = RETRY_STATUS.has(response.status);
        fail('law_http_error', `법제처 API가 HTTP ${response.status}로 응답했습니다. 결과 없음으로 해석하지 않습니다.`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > (options.maxResponseBytes ?? MAX_RESPONSE_BYTES)) fail('response_too_large', '응답이 너무 큽니다. 조문(article)을 지정하거나 범위를 좁혀 다시 조회하세요.');
      text = buffer.toString('utf8');
      break;
    } catch (error) {
      const timedOut = controller.signal.aborted;
      if (!(error instanceof LawDirectError)) retryable = !timedOut;
      if (retryable && attempt < 2 && deadline - Date.now() > 1000) { await sleep(300 * 3 ** attempt); continue; }
      if (error instanceof LawDirectError) throw error;
      fail(timedOut ? 'timeout' : 'transport_error', '법제처 API 연결에 실패했습니다. 결과 없음으로 해석하지 않습니다.');
    } finally { clearTimeout(timer); }
  }
  if (!text.trim()) fail('law_api_empty', '법제처 API가 빈 응답을 보냈습니다. 일시 장애이거나 해당 자료가 없는 경우로, 결과 없음으로 단정하지 않습니다.');
  let data;
  try { data = JSON.parse(redactOc(text, oc)); }
  catch { fail('law_api_non_json', '법제처 API가 JSON이 아닌 응답(안내 페이지)을 보냈습니다. 없는 시행일·조문 조합, JSON 미지원 API, OC 승인·등록 IP 문제 중 하나입니다.'); }
  if (data && typeof data === 'object' && typeof data.result === 'string' && typeof data.msg === 'string' && Object.keys(data).length <= 3) {
    fail('law_api_rejected', `법제처 API가 요청을 거절했습니다: ${data.result} ${data.msg}`.slice(0, 240));
  }
  return data;
}

/** DRF signals a missing document with an empty object or a lone message such as {"Law":"일치하는 판례가 없습니다"}. */
function notFoundMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '법제처 API가 형식을 알 수 없는 응답을 보냈습니다.';
  const keys = Object.keys(data);
  if (!keys.length) return '해당 식별자·시행일로 조회되는 원문이 없습니다.';
  if (keys.length === 1 && typeof data[keys[0]] === 'string') return data[keys[0]].replace(/\s+/g, ' ').trim().slice(0, 160);
  return null;
}

/** Every version of a law (현행·연혁·시행예정) as {mst, effective, promulgated, status, name}, newest effective date first. */
export async function lawVersions(lawId, oc, options = {}) {
  const get = options.get ?? ((endpoint, params) => drfGet(endpoint, params, oc, options));
  const rows = [];
  for (let page = 1; page <= 5; page++) {
    const data = await get('lawSearch.do', { target: 'eflaw', LID: lawId, nw: '1,2,3', display: 100, page });
    const list = [].concat(data?.LawSearch?.law ?? []);
    rows.push(...list);
    if (list.length < 100 || rows.length >= Number(data?.LawSearch?.totalCnt ?? 0)) break;
  }
  return rows.filter(row => /^\d{8}$/.test(String(row?.시행일자 ?? '')) && row?.법령일련번호)
    .map(row => ({ mst: String(row.법령일련번호), effective: String(row.시행일자), promulgated: String(row.공포일자 ?? ''), status: String(row.현행연혁코드 ?? ''), name: String(row.법령명한글 ?? '') }))
    .sort((a, b) => b.effective.localeCompare(a.effective) || b.mst.localeCompare(a.mst));
}

/** Keeps only the requested article: DRF may add the chapter heading or ignore JO altogether. */
function onlyArticle(data, jo) {
  const law = data?.법령;
  if (!law?.조문) return 0;
  const number = Number(jo.slice(0, 4)), branch = Number(jo.slice(4));
  const units = [].concat(law.조문.조문단위 ?? []).filter(unit => unit?.조문여부 === '조문'
    && Number(unit.조문번호) === number && Number(unit.조문가지번호 || 0) === branch);
  law.조문.조문단위 = units;
  return units.length;
}

/** Leaves the basic info and the 부칙 units, latest promulgation first. */
function onlyAddenda(data) {
  const law = data?.법령;
  const units = [].concat(law?.부칙?.부칙단위 ?? []).sort((a, b) => String(b?.부칙공포일자 ?? '').localeCompare(String(a?.부칙공포일자 ?? '')));
  data.법령 = { 기본정보: law?.기본정보, 부칙: { 부칙단위: units } };
  return units.length;
}

function htmlText(value) {
  return String(value ?? '').replace(/<(?:br|\/p|\/div|\/tr|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One 국세청·재정경제부 interpretation from 국세법령정보시스템. The detail page loads it with this form POST; an unknown id
 * answers SUCCESS with dcmDVO null, which is the only shape read as "no such document". */
export async function taxlawDocument(id, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const detailUrl = `${TAXLAW_DETAIL}?ntstDcmId=${id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  let json;
  try {
    const response = await fetchImpl(TAXLAW_ACTION, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://taxlaw.nts.go.kr', referer: detailUrl,
        'x-requested-with': 'XMLHttpRequest', 'User-Agent': 'market-research-mcp-law/1.1' },
      body: new URLSearchParams({ actionId: 'ASIQTB002PR01', paramData: JSON.stringify({ dcmDVO: { ntstDcmId: id } }) }).toString() });
    if (response.status < 200 || response.status >= 300) fail('taxlaw_http_error', `국세법령정보시스템이 HTTP ${response.status}로 응답했습니다. 결과 없음으로 해석하지 않습니다.`);
    try { json = JSON.parse(await response.text()); }
    catch { fail('taxlaw_non_json', '국세법령정보시스템이 JSON이 아닌 응답을 보냈습니다. 점검 중이거나 조회 방식이 바뀐 경우입니다.'); }
  } catch (error) {
    if (error instanceof LawDirectError) throw error;
    fail(controller.signal.aborted ? 'timeout' : 'transport_error', '국세법령정보시스템 연결에 실패했습니다. 결과 없음으로 해석하지 않습니다.');
  } finally { clearTimeout(timer); }
  const action = json?.data?.ASIQTB002PR01;
  const dcm = action?.dcmDVO;
  if (!dcm) {
    if (json?.status === 'SUCCESS' && action && action.dcmDVO === null) fail('not_found', `국세법령정보시스템에 ntstDcmId ${id} 문서가 없습니다.`);
    fail('taxlaw_unexpected', '국세법령정보시스템 응답 형식이 예상과 다릅니다. 결과 없음으로 해석하지 않습니다.');
  }
  // The editor HTML holds 사실관계·질의·관련법령 and ntstDcmCntn holds the 회신, so both are kept.
  const editor = [].concat(action.dcmHwpEditorDVOList ?? []).map(item => htmlText(item?.dcmFleByte)).filter(text => text.length > 20);
  return {
    status: 'ok',
    data: { 제목: htmlText(dcm.ntstDcmTtl), 안건번호: htmlText(dcm.ntstDcmDscmCntn), 회신번호: htmlText(dcm.ntstDcmRplyCntn),
      생산일자: String(dcm.ntstDcmRgtDt ?? ''), 요지: htmlText(dcm.ntstDcmGistCntn), 회신: htmlText(dcm.ntstDcmCntn), 본문: editor.join('\n\n'), ntstDcmId: id },
    metadata: { provider: '국세법령정보시스템(국세청) 공개 조회', source_url: detailUrl, request: { ntstDcmId: id },
      fetched_at: new Date(options.now ? options.now() : Date.now()).toISOString(), credential_mode: 'public_page',
      freshness: '생산일자와 조회 시각은 다릅니다. 법제처 Open API가 아닌 국세청 공개 화면의 조회 방식이라 인용 전 원문 링크로 대조하세요.' },
  };
}

/** Adds the 18-digit 국세법령정보시스템 id to each search hit whose detail link points there. */
function addTaxlawIds(value) {
  if (Array.isArray(value)) { value.forEach(addTaxlawIds); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /상세링크$/.test(key)) {
      const id = /ntstDcmId=(\d{18})/.exec(item)?.[1];
      if (id) value.본문조회ID = id;
    } else addTaxlawIds(item);
  }
}

export async function lawDirect(name, input, oc, options = {}) {
  if (name === 'law_decision_text') {
    const request = buildRequest(name, input);
    if (request.taxlaw) return taxlawDocument(request.id, options);
  }
  let version = null;
  if (name === 'law_text' && input.efYd) {
    if (input.mst) version = { requested_date: input.efYd, mst: input.mst, effective: input.efYd, resolved_by: 'mst_and_exact_effective_date' };
    else {
      const versions = await lawVersions(input.lawId, oc, options);
      const chosen = versions.find(v => v.effective <= input.efYd);
      if (!chosen) fail('not_found', versions.length ? `${input.efYd} 이전에 시행된 버전이 없습니다(가장 이른 시행일 ${versions.at(-1).effective}).` : '법령 ID로 조회되는 버전 목록이 없습니다.');
      version = { requested_date: input.efYd, mst: chosen.mst, effective: chosen.effective, promulgated: chosen.promulgated, status: chosen.status, name_then: chosen.name, resolved_by: 'version_list' };
    }
  }
  const { endpoint, params, note, keep, jo, addenda } = buildRequest(name, version ? { ...input, mst: version.mst, efYd: version.effective } : input);
  const data = await drfGet(endpoint, params, oc, options);
  if (name !== 'law_search' && name !== 'law_decisions_search') {
    const missing = notFoundMessage(data);
    if (missing) fail('not_found', version?.resolved_by === 'mst_and_exact_effective_date'
      ? `${missing} MST와 date를 함께 쓰면 date는 그 버전의 정확한 시행일이어야 합니다. 기준일 당시 버전은 law_id와 date로 조회하세요.` : missing);
  }
  let extra = null;
  if (name === 'law_text' && jo && !onlyArticle(data, jo)) fail('not_found', `해당 버전에 ${input.jo}가 없습니다. 조문 번호와 기준일을 확인하세요.`);
  if (name === 'law_text' && addenda) extra = `부칙 ${onlyAddenda(data)}건을 공포일 최근 순으로 반환했습니다.`;
  if (name === 'law_text' && jo && /[항호목]/.test(String(input.jo))) extra = '항·호·목은 조 단위로 조회했습니다. 해당 항·호·목은 조문 안에서 확인하세요.';
  if (name === 'law_decisions_search' && TAXLAW_TARGETS.has(params.target)) {
    addTaxlawIds(data);
    extra = '본문은 각 결과의 본문조회ID(국세법령정보시스템 ntstDcmId)로 law_decision_text를 조회합니다.';
  }
  let ranked = null;
  if (keep && data?.LawSearch) {
    const list = [].concat(data.LawSearch.law ?? []);
    data.LawSearch.law = rankLaws(list, input.query).slice(0, keep);
    ranked = { returned: data.LawSearch.law.length, considered: list.length, total: Number(data.LawSearch.totalCnt ?? list.length) };
  }
  const request = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const notes = [note, extra].filter(Boolean).join(' ');
  return {
    status: 'ok', data,
    metadata: {
      provider: '법제처 국가법령정보 공동활용 Open API', source_url: `${DRF_BASE}${endpoint}`, request,
      fetched_at: new Date(options.now ? options.now() : Date.now()).toISOString(), credential_mode: 'law_oc_direct',
      freshness: '공포일·시행일·선고일 등 원자료 날짜와 조회 시각은 다릅니다.', ...(version ? { version } : {}), ...(notes ? { note: notes } : {}),
      ...(ranked ? { ranking: `법령명 일치도 순으로 정렬해 상위 ${ranked.returned}건을 반환했습니다(검토 ${ranked.considered}건, 전체 ${ranked.total}건).` } : {}),
    },
  };
}

/** Finds 법제처 OPEN API entries by name or target for law_api. Local, no network call. */
export function lawCatalog({ query = '', kind, limit = 20 } = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = LAW_CATALOG.apis.filter(api => (!kind || api.kind === kind)
    && terms.every(t => api.name.toLowerCase().includes(t) || api.target.toLowerCase().includes(t)));
  return {
    status: 'ok',
    data: hits.slice(0, limit).map(api => ({ api_id: api.id, name: api.name, kind: api.kind, target: api.target,
      params: api.params.map(p => `${p.name}${p.required ? '*' : ''}: ${p.description}`) })),
    metadata: { catalog: LAW_CATALOG.source, compiled_from: LAW_CATALOG.compiled_from, compiled_at: LAW_CATALOG.compiled_at,
      total_apis: LAW_CATALOG.count, matched: hits.length, note: '* 표시는 필수 파라미터. OC·target·type은 서버가 채웁니다. law_api의 api_id로 실행합니다.' },
  };
}

/** Runs any catalogued 법제처 OPEN API with documented parameters only. */
export async function lawApi(apiId, params, oc, options = {}) {
  const spec = CATALOG.get(apiId);
  if (!spec) fail('invalid_input', 'Unknown api_id. Use law_catalog to find one.');
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('invalid_input', 'params must be an object.');
  const allowed = new Map(spec.params.map(p => [p.name, p]));
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (!allowed.has(key)) fail('invalid_input', `${spec.name}에 없는 파라미터입니다: ${key}`);
    if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 300) fail('invalid_input', `${key} 값 형식이 맞지 않습니다.`);
    clean[key] = String(value);
  }
  const missing = spec.params.filter(p => p.required && clean[p.name] === undefined).map(p => p.name);
  if (missing.length) fail('invalid_input', `필수 파라미터가 없습니다: ${missing.join(', ')}`);
  const data = await drfGet(spec.endpoint, { target: spec.target, ...clean }, oc, options);
  return { status: 'ok', data, metadata: { provider: '법제처 국가법령정보 공동활용 Open API', api_id: spec.id, api_name: spec.name,
    source_url: `${DRF_BASE}${spec.endpoint}`, request: { target: spec.target, ...clean }, fetched_at: new Date(options.now ? options.now() : Date.now()).toISOString(),
    credential_mode: 'law_oc_direct', freshness: '공포일·시행일·선고일 등 원자료 날짜와 조회 시각은 다릅니다.' } };
}
