/** Pure helpers for the law analysis tools: article and annex flattening, box-drawing tables, citation extraction,
 * line and word diffs, and 신구조문대비표 rows. No network, no environment. Written for this server; the feature set
 * follows korean-law-mcp (MIT, https://github.com/chrisryugj/korean-law-mcp) but no code is taken from it.
 */

const list = value => value === undefined || value === null ? [] : [].concat(value);
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** DRF text fields come as a string, an array of strings or nested arrays. */
export function textOf(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  // Only real HTML tags go; annotations such as <개정 2016.12.27> and <신설> are part of the legal text.
  return String(value).replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:p|div|span|b|i|u|font|strong|em|table|tbody|thead|tr|td|th|img|a)\b[^>]*>/gi, '')
    .replace(/\r/g, '').trim();
}

export function articleLabel(number, branch) {
  const n = Number(number), b = Number(branch || 0);
  return `제${n}조${b ? `의${b}` : ''}`;
}

/** 제750조·제10조의2 → { number, branch }. */
export function parseArticleLabel(text) {
  const match = /제?\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,2}))?/.exec(String(text ?? ''));
  return match ? { number: Number(match[1]), branch: Number(match[2] ?? 0) } : null;
}

/** One 조문단위 as ordered lines keyed by position: '' for the head, then 항 '①', 호 '①|1.', 목 '①|1.|가.'. */
export function articleLines(unit) {
  const lines = [];
  const head = textOf(unit?.조문내용);
  if (head) lines.push({ key: '', text: head });
  const pushItems = (items, parent, numberField, textField, childField, grandField) => {
    for (const item of list(items)) {
      const text = textOf(item?.[textField]);
      const marker = String(item?.[numberField] ?? '').trim() || markerOf(text) || '';
      const key = parent ? `${parent}|${marker}` : marker;
      if (text) lines.push({ key, text });
      if (childField) pushItems(item?.[childField], key, grandField.number, grandField.text, grandField.child, grandField.grand);
    }
  };
  const mok = { number: '목번호', text: '목내용' };
  const ho = { number: '호번호', text: '호내용', child: '목', grand: mok };
  for (const hang of list(unit?.항)) {
    const text = textOf(hang?.항내용);
    const marker = String(hang?.항번호 ?? '').trim() || markerOf(text) || '';
    if (text) lines.push({ key: marker, text });
    pushItems(hang?.호, marker, ho.number, ho.text, ho.child, ho.grand);
  }
  return lines;
}

/** Leading 항·호·목 marker of a line: '①', '1.', '1의2.', '가.'. */
export function markerOf(text) {
  const t = String(text ?? '').trim();
  if (CIRCLED.includes(t[0])) return t[0];
  const ho = /^(\d{1,3}(?:의\d{1,2})?)\.(?!\d)/.exec(t);
  if (ho) return `${ho[1]}.`;
  const mok = /^([가-하])\.(?!\S\.)/.exec(t);
  return mok ? `${mok[1]}.` : '';
}

/** Law JSON (법령 or the whole response) → Map of article label → { label, title, effective, lines }. */
export function lawArticles(data) {
  const law = data?.법령 ?? data;
  const out = new Map();
  for (const unit of list(law?.조문?.조문단위)) {
    if (unit?.조문여부 && unit.조문여부 !== '조문') continue;
    const label = articleLabel(unit.조문번호, unit.조문가지번호);
    out.set(label, { label, title: String(unit.조문제목 ?? ''), effective: String(unit.조문시행일자 ?? ''), lines: articleLines(unit) });
  }
  return out;
}

export function basicInfo(data) {
  const info = (data?.법령 ?? data)?.기본정보 ?? {};
  return {
    law_id: String(info.법령ID ?? ''), name: textOf(info.법령명_한글 ?? info.법령명한글),
    promulgated: String(info.공포일자 ?? ''), promulgation_no: String(info.공포번호 ?? ''),
    effective: String(info.시행일자 ?? ''), kind: textOf(info.법종구분?.content ?? info.법종구분),
    amendment: String(info.제개정구분 ?? ''), ministry: textOf(info.소관부처?.content ?? info.소관부처),
  };
}

