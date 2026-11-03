import { lawDirect, lawApi, lawCatalog, LawDirectError, DIRECT_ONLY_DOMAINS, DOMAIN_LABELS } from './law-direct.mjs';
import {
  lawAnnexes, lawCompareDates, lawAmendmentTable, lawApplicable, lawVerifyCitations, lawCiteCheck, lawImpactMap,
  lawOrdinanceRadar, lawBulkCheck, lawAdminRuleSearch, lawAdminRule,
} from './law-analysis.mjs';

/** Law tools. Every lookup goes to the 법제처 Open API with this server's LAW_OC (law-direct.mjs, law-analysis.mjs);
 * the only other host is 국세법령정보시스템 for 국세청·재정경제부 해석 본문. There is no third-party law server.
 * No filesystem or implicit env. Decision domain names and the analysis tool set follow korean-law-mcp (MIT).
 */
const SOURCE_URL = 'https://www.law.go.kr/DRF/';
const READ_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const NAMED_DOMAINS = Object.freeze([
  'precedent', 'interpretation', 'tax_tribunal', 'customs', 'nts', 'moel', 'mois',
  'constitutional', 'admin_appeal', 'ftc', 'pipc', 'nlrc', 'iaciac', 'eiac',
  'acr', 'appeal_review', 'acr_special', 'school', 'public_corp', 'public_inst',
  'treaty', 'english_law',
]);
const DOMAINS = Object.freeze([...NAMED_DOMAINS, ...DIRECT_ONLY_DOMAINS]);
const querySchema = { type: 'string', minLength: 1, maxLength: 2000 };
const domainSchema = { type: 'string', enum: DOMAINS, description: `precedent=판례, constitutional=헌재결정례, interpretation=법제처 법령해석례, admin_appeal=행정심판례, tax_tribunal=조세심판원, customs=관세청 해석, nts=국세청 해석(본문은 검색 결과의 본문조회ID), moel=고용노동부 해석, mois=행정안전부 해석(지방세 등), ftc=공정위, pipc=개인정보위, nlrc=노동위, iaciac=산재보험재심사, eiac=고용보험심사, acr=권익위, appeal_review=소청심사, acr_special=권익위 특별행정심판, school=학칙, public_corp=공사공단 규정, public_inst=공공기관 규정, treaty=조약, english_law=영문법령. 그 밖의 위원회·부처 target(moefCgmExpc 본문도 본문조회ID): ${DIRECT_ONLY_DOMAINS.map(d => `${d}=${DOMAIN_LABELS[d]}`).join(', ')}` };
function define(name, description, properties, required) {
  return Object.freeze({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: READ_ANNOTATIONS });
}
export const LAW_TOOL_DEFINITIONS = Object.freeze([
  define('law_search', '한국 법령·조례·행정규칙명 검색. 법령 ID/MST·공포일·시행일을 확인합니다.', {
    query: querySchema, display: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
  }, ['query']),
  define('law_text', '법령 조문 조회. law_id 또는 mst 하나를 지정합니다. law_id와 date를 주면 그날 시행 중이던 버전(계약일·사건일 기준)을 찾아 조회하고 metadata.version에 실제 버전을 적습니다. 생략하면 현행 또는 지정 MST 버전입니다.', {
    law_id: { type: 'string', pattern: '^[0-9]{6}$' },
    mst: { type: 'string', pattern: '^[0-9]{1,12}$' },
    article: { type: 'string', minLength: 1, maxLength: 120, description: '예: 제750조, 제10조의2, 제750조제1항(조 단위로 조회), 부칙(부칙만 최근 순)' },
    date: { type: 'string', pattern: '^[0-9]{8}$', description: '기준일 YYYYMMDD. law_id와 쓰면 그날 시행 중이던 버전, mst와 쓰면 그 버전의 정확한 시행일' },
  }, []),
  define('law_decisions_search', '판례·해석례·결정례 한 페이지 검색. domain을 명시하고 실제 원문 ID로 상세조회합니다.', {
    domain: domainSchema, query: querySchema,
    display: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
  }, ['domain', 'query']),
  define('law_catalog', '법제처 OPEN API 159개(법령·연혁·신구법·3단비교·체계도·위임법령·행정규칙·자치법규·별표서식·법령용어·판례·결정문·부처별 해석·특별행정심판·조약 등)에서 원하는 API와 파라미터를 찾습니다. 찾은 api_id를 law_api로 실행합니다. 원천 호출 없음.', {
    query: { type: 'string', maxLength: 100, description: '이름·target 검색어. 예: 신구법, 연혁, 행정규칙, 별표, 위임, 체계도, 금융위원회' },
    kind: { type: 'string', enum: ['list', 'body'], description: 'list=목록 조회, body=본문 조회' },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  }, []),
  define('law_api', '법제처 OPEN API를 직접 실행합니다. api_id와 해당 API에 문서화된 파라미터만 받습니다(law_catalog로 확인). OC·target·type은 서버가 채웁니다. 법제처 키가 등록된 서버에서만 동작합니다.', {
    api_id: { type: 'integer', minimum: 1, maximum: 159 },
    params: { type: 'object', additionalProperties: { type: ['string', 'integer', 'boolean'] }, description: '예: {"query":"상법","display":20} 또는 {"MST":"273629","JO":"038200"}' },
  }, ['api_id']),
  define('law_decision_text', '선택한 판례·해석례·결정례의 본문 조회. 검색 결과의 domain과 id를 유지합니다. nts·moefCgmExpc는 본문조회ID(18자리)로 국세법령정보시스템에서 받습니다. 없는 id는 not_found 오류입니다.', {
    domain: domainSchema, id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9._-]+$' },
  }, ['domain', 'id']),
]);

