import test from 'node:test';
import assert from 'node:assert/strict';
import {
  articleLines, lawArticles, annexesOf, boxTables, parseAnnexRef, extractCitations, compareArticleMaps, markChanges,
  amendmentRows, addendaOf, addendaProvisions, adminRuleUnits, adminArticleLabel, markdownTable,
} from './law-parse.mjs';

// Shapes follow real 법제처 JSON (법원설치법 MST 284429, 개인정보의 안전성 확보조치 기준, checked 2026-11-03).
const unit = {
  조문번호: '2', 조문가지번호: '', 조문여부: '조문', 조문제목: '설치', 조문내용: '제2조(설치)',
  항: [
    { 항번호: '①', 항내용: '① 고등법원을 별표 1과 같이 설치한다.' },
    { 항번호: '②', 항내용: '② 다음 각 호를 둔다.', 호: [{ 호번호: '1.', 호내용: '1. 시법원', 목: { 목번호: '가.', 목내용: '가. 서울' } }, { 호번호: '2.', 호내용: '2. 군법원' }] },
  ],
};

test('articles flatten into keyed 항·호·목 lines', () => {
  assert.deepEqual(articleLines(unit).map(l => l.key), ['', '①', '②', '②|1.', '②|1.|가.', '②|2.']);
  const map = lawArticles({ 법령: { 조문: { 조문단위: [{ 조문여부: '전문', 조문내용: '제1장 총칙' }, unit, { ...unit, 조문가지번호: '2', 항: undefined, 조문내용: '제2조의2(특례) 본문' }] } } });
  assert.deepEqual([...map.keys()], ['제2조', '제2조의2']);
  assert.equal(map.get('제2조의2').lines[0].text, '제2조의2(특례) 본문');
});

const tableLines = [
  '【별표】 위험을 감소시킬 수 있는 보호조치 예시 (제6조의2 관련)',
  '┌───────────────┬───────────────┐',
  '│구분                          │보호조치 예시                │',
  '├───────────────┼───────────────┤',
  '│1. 개인정보 파일을 다운로     │◇ 안전한 인증수단 적용      │',
  '│드 할 수 있는 컴퓨터          │◇ 다운로드 건수 제한        │',
  '├───────────────┴───────────────┤',
  '│※ 예시는 선별 적용할 수 있음                                │',
  '└───────────────────────────────┘',
];

test('box-drawing annex tables become rows and wrapped Hangul words are rejoined', () => {
  const [table] = boxTables(tableLines);
  assert.deepEqual(table.rows[0], ['구분', '보호조치 예시']);
  assert.equal(table.rows[1][0], '1. 개인정보 파일을 다운로드 할 수 있는 컴퓨터');
  assert.equal(table.rows[1][1], '◇ 안전한 인증수단 적용 ◇ 다운로드 건수 제한');
  assert.deepEqual(table.rows[2], ['※ 예시는 선별 적용할 수 있음']);
});

test('a cell spanning several rows is carried into each row (법원설치법 별표 3 layout)', () => {
  const [table] = boxTables([
    '┏━━┯━━━┯━━━━━━┓',
    '┃고등│지방  │관할구역    ┃',
    '┃법원│법원  │            ┃',
    '┠──┼───┼──────┨',
    '┃서울│서울  │종로구·관악 ┃',
    '┃    │중앙  │구          ┃',
    '┃    ├───┼──────┨',
    '┃    │서울  │성동구      ┃',
    '┃    │동부  │            ┃',
    '┠──┼───┼──────┨',
    '┃대전│대전  │대전광역시  ┃',
    '┗━━┷━━━┷━━━━━━┛',
  ]);
  assert.deepEqual(table.rows, [['고등법원', '지방법원', '관할구역'], ['서울', '서울중앙', '종로구·관악구'], ['서울', '서울동부', '성동구'], ['대전', '대전', '대전광역시']]);
});

test('annex units keep text, related article and file links', () => {
  const [annex] = annexesOf({ 법령: { 별표: { 별표단위: { 별표번호: '0003', 별표가지번호: '02', 별표구분: '별표', 별표제목: '과태료 부과기준(제38조 관련)',
    별표내용: [tableLines], 별표서식파일링크: '/LSW/flDownload.do?flSeq=1', 별표서식PDF파일링크: '/LSW/flDownload.do?flSeq=2' } } } });
  assert.equal(annex.label, '별표 3의2');
  assert.equal(annex.related_article, '제38조');
  assert.equal(annex.has_text, true);
  assert.equal(annex.files.pdf, '/LSW/flDownload.do?flSeq=2');
  assert.deepEqual(parseAnnexRef('별표 3의2'), { kind: '별표', number: 3, branch: 2 });
  assert.deepEqual(parseAnnexRef('4'), { kind: null, number: 4, branch: 0 });
  assert.equal(parseAnnexRef('부칙'), null);
});

test('citations: quoted and bare law articles and case numbers, in order, without 같은 법', () => {
  const found = extractCitations('「개인정보 보호법」 제29조제1항에 따라, 민법 제750조와 같은 법 제751조, 대법원 2013다61381 판결 및 2019헌바123 결정. 민법 제750조 재인용');
  assert.deepEqual(found.map(f => f.type === 'case' ? f.case_number : `${f.law_name} ${f.article}${f.paragraph ?? ''}`),
    ['개인정보 보호법 제29조제1항', '민법 제750조', '2013다61381', '2019헌바123']);
});

