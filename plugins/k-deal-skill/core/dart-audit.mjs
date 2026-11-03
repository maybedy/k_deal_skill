/** Financial statements read from a DART audit report (감사보고서·연결감사보고서). Unlisted companies under external
 * audit (외감) file only the audit report, which OpenDART's structured financial APIs do not cover, so the statement
 * tables are read from the filing XML: TABLE ACLASS="FINANCE" rows carry ACODE (account code) and ADELIM (column),
 * and the unit sits in the TU AUNIT/AUNITVALUE cell of the heading table.
 */
import { documentText, documentSections } from './extra-tools.mjs';

export const STATEMENTS = {
  bs: { name: '재무상태표', titles: ['재무상태표', '대차대조표'] },
  is: { name: '손익계산서', titles: ['포괄손익계산서', '손익계산서'] },
  ce: { name: '자본변동표', titles: ['자본변동표', '이익잉여금처분계산서', '결손금처리계산서'] },
  cf: { name: '현금흐름표', titles: ['현금흐름표'] },
};
const UNITS = { WON: 1, THOUSAND: 1000, MILLION: 1000000, BILLION: 1000000000 };
const squash = s => s.replace(/\s+/g, '');
const cellText = xml => documentText(xml).replace(/\s+/g, ' ').trim();

/** Audit report name: "감사보고서 (2024.12)", "[기재정정]연결감사보고서 (2024.03)". */
export function parseAuditReportName(name) {
  const m = /^(\[[^\]]+\])?\s*(연결)?감사보고서\s*\((\d{4})\.(\d{2})\)/.exec(String(name ?? '').trim());
  return m ? { corrected: Boolean(m[1]), consolidated: Boolean(m[2]), year: Number(m[3]), month: m[4] } : null;
}

/** The latest audit report for a fiscal year from OpenDART list rows (newest correction wins). */
export function pickAuditReport(rows, { year, consolidated = false }) {
  return rows
    .map(r => ({ row: r, info: parseAuditReportName(r.report_nm) }))
    .filter(x => x.info && x.info.year === year && x.info.consolidated === consolidated)
    .sort((a, b) => String(b.row.rcept_no).localeCompare(String(a.row.rcept_no)))[0]?.row ?? null;
}

/** "(1,234)" → -1234, "1,234" → 1234, "-" → 0, "" → null. Keeps anything else as null. */
export function parseAmount(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  if (!t) return null;
  if (/^[-–—]$/.test(t)) return 0;
  const m = /^(\()?(-)?([0-9][0-9,]*(?:\.[0-9]+)?)(\))?$/.exec(t);
  if (!m) return null;
  const n = Number(m[3].replace(/,/g, ''));
  return (m[1] && m[4]) || m[2] ? -n : n;
}

function unitOf(xml) {
  const tu = /<TU\b([^>]*)>([\s\S]*?)<\/TU>/i.exec(xml);
  if (tu) {
    const unit = /\bAUNIT="([A-Z]+)"/.exec(tu[1])?.[1];
    const value = Number(/\bAUNITVALUE="([0-9]+)"/.exec(tu[1])?.[1] ?? NaN);
    if (unit && UNITS[unit]) return { label: cellText(tu[2]), multiplier: UNITS[unit] * (Number.isFinite(value) ? value : 1) };
  }
  const text = documentText(xml);
  const m = /단위\s*[:：]\s*(백만원|천원|원)/.exec(text);
  return m ? { label: `(단위 : ${m[1]})`, multiplier: { 원: 1, 천원: 1000, 백만원: 1000000 }[m[1]] } : { label: null, multiplier: null };
}

function cells(rowXml) {
  const out = [];
  for (const m of rowXml.matchAll(/<(TE|TD|TH|TU)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    out.push({ text: cellText(m[3]), span: Number(/\bCOLSPAN="([0-9]+)"/i.exec(m[2])?.[1] ?? 1), code: /\bACODE="([^"]+)"/.exec(m[2])?.[1] ?? null,
      delim: /\bADELIM="([0-9]+)"/.exec(m[2])?.[1], level: /\bALEVEL="([0-9]+)"/.exec(m[2])?.[1] });
  }
  return out;
}

/** One statement table: period headers from THEAD, rows with account, code, level and one value per period.
 * Two-column-per-period layouts (detail and subtotal, common under K-GAAP) take the subtotal when both are filled. */
export function parseStatementTable(sectionXml) {
  const tables = [...sectionXml.matchAll(/<TABLE\b([^>]*)>([\s\S]*?)<\/TABLE>/gi)];
  const finance = tables.find(t => /ACLASS="FINANCE"/i.test(t[1])) ?? tables.sort((a, b) => b[2].length - a[2].length)[0];
  if (!finance) return null;
  const heading = sectionXml.slice(0, finance.index);
  const unit = unitOf(heading) ?? unitOf(finance[0]);
  const as_of = documentText(heading).split('\n').map(s => s.trim()).filter(s => /제\s*\d+\s*\(?[당전]?\)?\s*기/.test(s));
  const head = /<THEAD\b[^>]*>([\s\S]*?)<\/THEAD>/i.exec(finance[2])?.[1] ?? '';
  const headRows = [...head.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)].map(m => cells(m[1]));
  const periods = [];
  let col = 0;
  for (const c of headRows[0] ?? []) {
    if (col > 0) periods.push({ label: c.text.replace(/\s+/g, ' '), columns: Array.from({ length: c.span }, (_, i) => col + i) });
    col += c.span;
  }
  const body = /<TBODY\b[^>]*>([\s\S]*?)<\/TBODY>/i.exec(finance[2])?.[1] ?? finance[2];
  const rows = [];
  for (const m of body.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)) {
    const row = cells(m[1]);
    if (!row.length || !row[0].text) continue;
    const raw = [];
    row.forEach(c => { for (let i = 0; i < c.span; i++) raw.push(i ? '' : c.text); });
    const values = {};
    for (const p of (periods.length ? periods : [{ label: 'value', columns: raw.slice(1).map((_, i) => i + 1) }])) {
      const filled = p.columns.map(i => raw[i]).filter(v => v !== undefined && v !== '');
      values[p.label] = filled.length ? parseAmount(filled.at(-1)) : null;
    }
    rows.push({ account: row[0].text, code: row[0].code, level: row[0].level === undefined ? null : Number(row[0].level), values, raw: raw.slice(1) });
  }
  return { unit, as_of, periods: periods.map(p => p.label), rows };
}

/** Statement sections in one filing file, by key (bs, is, ce, cf). The consolidated report titles carry 연결. */
export function findStatementSections(xml, { consolidated = false } = {}) {
  const found = {};
  for (const sec of documentSections(xml)) {
    const t = squash(sec.title).replace(/^\(?첨부\)?/, '');
    if (consolidated !== t.startsWith('연결')) continue;
    const bare = t.replace(/^연결/, '');
    for (const [key, spec] of Object.entries(STATEMENTS)) {
      if (!found[key] && spec.titles.some(title => bare === title || bare.endsWith(title) && bare.length <= title.length + 4)) found[key] = sec;
    }
  }
  return found;
}
