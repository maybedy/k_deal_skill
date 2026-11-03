import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchLawTool, LAW_TOOL_DEFINITIONS, ALL_LAW_TOOL_DEFINITIONS } from './law-tools.mjs';

const OC = 'test-oc-secret';
const env = { LAW_OC: OC };
const NOW = () => Date.parse('2026-11-03T01:00:00Z');

/* A small fake 법제처: 테스트법 (ID 000001) has three versions. 제5조 changes in 2026; 제6조 is new in 2026. */
const VERSIONS = [
  { 법령일련번호: '400', 시행일자: '20270101', 공포일자: '20260601', 현행연혁코드: '시행예정', 법령명한글: '테스트법' },
  { 법령일련번호: '300', 시행일자: '20260101', 공포일자: '20251201', 현행연혁코드: '현행', 법령명한글: '테스트법' },
  { 법령일련번호: '200', 시행일자: '20230101', 공포일자: '20221201', 현행연혁코드: '연혁', 법령명한글: '테스트법' },
];
const art = (n, title, ...hang) => ({ 조문번호: String(n), 조문여부: '조문', 조문제목: title, 조문내용: `제${n}조(${title})`,
  항: hang.map((text, i) => ({ 항번호: '①②③'[i], 항내용: text })) });
function body(mst) {
  const units = [art(1, '목적', '① 이 법은 신고를 정한다.')];
  units.push(mst === '200' ? art(5, '신고', '① 누구든지 신고할 수 있다.', '② 신고는 서면으로 한다.')
    : art(5, '신고', '① 누구든지 신고할 수 있다.', '② 신고는 서면 또는 전자문서로 한다.'));
  if (mst !== '200') units.push(art(6, '통지', '① 결과를 통지한다.'));
  const addenda = [{ 부칙공포일자: '20221201', 부칙공포번호: '1', 부칙내용: [['부칙 <제1호,2022.12.1>', '이 법은 2023년 1월 1일부터 시행한다.']] }];
  if (mst !== '200') addenda.push({ 부칙공포일자: '20251201', 부칙공포번호: '2', 부칙내용: [['부칙 <제2호,2025.12.1>', '제1조(시행일) 이 법은 2026년 1월 1일부터 시행한다.', '제2조(적용례) 제5조제2항의 개정규정은 이 법 시행 이후 하는 신고부터 적용한다.', '제3조(다른 법률의 개정) 생략']] });
  if (mst === '400') addenda.push({ 부칙공포일자: '20260601', 부칙공포번호: '3', 부칙내용: [['부칙 <제3호,2026.6.1>', '제2조(경과조치) 이 법 시행 전에 한 통지는 종전의 규정에 따른다.']] });
  return { 법령: { 기본정보: { 법령ID: '000001', 법령명_한글: '테스트법', 공포일자: VERSIONS.find(v => v.법령일련번호 === mst).공포일자, 시행일자: VERSIONS.find(v => v.법령일련번호 === mst).시행일자 },
    조문: { 조문단위: units }, 부칙: { 부칙단위: addenda },
    별표: { 별표단위: [
      { 별표번호: '0001', 별표가지번호: '00', 별표구분: '별표', 별표제목: '수수료(제5조 관련)', 별표내용: [['┌──┬──┐', '│구분│금액│', '├──┼──┤', '│신고│1,000원│', '└──┴──┘']],
        별표서식파일링크: `/LSW/flDownload.do?flSeq=11&OC=${OC}`, 별표서식PDF파일링크: '/LSW/flDownload.do?flSeq=12' },
      { 별표번호: '0001', 별표가지번호: '00', 별표구분: '서식', 별표제목: '신고서', 별표내용: [], 별표서식파일링크: '/LSW/flDownload.do?flSeq=13' },
    ] } } };
}
const only = (data, jo) => {
  const n = Number(jo.slice(0, 4));
  return { 법령: { ...data.법령, 조문: { 조문단위: data.법령.조문.조문단위.filter(u => Number(u.조문번호) === n) } } };
};

