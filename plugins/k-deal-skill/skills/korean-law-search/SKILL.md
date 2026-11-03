---
name: korean-law-search
description: 한국 법령 조문(현행·과거 시행일 기준), 별표·서식, 판례·헌재·해석례·위원회 결정문, 연혁·신구법·위임법령·행정규칙·자치법규를 k-deal-skill 로컬 도구로 조회하고, 기준일 적용 법령·두 날짜 비교·신구조문대비표·인용 확인·영향 범위·조례 정비 점검·법령 개정 감시를 할 때 사용한다.
metadata:
  version: "2.1.1"
---

# 한국 법령 조회

이 스킬은 이 PC에서 사용자 본인 API 키로 도는 **k-deal-skill** 로컬 MCP의 도구만 쓴다. 키 값은 환경변수(`DART_API_KEY`, `KRX_API_KEY`, `DATA_GO_KR_KEY`, `LAW_OC`)에 있으므로 대화에 출력하거나 사용자에게 묻지 않고, 코드를 실행해 원천을 직접 부르지 않는다.

## 조회 도구 순서

1. `law_search`로 정식 법령명, 법령 ID(`law_id`), 버전 식별자(`mst`), 공포일·시행일을 확인한다. 약칭과 비슷한 이름의 법령(시행령·시행규칙)을 구분한다.
2. `law_text`로 조문을 본다.
   - 현행: `law_id`와 `article`(예: `제382조`, `제10조의2`).
   - 계약일·사건일 기준: `law_id`, `article`, `date`(YYYYMMDD)를 주면 그날 시행 중이던 버전을 찾아 조회하고 `metadata.version`에 실제 버전(MST·시행일)을 적는다. 답에도 그 시행일을 적는다.
   - `제38조제1항`처럼 항·호를 넣어도 조 단위로 돌려준다. 필요한 항을 본문에서 찾아 인용한다.
   - `article`에 `부칙`을 넣으면 부칙만 돌려준다.
3. 금액·기준·수수료가 별표에 있으면 `law_annexes`로 본다. `annex`(예: `별표 3`)나 `query`(별표 제목 낱말)로 한 건을 고르면 본문 `text`, 괘선 표를 행·열로 읽은 `tables`, HWP·PDF 링크를 준다. `date`를 주면 그날 시행본의 별표다. `has_text`가 false면 파일 링크만 있으니 내용을 짐작하지 않는다.
4. 판례·해석례·결정문은 `law_decisions_search`(domain, query) → `law_decision_text`(domain, id) 순서로 본다. domain은 precedent(판례), constitutional(헌재), interpretation(법령해석례), admin_appeal(행정심판), tax_tribunal(조세심판), nts(국세청), mois(행정안전부), ftc(공정위), pipc(개인정보위) 등과 부처별 해석 target(예: `molitCgmExpc`)이다. 국세청(nts)·재정경제부(`moefCgmExpc`) 해석은 검색 결과의 `본문조회ID`(18자리)를 id로 넣는다.
5. 행정규칙(고시·훈령·예규)은 `law_admin_rule_search`로 찾고 `law_admin_rule`로 필요한 부분만 본다: `article`(전후 `context`개), `chapter`(예: `제4편 제3장`), `keyword`, 또는 `page`.
6. 위 도구에 없는 자료(연혁 목록, 3단 비교, 체계도, 자치법규 본문, 법령용어, 조약 등)는 `law_catalog`로 API와 파라미터를 찾고 `law_api`로 실행한다.

## 분석 도구

| 질문 | 도구 | 꼭 줄 것 |
|---|---|---|
| 그때(계약·처분·행위일) 적용되던 조문과 그 뒤 경과조치 | `law_applicable` | `law_id` 또는 `law_name`, `date`, 가능하면 `article` |
| 두 시점 사이 무엇이 바뀌었나 | `law_compare_dates` | `from_date`, `to_date`, 범위가 크면 `article` |
| 개정안 신·구조문대비표 | `law_amendment_table` | 법령, `amendments[].text`(개정 후 조문). 조례·행정규칙·미공포안은 `current_text` |
| 답변·의견서·계약서의 법령·판례 인용 확인 | `law_verify_citations` | `text` |
| 이 판례가 뒤에 어떻게 인용·변경됐나 | `law_cite_check` | `case_number` |
| 조문 하나를 바꾸면 영향 받는 곳 | `law_impact_map` | 법령, `article` |
| 조례가 상위법 개정을 따라갔나 | `law_ordinance_radar` | `ordinance_name`(전체 이름) |
| 여러 법령 개정 여부 정기 확인 | `law_bulk_check` | `queries`, 다음부터 직전 `snapshot`을 `previous`로 |

