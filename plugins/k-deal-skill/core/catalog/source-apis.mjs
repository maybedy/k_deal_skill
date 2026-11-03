/** OpenDART and KRX API catalogs exposed through dart_report and krx_daily.
 * Every id was checked against the live endpoint on 2026-10-26 (DART status 000/013, KRX 200/401 vs 404 for unknown).
 * 2026-11-03: compared with the OpenDART guide (공시정보 4, 정기보고서 주요정보 30, 재무정보 7, 지분공시 2, 주요사항 36,
 * 증권신고서 6) and added astInhtrfEtcPtbkOpt, the two V2 pay APIs (reports filed from 2026-05) and xbrlTaxonomy;
 * each returned 000 or 013 on a live call. list, company, document, corpCode and fnlttSinglAcntAll are separate tools;
 * fnlttXbrl is dart_xbrl.
 */

// group: periodic = 정기보고서 주요정보 (corp_code, bsns_year, reprt_code)
//        financial = 정기보고서 재무정보 (corp_code, bsns_year, reprt_code[, idx_cl_code])
//        ownership = 지분공시 (corp_code)
//        event     = 주요사항보고서 (corp_code, bgn_de, end_de)
//        filing    = 증권신고서 주요정보 (corp_code, bgn_de, end_de)
//        taxonomy  = XBRL 표준계정과목 (sj_div, no corp_code)
export const DART_REPORTS = Object.freeze([
  ['irdsSttus', 'periodic', '증자(감자) 현황'], ['alotMatter', 'periodic', '배당에 관한 사항'],
  ['tesstkAcqsDspsSttus', 'periodic', '자기주식 취득 및 처분 현황'], ['hyslrSttus', 'periodic', '최대주주 현황'],
  ['hyslrChgSttus', 'periodic', '최대주주 변동현황'], ['mrhlSttus', 'periodic', '소액주주 현황'],
  ['exctvSttus', 'periodic', '임원 현황'], ['empSttus', 'periodic', '직원 현황'],
  ['hmvAuditIndvdlBySttus', 'periodic', '이사·감사의 개인별 보수현황'], ['hmvAuditAllSttus', 'periodic', '이사·감사 전체의 보수현황'],
  ['indvdlByPay', 'periodic', '개인별 보수지급 금액(5억 이상 상위 5인)'], ['otrCprInvstmntSttus', 'periodic', '타법인 출자현황'],
  ['hmvAuditIndvdlBySttusV2', 'periodic', '이사·감사의 개인별 보수현황 Ver 2.0(2026년 5월 이후 제출 보고서)'],
  ['indvdlByPayV2', 'periodic', '개인별 보수지급 금액 Ver 2.0(2026년 5월 이후 제출 보고서)'],
  ['stockTotqySttus', 'periodic', '주식의 총수 현황'], ['detScritsIsuAcmslt', 'periodic', '채무증권 발행실적'],
  ['entrprsBilScritsNrdmpBlce', 'periodic', '기업어음증권 미상환 잔액'], ['srtpdPsndbtNrdmpBlce', 'periodic', '단기사채 미상환 잔액'],
  ['cprndNrdmpBlce', 'periodic', '회사채 미상환 잔액'], ['newCaplScritsNrdmpBlce', 'periodic', '신종자본증권 미상환 잔액'],
  ['cndlCaplScritsNrdmpBlce', 'periodic', '조건부 자본증권 미상환 잔액'], ['accnutAdtorNmNdAdtOpinion', 'periodic', '회계감사인의 명칭 및 감사의견'],
  ['adtServcCnclsSttus', 'periodic', '감사용역 체결현황'], ['accnutAdtorNonAdtServcCnclsSttus', 'periodic', '회계감사인과의 비감사용역 계약체결 현황'],
  ['outcmpnyDrctrNdChangeSttus', 'periodic', '사외이사 및 그 변동현황'], ['unrstExctvMendngSttus', 'periodic', '미등기임원 보수현황'],
  ['drctrAdtAllMendngSttusGmtsckConfmAmount', 'periodic', '이사·감사 전체 보수(주주총회 승인금액)'],
  ['drctrAdtAllMendngSttusMendngPymntamtTyCl', 'periodic', '이사·감사 전체 보수(지급금액 유형별)'],
  ['pssrpCptalUseDtls', 'periodic', '공모자금의 사용내역'], ['prvsrpCptalUseDtls', 'periodic', '사모자금의 사용내역'],
  ['fnlttSinglAcnt', 'financial', '단일회사 주요계정'], ['fnlttMultiAcnt', 'financial', '다중회사 주요계정 (corp_code 쉼표 구분)'],
  ['fnlttSinglIndx', 'financial', '단일회사 주요 재무지표 (idx_cl_code 필요)'], ['fnlttCmpnyIndx', 'financial', '다중회사 주요 재무지표 (idx_cl_code 필요)'],
  ['xbrlTaxonomy', 'taxonomy', 'XBRL 택사노미 재무제표양식 (sj_div 필요, corp_code 없음)'],
  ['majorstock', 'ownership', '대량보유 상황보고'], ['elestock', 'ownership', '임원·주요주주 소유보고'],
  ['astInhtrfEtcPtbkOpt', 'event', '자산양수도(기타)·풋백옵션'], ['dfOcr', 'event', '부도발생'], ['bsnSp', 'event', '영업정지'], ['ctrcvsBgrq', 'event', '회생절차 개시신청'],
  ['dsRsOcr', 'event', '해산사유 발생'], ['piicDecsn', 'event', '유상증자 결정'], ['fricDecsn', 'event', '무상증자 결정'],
  ['pifricDecsn', 'event', '유무상증자 결정'], ['crDecsn', 'event', '감자 결정'], ['bnkMngtPcbg', 'event', '채권은행 등의 관리절차 개시'],
  ['lwstLg', 'event', '소송 등의 제기'], ['ovLstDecsn', 'event', '해외 증권시장 주권등 상장 결정'], ['ovDlstDecsn', 'event', '해외 증권시장 주권등 상장폐지 결정'],
  ['ovLst', 'event', '해외 증권시장 주권등 상장'], ['ovDlst', 'event', '해외 증권시장 주권등 상장폐지'],
  ['cvbdIsDecsn', 'event', '전환사채권 발행결정'], ['bdwtIsDecsn', 'event', '신주인수권부사채권 발행결정'], ['exbdIsDecsn', 'event', '교환사채권 발행결정'],
  ['bnkMngtPcsp', 'event', '채권은행 등의 관리절차 중단'], ['wdCocobdIsDecsn', 'event', '상각형 조건부자본증권 발행결정'],
  ['tsstkAqDecsn', 'event', '자기주식 취득 결정'], ['tsstkDpDecsn', 'event', '자기주식 처분 결정'],
  ['tsstkAqTrctrCnsDecsn', 'event', '자기주식취득 신탁계약 체결 결정'], ['tsstkAqTrctrCcDecsn', 'event', '자기주식취득 신탁계약 해지 결정'],
  ['bsnInhDecsn', 'event', '영업양수 결정'], ['bsnTrfDecsn', 'event', '영업양도 결정'], ['tgastInhDecsn', 'event', '유형자산 양수 결정'],
  ['tgastTrfDecsn', 'event', '유형자산 양도 결정'], ['otcprStkInvscrInhDecsn', 'event', '타법인 주식 및 출자증권 양수결정'],
  ['otcprStkInvscrTrfDecsn', 'event', '타법인 주식 및 출자증권 양도결정'], ['stkrtbdInhDecsn', 'event', '주권 관련 사채권 양수 결정'],
  ['stkrtbdTrfDecsn', 'event', '주권 관련 사채권 양도 결정'], ['cmpMgDecsn', 'event', '회사합병 결정'], ['cmpDvDecsn', 'event', '회사분할 결정'],
  ['cmpDvmgDecsn', 'event', '회사분할합병 결정'], ['stkExtrDecsn', 'event', '주식교환·이전 결정'],
  ['estkRs', 'filing', '증권신고서: 지분증권'], ['bdRs', 'filing', '증권신고서: 채무증권'], ['stkdpRs', 'filing', '증권신고서: 증권예탁증권'],
  ['mgRs', 'filing', '증권신고서: 합병'], ['extrRs', 'filing', '증권신고서: 주식의 포괄적 교환·이전'], ['dvRs', 'filing', '증권신고서: 분할'],
].map(([id, group, name]) => Object.freeze({ id, group, name })));

