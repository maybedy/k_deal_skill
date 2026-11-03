---
name: korean-public-data
description: 비상장 포함 회사 찾기, 국민연금 가입자 수·업종별 회사 리스트, 국세청 휴폐업, 금융위 기업개요·요약재무·계열회사, 관세청 품목별 수출입, 고용·산재보험 상시인원, 특허·상표 등록원부, 조달 실적·부정당제재, 공장등록, 가맹본부, 화장품·의료기기 업체, 예탁결제원·공정위 등 data.go.kr 자료를 k-deal-skill 로컬 도구로 조회할 때 사용한다. 공시·주석 수준의 재무 근거는 DART를 쓴다.
metadata:
  version: "2.1.1"
---

# 공공데이터 조회

이 스킬은 이 PC에서 사용자 본인 API 키로 도는 **k-deal-skill** 로컬 MCP의 도구만 쓴다. 키 값은 환경변수(`DART_API_KEY`, `KRX_API_KEY`, `DATA_GO_KR_KEY`, `LAW_OC`)에 있으므로 대화에 출력하거나 사용자에게 묻지 않고, 코드를 실행해 원천을 직접 부르지 않는다.

회사 찾기 도구(`company_search`, `industry_codes`, `industry_companies`, `mailorder_search`, `hs_search`)는 공공데이터 스냅샷 DB(`MRM_DATAGO_DB`)를 설정했을 때만 보인다. 없으면 `dart_corp_search`와 금융위 `fsc_outline`으로 찾는다.

## 도구 고르기

| 질문 | 도구 | 비고 |
|---|---|---|
| 회사 찾기 (비상장 포함), 사업자번호로 찾기 | `company_search` | DART 등록 여부, 국민연금 가입 사업장(가입자 수·업종·주소·자료월), 통신판매 신고를 함께 보여 줌 |
| 업종별 회사 리스트 | `industry_codes` → `industry_companies` | 업종코드를 먼저 확인. 지역·규모·법인 여부·비상장만 보기로 거름 |
| 온라인 판매 사업자, 브랜드 운영사 | `mailorder_search` | 상호·도메인·사업자번호. 개별 상품명으로는 못 찾음 |
| 휴업·폐업 여부 | `biz_status` | 사업자등록번호 최대 100개 |
| 기업개요·요약재무·계열회사 (금융위) | `fsc_outline`, `fsc_financials`, `fsc_affiliates` | **법인등록번호(13자리)** 기준. DART 고유번호·종목코드·사업자번호가 아님 |
| HS 품목별·국가별 수출입 | `hs_search` → `customs_trade` | 한 번에 최대 12개월 |
| 그 밖의 data.go.kr 자료 (예탁결제원 주식 발행·발행회사, 금융위 주식발행·자금조달 공시, 국민연금 실시간 등) | `datago_catalog` → `datago_api` | 카탈로그에서 service·operation과 파라미터를 확인한 뒤 실행 |

### 비상장 회사 점검 순서 (외감·비외감 공통)

1. 식별: `company_search`로 DART 고유번호·사업자번호, `fsc_outline`(회사명)으로 법인등록번호를 확인한다. 금융위 기업기본정보는 비상장도 나오지만 종업원수·감사의견은 비어 있는 경우가 많아 식별용으로만 쓴다.
2. 재무: 외감 법인이면 DART `dart_audit_financials`(korean-dart-research 스킬). 외감 미만 가맹본부는 `ftc_franchise_finance`(범위값).
3. 고용 규모: 국민연금(`company_search`, 자료월 표시)과 고용·산재보험 상시인원(`comwel_insured_workplace`, 사업자번호 10자리)을 함께 본다. 두 값은 기준이 달라 다를 수 있다.
4. 자산·역량: 특허·상표(`kipo_right_register`, 법인등록번호 searchType=3), 등록공장(`kicox_factory`), 업종 인허가(`mfds_cosmetics`, `mfds_meddev_company`), 창업기업 확인(`kised_startup_cert`).
5. 거래·리스크: 조달 등록·부정당제재(`pps_corp_info`), 공공조달 실적(`pps_stats`), 휴폐업(`biz_status`).

data.go.kr 서비스는 본인 키로 서비스마다 활용신청해야 응답한다. 신청하지 않은 서비스는 `not_registered` 오류가 오며, 이는 자료가 없다는 뜻이 아니다. 고용·산재보험 자료는 공공누리 제1유형이라 답에 "출처: 근로복지공단"을 적는다.

## 근거와 해석

- 법인, 기간, 단위, 연결/별도 기준을 맞춘다. 금융위 자료가 없다고 그 회사에 재무제표가 없는 것은 아니다. 감사받은 재무와 주석은 DART로 확인한다.
- 국민연금 가입자 수는 고용 규모를 가늠하는 값이며 매출이 아니다. 업종코드는 공단 분류라 통계청 KSIC와 다를 수 있다. 상장 여부 표시는 회사명을 대조한 근사치다. 자료월을 함께 적는다.
- 국민연금 사업자번호는 앞 6자리만 있는 경우가 있어 단독으로 법인을 특정하지 않는다.
- 수출입 결과에는 합계·소계 행과 상세 행이 섞여 있다. 한 가지 집계 수준만 골라 쓰고, 합계와 상세를 더하거나 겹치는 HS 코드를 합산하지 않는다.
- 응답의 원천 주소, 요청 파라미터, 자료 기준 기간을 남긴다. 조회 시각은 자료 기준일이 아니다.
- 페이지가 나뉜 결과는 `totalCount`와 `partial_result`를 보고 더 볼지 판단한다.

## 거절과 오류

- 오류·거절은 "자료 없음"이나 0으로 바꾸지 않는다. 승인되지 않은 data.go.kr 서비스는 오류로 온다.
- `not_connected`는 그 원천의 키가 환경변수에 없다는 뜻이다. `mrm_connection_status`(값 없이 유무만)로 확인하고 키 발급·설정을 안내한다. `rate_limited`·`http_429`는 원천 기관의 호출 제한이니 잠시 뒤 다시 조회한다.
- 대화에 k-deal-skill 도구(`mrm_connection_status` 등)가 보이지 않으면 로컬 MCP가 연결되지 않은 것이다. 값을 기억으로 채우지 않는다.

출처: [공공데이터포털](https://www.data.go.kr/), [국민연금 가입 사업장](https://www.data.go.kr/data/15083277/openapi.do).