function fakeLaw(extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const p = Object.fromEntries(u.searchParams);
    calls.push({ url: String(url), params: p, init });
    const json = data => new Response(JSON.stringify(data));
    if (u.hostname === 'taxlaw.nts.go.kr') return extra.taxlaw ? extra.taxlaw(init) : json({ status: 'SUCCESS', data: { ASIQTB002PR01: { dcmDVO: null } } });
    const route = `${u.pathname.split('/').pop()}:${p.target}`;
    if (extra[route]) return json(extra[route](p));
    if (route === 'lawSearch.do:law') {
      const law = { 법령명한글: '테스트법', 법령약칭명: '', 법령ID: '000001', 법령일련번호: '300', 공포일자: '20251201', 시행일자: '20260101' };
      return json({ LawSearch: { totalCnt: '2', law: p.query === '테스트법' ? [law, { ...law, 법령명한글: '테스트법 시행령', 법령ID: '000002', 법령일련번호: '301' }] : [] } });
    }
    if (route === 'lawSearch.do:eflaw') {
      const rows = p.nw === '3' ? VERSIONS.filter(v => v.현행연혁코드 === '시행예정') : VERSIONS;
      return json({ LawSearch: { totalCnt: String(rows.length), law: rows } });
    }
    if (route === 'lawService.do:eflaw' || route === 'lawService.do:law') {
      const mst = p.MST ?? '300';
      return json(p.JO ? only(body(mst), p.JO) : body(mst));
    }
    return json({});
  };
  return { calls, options: { fetchImpl, sleep: async () => {}, now: NOW } };
}
const run = (name, args, fake = fakeLaw()) => dispatchLawTool(name, args, env, fake.options).then(out => ({ out, calls: fake.calls }));
function noSecret(out, calls) {
  assert.ok(!JSON.stringify(out).includes(OC), 'the OC never appears in output');
  assert.ok(calls.every(c => c.url.startsWith('https://www.law.go.kr/DRF/') || c.url.startsWith('https://taxlaw.nts.go.kr/')));
}

test('analysis tools are offered next to the lookup tools; /law keeps only the lookup tools', () => {
  assert.equal(LAW_TOOL_DEFINITIONS.length, 6);
  assert.equal(ALL_LAW_TOOL_DEFINITIONS.length, 17);
  assert.ok(ALL_LAW_TOOL_DEFINITIONS.every(t => t.name.startsWith('law_') && t.inputSchema.additionalProperties === false));
});

test('law_applicable finds the version in force on the date and later 적용례·경과조치', async () => {
  const { out, calls } = await run('law_applicable', { law_name: '테스트법', date: '20230601', article: '제5조' });
  assert.equal(out.status, 'ok');
  assert.equal(out.data.version_then.mst, '200');
  assert.equal(out.data.version_now.mst, '300');
  assert.equal(out.data.version_latest.mst, '400');
  assert.deepEqual(out.data.later_versions.map(v => v.mst), ['300', '400']);
  assert.deepEqual(out.data.later_addenda.map(a => a.number), ['3', '2'], 'only addenda promulgated after the version in force');
  const application = out.data.later_addenda[1].provisions.find(p => p.kind === 'application');
  assert.equal(application.mentions_article, true);
  assert.ok(!out.data.later_addenda[1].provisions.some(p => p.text.includes('다른 법률의 개정')), 'unrelated addenda lines are left out');
  assert.equal(out.data.article.changed_since, true);
  assert.equal(out.data.article.changes[0].op, 'change');
  assert.equal(out.metadata.upstream_calls, calls.length);
  assert.equal(calls.length, 4);
  noSecret(out, calls);
});

test('law_compare_dates diffs the versions in force on two dates', async () => {
  const { out } = await run('law_compare_dates', { law_id: '000001', from_date: '20230601', to_date: '20260601' });
  assert.equal(out.data.from.mst, '200');
  assert.equal(out.data.to.mst, '300');
  assert.deepEqual(out.data.articles.changed.map(c => c.article), ['제5조']);
  assert.deepEqual(out.data.articles.added.map(c => c.article), ['제6조']);
  assert.equal(out.data.articles.changed[0].changes[0].new_marked, '② 신고는 <u>서면 또는 전자문서로</u> 한다.');
  const same = await run('law_compare_dates', { law_id: '000001', from_date: '20260201', to_date: '20260601' });
  assert.equal(same.out.data.same_version, true);
  const bad = await run('law_compare_dates', { law_id: '000001', from_date: '20260601', to_date: '20260101' });
  assert.equal(bad.out.metadata.error.code, 'invalid_input');
});

test('law_annexes returns one annex with text, table and absolute links without the OC', async () => {
  const { out, calls } = await run('law_annexes', { law_id: '000001', annex: '별표 1' });
  assert.equal(out.data.annexes.length, 1);
  const [annex] = out.data.annexes;
  assert.equal(annex.related_article, '제5조');
  assert.deepEqual(annex.tables[0].rows, [['구분', '금액'], ['신고', '1,000원']]);
  assert.equal(annex.files.pdf, 'https://www.law.go.kr/LSW/flDownload.do?flSeq=12');
  noSecret(out, calls);
  const listed = await run('law_annexes', { law_id: '000001' });
  assert.equal(listed.out.data.annexes.length, 2);
  assert.equal(listed.out.data.annexes[1].has_text, false);
  const dated = await run('law_annexes', { law_name: '테스트법', date: '20230601', query: '수수료' });
  assert.equal(dated.out.data.version.mst, '200');
  assert.equal(dated.calls.at(-1).params.efYd, '20230101');
});

