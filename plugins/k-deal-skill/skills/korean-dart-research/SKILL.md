---
name: korean-dart-research
description: 한국 회사의 DART 공시·재무제표·최대주주·임원·주요사항보고서·공시 원문·XBRL 주석(리스·우발부채·약정·보증·담보·특수관계·부문)을 k-deal-skill 로컬 도구로 조회할 때 사용한다. 전체 시장 공시 검색(예: 한 주간 CB 발행), 여러 회사 주요계정 비교, 인수 검토용 주식수·자기주식·최대주주·전환증권·우발채무 확인에도 쓴다. 법인, 연결/별도 기준, 기간, 접수번호를 보존한다.
metadata:
  version: "2.2.1"
---

# DART 공시·재무 조회

이 스킬은 이 PC에서 사용자 본인 API 키로 도는 **k-deal-skill** 로컬 MCP의 도구만 쓴다. 키 값은 환경변수(`DART_API_KEY`, `KRX_API_KEY`, `DATA_GO_KR_KEY`, `LAW_OC`)에 있으므로 대화에 출력하거나 사용자에게 묻지 않고, 코드를 실행해 원천을 직접 부르지 않는다.

회사 찾기 도구(`company_search`, `industry_codes`, `industry_companies`, `mailorder_search`, `hs_search`)는 공공데이터 스냅샷 DB(`MRM_DATAGO_DB`)를 설정했을 때만 보인다. 없으면 `dart_corp_search`와 금융위 `fsc_outline`으로 찾는다.

## 도구 순서

1. `dart_corp_search`(회사명·종목코드) 또는 `company_search`(비상장, 사업자번호)로 **corp_code(8자리)** 를 먼저 확정한다. 같은 이름의 회사가 여럿이면 상장 여부·대표자·주소로 구분하고, 애매하면 사용자에게 확인한다. 전체 시장 공시 검색과 `xbrlTaxonomy`는 corp_code 없이 쓴다.
2. `dart_company`: 정식 회사명, 대표자, 법인·사업자등록번호, 업종, 설립일, 결산월.
3. 질문에 맞는 도구를 고른다.

| 질문 | 도구 | 필수 값 |
|---|---|---|
| 재무제표 전체 계정 | `dart_financials` | `year`, `report`(11011 사업·11012 반기·11013 1분기·11014 3분기), `fs_div`(CFS 연결·OFS 별도) |
| **비상장 외감 법인** 재무제표(사업보고서 없이 감사보고서만 내는 회사) | `dart_audit_financials` | `corp_code`+`year`(회계연도) 또는 `rcept_no`. `consolidated`로 연결감사보고서. `dart_financials`가 `no_data`이면 이 도구를 쓴다. 금액은 원문 표 값이고 `unit`을 곱하면 원 |
| 최대주주·임원·직원·배당·자기주식·주식총수·타법인출자·감사의견·보수 등 정기보고서 항목 | `dart_report` (`api`로 항목 선택) | `bsns_year`, `reprt_code` |
| 여러 회사 주요계정·재무지표 비교 | `dart_report`의 `fnlttMultiAcnt`(주요계정), `fnlttCmpnyIndx`(재무지표, `idx_cl_code` 필요) | `corp_code`를 쉼표로 최대 100개, `bsns_year`, `reprt_code` |
| 재무지표(수익성·안정성·성장성·활동성) 한 회사 | `dart_report`의 `fnlttSinglIndx` | `bsns_year`, `reprt_code`, `idx_cl_code` |
| 유상증자·CB/BW/EB·합병·분할·영업양수도·자산양수도(기타)·풋백옵션 등 주요사항보고서, 5% 보유, 증권신고서 | `dart_report` | `bgn_de`, `end_de` |
| 한 회사의 공시 목록 | `dart_disclosures` | `corp_code`, `begin`, `end`(최대 366일) |
| 전체 시장 공시 목록(예: 지난주 CB 발행 전체) | `dart_disclosures`에서 `corp_code` 생략 | `begin`, `end`(시작일과 같은 날짜의 3개월 뒤까지), 보통 `detail_type` |
| 공시 본문 읽기 | `dart_document` | `rcept_no`(공시 목록 결과). 길면 첫 페이지의 `toc`에서 장·절을 골라 `section_id`로 읽거나 `offset`으로 이어 읽기 |
| 공시 목차만 | `dart_document`에 `toc=true` | `rcept_no` |
| 공시 본문에서 주석·단어 찾기 | `dart_document`에 `pattern` | `rcept_no`, `pattern` |
| 정기보고서 XBRL에서 주석 값 찾기 | `dart_xbrl` | 정기보고서 `rcept_no`, 그 보고서의 `reprt_code` |
| XBRL 표준계정과목 목록 | `dart_report`의 `xbrlTaxonomy` | `sj_div`(BS1~4 재무상태표, IS1~4 손익, CIS1~4 포괄손익, DCIS1~8 단일 포괄손익, CF1~4 현금흐름, SCE1~2 자본변동) |