// Analysis tools: several 법제처 calls per request (metadata.upstream_calls). Not offered on the anonymous /law path.
const lawRef = {
  law_id: { type: 'string', pattern: '^[0-9]{6}$', description: '법령 ID 6자리 (law_search 결과)' },
  mst: { type: 'string', pattern: '^[0-9]{1,12}$', description: '법령일련번호(MST)' },
  law_name: { type: 'string', minLength: 1, maxLength: 120, description: '법령명 또는 약칭(정확히 같은 이름만 받습니다)' },
};
const datedLawRef = { law_id: lawRef.law_id, law_name: lawRef.law_name };
const dateSchema = description => ({ type: 'string', pattern: '^[0-9]{8}$', description });
const articleSchema = { type: 'string', minLength: 1, maxLength: 40, description: '예: 제750조, 제10조의2' };
export const LAW_ANALYSIS_TOOL_DEFINITIONS = Object.freeze([
  define('law_annexes', '법령 별표·서식 조회. law_id·mst·law_name 중 하나. date를 주면 그날 시행 중이던 버전의 별표입니다. annex·query·article로 한 건을 고르면 본문 텍스트, 괘선 표를 행·열로 읽은 tables, HWP·PDF 링크를 줍니다. 텍스트 없는 별표는 파일 링크만 있습니다.', {
    ...lawRef, date: dateSchema('기준일 YYYYMMDD(law_id 또는 law_name과 함께)'),
    annex: { type: 'string', maxLength: 20, description: '예: 3, 별표 3, 별표 3의2, 서식 2' },
    query: { type: 'string', maxLength: 100, description: '별표 제목 검색어. 예: 과태료, 수수료' },
    article: { ...articleSchema, description: '위임 조문. 제목의 "(제N조 관련)"과 맞춰 고릅니다' },
  }, []),
  define('law_compare_dates', '두 날짜에 시행 중이던 법령 버전을 비교합니다. 추가·삭제·변경 조문, 바뀐 낱말 표시, 그 사이 개정 버전, 별표 변경을 줍니다. article로 조문 하나만 비교할 수 있습니다.', {
    ...datedLawRef, from_date: dateSchema('앞 기준일 YYYYMMDD'), to_date: dateSchema('뒤 기준일 YYYYMMDD'), article: articleSchema,
  }, ['from_date', 'to_date']),
  define('law_amendment_table', '개정안의 신·구조문대비표를 만듭니다. 개정 후 조문만 넣으면 현행 조문을 법제처에서 가져와 (생 략)·(현행과 같음)·<신 설>·<삭 제>와 바뀐 부분 밑줄(<u></u>)을 붙인 표와 markdown을 줍니다. 조례·행정규칙·미공포안은 current_text로 현행을 직접 줍니다.', {
    ...lawRef,
    amendments: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      article: articleSchema,
      text: { type: 'string', minLength: 1, maxLength: 8000, description: '개정 후 조문. 조 머리부터 한 줄에 항·호·목 하나. 안 바뀌는 항·호는 "② ∼ ⑤ (현행과 같음)", 지우는 항은 "③ 삭제", 조 전체 삭제는 "제5조 삭제". 적지 않은 현행 항·호는 삭제로 봅니다' },
      current_text: { type: 'string', maxLength: 8000, description: '현행 조문 원문을 직접 줄 때(조례·행정규칙·미공포안). 신설 조는 빈 문자열' },
    } } },
    title: { type: 'string', maxLength: 120, description: '대비표 제목. 예: 상법 일부개정법률안' },
  }, ['amendments']),
  define('law_applicable', '기준일(행위·계약·처분일)에 시행 중이던 법령 버전과, 그 뒤 개정 부칙의 시행일·적용례·경과조치 문장을 찾습니다. article을 주면 그때 조문과 최신 조문을 비교합니다.', {
    ...datedLawRef, date: dateSchema('기준일 YYYYMMDD'), article: articleSchema,
  }, ['date']),
  define('law_verify_citations', '글(답변·계약서·의견서)에 나온 「법령명」 제N조(항·호)와 사건번호가 법제처 자료에 실제로 있는지 확인합니다. 없는 법령·조문·항·호, 삭제 조문, 없는 사건번호를 구분합니다.', {
    text: { type: 'string', minLength: 1, maxLength: 20000 },
    max_citations: { type: 'integer', minimum: 1, maximum: 20, default: 15 },
  }, ['text']),
  define('law_cite_check', '판례·헌재결정의 후속 인용을 찾습니다. 사건번호가 실제로 있는지 확인하고, 그 사건번호를 본문에 담은 뒤 결정들과 "변경" 등으로 언급한 문장을 보여 줍니다.', {
    case_number: { type: 'string', minLength: 4, maxLength: 40, description: '예: 2013다61381, 2019헌바123' },
    display: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    deep_scan: { type: 'boolean', default: true, description: '뒤 판결 본문을 읽어 인용 문장을 찾습니다(판례만)' },
    scan_limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
  }, ['case_number']),
  define('law_impact_map', '조문 하나가 영향을 주는 범위: 이 조문을 위임받은 시행령·시행규칙 조문, 이 조문이 인용하는 법령, 이 조문을 언급한 판례·해석례·행정규칙 건수와 상위 목록, 연계 조례 조문.', {
    ...lawRef, article: articleSchema,
    display: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
    mermaid: { type: 'boolean', default: false, description: 'mermaid 그래프 코드 포함' },
  }, ['article']),
  define('law_ordinance_radar', '조례·규칙이 인용한 상위 법령이 그 뒤 개정됐거나 시행예정 개정이 있는지 점검합니다(조례 정비 대상 찾기).', {
    ordinance_name: { type: 'string', minLength: 2, maxLength: 120, description: '자치법규명 전체. 예: 서울특별시 주차장 설치 및 관리 조례' },
    ordinance_seq: { type: 'string', pattern: '^[0-9]{1,12}$', description: '자치법규일련번호' },
    include_upcoming: { type: 'boolean', default: true },
    max_laws: { type: 'integer', minimum: 1, maximum: 12, default: 10 },
  }, []),
  define('law_bulk_check', '여러 법령(최대 20건)의 현행 MST·공포일·시행일을 한 번에 확인합니다. 직전 결과의 snapshot을 previous로 넣으면 개정된 법령만 표시합니다(준법 등록부 감시). 캐시하지 않습니다.', {
    queries: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 120 } },
    previous: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9]{1,12}$' }, description: '{법령ID: 직전 MST}' },
    include_upcoming: { type: 'boolean', default: false, description: '시행예정 개정도 확인(법령당 호출 1회 추가)' },
    changed_only: { type: 'boolean', default: false },
  }, ['queries']),
  define('law_admin_rule_search', '행정규칙(훈령·예규·고시·공고·지침) 검색. 본문 조회용 행정규칙일련번호를 줍니다.', {
    query: { type: 'string', minLength: 1, maxLength: 200 },
    kind: { type: 'string', enum: ['1', '2', '3', '4', '5', '6'], description: '1=훈령, 2=예규, 3=고시, 4=공고, 5=지침, 6=기타' },
    display: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    body: { type: 'boolean', default: false, description: '본문 검색' },
    history: { type: 'boolean', default: false, description: '연혁(옛 발령본) 검색' },
  }, ['query']),
  define('law_admin_rule', '행정규칙 본문 일부 조회: article(조와 전후 context개), chapter(장·편), keyword(포함 조문), 또는 page(30조씩). 별표 텍스트·링크와 최근 부칙 3건을 함께 줍니다.', {
    id: { type: 'string', pattern: '^[0-9]{6,20}$', description: '행정규칙일련번호(검색 결과 id)' },
    rule_id: { type: 'string', pattern: '^[0-9]{1,12}$', description: '행정규칙ID(현행본 조회)' },
    article: { type: 'string', maxLength: 30, description: '예: 제9-5조, 9-5, 제10조의2' },
    context: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
    chapter: { type: 'string', maxLength: 30, description: '예: 제9장, 9, 제4편 제3장, 제4편' },
    keyword: { type: 'string', maxLength: 100 },
    max_results: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
    page: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
  }, []),
]);
export const LAW_ANALYSIS_TOOL_NAMES = new Set(LAW_ANALYSIS_TOOL_DEFINITIONS.map(tool => tool.name));
/** The original lookup tools, also served on the anonymous /law path for the public k-deal-skill. */
export const LAW_LOOKUP_TOOL_DEFINITIONS = LAW_TOOL_DEFINITIONS;
export const ALL_LAW_TOOL_DEFINITIONS = Object.freeze([...LAW_TOOL_DEFINITIONS, ...LAW_ANALYSIS_TOOL_DEFINITIONS]);
const DEFINITIONS = new Map(ALL_LAW_TOOL_DEFINITIONS.map(tool => [tool.name, tool]));