test('law_amendment_table fetches the current article and builds the table', async () => {
  const { out, calls } = await run('law_amendment_table', { law_id: '000001', title: '테스트법 일부개정법률안',
    amendments: [{ text: '제5조(신고) ① (현행과 같음)\n② 신고는 전자문서로 한다.' }, { text: '제9조(특례) 특례를 둔다.' }] });
  assert.equal(out.status, 'ok');
  assert.equal(calls.filter(c => c.params.JO).length, 2);
  assert.deepEqual(out.data.articles.map(a => a.status), ['amended', 'new']);
  assert.match(out.data.markdown, /^테스트법 일부개정법률안\n\n\| 현 행 \| 개 정 안 \|/);
  const own = await run('law_amendment_table', { amendments: [{ article: '제3조', current_text: '제3조(정의) ① 갑\n② 을', text: '제3조(정의) ① (현행과 같음)\n② 병' }] });
  assert.equal(own.calls.length, 0, 'current_text needs no source call');
  assert.equal(own.out.data.articles[0].rows.at(-1).proposed, '② <u>병</u>');
});

test('law_verify_citations separates existing, missing and malformed citations', async () => {
  const fake = fakeLaw({ 'lawSearch.do:prec': p => ({ PrecSearch: { totalCnt: '1', prec: p.nb === '2013다61381' ? [{ 사건번호: '2013다61381', 사건명: '손해배상', 법원명: '대법원', 선고일자: '20140101', 판례일련번호: '9' }] : [] } }) });
  const { out, calls } = await run('law_verify_citations', { text: '「테스트법」 제5조제2항, 「테스트법」 제5조제3항, 테스트법 제99조, 「없는법」 제1조, 2013다61381, 2020다1' }, fake);
  assert.deepEqual(out.data.citations.map(c => c.status), ['verified', 'paragraph_not_found', 'article_not_found', 'law_not_found', 'verified', 'not_found']);
  assert.equal(calls.filter(c => c.params.target === 'law' && c.params.query === '테스트법').length, 1, 'a law name is resolved once');
  assert.equal(out.data.summary.verified, 2);
  noSecret(out, calls);
});

test('law_cite_check lists later decisions that cite the case and flags 변경 wording', async () => {
  const fake = fakeLaw({
    'lawSearch.do:prec': p => p.nb ? { PrecSearch: { totalCnt: '1', prec: [{ 사건번호: '2013다61381', 사건명: '손해배상', 법원명: '대법원', 선고일자: '20140101', 판례일련번호: '9' }] } }
      : { PrecSearch: { totalCnt: '3', prec: [{ 사건번호: '2013다61381', 판례일련번호: '9', 선고일자: '20140101' }, { 사건번호: '2020다1', 판례일련번호: '10', 선고일자: '20200101' }, { 사건번호: '2022다2', 판례일련번호: '11', 선고일자: '20220101' }] } },
    'lawService.do:prec': p => ({ PrecService: { 판례내용: p.ID === '11' ? '대법원 2013다61381 판결은 이와 저촉되는 범위에서 변경한다. 끝.' : '대법원 2013다61381 판결 참조. 끝.' } }),
  });
  const { out } = await run('law_cite_check', { case_number: '2013다61381' }, fake);
  assert.equal(out.data.case.court, '대법원');
  assert.equal(out.data.citing_total, 2);
  assert.deepEqual(out.data.citing.map(c => c.case_number), ['2022다2', '2020다1']);
  assert.deepEqual(out.data.scanned.map(s => s.treatment), ['possibly_overruled_or_modified', 'cited']);
  const bad = await run('law_cite_check', { case_number: '아무말' });
  assert.equal(bad.out.metadata.error.code, 'invalid_input');
});

