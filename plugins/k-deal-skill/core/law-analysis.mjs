/** Law analysis tools built on the 법제처 Open API: annexes, two-date comparison, 신구조문대비표, the version that applied on a
 * date with later 적용례·경과조치, citation checks, impact map, ordinance review, bulk change watch and partial 행정규칙.
 * Each tool makes several DRF calls through one paced, counted client; metadata.upstream_calls reports how many so the
 * gateway charges the real number against daily budgets. The feature set follows korean-law-mcp (MIT,
 * https://github.com/chrisryugj/korean-law-mcp); the code is this server's own.
 */
import { drfGet, lawVersions, rankLaws, joCode, LawDirectError } from './law-direct.mjs';
import {
  textOf, articleLabel, parseArticleLabel, lawArticles, basicInfo, addendaOf, addendaProvisions, annexesOf, parseAnnexRef,
  adminRuleUnits, adminArticleLabel, extractCitations, quotedLawNames, compareArticleMaps, diffLines, amendmentRows,
  markdownTable, markerOf,
} from './law-parse.mjs';

const DRF_BASE = 'https://www.law.go.kr/DRF/';
const LAW_SITE = 'https://www.law.go.kr';
const list = value => value === undefined || value === null ? [] : [].concat(value);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
function fail(code, message) { throw new LawDirectError(code, message); }

/** DRF client for one tool call: spaces calls minIntervalMs apart and stops at maxCalls so one request cannot fan out
 * without bound. */
function drfClient(oc, options) {
  const maxCalls = options.maxCalls ?? 40, gap = options.minIntervalMs ?? 300, sleep = options.sleep ?? wait;
  const clock = options.clock ?? Date.now;
  let calls = 0, last = 0;
  return {
    get calls() { return calls; },
    async get(endpoint, params) {
      if (calls >= maxCalls) fail('call_budget', `이 분석은 한 번에 법제처 API를 ${maxCalls}회까지만 부릅니다. 범위(조문·건수)를 좁혀 다시 요청하세요.`);
      const delay = last + gap - clock();
      if (calls > 0 && delay > 0) await sleep(delay);
      calls++;
      try { return await drfGet(endpoint, params, oc, options); } finally { last = clock(); }
    },
  };
}

function envelope(client, options, data, request, extra = {}) {
  return {
    status: 'ok', data,
    metadata: {
      provider: '법제처 국가법령정보 공동활용 Open API', source_url: DRF_BASE, request,
      fetched_at: new Date(options.now ? options.now() : Date.now()).toISOString(), credential_mode: 'law_oc_direct',
      upstream_calls: client.calls,
      freshness: '공포일·시행일·선고일 등 원자료 날짜와 조회 시각은 다릅니다. 분석 결과는 원문 대조용 보조 자료입니다.', ...extra,
    },
  };
}