// KRX Data Marketplace OPEN API 서비스 목록 (openapi.krx.co.kr 서비스 목록, 2026-10-26). 각 API는 별도 이용신청·승인이 필요하다.
export const KRX_APIS = Object.freeze([
  ['idx/krx_dd_trd', '지수', 'KRX 시리즈 일별시세정보'], ['idx/kospi_dd_trd', '지수', 'KOSPI 시리즈 일별시세정보'],
  ['idx/kosdaq_dd_trd', '지수', 'KOSDAQ 시리즈 일별시세정보'], ['idx/bon_dd_trd', '지수', '채권지수 시세정보'],
  ['idx/drvprod_dd_trd', '지수', '파생상품지수 시세정보'],
  ['sto/stk_bydd_trd', '주식', '유가증권 일별매매정보'], ['sto/ksq_bydd_trd', '주식', '코스닥 일별매매정보'],
  ['sto/knx_bydd_trd', '주식', '코넥스 일별매매정보'], ['sto/sw_bydd_trd', '주식', '신주인수권증권 일별매매정보'],
  ['sto/sr_bydd_trd', '주식', '신주인수권증서 일별매매정보'], ['sto/stk_isu_base_info', '주식', '유가증권 종목기본정보'],
  ['sto/ksq_isu_base_info', '주식', '코스닥 종목기본정보'], ['sto/knx_isu_base_info', '주식', '코넥스 종목기본정보'],
  ['etp/etf_bydd_trd', '증권상품', 'ETF 일별매매정보'], ['etp/etn_bydd_trd', '증권상품', 'ETN 일별매매정보'],
  ['etp/elw_bydd_trd', '증권상품', 'ELW 일별매매정보'],
  ['bon/kts_bydd_trd', '채권', '국채전문유통시장 일별매매정보'], ['bon/bnd_bydd_trd', '채권', '일반채권시장 일별매매정보'],
  ['bon/smb_bydd_trd', '채권', '소액채권시장 일별매매정보'],
  ['drv/fut_bydd_trd', '파생상품', '선물 일별매매정보(주식선물 외)'], ['drv/eqsfu_stk_bydd_trd', '파생상품', '주식선물(유가) 일별매매정보'],
  ['drv/eqkfu_ksq_bydd_trd', '파생상품', '주식선물(코스닥) 일별매매정보'], ['drv/opt_bydd_trd', '파생상품', '옵션 일별매매정보(주식옵션 외)'],
  ['drv/eqsop_bydd_trd', '파생상품', '주식옵션(유가) 일별매매정보'], ['drv/eqkop_bydd_trd', '파생상품', '주식옵션(코스닥) 일별매매정보'],
  ['gen/oil_bydd_trd', '일반상품', '석유시장 일별매매정보'], ['gen/gold_bydd_trd', '일반상품', '금시장 일별매매정보'],
  ['gen/ets_bydd_trd', '일반상품', '배출권 시장 일별매매정보'],
  ['esg/esg_etp_info', 'ESG', 'ESG 증권상품'], ['esg/sri_bond_info', 'ESG', '사회책임투자채권 정보'], ['esg/esg_index_info', 'ESG', 'ESG 지수'],
].map(([id, category, name]) => Object.freeze({ id, category, name })));