test('law_impact_map gathers delegations, cited laws, decisions, rules and linked ordinances', async () => {
  const fake = fakeLaw({
    'lawService.do:lsDelegated': () => ({ lsDelegated: { 법령: { 위임조문정보: [{ 조정보: { 조문번호: '5', 조문제목: '신고' }, 위임정보: [
      { 위임법령제목: '테스트법 시행령', 위임법령일련번호: '301', 위임구분: '시행령', 위임법령조문정보: { 라인텍스트: '대통령령으로 정한다', 위임법령조문번호: '3', 조항호목: '제5조제2항', 링크텍스트: '대통령령', 위임법령조문제목: '신고 방법' } },
      { 위임법령제목: ['민법', '상법'], 위임법령일련번호: ['1', '2'], 위임구분: ['인용법령', '인용법령'], 위임법령조문정보: [{ 라인텍스트: '「상법」 제1조', 위임법령조문번호: '1', 조항호목: '제5조제1항', 링크텍스트: '「상법」' }] },
    ] }, { 조정보: { 조문번호: '6' }, 위임정보: { 위임법령제목: '기타', 위임구분: '시행령', 위임법령조문정보: { 위임법령조문번호: '9' } } }] } } }),
    'lawSearch.do:prec': () => ({ PrecSearch: { totalCnt: '12', prec: [{ 사건번호: '2020다1', 판례일련번호: '10' }] } }),
    'lawSearch.do:expc': () => ({ Expc: { totalCnt: '3', expc: [{ 안건번호: '20-0001', 안건명: '신고 해석' }] } }),
    'lawSearch.do:admrul': () => ({ AdmRulSearch: { totalCnt: '0' } }),
    'lawSearch.do:lnkLsOrdJo': p => { assert.deepEqual([p.JO, p.JOBR], ['0005', '00']); return { lnkOrdJoSearch: { totalCnt: '2', law: [{ 법령명한글: '테스트법', 자치법규명: '가 조례', 자치법규조번호: '제3조' }, { 법령명한글: '테스트법 시행령', 자치법규명: '나 조례' }] } }; },
  });
  const { out } = await run('law_impact_map', { law_id: '000001', article: '제5조', mermaid: true }, fake);
  assert.deepEqual(out.data.delegated_rules.map(r => [r.law, r.article, r.clause]), [['테스트법 시행령', '제3조', '제5조제2항']]);
  assert.deepEqual(out.data.cited_laws.map(r => r.law), ['상법']);
  assert.equal(out.data.precedents.total, 12);
  assert.equal(out.data.interpretations.total, 3);
  assert.deepEqual(out.data.ordinances.top.map(o => o.name), ['가 조례'], 'ordinances linked to another law are left out');
  assert.match(out.data.mermaid, /^graph LR/);
  assert.equal(out.metadata.upstream_calls, 6);
});

test('law_ordinance_radar flags cited laws amended after the ordinance', async () => {
  const fake = fakeLaw({
    'lawSearch.do:ordin': () => ({ OrdinSearch: { totalCnt: '1', law: [{ 자치법규명: '가시 신고 조례', 자치법규일련번호: '77' }] } }),
    'lawService.do:ordin': () => ({ LawService: { 자치법규기본정보: { 자치법규명: '가시 신고 조례', 공포일자: '20240101', 시행일자: '20240101', 지자체기관명: '가시' },
      조문: { 조: [{ 조문번호: '000100', 조제목: '목적', 조내용: '이 조례는 「테스트법」 제5조와 「없는법」에 따라 정한다.' }] } } }),
  });
  const { out } = await run('law_ordinance_radar', { ordinance_name: '가시 신고 조례' }, fake);
  const [law, missing] = out.data.laws;
  assert.equal(law.amended_after_ordinance, true);
  assert.deepEqual(law.upcoming.map(v => v.mst), ['400']);
  assert.equal(missing.status, 'not_found_as_law');
  assert.deepEqual(out.data.review_needed, ['테스트법']);
});

test('law_bulk_check reports MST changes against the previous snapshot and is not cached', async () => {
  const { out } = await run('law_bulk_check', { queries: ['테스트법', '없는법'], previous: { '000001': '200' }, include_upcoming: true });
  assert.equal(out.data.results[0].changed, true);
  assert.deepEqual(out.data.results[0].upcoming.map(v => v.mst), ['400']);
  assert.equal(out.data.results[1].status, 'law_not_found');
  assert.deepEqual(out.data.snapshot, { '000001': '300' });
  assert.deepEqual(out.data.changed, ['테스트법']);
});

