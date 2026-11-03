---
name: korean-law-search
description: 한국 법령·판례·해석례·위원회 결정문의 원문과 시행 시점을 조회할 때 사용한다. 사용자 본인의 법제처 OC로 법제처 Open API를 직접 조회하고, OC가 없으면 Market Research 서버의 공용 법령 연결(/law)을 쓴다.
metadata:
  version: "1.1.0"
---

# 한국 법령 조회

이 스킬은 조회 방법과 작은 Python 클라이언트를 제공한다. 설치만으로 MCP 연결, 네트워크 허용, 인증키 설정이 완료되는 것은 아니다.

## 조회 경로

1. 현재 대화에 법령 MCP 도구가 노출돼 있으면 그 도구를 써도 된다.
2. 사용자 PC에 `LAW_OC`가 있으면 `scripts/law_fetch.py`로 법제처 Open API(`www.law.go.kr/DRF`)를 직접 조회한다. OC는 [open.law.go.kr](https://open.law.go.kr/)에서 무료로 신청하며, 신청할 때 호출할 PC의 공인 IP나 도메인을 등록해야 한다. 등록하지 않은 곳에서 부르면 JSON이 아닌 응답이나 거절이 온다.
3. OC가 없거나 직접 조회가 실패하면 `scripts/mcp_http.py`로 Market Research 서버의 익명 법령 전용 연결(`/law`)을 조회한다. 이 서버는 운영자 OC로 법제처 Open API만 호출하며, 사용자의 OC는 보내지 않는다. IP별 분당·일 한도가 있고 검색어는 기록하지 않는다. 주소는 스크립트의 `PUBLIC_LAW_ENDPOINT`이며, 직접 띄운 서버를 쓰려면 환경변수 `K_DEAL_LAW_ENDPOINT=https://<호스트>/law`를 둔다. 주소가 비어 있으면 OC 발급을 안내한다.
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

- `law_search`(스크립트 `search-law`)로 정식 법령명, `lawId`, 버전 식별자 `mst`, 공포일·시행일을 확인한다. 약칭·유사 명칭을 구분한다.
- 현행·과거·시행예정 중 요청한 시점을 구분한다. 현행은 법령 ID로 조회한다. 계약일·사건일처럼 특정 날짜의 법령은 법령 ID와 `date`(`YYYYMMDD`)를 함께 주면 그날 시행 중이던 버전을 찾아 조회하고 `metadata.version`에 실제 버전(MST·시행일)을 적는다. `mst`와 `date`를 함께 주면 `date`는 그 버전의 정확한 시행일이어야 한다.
- 조문은 `제38조`, `제10조의2`처럼 넣으면 그 조만 돌려준다. `제38조제1항`은 조 단위로 조회한다. `부칙`은 부칙만 공포일 최근 순으로 돌려준다. 없는 조문·판례 ID는 `not_found` 오류다. 금액·요건이 별표에 있으면 `catalog --query 별표`로 별표서식 API를 찾아 `api`로 조회한다.
- 판례·해석례는 `decisions`(domain=precedent·interpretation 등) → `decision-text`(domain, id) 순서로 본다. 전문이 필요한지 판단한다.
- 연혁·신구법·3단비교·위임법령·행정규칙·자치법규는 `catalog`에서 API를 찾고 `api`로 실행한다. 원격 연결에서는 같은 기능이 `law_catalog`·`law_api` 도구다.
- 결과의 국가법령정보센터 링크·식별자·시행일을 남긴다. 검색 결과, 실제 읽은 원문, 해석을 구분하며 API 오류를 검색 0건으로 바꾸지 않는다.

## 원격 연결 클라이언트 예시

아래는 이 스킬 폴더를 작업 디렉터리로 사용한 예다. 다른 위치에서는 설치된 스킬 폴더의 실제 경로를 사용한다.

```bash
python3 scripts/mcp_http.py tools-list
python3 scripts/mcp_http.py search-law --query '민법' --display 3
python3 scripts/mcp_http.py law-text --law-id 001706 --article '제750조'
python3 scripts/mcp_http.py law-text --law-id 001706 --article '제750조' --date 20230101
python3 scripts/mcp_http.py call law_decisions_search --arguments '{"domain":"precedent","query":"손해배상","display":3}'
```

`call`은 허용된 읽기 도구(`law_search`, `law_text`, `law_decisions_search`, `law_decision_text`, `law_catalog`, `law_api`)에만 JSON 인자를 전달한다. HTTP 429는 IP별 한도 초과이며 검색 결과 없음이 아니다. 오류가 나면 멈추고, 자주 쓰면 OC를 발급받아 `law_fetch.py`로 옮긴다.

## 갱신·출처

조회 시각은 법령 시행일을 뜻하지 않는다. 원격 연결도 법제처 Open API 응답을 그대로 돌려주며, 서버가 저장해 둔 응답이면 `_gateway.cache: hit`이 붙는다.

- 법제처 API 159개 명세: [SeoNaRu/lexguard-mcp](https://github.com/SeoNaRu/lexguard-mcp) 크롤링 결과(MIT)를 정리했다.
- 판례·결정례 분야 이름과 DRF target 대응: [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)(MIT) 기준. 이 번들의 Python 클라이언트는 자체 작성했으며 upstream 코드·의존성을 포함하지 않는다. upstream 공개 서버는 호출하지 않는다.
- 데이터: [법제처 Open API](https://open.law.go.kr/).
