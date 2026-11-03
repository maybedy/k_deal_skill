/** Term search inside an OpenDART XBRL package (fnlttXbrl.xml) and inside filing text.
 * DART XBRL tags notes as numeric facts with dimension members plus short Korean text facts; there are no
 * text-block notes (checked on 삼성전자 FY2025 사업보고서, 2026-11-03). Terms are literal words, never regex,
 * so a caller cannot make the server backtrack on a crafted pattern.
 */

export const DEFAULT_NOTE_TERMS = '리스|우발|약정|보증|담보|특수관계|부문|감가상각|사용권자산';
const MAX_TERMS = 20;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = s => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
const attr = (text, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1];

/** '리스|우발' -> ['리스', '우발']. Returns null when no usable term remains. */
export function parseTerms(pattern) {
  const terms = [...new Set(String(pattern ?? '').split('|').map(t => t.trim()).filter(Boolean))];
  if (!terms.length || terms.length > MAX_TERMS || terms.some(t => t.length > 50)) return null;
  return terms;
}
const matchedTerms = (text, terms) => {
  const lower = text.toLowerCase();
  return terms.filter(t => lower.includes(t.toLowerCase()));
};

/** Finds every term occurrence in text. Occurrences inside an earlier passage are merged into it. */
export function findPassages(text, terms, { contextChars = 300, maxPassages = 50 } = {}) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const term of terms) {
    const t = term.toLowerCase();
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) hits.push({ offset: i, term, end: i + t.length });
  }
  hits.sort((a, b) => a.offset - b.offset);
  const counts = Object.fromEntries(terms.map(t => [t, 0]));
  const passages = [];
  let last = null;
  for (const hit of hits) {
    counts[hit.term]++;
    if (last && hit.offset < last.end) {
      if (!last.terms.includes(hit.term)) last.terms.push(hit.term);
      last.end = Math.max(last.end, Math.min(text.length, hit.end + contextChars));
      continue;
    }
    last = { offset: hit.offset, start: Math.max(0, hit.offset - contextChars), end: Math.min(text.length, hit.end + contextChars), terms: [hit.term] };
    passages.push(last);
  }
  return {
    total: passages.length, term_counts: counts,
    passages: passages.slice(0, maxPassages).map(p => ({ offset: p.offset, start: p.start, terms: p.terms, text: text.slice(p.start, p.end) })),
  };
}

/** concept id ('ifrs-full:LeaseLiabilities') -> Korean labels, from a _lab-ko.xml label linkbase. */
export function parseLabels(xml) {
  const locs = new Map(), resources = new Map(), arcs = [];
  for (const m of xml.matchAll(/<link:(loc|label|labelArc)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link:\1>)/g)) {
    const [, kind, attrs, body] = m;
    if (kind === 'loc') {
      const fragment = attr(attrs, 'xlink:href')?.split('#')[1];
      if (fragment) locs.set(attr(attrs, 'xlink:label'), fragment.replace('_', ':'));
    } else if (kind === 'label') {
      resources.set(attr(attrs, 'xlink:label'), { role: attr(attrs, 'xlink:role') ?? '', text: decodeEntities(body ?? '').trim() });
    } else arcs.push([attr(attrs, 'xlink:from'), attr(attrs, 'xlink:to')]);
  }
  const labels = new Map();
  for (const [from, to] of arcs) {
    const concept = locs.get(from), label = resources.get(to);
    if (!concept || !label?.text) continue;
    const entry = labels.get(concept) ?? { label: null, all: [] };
    if (!entry.all.includes(label.text)) entry.all.push(label.text);
    if (label.role.endsWith('/role/label') || !entry.label) entry.label = label.text;  // the standard label wins
    labels.set(concept, entry);
  }
  return labels;
}

const BASIS_AXIS = 'ifrs-full:ConsolidatedAndSeparateFinancialStatementsAxis';
const BASIS = { 'ifrs-full:ConsolidatedMember': 'CFS', 'ifrs-full:SeparateMember': 'OFS' };

/** Contexts of an XBRL instance: period, CFS/OFS basis and the other explicit dimension members. */
export function parseContexts(xml) {
  const contexts = new Map();
  for (const m of xml.matchAll(/<xbrli:context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g)) {
    const body = m[2];
    const instant = /<xbrli:instant>([^<]+)</.exec(body)?.[1];
    const period = instant ? { instant } : { start: /<xbrli:startDate>([^<]+)</.exec(body)?.[1] ?? null, end: /<xbrli:endDate>([^<]+)</.exec(body)?.[1] ?? null };
    let basis = null;
    const dims = [];
    for (const d of body.matchAll(/<xbrldi:explicitMember\b[^>]*dimension="([^"]+)"[^>]*>([^<]+)</g)) {
      const member = d[2].trim();
      if (d[1] === BASIS_AXIS) basis = BASIS[member] ?? member;
      else dims.push({ axis: d[1], member });
    }
    if (/<xbrldi:typedMember\b/.test(body)) dims.push({ axis: 'typed', member: 'typedMember (원문 확인)' });
    contexts.set(m[1], { period, basis, dims });
  }
  return contexts;
}