test('law_admin_rule returns one article with context, a chapter or keyword hits', async () => {
  const rule = { AdmRulService: { 행정규칙기본정보: { 행정규칙명: '테스트 고시', 행정규칙일련번호: '2100000000001', 현행여부: 'Y' },
    조문내용: ['제1장 총칙', '제1조(목적) 목적', '제2조(정의) 정의', '제2장 기준', '제3조(기준) 암호화 기준', '제4조(점검) 점검'],
    부칙: { 부칙공포일자: ['20260101'], 부칙공포번호: ['2026-1'], 부칙내용: ['부칙 이 고시는 발령한 날부터 시행한다.'] } } };
  const fake = fakeLaw({ 'lawService.do:admrul': () => rule });
  const one = await run('law_admin_rule', { id: '2100000000001', article: '제2조', context: 1 }, fake);
  assert.deepEqual(one.out.data.units.map(u => u.label), ['제1조', '제2조', '제3조']);
  const chapter = await run('law_admin_rule', { id: '2100000000001', chapter: '제2장' }, fake);
  assert.deepEqual(chapter.out.data.units.map(u => u.label), ['제2장', '제3조', '제4조']);
  const keyword = await run('law_admin_rule', { id: '2100000000001', keyword: '암호화' }, fake);
  assert.deepEqual(keyword.out.data.units.map(u => u.label), ['제3조']);
  assert.equal(keyword.out.data.recent_addenda[0].number, '2026-1');
  const both = await run('law_admin_rule', { id: '2100000000001', article: '제2조', keyword: 'x' }, fake);
  assert.equal(both.out.metadata.error.code, 'invalid_input');
});

test('국세청 해석: search hits get the taxlaw id, the text comes from 국세법령정보시스템', async () => {
  const id = '000000000000123456';
  const posted = [];
  const fake = fakeLaw({
    'lawSearch.do:ntsCgmExpc': () => ({ CgmExpc: { totalCnt: '1', cgmExpc: [{ 안건명: '부가세 질의', 법령해석상세링크: `https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=${id}` }] } }),
    taxlaw: init => {
      posted.push(new URLSearchParams(init.body));
      return new Response(JSON.stringify({ status: 'SUCCESS', data: { ASIQTB002PR01: { dcmDVO: { ntstDcmTtl: '부가세 질의', ntstDcmCntn: '<p>과세됩니다.</p>', ntstDcmGistCntn: '요지', ntstDcmRgtDt: '20240101' },
        dcmHwpEditorDVOList: [{ dcmFleByte: '<div>사실관계: 갑은 용역을 공급하였다. 질의: 과세 여부</div>' }] } } }));
    },
  });
  const search = await run('law_decisions_search', { domain: 'nts', query: '부가세' }, fake);
  assert.equal(search.out.data.CgmExpc.cgmExpc[0].본문조회ID, id);
  const text = await run('law_decision_text', { domain: 'nts', id }, fake);
  assert.equal(text.out.status, 'ok');
  assert.equal(text.out.data.회신, '과세됩니다.');
  assert.match(text.out.data.본문, /^사실관계/);
  assert.equal(posted[0].get('actionId'), 'ASIQTB002PR01');
  assert.deepEqual(JSON.parse(posted[0].get('paramData')), { dcmDVO: { ntstDcmId: id } });
  assert.ok(!fake.calls.find(c => c.url.startsWith('https://taxlaw')).url.includes(OC), 'the OC is never sent to taxlaw');
  const missing = await run('law_decision_text', { domain: 'nts', id });
  assert.equal(missing.out.metadata.error.code, 'not_found');
  const serial = await run('law_decision_text', { domain: 'nts', id: '12345' });
  assert.equal(serial.out.metadata.error.code, 'invalid_input');
  const mois = await run('law_decisions_search', { domain: 'mois', query: '취득세' });
  assert.equal(mois.calls[0].params.target, 'moisCgmExpc');
});

test('inputs are checked before any call and one request cannot fan out without bound', async () => {
  for (const [name, args] of [
    ['law_annexes', { law_id: '000001', law_name: '테스트법' }], ['law_annexes', {}], ['law_applicable', { law_id: '000001', date: '20230231' }],
    ['law_bulk_check', { queries: [] }], ['law_ordinance_radar', {}], ['law_amendment_table', { amendments: [{ text: 'x' }] }],
    ['law_verify_citations', { text: 'x', apiKey: 'y' }],
  ]) {
    const { out, calls } = await run(name, args);
    assert.equal(out.metadata.error.code, 'invalid_input', `${name} ${JSON.stringify(args)}`);
    assert.equal(calls.length, 0);
  }
  const fake = fakeLaw();
  const capped = await dispatchLawTool('law_applicable', { law_id: '000001', date: '20230601' }, env, { ...fake.options, maxCalls: 1 });
  assert.equal(capped.metadata.error.code, 'call_budget');
  assert.equal(fake.calls.length, 1);
  const noKey = await dispatchLawTool('law_applicable', { law_id: '000001', date: '20230601' }, {}, fake.options);
  assert.equal(noKey.metadata.error.code, 'not_connected');
});