/** 부칙단위 → [{ promulgated, number, lines }], newest promulgation first. Admin rules give parallel arrays. */
export function addendaOf(data) {
  const root = data?.법령 ?? data?.AdmRulService ?? data;
  const addenda = root?.부칙;
  if (!addenda) return [];
  let units = list(addenda.부칙단위);
  if (!units.length && addenda.부칙내용 !== undefined) {
    const dates = list(addenda.부칙공포일자), numbers = list(addenda.부칙공포번호), bodies = list(addenda.부칙내용);
    units = bodies.map((body, i) => ({ 부칙공포일자: dates[i], 부칙공포번호: numbers[i], 부칙내용: body }));
  }
  return units.map(unit => ({
    promulgated: String(unit?.부칙공포일자 ?? ''), number: String(unit?.부칙공포번호 ?? ''),
    lines: textOf(unit?.부칙내용).split('\n').map(s => s.trim()).filter(Boolean),
  })).sort((a, b) => b.promulgated.localeCompare(a.promulgated));
}

const PROVISION_KINDS = [
  ['transitional', /경과조치|종전의\s*(?:규정|예)|종전\s*규정/],
  ['application', /적용례|적용한다|적용하지\s*아니/],
  ['effective_date', /시행일|시행한다/],
];
/** Groups addenda lines into provisions (a 제N조 or ①… line with the 호 lines under it) and tags 시행일·적용례·경과조치.
 * An article mention is a 제N조 equal to the label. */
export function addendaProvisions(lines, label) {
  const groups = [];
  let hasArticles = false;
  for (const line of lines) {
    if (/^부칙\s*</.test(line) && !groups.length && line.length < 40) continue;
    const article = /^제\s*\d+\s*조/.test(line);
    if (article) hasArticles = true;
    if (!groups.length || article || (!hasArticles && CIRCLED.includes(line[0]))) groups.push(line);
    else groups[groups.length - 1] += `\n${line}`;
  }
  // 제5조의 개정규정 mentions 제5조; 제5조의2 is another article.
  const mention = label ? new RegExp(`${label.replace(/의/, '의\\s*')}(?!\\d|의\\s*\\d)`) : null;
  return groups.map(text => ({ kind: PROVISION_KINDS.find(([, re]) => re.test(text.split('\n')[0]))?.[0] ?? PROVISION_KINDS.find(([, re]) => re.test(text))?.[0] ?? 'other',
    mentions_article: mention ? mention.test(text) : false, text }));
}

/* ---------- annexes ---------- */

const BORDER = /^[\s┏┓┗┛┠┨┯┷┿╋┳┻┣┫━─┌┐└┘├┤┬┴┼═╔╗╚╝╠╣╦╩╬]+$/;
const VERTICAL = /[│┃║]/;
const hangulEnd = /[가-힣]$/, hangulStart = /^[가-힣]/;
function joinWrapped(a, b) {
  if (!a) return b;
  if (!b) return a;
  return hangulEnd.test(a) && hangulStart.test(b) ? a + b : `${a} ${b}`;
}

/** Box-drawing tables in 별표내용 → [{ rows: [[cell, …], …] }]. Cell text wrapped over several lines is joined;
 * Hangul-to-Hangul wraps are joined without a space, so a word broken by the layout is read back as one word.
 * A partial border (┃    ├───┼───┨) ends a row while the cells to its left span on; those are carried into the
 * following rows so each row reads on its own. */