const today = options => {
  const t = options.now ? options.now() : Date.now();
  return new Date(t + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
};
const absolute = link => link ? new URL(link, LAW_SITE).toString().replace(/([?&]OC=)[^&]*/i, '$1') : null;

/* ---------- law resolution and fetch ---------- */

/** law_id, mst or law_name → { lawId, mst, name }. A name must match a law name or short name exactly. */
async function resolveLaw(c, input) {
  if (input.lawId || input.mst) return { lawId: input.lawId ?? null, mst: input.mst ?? null, name: null };
  const data = await c.get('lawSearch.do', { target: 'law', query: input.lawName, display: 100 });
  const ranked = rankLaws(list(data?.LawSearch?.law), input.lawName);
  const squeeze = s => String(s ?? '').replace(/\s+/g, '');
  const exact = ranked.find(item => squeeze(item.법령명한글) === squeeze(input.lawName) || squeeze(item.법령약칭명) === squeeze(input.lawName));
  if (!exact) {
    const candidates = ranked.slice(0, 5).map(item => item.법령명한글).filter(Boolean);
    fail('law_not_found', candidates.length ? `「${input.lawName}」과 이름이 같은 법령이 없습니다. 후보: ${candidates.join(', ')}` : `「${input.lawName}」을 법령 목록에서 찾지 못했습니다.`);
  }
  return { lawId: String(exact.법령ID), mst: String(exact.법령일련번호), name: String(exact.법령명한글), promulgated: String(exact.공포일자 ?? ''), effective: String(exact.시행일자 ?? '') };
}

/** Current text (law target) or a dated version (eflaw MST + efYd); jo narrows to one article. */
async function fetchLaw(c, { lawId, mst, version, jo }) {
  const params = version ? { target: 'eflaw', MST: version.mst, efYd: version.effective } : { target: 'law', ...(mst ? { MST: mst } : { ID: lawId }) };
  if (jo) params.JO = jo;
  const data = await c.get('lawService.do', params);
  if (!data?.법령) fail('not_found', '해당 법령 본문이 조회되지 않습니다. 식별자와 기준일을 확인하세요.');
  return data;
}

async function versionsOf(c, lawId) {
  if (!lawId) fail('invalid_input', '기준일 비교에는 law_id 또는 law_name이 필요합니다.');
  const versions = await lawVersions(lawId, null, { get: (endpoint, params) => c.get(endpoint, params) });
  if (!versions.length) fail('not_found', '법령 ID로 조회되는 버전 목록이 없습니다.');
  return versions;
}
function versionOn(versions, date) {
  const chosen = versions.find(v => v.effective <= date);
  if (!chosen) fail('not_found', `${date} 이전에 시행된 버전이 없습니다(가장 이른 시행일 ${versions.at(-1).effective}).`);
  return chosen;
}
const versionView = v => v && { mst: v.mst, effective: v.effective, promulgated: v.promulgated, status: v.status, name: v.name };

function articleInput(article) {
  const parsed = parseArticleLabel(article);
  if (!parsed || !parsed.number) fail('invalid_input', '조문 번호 형식이 아닙니다. 예: 제750조, 제10조의2');
  return { label: articleLabel(parsed.number, parsed.branch), jo: joCode(articleLabel(parsed.number, parsed.branch)) };
}

/* ---------- annexes ---------- */

export async function lawAnnexes(input, oc, options = {}) {
  const c = drfClient(oc, options);
  const law = await resolveLaw(c, input);
  let version = null;
  if (input.date) version = versionOn(await versionsOf(c, law.lawId), input.date);
  const data = await fetchLaw(c, { ...law, version });
  let annexes = annexesOf(data);
  const total = annexes.length;
  const ref = input.annex ? parseAnnexRef(input.annex) : null;
  if (input.annex && !ref) fail('invalid_input', 'annex는 "3", "별표 3", "별표 3의2", "서식 2"처럼 씁니다.');
  if (ref) annexes = annexes.filter(a => a.number === ref.number && a.branch === ref.branch && (!ref.kind || a.kind.includes(ref.kind)));
  if (input.query) {
    const terms = input.query.split(/\s+/).filter(Boolean);
    annexes = annexes.filter(a => terms.every(t => a.title.includes(t)));
  }
  if (input.article) {
    const { label } = articleInput(input.article);
    annexes = annexes.filter(a => a.related_article === label || a.title.includes(`${label} `) || a.title.includes(`${label}관련`));
  }
  const info = basicInfo(data);
  const files = a => ({ hwp: absolute(a.files.hwp), pdf: absolute(a.files.pdf), images: a.files.images.map(absolute) });
  const one = annexes.length === 1 || (ref && annexes.length);
  const result = one
    ? annexes.map(a => ({ label: a.label, title: a.title, related_article: a.related_article, has_text: a.has_text,
      text: a.lines.join('\n').trim(), tables: a.tables, files: files(a) }))
    : annexes.map(a => ({ label: a.label, title: a.title, related_article: a.related_article, has_text: a.has_text, files: files(a) }));
  const notes = [];
  if (!total) notes.push('이 버전 본문에는 별표·서식이 없습니다.');
  else if (!annexes.length) notes.push(`조건에 맞는 별표가 없습니다(전체 ${total}건). annex·query·article 조건을 확인하세요.`);
  else if (!one) notes.push('여러 건이 맞아 목록만 반환했습니다. annex(예: "별표 3") 또는 query로 한 건을 지정하면 본문과 표를 함께 반환합니다.');
  if (one && result.some(a => !a.has_text)) notes.push('본문 텍스트가 없는 별표·서식은 법제처가 파일(HWP·PDF·이미지)로만 제공합니다. files 링크로 확인하세요.');
  if (one && result.some(a => a.tables.length)) notes.push('tables는 별표의 괘선 표를 행·열로 읽은 것입니다. 줄바꿈된 셀은 이어 붙였으므로 금액·기준은 text와 대조하세요.');
  return envelope(c, options, { law: info, version: versionView(version), annexes: result, total_annexes: total },
    { ...input, date: input.date ?? null }, notes.length ? { note: notes.join(' ') } : {});
}

/* ---------- two-date comparison ---------- */

function annexDiff(before, after) {
  const key = a => `${a.kind}|${a.number}|${a.branch}`;
  const b = new Map(before.map(a => [key(a), a])), n = new Map(after.map(a => [key(a), a]));
  const out = { added: [], removed: [], changed: [] };
  for (const [k, a] of b) {
    const x = n.get(k);
    if (!x) out.removed.push(`${a.label} ${a.title}`);
    else if (a.lines.join('\n') !== x.lines.join('\n') || a.title !== x.title) out.changed.push(`${x.label} ${x.title}`);
  }
  for (const [k, x] of n) if (!b.has(k)) out.added.push(`${x.label} ${x.title}`);
  return out;
}

export async function lawCompareDates(input, oc, options = {}) {
  const c = drfClient(oc, options);
  if (input.fromDate >= input.toDate) fail('invalid_input', 'from_date는 to_date보다 앞서야 합니다.');
  const law = await resolveLaw(c, input);
  const versions = await versionsOf(c, law.lawId);
  const before = versionOn(versions, input.fromDate), after = versionOn(versions, input.toDate);
  const between = versions.filter(v => v.effective > before.effective && v.effective <= after.effective).reverse().map(versionView);
  const base = { law_id: law.lawId, from: versionView(before), to: versionView(after), versions_between: between };
  if (before.mst === after.mst && before.effective === after.effective) {
    return envelope(c, options, { ...base, same_version: true, articles: { added: [], deleted: [], changed: [], unchanged: null } }, input,
      { note: '두 날짜에 같은 버전이 시행 중이었습니다. 조문 변경이 없습니다.' });
  }
  const target = input.article ? articleInput(input.article) : null;
  const [a, b] = [await fetchLaw(c, { version: before, jo: target?.jo }), await fetchLaw(c, { version: after, jo: target?.jo })];
  let mapA = lawArticles(a), mapB = lawArticles(b);
  if (target) {
    mapA = new Map([...mapA].filter(([label]) => label === target.label));
    mapB = new Map([...mapB].filter(([label]) => label === target.label));
  }
  const articles = compareArticleMaps(mapA, mapB);
  const limit = 80, truncated = Math.max(0, articles.changed.length - limit);
  articles.changed = articles.changed.slice(0, limit);
  const data = { ...base, same_version: false, articles, ...(target ? {} : { annexes: annexDiff(annexesOf(a), annexesOf(b)) }) };
  const notes = ['changes의 old_marked·new_marked는 바뀐 낱말을 <u></u>로 표시했습니다.'];
  if (truncated) notes.push(`변경 조문이 많아 앞의 ${limit}건만 반환했습니다(생략 ${truncated}건). article로 조문을 지정하세요.`);
  if (target && !mapA.size && !mapB.size) notes.push(`두 버전 모두 ${target.label}가 없습니다.`);
  return envelope(c, options, data, input, { note: notes.join(' ') });
}

/* ---------- 신구조문대비표 ---------- */

/** Plain article text (조례·행정규칙·미공포안) → keyed lines like articleLines. */
export function linesFromText(text) {
  const lines = [];
  let hang = '', ho = '';
  for (const raw of String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean)) {
    const head = /^(제\s*\d{1,4}\s*조(?:\s*의\s*\d{1,2})?(?:\s*\([^)]*\))?)\s*(.*)$/.exec(raw);
    if (head && !lines.length) {
      const rest = head[2];
      const marker = markerOf(rest);
      if (marker && CIRCLED.includes(marker)) { lines.push({ key: '', text: head[1] }); hang = marker; lines.push({ key: marker, text: rest }); }
      else lines.push({ key: '', text: raw });
      continue;
    }
    const marker = markerOf(raw);
    if (!marker) { if (lines.length) lines.at(-1).text += ` ${raw}`; else lines.push({ key: '', text: raw }); continue; }
    if (CIRCLED.includes(marker)) { hang = marker; ho = ''; lines.push({ key: marker, text: raw }); }
    else if (/^\d/.test(marker)) { ho = marker; lines.push({ key: hang ? `${hang}|${marker}` : marker, text: raw }); }
    else lines.push({ key: [hang, ho, marker].filter(Boolean).join('|'), text: raw });
  }
  return lines;
}

