# k-deal-skill

한국 딜·기업 리서치용 원천자료(DART·KRX·data.go.kr·법제처)를 Claude Code·Codex에서 조회하는 스킬 묶음. 서버 없이 각자 PC에서 돌고, API 키도 각자 발급해 각자 환경변수에 둔다. 스크립트는 Python 3.10 이상 표준 라이브러리만 쓴다.

## 스킬 4개

| 스킬 | 스크립트 | 조회 범위 | 필요한 키 |
|---|---|---|---|
| korean-dart-research | `dart_fetch.py` | 회사코드, 공시 목록, 전체 재무제표, 공시 원문·XBRL, 보고서 75종(최대주주·임원·배당·자기주식·타법인출자·감사의견·5% 보유·유상증자·CB/BW·합병·분할·증권신고서 등) | `DART_API_KEY` |
| krx-market-data | `krx_fetch.py` | 종목 일별 시세·시가총액·상장주식수, 종목기본정보, KRX Open API 31종(지수·ETF/ETN·채권·파생·일반상품·ESG) | `KRX_API_KEY` |
| korean-public-data | `api_fetch.py` | 금융위 기업개요·요약재무·계열사, 관세청 품목·국가별 수출입, 카탈로그 19개 서비스 85개 오퍼레이션(예탁원 발행회사·주식, 국민연금 사업장, 공정위 통신판매 등), 국세청 사업자 상태 | `DATA_GO_KR_KEY` |
| korean-law-search | `law_fetch.py`, `mcp_http.py` | 법령 검색·조문(시행일 기준 포함), 판례·해석례·위원회 결정문, 법제처 Open API 159개. OC가 없으면 공개 원격 법령 MCP로 조회 | `LAW_OC` (선택) |

빈 결과와 오류를 구분한다. 승인되지 않은 서비스, 한도 초과, 인증 실패는 `error`로 돌려주고 0건으로 바꾸지 않는다. 응답에는 원천 주소, 요청 파라미터, 조회 시각을 남기며 키 값은 출력하지 않는다.

## 설치

Claude Code:

```bash
claude plugin marketplace add maybedy/k_deal_skill
```

```bash
claude plugin install k-deal-skill@k-deal-skill
```

Codex: 스킬 폴더를 `~/.codex/skills/`에 복사한다. 같은 이름의 스킬이 이미 있으면 덮어쓰지 말고 이름을 바꿔 넣는다.

```bash
git clone https://github.com/maybedy/k_deal_skill.git && cp -R k_deal_skill/plugins/k-deal-skill/skills/* ~/.codex/skills/
```

ChatGPT·Codex 워크스페이스 관리자는 `.agents/plugins/marketplace.json`을 쓰거나 `python3 tools/package.py`로 만든 ZIP을 올린다. 워크스페이스 웹 환경에는 사용자 PC의 환경변수가 없으므로, 키를 넣을 수 있는 코드 실행 환경에서만 스크립트가 돈다.

## API 키 발급과 설정

| 자료원 | 신청처 | 비고 |
|---|---|---|
| OpenDART | [opendart.fss.or.kr](https://opendart.fss.or.kr/) 인증키 신청 | 무료, 즉시 발급. 하루 20,000건. 분당 1,000건 안팎으로 몰아 부르면 IP가 1시간 차단된다 |
| KRX Open API | [openapi.krx.co.kr](https://openapi.krx.co.kr/) 회원가입 후 인증키·서비스별 이용신청 | 서비스마다 따로 승인. 이용약관상 비상업적 이용만 가능하고 제3자에게 대가를 받을 수 없다 |
| 공공데이터포털 | [data.go.kr](https://www.data.go.kr/) 서비스별 활용신청 | 키 하나로 승인받은 서비스만 호출된다. 일부 개발계정은 하루 100건 |
| 법제처 | [open.law.go.kr](https://open.law.go.kr/) OPEN API 신청 | OC 발급 시 호출할 PC의 공인 IP·도메인을 등록해야 한다 |

키는 셸 프로필(예: `~/.zshrc`)에 환경변수로 둔다. 채팅이나 명령 인자에 넣지 않는다.

```bash
export DART_API_KEY=발급받은_키
export KRX_API_KEY=발급받은_키
export DATA_GO_KR_KEY=발급받은_일반인증키_디코딩값
export LAW_OC=발급받은_OC
```

이미 다른 MCP 설정(`.mcp.json`, Codex `config.toml`)에 키를 넣어 두었다면 `python3 tools/connect_existing_mcp.py --mcp-json <경로>`로 그 파일 경로만 등록할 수 있다. 등록 파일(`~/.config/k-deal-skill/connection.json`)에는 경로만 저장하고 키 값은 복사하지 않는다.

설정 확인(네트워크 호출 없음):

```bash
python3 plugins/k-deal-skill/skills/korean-dart-research/scripts/dart_fetch.py env-status
```

```bash
python3 plugins/k-deal-skill/skills/korean-law-search/scripts/law_fetch.py env-status
```

## 검증

```bash
python3 -m unittest discover -s tests
```

```bash
python3 tools/package.py
```

테스트 69개는 네트워크 없이 돈다. 2026-11-03 실제 키로 DART(회사코드·최대주주·유상증자 결정), KRX(종목 시세·지수 시리즈, 미승인 서비스 거절), data.go.kr(금융위 개요·국세청 상태·국민연금 사업장), 법제처(법령 검색·조문·판례·카탈로그 API)와 원격 법령 MCP 호출을 확인했다.

## 출처와 라이선스

API 이름은 2026-10-26 실제 호출로 확인했다. 법제처 Open API 159개 명세는 [lexguard-mcp](https://github.com/SeoNaRu/lexguard-mcp)(MIT, Copyright (c) 2026 SeoNaRu)의 크롤링 결과를, 판례·결정례 분야 매핑과 원격 법령 서버는 [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)(MIT)를 썼다. 재사용 범위는 [docs/provenance.md](docs/provenance.md).

이 저장소 자체의 라이선스는 아직 정하지 않았다.