export function boxTables(lines) {
  const tables = [];
  let table = null, pending = null, span = [];
  const flush = () => {
    if (!pending) return;
    const row = pending.map(s => s.trim());
    span.forEach((value, i) => { if (!row[i] && value) row[i] = value; });
    table.rows.push(row);
    pending = null;
  };
  const borderOnly = segment => /[━─═]{2,}/.test(segment) && /^[\s├┼┤┨┠┣┫╂╋┬┴┯┷┿━─═]+$/.test(segment);
  for (const raw of lines) {
    const trimmed = String(raw ?? '').trim();
    if (trimmed && BORDER.test(trimmed) && /[━─═]/.test(trimmed)) {
      if (!table) { table = { rows: [] }; tables.push(table); }
      flush();
      span = [];
      if (/^[┗└╚]/.test(trimmed)) table = null;
      continue;
    }
    if (table && /^[│┃║]/.test(trimmed)) {
      const segments = trimmed.replace(/^[│┃║]|[│┃║]$/g, '').split(VERTICAL);
      const at = segments.findIndex(borderOnly);
      if (at >= 0 && segments.slice(at).every(seg => borderOnly(seg) || !seg.trim())) {
        // Columns the border crosses = crossings + 1 per border segment; the rest, on the left, keep spanning.
        const covered = segments.filter(borderOnly).reduce((n, seg) => n + (seg.match(/[┼┿╂╋┬┴┯┷]/g)?.length ?? 0) + 1, 0);
        const columns = (pending ?? table.rows.at(-1) ?? []).length;
        const spanned = Math.max(0, columns - covered);
        const carried = (pending ?? []).slice(0, spanned).map(s => s.trim());
        flush();
        const previous = table.rows.at(-1) ?? [];
        span = Array.from({ length: spanned }, (_, i) => carried[i] || previous[i] || '');
        continue;
      }
      const cells = segments.map(s => s.trim());
      if (!pending || pending.length !== cells.length) { flush(); pending = cells; }
      else pending = pending.map((cell, i) => joinWrapped(cell, cells[i]));
      continue;
    }
    if (table) { flush(); table = null; }
  }
  if (table) flush();
  return tables.filter(t => t.rows.length);
}

/** 별표단위 (law, admin rule or ordinance) → annex records with text, parsed tables and file links. */
export function annexesOf(data) {
  const root = data?.법령 ?? data?.AdmRulService ?? data?.LawService ?? data;
  return list(root?.별표?.별표단위).map(unit => {
    const lines = list(unit?.별표내용).flat(Infinity).map(s => String(s ?? '').replace(/\s+$/, ''));
    const number = Number(unit?.별표번호 ?? 0), branch = Number(unit?.별표가지번호 ?? 0);
    const kind = String(unit?.별표구분 ?? '별표');
    const title = textOf(unit?.별표제목);
    const linked = /\(\s*(제\s*\d+\s*조(?:\s*의\s*\d+)?)[^)]*관련\s*\)/.exec(title);
    return {
      kind, number, branch, label: `${kind} ${number || ''}${branch ? `의${branch}` : ''}`.trim(), title,
      related_article: linked ? linked[1].replace(/\s+/g, '') : null,
      has_text: lines.some(line => line.trim()),
      lines, tables: boxTables(lines),
      files: { hwp: list(unit?.별표서식파일링크)[0] ?? null, pdf: list(unit?.별표서식PDF파일링크)[0] ?? null,
        images: list(unit?.별표서식이미지파일링크) },
    };
  });
}

/** '3', '별표 3', '별표3의2', '서식 2' → { kind, number, branch }. */
export function parseAnnexRef(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  const match = /^(별표|서식|별지|별지서식)?(?:제)?(\d{1,3})(?:호)?(?:의(\d{1,2}))?(?:서식)?$/.exec(t);
  if (!match) return null;
  const kind = match[1] ? (match[1] === '별표' ? '별표' : '서식') : null;
  return { kind, number: Number(match[2]), branch: Number(match[3] ?? 0) };
}

/* ---------- admin rules ---------- */