export async function lawAmendmentTable(input, oc, options = {}) {
  const c = drfClient(oc, options);
  const needsLaw = input.amendments.some(a => a.currentText === undefined);
  const law = needsLaw || input.lawName ? await resolveLaw(c, input) : { lawId: input.lawId, mst: input.mst, name: null };
  let lawInfo = null;
  const articles = [];
  for (const amendment of input.amendments) {
    const labelSource = amendment.article ?? /^\s*(제\s*\d{1,4}\s*조(?:\s*의\s*\d{1,2})?)/.exec(amendment.text)?.[1];
    if (!labelSource) fail('invalid_input', '개정 조문의 조 번호를 찾지 못했습니다. article을 주거나 text를 "제N조"로 시작하세요.');
    const { label, jo } = articleInput(labelSource);
    let current;
    if (amendment.currentText !== undefined) current = linesFromText(amendment.currentText);
    else {
      const data = await fetchLaw(c, { lawId: law.lawId, mst: law.mst, jo });
      lawInfo ??= basicInfo(data);
      current = lawArticles(data).get(label)?.lines ?? [];
    }
    const { rows, warnings, status } = amendmentRows(label, current, amendment.text);
    articles.push({ article: label, status, rows, warnings });
  }
  const title = input.title ?? (lawInfo?.name || law.name ? `${lawInfo?.name || law.name} 일부개정안 신·구조문대비표` : '신·구조문대비표');
  const rows = articles.flatMap(a => a.rows);
  return envelope(c, options, { title, law: lawInfo, articles, markdown: `${title}\n\n${markdownTable(rows)}` },
    { law_id: input.lawId ?? null, mst: input.mst ?? null, law_name: input.lawName ?? null, articles: articles.map(a => a.article) },
    { note: '현행은 법제처 현행 본문 기준입니다(current_text를 준 조문은 그 원문). <u></u>는 바뀐 부분 밑줄 표시입니다. 개정안에 적지 않은 현행 항·호는 삭제로 보며 warnings에 적습니다.' });
}

/* ---------- applicable law ---------- */