/** Matches terms against concept labels, dimension member labels and text facts of an XBRL instance.
 * Every returned fact carries the instance file name and line, so it can be traced back to the source. */
export function searchXbrl({ instanceName, instance, labels }, terms, { basis = 'all', maxFacts = 60, contextChars = 300 } = {}) {
  const contexts = parseContexts(instance);
  const labelOf = concept => labels.get(concept)?.label ?? null;
  const conceptHits = new Map();
  const conceptTerms = concept => {
    if (!conceptHits.has(concept)) {
      const entry = labels.get(concept);
      conceptHits.set(concept, matchedTerms([concept.split(':')[1] ?? concept, ...(entry?.all ?? [])].join('\n'), terms));
    }
    return conceptHits.get(concept);
  };
  const facts = [], textMatches = [], concepts = new Map();
  let factsMatched = 0, textMatched = 0, factsScanned = 0;
  let line = 1, cursor = 0;
  const lineAt = index => { for (; cursor < index; cursor++) if (instance.charCodeAt(cursor) === 10) line++; return line; };
  const factRe = /<([A-Za-z][\w.-]*:[A-Za-z_][\w.-]*)\s([^>]*?\bcontextRef="([^"]+)"[^>]*?)(?:\/>|>([^<]*)<\/\1>)/g;
  for (const m of instance.matchAll(factRe)) {
    const [, concept, attrs, contextRef, raw] = m;
    const ctx = contexts.get(contextRef) ?? { period: null, basis: null, dims: [] };
    if (basis !== 'all' && ctx.basis !== basis) continue;
    factsScanned++;
    // Dimensions as 'axis label: member label'; the instance line in source locates the exact member ids.
    const dims = ctx.dims.map(d => `${labelOf(d.axis) ?? d.axis}: ${labelOf(d.member) ?? d.member}`);
    const onConcept = conceptTerms(concept);
    const onMember = [...new Set(ctx.dims.flatMap(d => matchedTerms(`${labelOf(d.member) ?? ''}\n${d.member}`, terms)))];
    const value = decodeEntities(raw ?? '').trim();
    const isText = attr(attrs, 'xml:lang') !== undefined;
    const onText = isText ? matchedTerms(value, terms) : [];
    if (!onConcept.length && !onMember.length && !onText.length) continue;
    const position = { file: instanceName, line: lineAt(m.index) };
    const base = { concept, label: labelOf(concept), period: ctx.period, basis: ctx.basis, dims, source: position };
    const summary = concepts.get(concept) ?? { concept, label: labelOf(concept), terms: [], facts: 0 };
    for (const t of [...onConcept, ...onMember, ...onText]) if (!summary.terms.includes(t)) summary.terms.push(t);
    summary.facts++;
    concepts.set(concept, summary);
    if (isText) {
      textMatched++;
      if (textMatches.length >= maxFacts) continue;
      const found = findPassages(value, onText.length ? onText : terms, { contextChars, maxPassages: 3 });
      textMatches.push({ ...base, matched_on: onText.length ? 'text' : onConcept.length ? 'concept_label' : 'member_label', terms: [...new Set([...onConcept, ...onMember, ...onText])],
        text_chars: value.length, passages: found.passages.length ? found.passages : [{ offset: 0, start: 0, terms: [], text: value.slice(0, contextChars * 2) }] });
    } else {
      factsMatched++;
      if (facts.length >= maxFacts) continue;
      facts.push({ ...base, matched_on: onConcept.length ? 'concept_label' : 'member_label', terms: [...new Set([...onConcept, ...onMember])],
        value: attr(attrs, 'xsi:nil') === 'true' ? null : value, unit: attr(attrs, 'unitRef') ?? null, decimals: attr(attrs, 'decimals') ?? null });
    }
  }
  return {
    facts, text_matches: textMatches, concepts: [...concepts.values()],
    counts: { facts_scanned: factsScanned, facts_matched: factsMatched, facts_returned: facts.length, text_matched: textMatched, text_returned: textMatches.length, contexts: contexts.size, labelled_concepts: labels.size },
  };
}
