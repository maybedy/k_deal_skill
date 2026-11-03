---
name: korean-law-search
description: 한국 법령·판례·해석례·위원회 결정문의 원문과 시행 시점을 조회할 때 사용한다. 사용자 본인의 법제처 OC로 법제처 Open API를 직접 조회하고, OC가 없거나 직접 조회가 실패하면 공개 원격 Korean Law MCP를 쓴다.
metadata:
  version: "1.0.0"
---

# 한국 법령 조회

이 스킬은 조회 방법과 작은 Python 클라이언트를 제공한다. 설치만으로 MCP 연결, 네트워크 허용, 인증키 설정이 완료되는 것은 아니다.

## 조회 경로

1. 현재 대화에 Korean Law MCP 도구가 노출돼 있으면 그 도구를 써도 된다.
2. 사용자 PC에 `LAW_OC`가 있으면 `scripts/law_fetch.py`로 법제처 Open API(`www.law.go.kr/DRF`)를 직접 조회한다. OC는 [open.law.go.kr](https://open.law.go.kr/)에서 무료로 신청하며, 신청할 때 호출할 PC의 공인 IP나 도메인을 등록해야 한다. 등록하지 않은 곳에서 부르면 JSON이 아닌 응답이나 거절이 온다.
3. OC가 없거나 직접 조회가 실패하면 `scripts/mcp_http.py`로 공개 원격 서버 `https://mcp.gomdori.app/law`를 조회한다. 이때 OC는 보내지 않는다.
4. 실행·네트워크 권한이 없으면 필요한 설정을 설명한다. 설치된 스킬을 실제 연결 성공으로 표현하지 않는다.

```bash
python3 scripts/law_fetch.py env-status
python3 scripts/law_fetch.py search-law --query 상법 --display 5
python3 scripts/law_fetch.py law-text --law-id 001702 --article 제382조
python3 scripts/law_fetch.py law-text --law-id 001702 --article 제382조 --date 20240101
python3 scripts/law_fetch.py decisions --domain precedent --query 경영권 --display 10
python3 scripts/law_fetch.py decision-text --domain precedent --id <판례일련번호>
python3 scripts/law_fetch.py catalog --query 연혁
python3 scripts/law_fetch.py api --api-id 1 --param query=상법 --param display=5
```

`search-law`는 법령명 일치도 순으로 정렬한다(정확한 이름, 시행령·시행규칙, 앞부분 일치, 포함 순). `decisions`의 domain은 precedent·interpretation·constitutional·tax_tribunal·admin_appeal·ftc·pipc 등 이름이나 부처·위원회의 DRF target 코드(예: moefCgmExpc)를 받는다. 국세청 법령해석 본문(nts)은 법제처 API에 없어 국세법령정보시스템을 안내한다. `catalog`는 [references/law-apis.json](references/law-apis.json)의 법제처 Open API 159개(연혁·신구법·3단비교·위임법령·행정규칙·자치법규·별표서식 등)를 네트워크 없이 찾고, `api`는 문서화된 파라미터만 보낸다. 일부 API는 JSON을 지원하지 않아 `law_api_non_json` 오류가 나며, 이를 결과 없음으로 바꾸지 않는다. 응답 속 링크의 OC 값은 `[REDACTED]`로 가린다.

`LAW_OC`는 환경변수로만 읽는다. 키를 대화, 스킬 파일, 명령 인자 또는 URL에 넣지 않는다. 원격 서버는 키 없이 공용 용량으로 조회될 수 있으나 가용성·할당량을 보장하지 않으며, 인증·쿼터 오류를 자료 없음으로 해석하지 않는다.

## 자료 선택

- `search_law`로 정식 법령명, `lawId`, 버전 식별자 `mst`, 공포일·시행일을 확인한다. 약칭·유사 명칭을 구분한다.
- 현행·과거·시행예정 중 요청한 시점을 구분한다. 현행은 `lawId`로 조회하고, 특정 시행본은 `mst` 또는 기준일 `efYd`를 사용한다. 기준일은 `YYYYMMDD`다.
- `get_law_text`의 `jo`에는 `제38조`, `제10조의2`, `부칙`처럼 자연어 조문 표기를 넣는다. 금액·요건이 별표에 있으면 `get_annexes`를 조회한다.
- 판례·해석례는 `search_decisions(domain="precedent" 또는 "interpretation", ...)` → `get_decision_text(domain, id)`를 쓴다. `full=true`로 전문이 필요한지 판단한다.
- 조례·행정규칙도 먼저 `search_law`로 찾는다. 전문 기능은 노출 MCP의 `discover_tools`로 확인한다. 번들 클라이언트는 검토한 최상위 조회 도구만 허용하며 `execute_tool` 프록시는 실행하지 않는다.
- 결과의 국가법령정보센터 링크·식별자·시행일을 남긴다. 검색 결과, 실제 읽은 원문, 해석을 구분하며 API 오류를 검색 0건으로 바꾸지 않는다.

## 원격 서버 클라이언트 예시

아래는 이 스킬 폴더를 작업 디렉터리로 사용한 예다. 다른 위치에서는 설치된 스킬 폴더의 실제 경로를 사용한다.

```bash
python3 scripts/mcp_http.py initialize
python3 scripts/mcp_http.py tools-list
python3 scripts/mcp_http.py search-law --query '민법' --display 3
python3 scripts/mcp_http.py law-text --law-id 001706 --article '제750조'
python3 scripts/mcp_http.py law-text --law-id 001706 --article '제750조' --date 20230101
python3 scripts/mcp_http.py call search_decisions --arguments '{"domain":"precedent","query":"손해배상","display":3}'
```

`tools-list`는 서버에 실제 노출된 도구를 확인한다. 도움말에 안내되는 `call`은 허용된 읽기 도구에만 JSON 인자를 전달한다. 오류 시 응답을 확인하고 멈춘다. 인증키·무제한 재시도·대체 유료 서비스를 임의로 추가하지 않는다.

## 갱신·출처

2026-10-22 확인한 upstream은 v4.15.9다. 공개 서버 프로그램은 운영자가 갱신하므로 `initialize`의 실제 버전을 확인한다. 법령 자료는 법제처 API에서 조회하며, upstream 구현상 검색·현행 본문은 보통 1시간, 버전이 특정된 본문은 24시간 캐시된다. 조회 시각이 법령 시행일을 뜻하지 않는다.

기존 법망 fallback은 2026-10-22 확인 시 운영 중단 공지가 있어 자동 재시도 대상으로 포함하지 않는다. 필요하면 공식 [국가법령정보센터](https://www.law.go.kr/) 원문 경로를 확인한다.

- 법제처 API 159개 명세: [SeoNaRu/lexguard-mcp](https://github.com/SeoNaRu/lexguard-mcp) 크롤링 결과(MIT)를 정리했다.
- Upstream: [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp), MIT 라이선스. 이 번들의 Python 클라이언트는 자체 작성했으며 upstream 코드·의존성을 포함하지 않는다.
- 데이터: [법제처 Open API](https://open.law.go.kr/). 일부 국세청 결정문은 upstream이 국세법령정보시스템에서 보완한다.
- 인증: upstream은 사용자별 OC 발급을 안내한다. 팀 키 사용 범위는 발급기관 조건에 맞춘다.