`dart_report`의 `api` 값 79종과 설명은 도구 설명에 있다. 항목 이름이 확실하지 않으면 도구 설명에서 찾는다. 이사·감사 개인별 보수와 5억 이상 상위 5인은 2026년 5월 이후 제출된 보고서면 `hmvAuditIndvdlBySttusV2`·`indvdlByPayV2`, 그 전 보고서면 기존 API를 쓴다.

### 공시 목록 조건

- `type`: A 정기, B 주요사항, C 발행, D 지분, E 기타, F 외부감사, G 펀드, H 자산유동화, I 거래소, J 공정위.
- `detail_type`(공시상세유형, 영문 1자+숫자 3자리): A001 사업보고서, A002 반기, A003 분기, B001 주요사항보고서, C001 증권신고(지분증권), D001 대량보유, D002 임원·주요주주 소유, F001 감사보고서, F002 연결감사보고서, I001 수시공시. `type`과 같이 쓰면 첫 글자가 같아야 한다.
- `corp_cls`: Y 유가증권, K 코스닥, N 코넥스, E 기타. `sort`: date 접수일, crp 회사명, rpt 보고서명. `sort_order`: asc, desc.
- `report_name_contains`: 받은 페이지 안에서만 보고서명으로 거른다(공백 무시). DART에 보내는 조건이 아니다.
- 한 번에 한 페이지(최대 100건)다. `metadata.pagination.complete`가 false면 `page_no`를 올려 끝까지 읽은 뒤에 "없다"고 말한다.

예: 2026-10-27~11-02 CB 발행 전체는 `begin=20261027`, `end=20261102`, `detail_type=B001`, `report_name_contains=전환사채권발행결정`으로 1~3페이지를 차례로 읽는다(2026-11-03 확인: 그 주 B001 215건, 3페이지). 정정공시(`[기재정정]`)는 원 공시와 구분해 센다.

## 주석 찾기

정기보고서 주석 근거가 필요하면 두 경로를 같이 쓴다.

1. `dart_disclosures`로 사업·반기·분기보고서의 `rcept_no`를 찾는다(`detail_type` A001·A002·A003).
2. 숫자 값: `dart_xbrl`에 `rcept_no`, `reprt_code`, `pattern`(예: `리스부채|사용권자산`, `지급보증|담보`, `특수관계`)과 필요하면 `basis`(CFS·OFS)를 준다. 계정·주석 항목의 한글 라벨, 차원 구성요소 라벨(예: "약정의 유형: 지급보증"), 문장형 주석에서 단어를 찾아 값·단위·`decimals`·기간·연결/별도·차원·원본 파일 줄 번호를 준다. `pattern`을 생략하면 리스·우발·약정·보증·담보·특수관계·부문·감가상각·사용권자산을 찾는다.
3. 문장·표 원문: `dart_document`에 같은 `rcept_no`와 `pattern`(예: `우발부채|지급보증|담보제공`)을 주면 단어가 나온 구간, `start`·`offset`, 속한 장·절(`section`)을 준다. 그 `start`를 `offset`으로 `pattern` 없이 다시 불러 해당 주석부터 읽는다.

### 큰 공시 읽기

사업보고서는 100만 자 가까이 되므로 처음부터 넘겨 읽지 않는다.

1. `toc=true`(또는 `max_chars`보다 긴 문서의 첫 페이지에 같이 오는 `toc`)로 목차를 받는다. 항목마다 `id`, 제목, `level`(1 장, 2 절), 파일, 문서 안 `offset`, 글자 수(`chars`)가 있다. 감사보고서·연결감사보고서는 같은 접수번호 안의 별도 파일로, `id` 앞자리가 파일 번호다(예: `0.7` 본문 "4. 주식의 총수 등", `2.4` 연결감사보고서 "주석").
2. 필요한 장·절만 `section_id`로 읽는다. 장(`level` 1)을 고르면 그 아래 절이 모두 들어 있다. `section_id`와 함께 준 `offset`은 그 장·절 안의 위치이고, `status: partial`이면 `next_offset`으로 이어 읽는다.
3. 목차 `id`는 그 접수번호에서만 쓴다. 다른 공시에서는 목차를 다시 받는다.
4. 감사보고서 "주석"은 목차에 한 항목으로만 나온다(주석 번호별 목차 없음). 특정 주석은 `pattern`으로 찾아 위치를 얻는다.

`pattern`, `toc`, `section_id`는 한 번에 하나만 쓴다.

- `pattern`은 `|`로 구분한 단어 목록이다(최대 20개). 정규식이 아니며 대소문자를 구분하지 않는다.
- `status: partial`이면 건수 한도(`max_facts`, `max_matches`)에 걸린 것이다. 단어를 좁히거나 `basis`를 지정해 다시 찾는다. `concepts` 목록으로 어떤 계정이 걸렸는지 먼저 보고 좁히면 빠르다.
- XBRL 값의 부호와 단위는 원본 그대로다. `decimals=-6`은 백만 원 단위 반올림이다. 같은 계정이 차원(만기 구간, 거래상대방, 부문 등)별로 여러 줄 나오므로 합계 행과 구성 행을 섞어 더하지 않는다.
- XBRL에 단어가 없다는 결과는 태그된 항목에 한정된다. 원문에 있을 수 있으므로 `dart_document` 검색으로 확인한다.