export async function lawApplicable(input, oc, options = {}) {
  const c = drfClient(oc, options);
  const law = await resolveLaw(c, input);
  const versions = await versionsOf(c, law.lawId);
  const then = versionOn(versions, input.date);
  const latest = versions[0];
  const now = versions.find(v => v.effective <= today(options)) ?? latest;
  const later = versions.filter(v => v.effective > then.effective).reverse().map(versionView);
  const target = input.article ? articleInput(input.article) : null;
  const latestBody = await fetchLaw(c, { version: latest });
  const addenda = addendaOf(latestBody).filter(a => a.promulgated > then.promulgated).map(a => {
    const provisions = addendaProvisions(a.lines, target?.label).filter(p => p.kind !== 'other' || p.mentions_article);
    return { promulgated: a.promulgated, number: a.number, provisions };
  }).filter(a => a.provisions.length);
  const data = { law: basicInfo(latestBody), base_date: input.date, version_then: versionView(then), version_now: versionView(now),
    version_latest: versionView(latest), later_versions: later, later_addenda: addenda.slice(0, 40) };
  if (target) {
    const thenBody = await fetchLaw(c, { version: then, jo: target.jo });
    const articleThen = lawArticles(thenBody).get(target.label) ?? null;
    const articleLatest = lawArticles(latestBody).get(target.label) ?? null;
    const a = articleThen?.lines.map(l => l.text) ?? [], b = articleLatest?.lines.map(l => l.text) ?? [];
    data.article = { label: target.label, text_then: a.join('\n') || null, text_latest: b.join('\n') || null,
      changed_since: a.join('\n') !== b.join('\n'), changes: a.join('\n') === b.join('\n') ? [] : diffLines(a, b) };
  }
  const notes = ['version_then이 기준일에 시행 중이던 버전입니다.',
    'later_addenda는 그 뒤 공포된 개정의 부칙에서 시행일·적용례·경과조치 문장을 낱말 기준으로 골라낸 것입니다. 기준일의 행위에 새 규정이 적용되는지는 해당 문언과 원문으로 판단하세요.'];
  if (addenda.length > 40) notes.push(`부칙이 많아 최근 40건만 반환했습니다(전체 ${addenda.length}건).`);
  if (latest.effective > today(options)) notes.push(`시행예정 버전(${latest.effective} 시행)이 있습니다. version_latest와 text_latest는 시행예정본 기준입니다.`);
  return envelope(c, options, data, input, { note: notes.join(' ') });
}

/* ---------- citations ---------- */

const paragraphMarker = text => { const n = Number(/\d+/.exec(text ?? '')?.[0]); return n >= 1 && n <= 20 ? CIRCLED[n - 1] : null; };

async function findCase(c, caseNumber) {
  const constitutional = /헌/.test(caseNumber);
  const target = constitutional ? 'detc' : 'prec';
  const data = await c.get('lawSearch.do', { target, nb: caseNumber, display: 20 });
  const root = data?.PrecSearch ?? data?.DetcSearch ?? Object.values(data ?? {})[0];
  const rows = list(root?.[target] ?? root?.Detc ?? root?.prec);
  const squeeze = s => String(s ?? '').replace(/\s+/g, '');
  const hit = rows.find(row => squeeze(row.사건번호).split(/[,·]/).includes(squeeze(caseNumber)));
  return { target, hit: hit ? { case_number: String(hit.사건번호), name: textOf(hit.사건명), court: textOf(hit.법원명 ?? (constitutional ? '헌법재판소' : '')),
    decided: String(hit.선고일자 ?? hit.종국일자 ?? ''), id: String(hit.판례일련번호 ?? hit.헌재결정례일련번호 ?? '') } : null };
}

export async function lawVerifyCitations(input, oc, options = {}) {
  const c = drfClient(oc, { maxCalls: 45, ...options });
  const citations = extractCitations(input.text, input.maxCitations);
  if (!citations.length) fail('no_citations', '본문에서 「법령명」 제N조, 법령명 제N조, 사건번호 형식의 인용을 찾지 못했습니다.');
  const laws = new Map(), bodies = new Map();
  const results = [];
  for (const cite of citations) {
    if (cite.type === 'case') {
      const { hit } = await findCase(c, cite.case_number);
      results.push({ ...cite, status: hit ? 'verified' : 'not_found', found: hit });
      continue;
    }
    if (!laws.has(cite.law_name)) {
      try { laws.set(cite.law_name, await resolveLaw(c, { lawName: cite.law_name })); }
      catch (error) { if (error instanceof LawDirectError && error.code === 'law_not_found') laws.set(cite.law_name, { error: error.message }); else throw error; }
    }
    const law = laws.get(cite.law_name);
    if (law.error) { results.push({ ...cite, status: 'law_not_found', message: law.error }); continue; }
    const { label, jo } = articleInput(cite.article);
    const key = `${law.lawId}|${jo}`;
    if (!bodies.has(key)) bodies.set(key, lawArticles(await fetchLaw(c, { lawId: law.lawId, jo })).get(label) ?? null);
    const article = bodies.get(key);
    const found = { law_name: law.name, law_id: law.lawId, article: label, title: article?.title ?? null };
    if (!article || (article.lines.length <= 1 && /삭제/.test(article.lines[0]?.text ?? ''))) { results.push({ ...cite, status: article ? 'article_deleted' : 'article_not_found', found }); continue; }
    const hang = cite.paragraph ? paragraphMarker(cite.paragraph) : null;
    if (cite.paragraph && !article.lines.some(l => l.key === hang)) { results.push({ ...cite, status: 'paragraph_not_found', found }); continue; }
    if (cite.item) {
      const ho = `${/\d+/.exec(cite.item)[0]}.`;
      const ok = article.lines.some(l => hang ? l.key === `${hang}|${ho}` : l.key.endsWith(`|${ho}`) || l.key === ho);
      if (!ok) { results.push({ ...cite, status: 'item_not_found', found }); continue; }
    }
    const text = article.lines.map(l => l.text).join(' ');
    results.push({ ...cite, status: 'verified', found: { ...found, excerpt: text.slice(0, 240) } });
  }
  const summary = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  return envelope(c, options, { summary, citations: results }, { citations_found: citations.length },
    { note: 'verified는 법령·조문(항·호)·사건번호가 현행 법제처 자료에 있다는 뜻이며, 인용한 내용이 조문 취지와 맞는지는 excerpt와 원문으로 확인해야 합니다. 옛 조문 번호를 인용한 경우 현행 기준으로 불일치가 날 수 있습니다.' });
}