/** 행정규칙 조문내용 strings → [{ type: 'heading'|'article', label, text, chapter }]. */
export function adminRuleUnits(data) {
  const raw = list(data?.AdmRulService?.조문내용 ?? data?.조문내용).map(textOf).filter(Boolean);
  const units = [];
  let part = '', chapter = '';
  for (const text of raw) {
    const heading = /^제\s*(\d+)\s*(편|장|절|관)\s*/.exec(text);
    const article = /^제\s*(\d+(?:-\d+)*)\s*조(?:\s*의\s*(\d+))?/.exec(text);
    if (heading && !article) {
      if (heading[2] === '편') { part = `제${heading[1]}편`; chapter = ''; }
      if (heading[2] === '장') chapter = `제${heading[1]}장`;
      units.push({ type: 'heading', label: `제${heading[1]}${heading[2]}`, text, part, chapter });
    } else {
      const label = article ? `제${article[1]}조${article[2] ? `의${article[2]}` : ''}` : null;
      units.push({ type: 'article', label, text, part, chapter });
    }
  }
  return units;
}

/** '제9-5조', '9-5', '제10조의2' → normalized 행정규칙 article label. */
export function adminArticleLabel(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  const match = /^제?(\d+(?:-\d+)*)(?:조)?(?:의(\d+))?(?:조)?$/.exec(t);
  return match ? `제${match[1]}조${match[2] ? `의${match[2]}` : ''}` : null;
}

/* ---------- citations ---------- */

const CASE_CODES = '헌가|헌나|헌라|헌마|헌바|헌사|헌아|가합|가단|가소|가기|고합|고단|고정|고약|구합|구단|드합|드단|카합|카단|카기|재다|재두|재도|재누|재구|비합|회합|회단|하합|하단|느합|느단|다|나|가|도|노|두|누|구|므|르|스|브|드|느|머|카|추|후|허|모|오|초|로|라|마|그|재';
const CASE_RE = new RegExp(`(?<![\\d가-힣])((?:19|20)?\\d{2})\\s?(${CASE_CODES})\\s?(\\d{1,7})(?![\\d가-힣])`, 'g');
const QUOTED_RE = /「([^」]{2,80})」\s*(제\s*\d{1,4}\s*조(?:\s*의\s*\d{1,2})?)(?:\s*(제\s*\d{1,3}\s*항))?(?:\s*(제\s*\d{1,3}\s*호))?/g;
const BARE_RE = /(?<![가-힣「」])([가-힣]{1,30}(?:법|법률|시행령|시행규칙|규칙|규정))\s*(제\s*\d{1,4}\s*조(?:\s*의\s*\d{1,2})?)(?:\s*(제\s*\d{1,3}\s*항))?(?:\s*(제\s*\d{1,3}\s*호))?/g;
const NOT_A_LAW = /^(?:같은|동|이|그|본|해당|위|관계|관련|상위|하위|개정|구|현행|신|헌)법$|^(?:같은|동|이)?(?:법률|시행령|시행규칙|규칙|규정)$/;