class LawError extends Error {
  constructor(code, message) { super(message); this.name = 'LawError'; this.code = code; }
}
function fail(code, message) { throw new LawError(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_input', `${name} is missing or outside the permitted length.`);
  return value.trim();
}
function integer(value, min, max, fallback) {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || n < min || n > max) fail('invalid_input', 'An integer input is outside its permitted range.');
  return n;
}
function domain(value) {
  if (!DOMAINS.includes(value)) fail('invalid_input', 'The decision domain is not supported.');
  return value;
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) fail('invalid_input', 'date must be YYYYMMDD.');
  const y = Number(value.slice(0, 4)), m = Number(value.slice(4, 6)), d = Number(value.slice(6));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2100 || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) fail('invalid_input', 'date is not a supported calendar date.');
  return value;
}
/** Checks one value against the subset of JSON Schema the analysis tool definitions use. */
function checkValue(schema, value, path) {
  const bad = why => fail('invalid_input', `${path}: ${why}`);
  if (schema.type === 'string') {
    if (typeof value !== 'string') bad('문자열이어야 합니다.');
    if (schema.minLength && value.trim().length < schema.minLength) bad('값이 비었거나 너무 짧습니다.');
    if (schema.maxLength && value.length > schema.maxLength) bad(`${schema.maxLength}자 이하여야 합니다.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) bad('형식이 맞지 않습니다.');
    if (schema.enum && !schema.enum.includes(value)) bad(`${schema.enum.join(', ')} 중 하나여야 합니다.`);
    return schema.pattern ? value : value.trim();
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) bad(`${schema.minimum}~${schema.maximum} 정수여야 합니다.`);
    return value;
  }
  if (schema.type === 'boolean') { if (typeof value !== 'boolean') bad('true/false여야 합니다.'); return value; }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) bad(`${schema.minItems ?? 0}~${schema.maxItems}개 배열이어야 합니다.`);
    return value.map((item, i) => checkValue(schema.items, item, `${path}[${i}]`));
  }
  if (schema.type === 'object') {
    if (!object(value)) bad('객체여야 합니다.');
    if (schema.properties) return checkObject(schema, value, path);
    if (Object.keys(value).length > 100) bad('항목이 너무 많습니다.');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, checkValue(schema.additionalProperties, v, `${path}.${k}`)]));
  }
  return value;
}
const camel = key => key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
function checkObject(schema, value, path) {
  for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) fail('invalid_input', `${path}: 문서에 없는 입력입니다: ${key}`);
  for (const key of schema.required ?? []) if (value[key] === undefined) fail('invalid_input', `${path}: ${key}가 필요합니다.`);
  const out = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (value[key] !== undefined) out[camel(key)] = checkValue(spec, value[key], key);
    else if (spec.default !== undefined) out[camel(key)] = spec.default;
  }
  return out;
}
function analysisArgs(name, definition, args) {
  const input = checkObject(definition.inputSchema, args, name);
  const refs = ['lawId', 'mst', 'lawName'].filter(key => input[key] !== undefined);
  const lawKeys = Object.keys(definition.inputSchema.properties).filter(k => ['law_id', 'mst', 'law_name'].includes(k));
  if (lawKeys.length && name !== 'law_amendment_table' && refs.length !== 1) fail('invalid_input', `${lawKeys.join('·')} 중 하나만 지정합니다.`);
  if (name === 'law_amendment_table' && refs.length > 1) fail('invalid_input', 'law_id·mst·law_name 중 하나만 지정합니다.');
  if (name === 'law_amendment_table' && !refs.length && input.amendments.some(a => a.currentText === undefined)) fail('invalid_input', '현행을 법제처에서 가져오려면 law_id·mst·law_name 중 하나가 필요합니다.');
  for (const key of ['date', 'fromDate', 'toDate']) if (input[key] !== undefined) calendarDate(input[key]);
  if (name === 'law_annexes' && input.date && input.mst) fail('invalid_input', 'date는 law_id 또는 law_name과 함께 씁니다.');
  if (name === 'law_ordinance_radar' && (input.ordinanceName === undefined) === (input.ordinanceSeq === undefined)) fail('invalid_input', 'ordinance_name과 ordinance_seq 중 하나만 지정합니다.');
  if (name === 'law_admin_rule') {
    if ((input.id === undefined) === (input.ruleId === undefined)) fail('invalid_input', 'id와 rule_id 중 하나만 지정합니다.');
    if ([input.article, input.chapter, input.keyword].filter(v => v !== undefined).length > 1) fail('invalid_input', 'article·chapter·keyword는 하나만 씁니다.');
  }
  if (name === 'law_cite_check' && !/\d{2}\s*[가-힣]{1,3}\s*\d/.test(input.caseNumber)) fail('invalid_input', '사건번호 형식이 아닙니다. 예: 2013다61381');
  return input;
}
const ANALYSIS_RUNNERS = Object.freeze({
  law_annexes: lawAnnexes, law_compare_dates: lawCompareDates, law_amendment_table: lawAmendmentTable, law_applicable: lawApplicable,
  law_verify_citations: lawVerifyCitations, law_cite_check: lawCiteCheck, law_impact_map: lawImpactMap,
  law_ordinance_radar: lawOrdinanceRadar, law_bulk_check: lawBulkCheck, law_admin_rule_search: lawAdminRuleSearch, law_admin_rule: lawAdminRule,
});

function toolArgs(name, args) {
  const definition = DEFINITIONS.get(name);
  if (!definition) fail('unknown_tool', 'This law tool is not available.');
  if (!object(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key))) fail('invalid_input', 'Only documented law tool inputs are accepted.');
  if (LAW_ANALYSIS_TOOL_NAMES.has(name)) return analysisArgs(name, definition, args);
  if (name === 'law_search') return { query: string(args.query, 2000, 'query'), display: integer(args.display, 1, 50, 10) };
  if (name === 'law_catalog') {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 100)) fail('invalid_input', 'query is too long.');
    if (args.kind !== undefined && !['list', 'body'].includes(args.kind)) fail('invalid_input', 'kind must be list or body.');
    return { query: args.query ?? '', kind: args.kind, limit: integer(args.limit, 1, 50, 20) };
  }
  if (name === 'law_api') return { apiId: integer(args.api_id, 1, 159, undefined), params: args.params ?? {} };
  if (name === 'law_text') {
    if ((args.law_id !== undefined) === (args.mst !== undefined)) fail('invalid_input', 'Specify exactly one of law_id or mst.');
    const key = args.mst !== undefined ? 'mst' : 'lawId';
    const value = args.mst ?? args.law_id;
    if (typeof value !== 'string' || !(key === 'mst' ? /^\d{1,12}$/ : /^\d{6}$/).test(value)) fail('invalid_input', 'The law identifier has an invalid format.');
    const result = { [key]: value };
    if (args.article !== undefined) result.jo = string(args.article, 120, 'article');
    if (args.date !== undefined) result.efYd = calendarDate(args.date);
    return result;
  }
  if (name === 'law_decisions_search') return {
    domain: domain(args.domain), query: string(args.query, 2000, 'query'),
    display: integer(args.display, 1, 50, 10), page: integer(args.page, 1, 100, 1),
  };
  const id = string(args.id, 80, 'id');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) fail('invalid_input', 'The decision identifier has an invalid format.');
  return { domain: domain(args.domain), id };
}
function redact(value, key) {
  if (typeof value === 'string') {
    let result = value;
    if (key) for (const variant of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) result = result.split(variant).join('[REDACTED]');
    return result.replace(/([?&](?:oc|api_?key|token)=)[^&\s"<>]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), redact(item, key)]));
  return value;
}
/** options.fetchImpl/now are test seams; callers cannot supply a remote endpoint. */
export async function dispatchLawTool(name, args, env = {}, options = {}) {
  let key = '';
  const metadata = { provider: '법제처 Open API', source_url: SOURCE_URL, fetched_at: new Date().toISOString() };
  try {
    if (!object(options) || Object.hasOwn(options, 'endpoint') || Object.hasOwn(options, 'url')) fail('invalid_endpoint', 'The law endpoint is fixed and cannot be overridden.');
    if (options.now) metadata.fetched_at = new Date(options.now()).toISOString();
    const upstreamArgs = toolArgs(name, args);
    key = typeof env?.LAW_OC === 'string' ? env.LAW_OC.trim() : '';
    if (key && !/^[\x20-\x7E]{1,512}$/.test(key)) fail('invalid_credential_format', 'LAW_OC is not a valid HTTP header value.');
    if (name === 'law_catalog') return lawCatalog(upstreamArgs);
    if (!key) fail('not_connected', '법제처 Open API 키(LAW_OC)가 등록된 서버에서만 법령을 조회할 수 있습니다.');
    try {
      if (ANALYSIS_RUNNERS[name]) return await ANALYSIS_RUNNERS[name](upstreamArgs, key, options);
      return name === 'law_api' ? await lawApi(upstreamArgs.apiId, upstreamArgs.params, key, options) : await lawDirect(name, upstreamArgs, key, options);
    } catch (error) { if (error instanceof LawDirectError) fail(error.code, error.message); throw error; }
  } catch (error) {
    const safe = error instanceof LawError ? { code: error.code, message: error.message } : { code: 'law_request_failed', message: 'Law lookup failed; no result was inferred.' };
    return redact({ status: 'error', data: null, metadata: { ...metadata, error: safe } }, key);
  }
}