export async function lawCiteCheck(input, oc, options = {}) {
  const c = drfClient(oc, options);
  const caseNumber = input.caseNumber.replace(/\s+/g, '');
  const { target, hit } = await findCase(c, caseNumber);
  if (!hit) fail('not_found', `${caseNumber} 사건을 ${target === 'detc' ? '헌재결정례' : '판례'} 목록에서 찾지 못했습니다. 사건번호를 확인하세요.`);
  const data = await c.get('lawSearch.do', { target, query: caseNumber, search: 2, display: input.display });
  const root = Object.values(data ?? {})[0];
  const all = list(root?.[target] ?? root?.prec ?? root?.Detc);
  const rows = all.filter(row => String(row.사건번호 ?? '').replace(/\s+/g, '') !== caseNumber);
  const citing = rows.map(row => ({ case_number: String(row.사건번호 ?? ''), name: textOf(row.사건명), court: textOf(row.법원명),
    decided: String(row.선고일자 ?? row.종국일자 ?? ''), id: String(row.판례일련번호 ?? row.헌재결정례일련번호 ?? '') }))
    .sort((a, b) => b.decided.localeCompare(a.decided));
  const scanned = [];
  if (input.deepScan && target === 'prec') {
    for (const row of citing.slice(0, input.scanLimit)) {
      const body = await c.get('lawService.do', { target: 'prec', ID: row.id });
      const text = textOf(Object.values(body?.PrecService ?? body ?? {}));
      const sentences = text.split(/(?<=[.다])\s+/).filter(s => s.replace(/\s+/g, '').includes(caseNumber));
      const changed = sentences.filter(s => /변경|폐기|저촉되는\s*범위/.test(s));
      scanned.push({ case_number: row.case_number, decided: row.decided, treatment: changed.length ? 'possibly_overruled_or_modified' : sentences.length ? 'cited' : 'not_in_text',
        excerpts: (changed.length ? changed : sentences).slice(0, 2).map(s => s.trim().slice(0, 300)) });
    }
  }
  const total = Number(root?.totalCnt ?? citing.length);
  const notes = ['citing은 판례 본문 검색에서 이 사건번호가 나온 결정입니다. 인용 방식(따름·구별·변경)은 scanned와 원문으로 확인하세요.'];
  if (scanned.some(s => s.treatment === 'possibly_overruled_or_modified')) notes.push('뒤 판결 본문에 이 사건을 "변경" 등과 함께 언급한 문장이 있습니다. 전원합의체 판결 여부와 변경 범위를 원문으로 확인하세요.');
  return envelope(c, options, { case: hit, citing_total: Math.max(0, total - (all.length - rows.length)), citing, scanned },
    { case_number: caseNumber, deep_scan: input.deepScan }, { note: notes.join(' ') });
}

/* ---------- impact map ---------- */

/** lsDelegated → delegations (시행령·시행규칙·행정규칙 that implement the article) and laws the article cites. */
function delegationsFor(data, label) {
  const root = data?.lsDelegated?.법령;
  const delegated = [], cited = [];
  for (const block of list(root?.위임조문정보)) {
    const info = block?.조정보 ?? {};
    if (articleLabel(info.조문번호, info.조문가지번호) !== label) continue;
    for (const entry of list(block?.위임정보)) {
      const titles = list(entry?.위임법령제목), kinds = list(entry?.위임구분), serials = list(entry?.위임법령일련번호);
      for (const item of list(entry?.위임법령조문정보)) {
        const row = { clause: String(item?.조항호목 ?? ''), text: textOf(item?.라인텍스트), law: textOf(titles[0]) || null, kind: String(kinds[0] ?? ''),
          mst: String(serials[0] ?? ''), article: Number(item?.위임법령조문번호) ? articleLabel(String(item.위임법령조문번호).split(',')[0], String(item?.위임법령조문가지번호 ?? '0').split(',')[0]) : null,
          article_title: textOf(item?.위임법령조문제목) || null };
        if (titles.length > 1) {
          const linked = textOf(item?.링크텍스트).replace(/[「」]/g, '');
          const index = titles.findIndex(t => textOf(t) === linked || row.text.includes(`「${textOf(t)}」`));
          if (index >= 0) Object.assign(row, { law: textOf(titles[index]), kind: String(kinds[index] ?? ''), mst: String(serials[index] ?? '') });
        }
        (row.kind === '인용법령' ? cited : delegated).push(row);
      }
    }
  }
  const unique = rows => [...new Map(rows.map(r => [`${r.law}|${r.article}|${r.clause}`, r])).values()];
  return { delegated: unique(delegated), cited: unique(cited) };
}