/** Law article citations and case numbers in free text, in order of appearance, without duplicates. */
export function extractCitations(text, max = 15) {
  const source = String(text ?? '');
  const found = [];
  const seen = new Set();
  const add = (item, index) => {
    const key = item.type === 'case' ? `case:${item.case_number}` : `law:${item.law_name}|${item.article}|${item.paragraph ?? ''}|${item.item ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ...item, index });
  };
  const squeeze = s => s ? s.replace(/\s+/g, '') : null;
  for (const m of source.matchAll(QUOTED_RE)) add({ type: 'law', raw: m[0], law_name: m[1].trim(), article: squeeze(m[2]), paragraph: squeeze(m[3]), item: squeeze(m[4]) }, m.index);
  for (const m of source.matchAll(BARE_RE)) {
    if (NOT_A_LAW.test(m[1])) continue;
    const before = source.slice(Math.max(0, m.index - 2), m.index);
    if (before.endsWith('」')) continue;
    add({ type: 'law', raw: m[0], law_name: m[1], article: squeeze(m[2]), paragraph: squeeze(m[3]), item: squeeze(m[4]) }, m.index);
  }
  for (const m of source.matchAll(CASE_RE)) add({ type: 'case', raw: m[0], case_number: `${m[1]}${m[2]}${m[3]}` }, m.index);
  return found.sort((a, b) => a.index - b.index).slice(0, max).map(({ index, ...rest }) => rest);
}

/** 「인감증명법」 → ['인감증명법'], unique, in order. */
export function quotedLawNames(text) {
  const names = [];
  for (const m of String(text ?? '').matchAll(/「([^」]{2,80})」/g)) {
    const name = m[1].trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/* ---------- diff ---------- */

/** Longest common subsequence alignment of two arrays → [{ op: 'same'|'del'|'add', a, b }]. */
export function diffSequence(a, b, equal = (x, y) => x === y) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {  // too large to align; report as a full replacement
    return [...a.map(x => ({ op: 'del', a: x })), ...b.map(y => ({ op: 'add', b: y }))];
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i][j] = equal(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (equal(a[i], b[j])) { ops.push({ op: 'same', a: a[i], b: b[j] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push({ op: 'del', a: a[i++] });
    else ops.push({ op: 'add', b: b[j++] });
  }
  while (i < n) ops.push({ op: 'del', a: a[i++] });
  while (j < m) ops.push({ op: 'add', b: b[j++] });
  return ops;
}

const tokens = text => String(text ?? '').match(/[가-힣A-Za-z0-9]+|\s+|./gu) ?? [];
/** Word-level change marking: removed parts underlined in the old text, added parts in the new text. */
export function markChanges(oldText, newText, open = '<u>', close = '</u>') {
  const ops = diffSequence(tokens(oldText), tokens(newText));
  // A space kept between two changed words belongs to the change, so the underline runs across it.
  for (let k = 1; k < ops.length - 1; k++) {
    if (ops[k].op === 'same' && !ops[k].a.trim() && ops[k - 1].op !== 'same' && ops.slice(k + 1).find(o => o.op !== 'same' || o.a.trim())?.op !== 'same') {
      ops.splice(k, 1, { op: 'del', a: ops[k].a }, { op: 'add', b: ops[k].b });
    }
  }
  let oldOut = '', newOut = '', oldRun = '', newRun = '';
  const wrap = run => {
    if (!run.trim()) return run;
    const lead = /^\s*/.exec(run)[0], tail = /\s*$/.exec(run)[0];
    return `${lead}${open}${run.trim()}${close}${tail}`;
  };
  const flush = () => { oldOut += wrap(oldRun); newOut += wrap(newRun); oldRun = ''; newRun = ''; };
  for (const op of ops) {
    if (op.op === 'same') { flush(); oldOut += op.a; newOut += op.b; }
    else if (op.op === 'del') oldRun += op.a;
    else newRun += op.b;
  }
  flush();
  return { old: oldOut, new: newOut };
}

/** Line diff of two articles: pairs adjacent removals and additions as changes. */
export function diffLines(oldLines, newLines) {
  const ops = diffSequence(oldLines, newLines);
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.op === 'del' && ops[k + 1]?.op === 'add') {
      const marked = markChanges(op.a, ops[k + 1].b);
      out.push({ op: 'change', old: op.a, new: ops[k + 1].b, old_marked: marked.old, new_marked: marked.new });
      k++;
    } else if (op.op === 'del') out.push({ op: 'delete', old: op.a });
    else if (op.op === 'add') out.push({ op: 'add', new: op.b });
  }
  return out;
}

/** Article-by-article comparison of two article maps (see lawArticles). */
export function compareArticleMaps(before, after) {
  const added = [], deleted = [], changed = [];
  let unchanged = 0;
  const isDeleted = article => article && article.lines.length <= 1 && /삭제/.test(article.lines[0]?.text ?? '');
  for (const [label, old] of before) {
    const now = after.get(label);
    if (!now || (isDeleted(now) && !isDeleted(old))) { deleted.push({ article: label, title: old.title }); continue; }
    const a = old.lines.map(l => l.text), b = now.lines.map(l => l.text);
    if (a.join('\n') === b.join('\n')) { unchanged++; continue; }
    changed.push({ article: label, title_before: old.title, title_after: now.title, changes: diffLines(a, b) });
  }
  for (const [label, now] of after) {
    const old = before.get(label);
    if ((!old || isDeleted(old)) && !isDeleted(now)) added.push({ article: label, title: now.title, text: now.lines.map(l => l.text).join('\n') });
  }
  return { added, deleted, changed, unchanged };
}

/* ---------- 신구조문대비표 ---------- */

const SAME = /\(\s*현행과\s*같음\s*\)/;
/** Parses amendment text: '② ∼ ⑤ (현행과 같음)', '1.·2. (현행과 같음)', '③ 삭제', '제5조 삭제'. */
export function parseAmendmentLines(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean)) {
    if (/^제\s*\d{1,4}\s*조(?:\s*의\s*\d{1,2})?\s*삭제\s*$/.test(raw)) { out.push({ markers: [''], kind: 'delete_article', text: raw }); continue; }
    const headMatch = /^(제\s*\d{1,4}\s*조(?:\s*의\s*\d{1,2})?(?:\s*\([^)]*\))?)\s*(.*)$/.exec(raw);
    if (headMatch) {
      const rest = headMatch[2];
      const first = markerOf(rest);
      if (SAME.test(raw) && (!first || rest.replace(SAME, '').trim() === first)) {
        out.push({ markers: [''], kind: 'same', text: headMatch[1] });
        if (first && first !== '') out.push({ markers: [first], kind: 'same', text: rest });
        continue;
      }
      out.push({ markers: [''], kind: 'text', text: first ? headMatch[1] : raw });
      if (first) out.push(...parseAmendmentLines(rest));
      continue;
    }
    const markers = [];
    let rest = raw;
    for (;;) {
      const m = markerOf(rest);
      if (!m) break;
      markers.push(m);
      rest = rest.slice(rest.indexOf(m) + m.length).replace(/^\s*(?:[∼~·ㆍ,]|부터)\s*/, '');
      if (!markerOf(rest)) break;
    }
    if (!markers.length) { out.push({ markers: [null], kind: 'text', text: raw }); continue; }
    const range = /∼|~|부터/.test(raw.slice(0, raw.length - rest.length));
    if (SAME.test(rest) && rest.replace(SAME, '').trim() === '') out.push({ markers, range, kind: 'same', text: raw });
    else if (/^삭제\s*(?:<[^>]*>)?$/.test(rest.trim())) out.push({ markers, kind: 'delete', text: raw });
    else out.push({ markers: [markers[0]], kind: 'text', text: raw });
  }
  return out;
}

/** Keys the amendment lines like articleLines: 항 at top level, 호 under the last 항, 목 under the last 호. */
function keyAmendment(parsed, currentKeys) {
  const keyed = [];
  let hang = '', ho = '';
  const levelOf = marker => marker === '' ? 0 : CIRCLED.includes(marker) ? 1 : /^\d/.test(marker) ? 2 : 3;
  const keyFor = marker => {
    const level = levelOf(marker);
    if (level === 0) return '';
    if (level === 1) { hang = marker; ho = ''; return marker; }
    if (level === 2) { ho = marker; return hang ? `${hang}|${marker}` : marker; }
    const parent = [hang, ho].filter(Boolean).join('|');
    return parent ? `${parent}|${marker}` : marker;
  };
  for (const line of parsed) {
    if (line.markers[0] === null) { keyed.push({ ...line, keys: [null] }); continue; }
    let keys = line.markers.map(keyFor);
    if (line.range && keys.length === 2) {
      const from = currentKeys.indexOf(keys[0]), to = currentKeys.indexOf(keys[1]);
      const depth = keys[0].split('|').length;
      if (from >= 0 && to >= from) keys = currentKeys.slice(from, to + 1).filter(k => k.split('|').length === depth);
    }
    keyed.push({ ...line, keys });
  }
  return keyed;
}

/** Builds 신구조문대비표 rows for one article. current: articleLines of the 현행 article ([] when the article is new).
 * Rows follow the usual drafting conventions: unchanged runs as '(생 략)' / '(현행과 같음)', <신 설>, <삭 제>, and
 * changed words underlined. Current items the amendment does not mention are treated as deleted and listed in warnings. */
export function amendmentRows(label, current, amendmentText) {
  const warnings = [];
  const parsed = parseAmendmentLines(amendmentText);
  if (parsed.length === 1 && parsed[0].kind === 'delete_article') {
    return { rows: current.length ? [{ current: current.map(l => `<u>${l.text}</u>`).join('\n'), proposed: `${label} 삭제` }] : [], warnings,
      status: current.length ? 'deleted' : 'not_found' };
  }
  if (!current.length) {
    return { rows: [{ current: '<신 설>', proposed: parsed.map(l => `<u>${l.text}</u>`).join('\n') }], warnings, status: 'new' };
  }
  const currentKeys = current.map(l => l.key);
  const byKey = new Map(current.map(l => [l.key, l.text]));
  const proposed = new Map();
  const order = [];
  for (const line of keyAmendment(parsed, currentKeys)) {
    for (const key of line.keys) {
      if (key === null) { warnings.push(`항·호·목 번호가 없는 줄은 앞 줄에 이어 붙였습니다: ${line.text.slice(0, 40)}`); continue; }
      if (!order.includes(key)) order.push(key);
      proposed.set(key, line.kind === 'same' ? { same: true } : line.kind === 'delete' ? { deleted: true } : { text: line.keys.length === 1 ? line.text : null });
    }
  }
  // A new item goes right after the item written before it in the amendment, past that item's own sub-items.
  const keys = [...currentKeys];
  order.forEach((key, index) => {
    if (keys.includes(key)) return;
    const previous = order.slice(0, index).reverse().find(k => keys.includes(k));
    let at = previous === undefined ? keys.length : keys.indexOf(previous) + 1;
    if (previous !== undefined) while (at < keys.length && previous !== '' && keys[at].startsWith(`${previous}|`)) at++;
    keys.splice(at, 0, key);
  });
  const rows = [];
  let run = [];
  const markerText = key => key.split('|').at(-1) || label;
  const flushRun = () => {
    if (!run.length) return;
    const span = run.length === 1 ? markerText(run[0]) : `${markerText(run[0])} ∼ ${markerText(run.at(-1))}`;
    rows.push({ current: `${span} (생 략)`, proposed: `${span} (현행과 같음)` });
    run = [];
  };
  for (const key of keys) {
    const old = byKey.get(key);
    const next = proposed.get(key);
    if (key === '' && old !== undefined && (!next || next.same)) { flushRun(); rows.push({ current: old, proposed: `${label} (현행과 같음)` }); continue; }
    if (old !== undefined && (!next || next.same)) {
      if (!next && key !== '') warnings.push(`개정안에 ${markerText(key)}이(가) 없어 삭제로 보았습니다. 유지하려면 '${markerText(key)} (현행과 같음)'을 넣으세요.`);
      if (!next && key !== '') { flushRun(); rows.push({ current: `<u>${old}</u>`, proposed: '<삭 제>' }); continue; }
      run.push(key); continue;
    }
    flushRun();
    if (old === undefined) rows.push({ current: '<신 설>', proposed: `<u>${next.text}</u>` });
    else if (next.deleted) rows.push({ current: `<u>${old}</u>`, proposed: `${markerText(key)} 삭제` });
    else if (next.text === old) rows.push({ current: old, proposed: next.text });
    else { const marked = markChanges(old, next.text); rows.push({ current: marked.old, proposed: marked.new }); }
  }
  flushRun();
  return { rows, warnings, status: 'amended' };
}

export function markdownTable(rows, headers = ['현 행', '개 정 안']) {
  const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${cell(r.current)} | ${cell(r.proposed)} |`)].join('\n');
}