test('article comparison reports added, deleted and changed articles with marked words', () => {
  const art = (label, title, ...texts) => [label, { label, title, lines: texts.map((text, i) => ({ key: String(i), text })) }];
  const before = new Map([art('제1조', '목적', '제1조(목적) 이 법은 A를 정한다.'), art('제2조', '정의', '제2조(정의) 정의한다.'), art('제3조', '특례', '제3조(특례) 특례')]);
  const after = new Map([art('제1조', '목적', '제1조(목적) 이 법은 B를 정한다.'), art('제2조', '정의', '제2조(정의) 정의한다.'), art('제3조', '', '제3조 삭제 <2026.1.1>'), art('제4조', '신설', '제4조(신설) 새 조문')]);
  const diff = compareArticleMaps(before, after);
  assert.deepEqual(diff.deleted.map(d => d.article), ['제3조']);
  assert.deepEqual(diff.added.map(d => d.article), ['제4조']);
  assert.equal(diff.unchanged, 1);
  assert.equal(diff.changed[0].changes[0].new_marked, '제1조(목적) 이 법은 <u>B를</u> 정한다.');
  assert.deepEqual(markChanges('3년 이하의 징역', '5년 이하의 징역'), { old: '<u>3년</u> 이하의 징역', new: '<u>5년</u> 이하의 징역' });
});

const current = [
  { key: '', text: '제5조(신고)' }, { key: '①', text: '① 누구든지 신고할 수 있다.' }, { key: '②', text: '② 신고는 서면으로 한다.' },
  { key: '③', text: '③ 기한은 30일로 한다.' }, { key: '④', text: '④ 그 밖의 사항은 대통령령으로 정한다.' },
];

test('신구조문대비표 follows 생략·현행과 같음·신설·삭제 conventions', () => {
  const { rows, warnings, status } = amendmentRows('제5조', current, '제5조(신고) ① (현행과 같음)\n② ∼ ③ (현행과 같음)\n④ 그 밖의 사항은 총리령으로 정한다.\n⑤ 신고 결과는 통지한다.');
  assert.equal(status, 'amended');
  assert.deepEqual(warnings, []);
  assert.deepEqual(rows, [
    { current: '제5조(신고)', proposed: '제5조 (현행과 같음)' },
    { current: '① ∼ ③ (생 략)', proposed: '① ∼ ③ (현행과 같음)' },
    { current: '④ 그 밖의 사항은 <u>대통령령으로</u> 정한다.', proposed: '④ 그 밖의 사항은 <u>총리령으로</u> 정한다.' },
    { current: '<신 설>', proposed: '<u>⑤ 신고 결과는 통지한다.</u>' },
  ]);
  const omitted = amendmentRows('제5조', current, '제5조(신고) ① (현행과 같음)\n② 신고는 전자문서로도 한다.\n③ 삭제\n④ (현행과 같음)');
  assert.deepEqual(omitted.warnings, []);
  assert.deepEqual(omitted.rows[3], { current: '<u>③ 기한은 30일로 한다.</u>', proposed: '③ 삭제' });
  const missing = amendmentRows('제5조', current, '제5조(신고) ① (현행과 같음)\n② 신고는 전자문서로도 한다.');
  assert.equal(missing.warnings.length, 2, 'unmentioned ③ and ④ are read as deleted and reported');
  assert.equal(amendmentRows('제9조', [], '제9조(특례) 특례를 둔다.').rows[0].current, '<신 설>');
  assert.equal(amendmentRows('제5조', current, '제5조 삭제').status, 'deleted');
  assert.match(markdownTable(rows), /^\| 현 행 \| 개 정 안 \|/);
});

test('addenda are tagged as 시행일·적용례·경과조치 and article mentions are found', () => {
  const addenda = addendaOf({ 법령: { 부칙: { 부칙단위: [
    { 부칙공포일자: '20200101', 부칙공포번호: '1', 부칙내용: [['부칙 <제1호,2020.1.1>', '이 법은 공포한 날부터 시행한다.']] },
    { 부칙공포일자: '20250101', 부칙공포번호: '2', 부칙내용: [['부칙 <제2호,2025.1.1>', '제1조(시행일) 이 법은 2025년 7월 1일부터 시행한다.', '제2조(적용례) 제5조의 개정규정은 이 법 시행 이후 신고하는 경우부터 적용한다.', '제3조(경과조치) 이 법 시행 전의 신고는 종전의 규정에 따른다.', '제4조 다른 법률의 개정']] },
  ] } } });
  assert.deepEqual(addenda.map(a => a.promulgated), ['20250101', '20200101']);
  const provisions = addendaProvisions(addenda[0].lines, '제5조');
  assert.deepEqual(provisions.map(p => p.kind), ['effective_date', 'application', 'transitional', 'other']);
  assert.deepEqual(provisions.map(p => p.mentions_article), [false, true, false, false]);
  const adm = addendaOf({ AdmRulService: { 부칙: { 부칙공포일자: ['20200811', '20260701'], 부칙공포번호: ['2020-2', '2026-9'], 부칙내용: ['부칙 a', '부칙 b'] } } });
  assert.deepEqual(adm.map(a => a.number), ['2026-9', '2020-2']);
});

test('admin rule text splits into chapters and articles, including 제9-5조 labels', () => {
  const units = adminRuleUnits({ AdmRulService: { 조문내용: ['제4편 영업', '제1장 총칙', '제1조(목적) 목적', '제9-5조(특례) 특례', '제2장 보칙', '제10조의2(위임) 위임'] } });
  assert.deepEqual(units.filter(u => u.type === 'article').map(u => [u.label, u.part, u.chapter]),
    [['제1조', '제4편', '제1장'], ['제9-5조', '제4편', '제1장'], ['제10조의2', '제4편', '제2장']]);
  assert.equal(adminArticleLabel('9-5'), '제9-5조');
  assert.equal(adminArticleLabel('제10조의2'), '제10조의2');
});