const hits = (data, key) => {
  const root = Object.values(data ?? {})[0];
  return { total: Number(root?.totalCnt ?? 0), rows: list(root?.[key]) };
};

export async function lawImpactMap(input, oc, options = {}) {
  const c = drfClient(oc, options);
  const law = await resolveLaw(c, input);
  const target = articleInput(input.article);
  const head = await fetchLaw(c, { lawId: law.lawId, mst: law.mst, jo: target.jo });
  const info = basicInfo(head);
  const article = lawArticles(head).get(target.label);
  if (!article) fail('not_found', `${info.name}에 ${target.label}가 없습니다.`);
  const phrase = `${info.name} ${target.label}`;
  const delegated = delegationsFor(await c.get('lawService.do', { target: 'lsDelegated', MST: law.mst ?? undefined, ID: law.mst ? undefined : law.lawId }), target.label);
  const prec = hits(await c.get('lawSearch.do', { target: 'prec', query: phrase, search: 2, display: input.display }), 'prec');
  const expc = hits(await c.get('lawSearch.do', { target: 'expc', query: phrase, search: 2, display: input.display }), 'expc');
  const admrul = hits(await c.get('lawSearch.do', { target: 'admrul', query: phrase, search: 2, display: input.display }), 'admrul');
  const ordin = hits(await c.get('lawSearch.do', { target: 'lnkLsOrdJo', query: info.name, JO: target.jo.slice(0, 4), JOBR: target.jo.slice(4), display: input.display }), 'law');
  const ordinRows = ordin.rows.filter(r => String(r.법령명한글 ?? '').replace(/\s+/g, '') === info.name.replace(/\s+/g, ''));
  const data = {
    law: info, article: { label: target.label, title: article.title },
    delegated_rules: delegated.delegated, cited_laws: delegated.cited,
    precedents: { total: prec.total, top: prec.rows.map(r => ({ case_number: String(r.사건번호 ?? ''), name: textOf(r.사건명), court: textOf(r.법원명), decided: String(r.선고일자 ?? ''), id: String(r.판례일련번호 ?? '') })) },
    interpretations: { total: expc.total, top: expc.rows.map(r => ({ number: String(r.안건번호 ?? ''), name: textOf(r.안건명), date: String(r.회신일자 ?? ''), id: String(r.법령해석례일련번호 ?? '') })) },
    admin_rules: { total: admrul.total, top: admrul.rows.map(r => ({ name: textOf(r.행정규칙명), kind: textOf(r.행정규칙종류), ministry: textOf(r.소관부처명), id: String(r.행정규칙일련번호 ?? '') })) },
    ordinances: { total_linked_to_article: ordinRows.length < ordin.rows.length ? ordinRows.length : ordin.total,
      top: ordinRows.map(r => ({ name: textOf(r.자치법규명), article: String(r.자치법규조번호 ?? ''), effective: String(r.시행일자 ?? ''), seq: String(r.자치법규일련번호 ?? '') })) },
  };
  if (input.mermaid) {
    const id = s => `n${[...String(s)].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7)}`;
    const lines = ['graph LR', `  A["${phrase}"]`];
    for (const r of delegated.delegated.slice(0, 15)) lines.push(`  A -->|${r.clause}| ${id(r.law + r.article)}["${r.law} ${r.article ?? ''}"]`);
    for (const r of delegated.cited.slice(0, 10)) lines.push(`  A -.->|인용| ${id(r.law + r.article)}["${r.law} ${r.article ?? ''}"]`);
    lines.push(`  A --- P["판례 ${prec.total}건"]`, `  A --- E["해석례 ${expc.total}건"]`, `  A --- R["행정규칙 ${admrul.total}건"]`, `  A --- O["연계 조례 조문 ${data.ordinances.total_linked_to_article}건"]`);
    data.mermaid = lines.join('\n');
  }
  return envelope(c, options, data, input, { note: '판례·해석례·행정규칙은 "법령명 제N조" 본문 검색 건수라 다른 법령의 같은 조 번호가 섞일 수 있습니다. 위임·인용은 법제처 위임법령 자료, 조례는 법령-자치법규 연계 자료 기준입니다.' });
}

/* ---------- ordinance radar ---------- */

