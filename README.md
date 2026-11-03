# k-deal-skill

한국 기업·딜 리서치에 쓰는 공식 원천자료를 Claude Code·Codex 같은 AI 코딩 도구에서 조회하게 해 주는 무료 스킬 묶음입니다. 대상 자료는 DART 공시·재무제표, KRX 시세, 금융위·관세청·국세청 공공데이터, 법제처 법령·판례입니다. 별도 서버 없이 각자 PC에서 돌고, API 키도 각자 발급해 각자 PC에 둡니다.

## 목차

1. [기획](#1-기획)
2. [할 수 있는 일](#2-할-수-있는-일)
3. [준비: API 키 발급](#3-준비-api-키-발급)
4. [설치: Claude·ChatGPT·Codex](#4-설치-claudechatgptcodex)
5. [써 보기](#5-써-보기)
6. [문제 해결](#6-문제-해결)
7. [유지보수](#7-유지보수)
8. [기술 상세](#8-기술-상세)

## 1. 기획

**해결하려는 문제.** AI에게 "이 회사 최대주주 누구야", "작년 매출 얼마야"라고 물으면 기억에 의존한 숫자나 출처 없는 답이 나오기 쉽습니다. 리서치에는 원자료와 기준일이 필요합니다.

**접근.** 스킬은 두 부분으로 이뤄집니다.

- **설명서(`SKILL.md`)**: AI에게 어떤 순서로 조회하고 출처를 어떻게 적을지 알려 줍니다.
- **스크립트(Python)**: 기관 공식 API를 실제로 부릅니다.

AI가 질문을 받으면 스크립트를 실행해 원문을 가져오고, 원천 주소·기준일·조회 시각을 붙여 답합니다.

**원칙.**

- 기관 공식 API만 부릅니다.
- "결과 없음"과 "오류"를 구분합니다. 승인 안 된 서비스, 한도 초과, 인증 실패를 0건으로 바꾸지 않습니다.
- 키 값은 화면이나 결과에 출력하지 않습니다.
- Python 3.10 이상 표준 라이브러리만 씁니다. 추가 설치가 필요 없습니다.

**서버판과의 차이.** 팀 단위로 키 없이 ChatGPT·Claude 워크스페이스에서 쓰는 운영자 서버판(Market Research MCP)이 따로 있습니다. 이 공개판은 개인이 자기 키로 쓰는 버전입니다. 공개판이 서버를 쓰는 곳은 법제처 OC가 없을 때의 법령 조회(`/law`) 하나뿐입니다.

## 2. 할 수 있는 일

| 스킬 | 이런 질문에 씁니다 | 필요한 키 |
|---|---|---|
| korean-dart-research | "에이피알 2025년 연결 재무제표", "최대주주·임원 현황", "올해 유상증자·CB 공시", "공시 원문 읽어줘" | `DART_API_KEY` |
| krx-market-data | "2026-10-31 삼성전자 종가·시가총액·상장주식수", "코스닥 지수 추이" | `KRX_API_KEY` |
| korean-public-data | "이 법인 계열회사", "HS 3304 베트남 수출 12개월", "이 사업자번호 폐업 여부", "비상장사 주식 발행 정보" | `DATA_GO_KR_KEY` |
| korean-law-search | "상법 제382조", "2020년 시행 당시 조문", "이사 충실의무 판례", "공정위 결정례" | `LAW_OC` (선택) |

자세한 조회 범위는 다음과 같습니다.

- **DART**: 보고서 75종을 조회합니다. 최대주주, 임원, 배당, 자기주식, 타법인출자, 감사의견, 5% 보유, 유상증자, CB·BW, 합병, 분할, 증권신고서 등이 들어 있습니다.
- **KRX**: Open API 31종을 조회합니다. 지수, ETF·ETN, 채권, 파생, 일반상품, ESG 자료가 들어 있습니다.
- **data.go.kr**: 서비스 19개, 오퍼레이션 85개를 조회합니다.
- **법제처**: Open API 159개를 조회합니다.

## 3. 준비: API 키 발급

키 네 종류는 모두 무료입니다. 필요한 것만 받아도 됩니다. 키가 없는 스킬은 "키를 설정하라"는 안내만 하고 다른 스킬은 정상 동작합니다.

| 자료원 | 신청처 | 알아둘 점 |
|---|---|---|
| OpenDART | [opendart.fss.or.kr](https://opendart.fss.or.kr/) → 인증키 신청 | 즉시 발급. 하루 20,000건. 짧은 시간에 몰아 부르면 IP가 약 1시간 차단됩니다 |
| KRX Open API | [openapi.krx.co.kr](https://openapi.krx.co.kr/) → 회원가입 → 인증키 신청 → 서비스별 이용신청 | 서비스마다 따로 승인을 받아야 합니다. 약관상 비상업적 이용만 가능합니다 |
| 공공데이터포털 | [data.go.kr](https://www.data.go.kr/) → 쓰려는 서비스마다 활용신청 | 키 하나로 승인받은 서비스만 호출됩니다. 개발계정은 하루 100건인 서비스도 있습니다 |
| 법제처 | [open.law.go.kr](https://open.law.go.kr/) → OPEN API 신청 | 신청할 때 **조회할 PC의 공인 IP**를 등록합니다. 다른 곳(카페, 집)에서 부르면 거절됩니다. 없어도 법령 조회는 됩니다(아래) |

받은 키는 셸 설정 파일(macOS는 보통 `~/.zshrc`)에 넣고 터미널을 새로 엽니다.

```bash
export DART_API_KEY=발급받은_키
export KRX_API_KEY=발급받은_키
export DATA_GO_KR_KEY=발급받은_일반인증키_디코딩값
export LAW_OC=발급받은_OC
```

키를 AI 채팅창이나 명령 인자에 붙여 넣지 않습니다.

이미 다른 MCP 설정 파일(`.mcp.json`, Codex `config.toml`)에 키를 넣어 두었다면 그 파일 경로만 등록해도 됩니다. 등록 파일(`~/.config/k-deal-skill/connection.json`)에는 경로만 저장하고 키 값은 복사하지 않습니다.

```bash
python3 tools/connect_existing_mcp.py --mcp-json <경로>
```

**법제처 OC가 없을 때.** 스킬은 운영자 서버의 공용 법령 연결(`/law`)로 법령을 조회합니다. IP별 분당·하루 한도가 있고, 검색어는 기록하지 않습니다. 2026-11-03 현재 이 서버의 공개 주소가 아직 없습니다. 그래서 OC가 없으면 법령 조회 대신 "OC를 발급하라"는 안내가 나옵니다.

## 4. 설치: Claude·ChatGPT·Codex

스킬은 **내 PC에서 Python을 실행할 수 있는 AI 도구**에서 동작합니다. 키가 내 PC 환경변수에 있기 때문입니다.

| 도구 | 지원 | 방법 |
|---|---|---|
| Claude Code (터미널, 데스크톱 앱 Code 탭, VS Code) | 권장 | 아래 플러그인 설치 |
| Codex CLI·데스크톱 | 지원 | 스킬 폴더 복사 |
| ChatGPT·Claude 웹 대화창 | 권장하지 않음 | 대화창의 코드 실행 환경에는 내 PC 환경변수가 없고 외부 접속이 막혀 있을 수 있습니다. 이 환경에서의 동작은 확인하지 않았습니다. 웹 대화창에서 쓰려면 서버판(운영자 문의)을 씁니다 |

**Claude Code**

```bash
claude plugin marketplace add maybedy/k_deal_skill
```

```bash
claude plugin install k-deal-skill@k-deal-skill
```

설치 후 Claude Code를 다시 시작합니다. 새 버전이 나오면 `claude plugin marketplace update k-deal-skill`로 목록을 갱신한 뒤 `claude plugin update k-deal-skill@k-deal-skill`로 받습니다.

**Codex**

```bash
git clone https://github.com/maybedy/k_deal_skill.git && cp -R k_deal_skill/plugins/k-deal-skill/skills/* ~/.codex/skills/
```

같은 이름의 스킬이 이미 `~/.codex/skills/`에 있으면 덮어쓰지 말고 이름을 바꿔 넣습니다.

**ChatGPT·Codex 워크스페이스 관리자**는 두 가지 중 하나를 씁니다.

- `.agents/plugins/marketplace.json`을 씁니다.
- `python3 tools/package.py`로 만든 ZIP을 올립니다.

이 경우에도 스크립트는 키를 넣을 수 있는 코드 실행 환경에서만 돕니다.

## 5. 써 보기

**설정 확인.** 네트워크 호출 없이 키가 잡혔는지만 봅니다. 저장소 폴더에서 실행합니다.

```bash
python3 plugins/k-deal-skill/skills/korean-dart-research/scripts/dart_fetch.py env-status
```

```bash
python3 plugins/k-deal-skill/skills/krx-market-data/scripts/krx_fetch.py env-status
```

```bash
python3 plugins/k-deal-skill/skills/korean-public-data/scripts/api_fetch.py status
```

```bash
python3 plugins/k-deal-skill/skills/korean-law-search/scripts/law_fetch.py env-status
```

**AI에게 물어보기.** Claude Code나 Codex에서 평소처럼 질문합니다. 예를 들어 "DART에서 에이피알 고유번호 찾고 2025년 사업보고서 최대주주 현황 보여줘"라고 묻습니다. AI가 스킬을 골라 스크립트를 실행하고, 답에 출처와 기준일을 붙입니다.

## 6. 문제 해결

### 설치·실행 환경

| 증상 | 원인 | 조치 |
|---|---|---|
| AI가 스킬을 안 쓰고 기억으로 답함 | 플러그인 미설치, 재시작 안 함 | `claude plugin list`로 확인, Claude Code 재시작. 질문에 "DART에서 조회해서"처럼 자료원을 적기 |
| 키를 넣었는데 `not_connected` | 터미널·앱을 다시 열지 않음, 오타 | 새 터미널에서 `env-status` 확인. 데스크톱 앱은 완전히 종료 후 재실행 |
| `python3: command not found` 또는 문법 오류 | Python 없음, 3.10 미만 | `python3 --version` 확인 후 3.10 이상 설치 |
| 웹 대화창에서 "네트워크에 접근할 수 없다" | 샌드박스 외부 접속 제한 | Claude Code·Codex 같은 로컬 도구 사용 |

### 자료원별

| 자료원 | 증상 | 조치 |
|---|---|---|
| DART | `dart_020` | 그 키의 하루 한도 초과. 자정 이후 재시도 |
| DART | 연결 끊김, 응답 없음 | 몰아 부르기로 IP 차단(최대 약 1시간). **20분 이상 기다린 뒤** 한 번만 확인. 재시도가 차단을 늘림 |
| DART | 회사를 못 찾음 | 고유번호(8자리)·종목코드(6자리)로 다시. 비상장사는 정확한 법인명으로 |
| KRX | `not_approved` | 그 서비스의 이용신청 미승인. openapi.krx.co.kr 마이페이지에서 서비스별 신청 |
| KRX | 결과 0건 | 휴장일이거나 그날 자료가 아직 없음. 직전 영업일로 다시 |
| data.go.kr | `public_data_error`, 인증 오류 | 그 서비스 활용신청이 승인되지 않았거나 키를 인코딩값으로 넣음. `DATA_GO_KR_KEY`에는 디코딩값 |
| data.go.kr | 하루 100건에서 막힘 | 개발계정 한도. 운영계정 전환 신청 |
| 법제처 | `law_api_rejected`, `law_api_non_json` | 지금 PC의 공인 IP가 OC 신청 때 등록한 IP와 다름. open.law.go.kr에서 IP 추가 |
| 법제처 | `not_found` | 법령·판례 번호가 틀렸거나 그 기준일에 시행된 판이 없음. 검색부터 다시 |
| 법제처 | "OC를 발급하라" 안내 | OC 없음 + 공용 법령 연결 주소 없음. OC를 발급하거나 서버 공개 후 업데이트 |
| 법제처 | HTTP 429 | 공용 법령 연결의 IP별 한도 초과. 잠시 뒤 재시도하거나 OC 발급 |

오류는 "자료가 없다"는 뜻이 아닙니다. AI가 오류를 0건으로 요약하면 원문 오류를 다시 보여 달라고 요청합니다.

## 7. 유지보수

### 고칠 곳

| 하고 싶은 일 | 고칠 곳 |
|---|---|
| AI의 조회 순서·표기 규칙 변경 | `plugins/k-deal-skill/skills/<스킬>/SKILL.md` |
| 조회 기능 수정 | 같은 폴더의 `scripts/*.py` |
| DART 보고서·KRX 서비스·data.go.kr 서비스·법제처 API 목록 | 같은 폴더의 `references/*.json` (코드 수정 없이 반영) |
| 공용 법령 연결 주소 | `korean-law-search/scripts/mcp_http.py`의 `PUBLIC_LAW_ENDPOINT` |
| 버전 올리기 | `plugins/k-deal-skill/plugin.json`, `plugins/k-deal-skill/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` 세 곳을 같은 번호로 |

### 고친 뒤 확인

```bash
python3 -m unittest discover -s tests
```

```bash
python3 tools/package.py
```

- 테스트 74개는 네트워크·실제 키 없이 돕니다.
- GitHub에 올리면 같은 검사가 자동으로 돕니다(`.github/workflows/validate.yml`).
- 실제 기관 호출로 확인했다면 날짜와 함께 [docs/acceptance.md](docs/acceptance.md)나 커밋 메시지에 적습니다.
- AI 에이전트로 작업할 때 지켜야 할 규칙은 [AGENTS.md](AGENTS.md)에 있습니다.

### 서버판과 같이 고쳐야 하는 파일

이 저장소와 운영자 서버판(비공개)은 실행할 때 서로의 코드를 쓰지 않습니다. 대신 서버판에 이 저장소 스크립트의 사본과, 같은 법령 조회 로직을 다른 언어(Node)로 구현한 코드가 있습니다. 아래 파일을 고치면 서버판에도 같은 수정이 필요한지 확인합니다.

| 이 저장소 | 서버판 대응 |
|---|---|
| `korean-law-search/scripts/law_fetch.py` | 서버 `law-direct.mjs` (같은 동작) |
| `korean-law-search/scripts/mcp_http.py` | 플러그인 사본 (클라이언트 이름 줄만 다름) |
| `*/scripts/source_credentials.py` | 플러그인 사본 (제품 이름만 다름) |
| `references/law-apis.json`, `references/datago-apis.json` | 서버 카탈로그 (같은 파일) |
| `dart_fetch.py`, `krx_fetch.py`, `api_fetch.py` | 플러그인 사본 (이미 갈라짐. 공개판이 앞섬) |

## 8. 기술 상세

### 폴더

| 경로 | 내용 |
|---|---|
| `plugins/k-deal-skill/skills/` | 스킬 4개 (설명서, 스크립트, API 목록) |
| `.claude-plugin/`, `.agents/plugins/` | Claude Code·Codex 마켓플레이스 정의 |
| `tools/package.py` | 배포용 ZIP 생성과 구성 점검 |
| `tools/connect_existing_mcp.py` | 기존 MCP 설정 파일 경로 등록 |
| `tests/` | 네트워크 없는 단위 테스트 |
| `docs/` | [재사용 출처](docs/provenance.md), [수용 시험](docs/acceptance.md) |

### 스크립트 명령

| 스크립트 | 명령 |
|---|---|
| `dart_fetch.py` | `env-status`, `corp-code`, `disclosures`, `financials`, `reports`, `report`, `search-xbrl` |
| `krx_fetch.py` | `env-status`, 종목 기본·일별, `apis`, `daily` |
| `api_fetch.py` | `status`, `catalog`, `call`, `biz-status`, `customs`, 금융위 조회 |
| `law_fetch.py` | `env-status`, `search-law`, `law-text`, `decisions`, `decision-text`, `catalog`, `api` |
| `mcp_http.py` | 공용 법령 연결 클라이언트: `initialize`, `tools-list`, `search-law`, `law-text`, `call` |

각 명령의 사용법은 `python3 <스크립트> <명령> --help`로 봅니다.

### 확인 기록

- **2026-11-03 실제 키로 호출 확인**
  - DART: 회사코드, 최대주주, 유상증자 결정
  - KRX: 종목 시세, 지수 시리즈, 미승인 서비스 거절
  - data.go.kr: 금융위 개요, 국세청 상태, 국민연금 사업장
  - 법제처: 법령 검색, 조문, 판례, 카탈로그 API
- **2026-11-03 공용 법령 연결(`/law`)**: 운영자 서버 로컬에서 법령 검색·조문·판례 조회를 확인했습니다.

### 출처와 라이선스

- API 이름은 2026-10-26 실제 호출로 확인했습니다.
- 법제처 Open API 159개 명세는 [lexguard-mcp](https://github.com/SeoNaRu/lexguard-mcp)(MIT, Copyright (c) 2026 SeoNaRu)의 크롤링 결과를 정리했습니다.
- 판례·결정례 분야 매핑은 [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)(MIT)를 참고했습니다.
- 재사용 범위는 [docs/provenance.md](docs/provenance.md)에 있습니다.

이 저장소 자체의 라이선스는 아직 정하지 않았습니다.
