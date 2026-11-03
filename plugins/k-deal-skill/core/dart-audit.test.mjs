import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditReportName, pickAuditReport, parseAmount, parseStatementTable, findStatementSections } from './dart-audit.mjs';
import { dispatchExtraTool } from './extra-tools.mjs';

const BS = `<SECTION-1><LIBRARY><TABLE-GROUP ACLASS="PBS-2:A">
<TITLE ATOC="Y" ATOCID="3">재 무 상 태 표</TITLE>
<TABLE ACLASS="EXTRACTION"><TBODY>
<TR><TD COLSPAN="2">제 21(당)기 2024년 12월 31일 현재</TD></TR>
<TR><TD COLSPAN="2">제 20(전)기 2023년 12월 31일 현재</TD></TR>
<TR><TD>주식회사 예시</TD><TU AUNIT="WON" AUNITVALUE="1">(단위 : 원)</TU></TR>
</TBODY></TABLE>
<TABLE ACLASS="FINANCE"><THEAD>
<TR><TH>과 목</TH><TH COLSPAN="2">제 21(당) 기</TH><TH COLSPAN="2">제 20(전) 기</TH></TR>
</THEAD><TBODY>
<TR><TE ACODE="11000000000000" ADELIM="0" ALEVEL="0">자 산</TE><TE ADELIM="1"></TE><TE ADELIM="2"></TE><TE ADELIM="3"></TE><TE ADELIM="4"></TE></TR>
<TR><TE ACODE="11200000040000" ADELIM="0" ALEVEL="0">Ⅰ. 유동자산</TE><TE ADELIM="1"></TE><TE ADELIM="2">33,629,456,356</TE><TE ADELIM="3"></TE><TE ADELIM="4">22,046,820,526</TE></TR>
<TR><TE ACODE="11130000030000" ADELIM="0" ALEVEL="1">현금및현금성자산</TE><TE ADELIM="1">1,000</TE><TE ADELIM="2"></TE><TE ADELIM="3">(2,500)</TE><TE ADELIM="4"></TE></TR>
<TR><TE ADELIM="0">미수금</TE><TE ADELIM="1">-</TE><TE ADELIM="2"></TE><TE ADELIM="3"></TE><TE ADELIM="4"></TE></TR>
</TBODY></TABLE></TABLE-GROUP></LIBRARY></SECTION-1>`;
const IS = `<SECTION-1><TITLE ATOC="Y" ATOCID="4">손 익 계 산 서</TITLE>
<TABLE ACLASS="EXTRACTION"><TBODY><TR><TD>예시</TD><TU AUNIT="THOUSAND" AUNITVALUE="1">(단위 : 천원)</TU></TR></TBODY></TABLE>
<TABLE ACLASS="FINANCE"><THEAD><TR><TH>과 목</TH><TH>당기</TH><TH>전기</TH></TR></THEAD><TBODY>
<TR><TE ACODE="41000000000000" ADELIM="0">매출액</TE><TE ADELIM="1">12,345</TE><TE ADELIM="2">10,000</TE></TR>
</TBODY></TABLE></SECTION-1>`;

test('audit report names, newest correction and fiscal year matching', () => {
  assert.deepEqual(parseAuditReportName('감사보고서 (2024.12)'), { corrected: false, consolidated: false, year: 2024, month: '12' });
  assert.deepEqual(parseAuditReportName('[기재정정]연결감사보고서 (2024.03)'), { corrected: true, consolidated: true, year: 2024, month: '03' });
  assert.equal(parseAuditReportName('사업보고서 (2024.12)'), null);
  const rows = [
    { report_nm: '감사보고서 (2023.12)', rcept_no: '20240401000001' },
    { report_nm: '감사보고서 (2024.12)', rcept_no: '20250404000675' },
    { report_nm: '[기재정정]감사보고서 (2024.12)', rcept_no: '20250510000002' },
    { report_nm: '연결감사보고서 (2024.12)', rcept_no: '20250404000676' },
  ];
  assert.equal(pickAuditReport(rows, { year: 2024 }).rcept_no, '20250510000002');
  assert.equal(pickAuditReport(rows, { year: 2024, consolidated: true }).rcept_no, '20250404000676');
  assert.equal(pickAuditReport(rows, { year: 2022 }), null);
});

test('amounts keep sign, dash is zero and blanks stay empty', () => {
  assert.equal(parseAmount('33,629,456,356'), 33629456356);
  assert.equal(parseAmount('(2,500)'), -2500);
  assert.equal(parseAmount('-1,000'), -1000);
  assert.equal(parseAmount('-'), 0);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('주석 5'), null);
});

test('statement table reads periods, unit, codes and the subtotal column of each period', () => {
  const sections = findStatementSections(BS + IS);
  assert.deepEqual(Object.keys(sections).sort(), ['bs', 'is']);
  const bs = parseStatementTable((BS + IS).slice(sections.bs.start, sections.bs.end));
  assert.deepEqual(bs.periods, ['제 21(당) 기', '제 20(전) 기']);
  assert.equal(bs.unit.multiplier, 1);
  assert.equal(bs.as_of.length, 2);
  const current = bs.rows.find(r => r.code === '11200000040000');
  assert.equal(current.values['제 21(당) 기'], 33629456356);
  assert.equal(current.values['제 20(전) 기'], 22046820526);
  const cash = bs.rows.find(r => r.account === '현금및현금성자산');
  assert.equal(cash.level, 1);
  assert.equal(cash.values['제 20(전) 기'], -2500);
  assert.equal(bs.rows.find(r => r.account === '미수금').values['제 21(당) 기'], 0);
  const is = parseStatementTable((BS + IS).slice(sections.is.start, sections.is.end));
  assert.equal(is.unit.multiplier, 1000);
  assert.equal(is.rows[0].values['당기'], 12345);
  assert.equal(findStatementSections(BS, { consolidated: true }).bs, undefined, 'separate statements are not consolidated');
});

test('dart_audit_financials asks for a company and year or a receipt number', async () => {
  const out = await dispatchExtraTool('dart_audit_financials', {}, { DART_API_KEY: 'k' });
  assert.equal(out.error.code, 'invalid_input');
  const bad = await dispatchExtraTool('dart_audit_financials', { rcept_no: '20250404000675', statements: ['xx'] }, { DART_API_KEY: 'k' });
  assert.equal(bad.error.code, 'invalid_input');
});