export async function lawOrdinanceRadar(input, oc, options = {}) {
  const c = drfClient(oc, options);
  let seq = input.ordinanceSeq;
  if (!seq) {
    const data = await c.get('lawSearch.do', { target: 'ordin', query: input.ordinanceName, display: 20 });
    const rows = list(Object.values(data ?? {})[0]?.law);
    const squeeze = s => String(s ?? '').replace(/\s+/g, '');
    const hit = rows.find(r => squeeze(r.자치법규명) === squeeze(input.ordinanceName)) ?? (rows.length === 1 ? rows[0] : null);
    if (!hit) fail('not_found', rows.length ? `이름이 같은 자치법규가 없습니다. 후보: ${rows.slice(0, 5).map(r => r.자치법규명).join(', ')}` : '자치법규를 찾지 못했습니다.');
    seq = String(hit.자치법규일련번호);
  }
  const body = await c.get('lawService.do', { target: 'ordin', MST: seq });
  const svc = body?.LawService ?? Object.values(body ?? {})[0];
  const base = svc?.자치법규기본정보;
  if (!base) fail('not_found', '자치법규 본문이 조회되지 않습니다.');
  const ordinance = { name: textOf(base.자치법규명), seq, local_government: textOf(base.지자체기관명), promulgated: String(base.공포일자 ?? ''), effective: String(base.시행일자 ?? '') };
  const citedIn = new Map();
  for (const unit of list(svc?.조문?.조)) {
    const text = textOf(unit?.조내용);
    const where = textOf(unit?.조제목) ? `${articleLabel(unit?.조문번호 ?? 0, 0)}(${textOf(unit?.조제목)})` : String(unit?.조문번호 ?? '');
    for (const name of quotedLawNames(text)) {
      if (!citedIn.has(name)) citedIn.set(name, []);
      if (!citedIn.get(name).includes(where)) citedIn.get(name).push(where);
    }
  }
  const names = [...citedIn.keys()].slice(0, input.maxLaws);
  const laws = [];
  for (const name of names) {
    try {
      const law = await resolveLaw(c, { lawName: name });
      const row = { name: law.name, law_id: law.lawId, mst: law.mst, promulgated: law.promulgated, effective: law.effective, cited_in: citedIn.get(name),
        amended_after_ordinance: !!ordinance.promulgated && law.promulgated > ordinance.promulgated };
      if (input.includeUpcoming) {
        const versions = await versionsOf(c, law.lawId);
        row.upcoming = versions.filter(v => v.effective > today(options)).map(versionView);
      }
      laws.push(row);
    } catch (error) {
      if (!(error instanceof LawDirectError) || error.code !== 'law_not_found') throw error;
      laws.push({ name, status: 'not_found_as_law', cited_in: citedIn.get(name), message: error.message });
    }
  }
  const flagged = laws.filter(l => l.amended_after_ordinance || l.upcoming?.length);
  const notes = ['amended_after_ordinance는 상위 법령의 최근 공포일이 이 자치법규 공포일보다 늦다는 뜻입니다. 개정 내용이 이 자치법규가 인용한 조문에 미치는지는 law_compare_dates로 확인하세요.'];
  if (citedIn.size > names.length) notes.push(`인용 법령이 많아 앞의 ${names.length}건만 확인했습니다(전체 ${citedIn.size}건).`);
  return envelope(c, options, { ordinance, laws, review_needed: flagged.map(l => l.name) }, input, { note: notes.join(' ') });
}

/* ---------- bulk change watch ---------- */

export async function lawBulkCheck(input, oc, options = {}) {
  const c = drfClient(oc, { maxCalls: 45, ...options });
  const results = [];
  for (const query of input.queries) {
    try {
      const law = await resolveLaw(c, { lawName: query });
      const row = { query, name: law.name, law_id: law.lawId, mst: law.mst, promulgated: law.promulgated, effective: law.effective };
      if (input.previous) row.changed = input.previous[law.lawId] !== undefined ? input.previous[law.lawId] !== law.mst : null;
      if (input.includeUpcoming) {
        const data = await c.get('lawSearch.do', { target: 'eflaw', LID: law.lawId, nw: '3', display: 20 });
        row.upcoming = list(data?.LawSearch?.law).map(v => ({ mst: String(v.법령일련번호 ?? ''), effective: String(v.시행일자 ?? ''), promulgated: String(v.공포일자 ?? '') }))
          .filter(v => v.effective > today(options));
      }
      results.push(row);
    } catch (error) {
      if (!(error instanceof LawDirectError) || error.code !== 'law_not_found') throw error;
      results.push({ query, status: 'law_not_found', message: error.message });
    }
  }
  const snapshot = Object.fromEntries(results.filter(r => r.law_id).map(r => [r.law_id, r.mst]));
  const changed = input.previous ? results.filter(r => r.changed) : null;
  return envelope(c, options, { results: input.previous && input.changedOnly ? changed : results, changed: changed?.map(r => r.name) ?? null, snapshot },
    { queries: input.queries.length, previous: !!input.previous },
    { note: 'snapshot({법령ID: MST})을 다음 호출의 previous로 넣으면 MST가 바뀐 법령(개정·시행)만 changed로 표시합니다. 이 도구는 캐시하지 않습니다.' });
}