- `law_applicable`: `version_then`이 기준일 시행 버전이다. `later_addenda`는 그 뒤 개정 부칙에서 시행일·적용례·경과조치 문장을 낱말로 골라낸 것이라, 기준일 행위에 새 규정이 미치는지는 그 문장을 읽고 판단해 답에 근거 문장을 적는다. `mentions_article`이 true인 문장을 먼저 본다.
- `law_amendment_table`: 개정안에 적지 않은 현행 항·호는 삭제로 본다. 유지할 항은 `② ∼ ⑤ (현행과 같음)`처럼 적는다. `warnings`가 있으면 사용자에게 알린다. 결과의 `markdown`을 그대로 보여 주되 `<u></u>`가 밑줄 표시임을 알린다.
- `law_verify_citations`: `verified`는 그 법령·조·항·호·사건번호가 현행 자료에 있다는 뜻일 뿐, 인용 내용이 맞다는 뜻이 아니다. `excerpt`와 원문으로 취지를 대조한다. `article_not_found`·`law_not_found`는 옛 조문 번호·옛 법령명일 수 있으니 `law_applicable`·`law_search`로 확인한다.
- `law_cite_check`: `possibly_overruled_or_modified`는 뒤 판결 본문이 "변경" 등과 함께 그 사건을 언급했다는 신호다. 전원합의체 여부와 변경 범위를 원문(`law_decision_text`)으로 확인하기 전에는 "폐기됐다"고 쓰지 않는다.
- `law_impact_map`: 판례·해석례·행정규칙 건수는 "법령명 제N조" 본문 검색이라 다른 법령의 같은 조 번호가 섞일 수 있다. 건수를 근거로 쓰지 말고 목록을 열어 확인한다.
- `law_ordinance_radar`: `amended_after_ordinance`는 상위법 최근 공포일이 조례보다 늦다는 뜻이다. 실제로 인용 조문이 바뀌었는지는 `law_compare_dates`로 확인한다.
- 분석 도구는 요청 하나에 법제처를 여러 번 부르고 그만큼 한도에서 빠진다(`metadata.upstream_calls`). 범위를 좁힐 수 있으면 `article`을 준다.

## 근거와 해석

- 법령명, 법령 ID 또는 MST, 시행일, 조문 번호를 답에 남긴다. 판례는 사건번호·선고일·법원을 남긴다. 별표는 별표 번호와 그 버전 시행일을 남긴다.
- 현행, 과거 시행본, 시행 예정본을 구분한다. 조회 시각은 법령 시행일이 아니다.
- 검색 결과 목록, 실제로 읽은 원문, 분석 도구의 자동 분류, 해석을 구분한다. 원문을 읽지 않은 판례를 결론의 근거로 쓰지 않는다.
- 국세청·재정경제부 해석 본문은 국세법령정보시스템 공개 조회 결과다(`metadata.provider`). 인용 전에 `metadata.source_url`의 원문과 대조하도록 안내한다.

## 거절과 오류

- `not_found`는 그 법령·조문·판례 ID가 없거나 그 기준일에 시행 중인 버전이 없다는 뜻이다. 검색부터 다시 한다.
- `law_not_found`는 이름이 정확히 같은 법령이 없다는 뜻이다. 메시지의 후보 이름으로 다시 요청한다.
- `call_budget`은 한 요청의 법제처 호출 상한에 걸린 것이다. 조문·건수를 좁혀 다시 요청한다.
- `law_api_rejected`, `law_api_non_json`은 법제처 연결 문제(OC·등록 IP 확인)이거나 JSON을 지원하지 않는 API다. `taxlaw_http_error`, `taxlaw_non_json`, `taxlaw_unexpected`는 국세법령정보시스템 쪽 문제다. "결과 없음"으로 바꾸지 않는다.
- `not_connected`는 그 원천의 키가 환경변수에 없다는 뜻이다. `mrm_connection_status`(값 없이 유무만)로 확인하고 키 발급·설정을 안내한다. `rate_limited`·`http_429`는 원천 기관의 호출 제한이니 잠시 뒤 다시 조회한다.
- 대화에 k-deal-skill 도구(`mrm_connection_status` 등)가 보이지 않으면 로컬 MCP가 연결되지 않은 것이다. 값을 기억으로 채우지 않는다.

출처: [법제처 Open API](https://open.law.go.kr/), 국세청 해석 본문은 [국세법령정보시스템](https://taxlaw.nts.go.kr/). 판례·결정례 분야와 분석 도구 구성은 [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)(MIT)를 참고했다.