## 인수 검토에서 반드시 확인할 항목

인수·지분투자 검토에서는 아래를 각각 원자료로 확인하고, 확인하지 못한 항목은 "확인하지 못함"으로 남긴다.

| 항목 | 주로 쓰는 조회 |
|---|---|
| 발행주식총수·유통주식수 | `dart_report`의 `stockTotqySttus` |
| 자기주식 | `tesstkAcqsDspsSttus`, 기간 중 변동은 `tsstkAqDecsn`·`tsstkDpDecsn` |
| 최대주주·특수관계인과 변동 | `hyslrSttus`, `hyslrChgSttus`, `majorstock`, `elestock` |
| CB·BW·EB 등 전환·교환 가능 증권 | 발행 결정 `cvbdIsDecsn`·`bdwtIsDecsn`·`exbdIsDecsn`, 미상환 잔액 `cprndNrdmpBlce` 등, 전환가액 조정은 공시 원문 |
| 지급보증·담보·약정·우발채무, 장부 밖 의무 | `dart_xbrl`과 `dart_document` 주석 검색 |
| 풋백옵션·자산양수도 | `astInhtrfEtcPtbkOpt` |

- EV나 순차입금을 말하기 전에 현금및현금성자산, 단기금융상품 등 단기 금융자산, 리스부채, 이자부 차입금(단기·장기·사채)을 따로 확인해 각각 적는다. 한 숫자로 뭉쳐 말하지 않는다.
- 희석 주식수는 전환·교환 가능 증권의 미상환 잔액과 현재 전환가액을 확인한 뒤 계산하고, 계산했다고 적는다.

## 근거와 해석

- corp_code, 정식 법인명, 종목코드(상장사)를 답에 남긴다.
- 공시는 접수번호(`rcept_no`), 보고서명, 접수일, DART 원문 주소를 남긴다. 정정공시가 있으면 원 공시와 구분한다.
- 회사 전체를 볼 때는 연결(CFS)을 먼저 쓰고, 법인 단독 질문이면 별도(OFS)를 쓴다. 어느 기준인지 항상 적는다. 연결이 없다고 별도로 바꿔 조회했으면 그 사실을 적는다. 한 표에 CFS와 OFS를 섞으면 열마다 기준을 적는다.
- 금액은 원자료 단위와 값을 보존한다. 누적 금액에서 분기 금액을 빼서 만들었으면 계산했다고 적는다.
- 보고서 표에 직접 나온 값이 아니라 XBRL 태그나 주석 검색으로 찾은 값은 "XBRL 추출" 또는 "주석 검색"으로 표시하고, 접수번호와 `source.line`(XBRL) 또는 `offset`(원문)을 남긴다.
- 조회 시각은 자료 기준일이 아니다. 재무제표는 사업연도·보고서 기준으로, 공시는 접수일로 기준을 적는다.
- 원자료 값, 계산, 해석을 구분한다.
- `dart_audit_financials` 값은 감사보고서 원문 표에서 읽은 것이다. 계정 체계가 회사마다 달라 합계 계정(`code`·`level`)을 확인하고, 투자 판단에 쓰는 숫자는 `viewer_url` 원문과 대조한다. 감사의견·계속기업 문단은 `dart_document`로 같은 접수번호의 감사보고서 본문에서 확인한다.

## 거절과 오류

- `status: no_data`(또는 `metadata.data_status: no_data`·`no_match`)는 그 범위·단어에 자료가 없다는 뜻이다. 오류·거절은 "자료 없음"이나 0으로 바꾸지 않는다.
- `invalid_input`은 조건이 맞지 않는다는 뜻이다(예: corp_code 없이 3개월 초과). 메시지대로 범위를 줄여 다시 부른다.
- `no_document`는 그 접수번호에 원본 파일(원문 또는 XBRL)이 없다는 뜻이다. 감사보고서·주요사항보고서처럼 XBRL이 없는 공시는 `dart_document`를 쓴다.
- `not_connected`는 그 원천의 키가 환경변수에 없다는 뜻이다. `mrm_connection_status`(값 없이 유무만)로 확인하고 키 발급·설정을 안내한다. `rate_limited`·`http_429`는 원천 기관의 호출 제한이니 잠시 뒤 다시 조회한다.
- 대화에 k-deal-skill 도구(`mrm_connection_status` 등)가 보이지 않으면 로컬 MCP가 연결되지 않은 것이다. 값을 기억으로 채우지 않는다.

출처: [OpenDART 개발가이드](https://opendart.fss.or.kr/guide/main.do). 공시 원문 목차와 장·절 조회는 [korea-stock-mcp](https://github.com/jjlabsio/korea-stock-mcp)(MIT)를 참고했다.