/* ---------- 행정규칙 ---------- */

export async function lawAdminRuleSearch(input, oc, options = {}) {
  const c = drfClient(oc, options);
  const params = { target: 'admrul', query: input.query, display: input.display, search: input.body ? 2 : undefined, knd: input.kind, nw: input.history ? 2 : undefined };
  const data = await c.get('lawSearch.do', params);
  const root = data?.AdmRulSearch ?? Object.values(data ?? {})[0];
  const rows = list(root?.admrul).map(r => ({ name: textOf(r.행정규칙명), kind: textOf(r.행정규칙종류), ministry: textOf(r.소관부처명),
    status: String(r.현행연혁구분 ?? ''), issued: String(r.발령일자 ?? ''), effective: String(r.시행일자 ?? ''), number: String(r.발령번호 ?? ''),
    id: String(r.행정규칙일련번호 ?? ''), rule_id: String(r.행정규칙ID ?? '') }));
  return envelope(c, options, { total: Number(root?.totalCnt ?? rows.length), rules: rows }, params,
    { note: '본문은 id(행정규칙일련번호)로 law_admin_rule을 조회합니다. rule_id(행정규칙ID)로 조회하면 현행본입니다.' });
}

export async function lawAdminRule(input, oc, options = {}) {
  const c = drfClient(oc, options);
  const data = await c.get('lawService.do', { target: 'admrul', ...(input.id ? { ID: input.id } : { LID: input.ruleId }) });
  const svc = data?.AdmRulService;
  if (!svc?.행정규칙기본정보) fail('not_found', '행정규칙 본문이 조회되지 않습니다. 행정규칙일련번호(13자리) 또는 행정규칙ID를 확인하세요.');
  const b = svc.행정규칙기본정보;
  const info = { name: textOf(b.행정규칙명), kind: textOf(b.행정규칙종류), ministry: textOf(b.소관부처명), issued: String(b.발령일자 ?? ''),
    effective: String(b.시행일자 ?? ''), number: String(b.발령번호 ?? ''), current: b.현행여부 === 'Y', id: String(b.행정규칙일련번호 ?? ''), rule_id: String(b.행정규칙ID ?? '') };
  const units = adminRuleUnits(data);
  let selected = units, mode = 'page';
  if (input.article) {
    const label = adminArticleLabel(input.article);
    if (!label) fail('invalid_input', 'article은 "제9-5조", "9-5", "제10조의2" 형식으로 씁니다.');
    const at = units.findIndex(u => u.label === label);
    if (at < 0) fail('not_found', `${info.name}에 ${label}가 없습니다.`);
    const articles = units.map((u, i) => [u, i]).filter(([u]) => u.type === 'article');
    const pos = articles.findIndex(([, i]) => i === at);
    selected = articles.slice(Math.max(0, pos - input.context), pos + input.context + 1).map(([u]) => u);
    mode = 'article';
  } else if (input.chapter) {
    const want = String(input.chapter).replace(/\s+/g, '');
    const part = /(\d+)편/.exec(want)?.[1], chapter = /(\d+)장/.exec(want)?.[1] ?? /^제?(\d+)$/.exec(want)?.[1];
    if (!part && !chapter) fail('invalid_input', 'chapter는 "제9장", "9", "제4편 제3장", "제4편"처럼 씁니다.');
    selected = units.filter(u => (!part || u.part === `제${part}편`) && (!chapter || u.chapter === `제${chapter}장`));
    if (!selected.length) fail('not_found', `${info.name}에 ${input.chapter}이(가) 없습니다.`);
    mode = 'chapter';
  } else if (input.keyword) {
    selected = units.filter(u => u.type === 'article' && u.text.includes(input.keyword)).slice(0, input.maxResults);
    mode = 'keyword';
  }
  const pageSize = 30, pages = Math.max(1, Math.ceil(selected.length / pageSize));
  const page = mode === 'page' ? Math.min(input.page, pages) : 1;
  const shown = mode === 'page' ? selected.slice((page - 1) * pageSize, page * pageSize) : selected;
  const annexes = annexesOf(data).map(a => ({ label: a.label, title: a.title, has_text: a.has_text, text: a.lines.join('\n').trim().slice(0, 6000) || null,
    tables: a.tables, files: { hwp: absolute(a.files.hwp), pdf: absolute(a.files.pdf) } }));
  const addenda = addendaOf(data).slice(0, 3);
  return envelope(c, options, { rule: info, mode, units: shown.map(({ type, label, text, part, chapter }) => ({ type, label, chapter: [part, chapter].filter(Boolean).join(' ') || null, text })),
    ...(mode === 'page' ? { page, total_pages: pages } : {}), total_units: units.length, annexes, recent_addenda: addenda },
    { id: input.id ?? null, rule_id: input.ruleId ?? null, article: input.article ?? null, chapter: input.chapter ?? null, keyword: input.keyword ?? null },
    { note: mode === 'keyword' && !selected.length ? `"${input.keyword}"가 들어간 조문이 없습니다.` : '별표 text가 없거나 6,000자에서 잘린 경우 files 링크로 원문을 확인합니다.' });
}
