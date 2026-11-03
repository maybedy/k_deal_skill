# k-deal-skill

한국 기업·딜 리서치에 쓰는 공식 원천자료를 Claude Code·Codex 같은 AI 도구에서 조회하게 해 주는 무료 MCP와 스킬 묶음입니다. 대상 자료는 DART 공시·재무제표(비상장 외감 법인의 감사보고서 재무 포함), KRX 시세, 금융위·관세청·국세청 등 data.go.kr 공공데이터, 법제처 법령·판례입니다. 각자 PC에서 실행되고, API 키도 각자 발급해 각자 PC에 둡니다.

**0.4.0 변경:** 파이썬 스크립트를 없애고, 호스팅 서비스(Market Research)와 같은 Node 조회 코드를 로컬 MCP로 띄우는 방식으로 바꿨습니다. 도구 이름과 동작이 호스팅판과 같습니다.

## 시작 전 준비사항

**필요한 것**

- MCP를 쓰는 로컬 AI 도구: Claude Code(터미널, 데스크톱 앱 Code 탭, VS Code) 또는 Codex
- Node.js 22.13 이상과 npm: `node --version`으로 확인합니다. 첫 실행 때 필요한 패키지 하나(`fast-xml-parser`)를 자동으로 설치합니다.
- 쓰려는 자료원의 API 키: 모두 무료입니다. 필요한 것만 받으면 됩니다.

**환경값.** 받은 키는 셸 설정 파일(macOS는 보통 `~/.zshrc`)에 `export 이름=값`으로 넣고 터미널과 AI 도구를 새로 엽니다. 채팅창이나 명령 인자에는 넣지 않습니다.

| 환경값 이름 | 넣는 값 | 없으면 |
|---|---|---|
| `DART_API_KEY` | OpenDART 인증키 40자리(`OPENDART_API_KEY`도 읽음) | DART 도구가 `not_connected` |
| `KRX_API_KEY` | KRX Open API 인증키. 쓸 서비스마다 이용신청 승인 필요 | KRX 도구가 `not_connected` |
| `DATA_GO_KR_KEY` 또는 `DATA_GO_KR_KEY_ENC` | data.go.kr 일반 인증키 디코딩값 또는 인코딩값. 둘 다 있으면 인코딩값을 씀 | 금융위·관세청·국세청·data.go.kr 도구가 `not_connected` |
| `LAW_OC` | 법제처 OC(신청 때 정한 값) | 법령 도구가 `not_connected` |
| `MRM_DATAGO_DB` (선택) | 국민연금·통신판매·HS 공공데이터 스냅샷 SQLite 경로 | 회사 찾기 도구(`company_search` 등)가 목록에 나오지 않음 |

## 1. 할 수 있는 일

| 자료원 | 도구 예 | 내용 |
|---|---|---|
| DART | `dart_corp_search`, `dart_financials`, `dart_audit_financials`, `dart_report`, `dart_disclosures`, `dart_document`, `dart_xbrl` | 회사 고유번호, 연결/별도 재무제표, **비상장 외감 법인 감사보고서 재무제표**, 정기보고서 항목·주요사항보고서 79종, 전체 시장 공시 검색, 공시 원문 목차·장절·단어 검색, XBRL 주석 검색 |
| KRX | `krx_base`, `krx_trade`, `krx_daily` | 종목 기본정보, 일별 시세·시가총액·상장주식수, 지수·ETF·채권·파생 등 Open API 31종 |
| 공공데이터 | `fsc_outline`, `fsc_financials`, `fsc_affiliates`, `biz_status`, `customs_trade`, `datago_catalog`, `datago_api` | 금융위 기업개요·요약재무·계열사, 국세청 휴폐업, 관세청 수출입, data.go.kr 서비스 29개(신청한 서비스만 응답) |
| 법제처 | `law_search`, `law_text`, `law_applicable`, `law_annexes`, `law_compare_dates`, `law_verify_citations` 등 | 조문(기준일 시행본), 경과조치, 별표, 두 시점 비교, 신·구조문대비표, 인용 검증, 판례·해석례, Open API 159개 |

모든 도구는 읽기 전용입니다. 응답에는 원천 주소, 자료 기준일, 연결/별도 기준, 일부 결과 여부가 붙습니다.

## 2. API 키 발급

| 자료원 | 신청처 | 알아둘 점 |
|---|---|---|
| OpenDART | [opendart.fss.or.kr](https://opendart.fss.or.kr/) → 인증키 신청 | 즉시 발급. 하루 20,000건. 짧은 시간에 몰아서 호출하면 IP가 약 1시간 차단됩니다 |
| KRX Open API | [openapi.krx.co.kr](https://openapi.krx.co.kr/) → 인증키 신청 → 서비스별 이용신청 | 서비스마다 승인이 따로 필요합니다. 약관상 비상업적 이용만 가능합니다 |
| 공공데이터포털 | [data.go.kr](https://www.data.go.kr/) → 쓰려는 서비스마다 활용신청 | 키 하나로 승인받은 서비스만 호출됩니다. 개발계정은 서비스별 하루 100~10,000건 |
| 법제처 | [open.law.go.kr](https://open.law.go.kr/) → OPEN API 신청 | 신청 화면의 안내에 따라 OC와 (필요하면) 호출할 PC의 IP를 등록합니다 |

## 3. 설치

### Claude Code

```bash
claude plugin marketplace add maybedy/k_deal_skill
claude plugin install k-deal-skill@k-deal-skill
```

Claude Code를 다시 시작하면 `k-deal-skill` MCP와 스킬 4개가 함께 켜집니다. MCP는 플러그인 안의 `local/launch.mjs`를 Node로 실행하고, 위 환경값을 셸에서 넘겨받습니다.

### Codex

저장소를 받아 둔 뒤 `~/.codex/config.toml`에 추가합니다(경로는 받아 둔 위치로).

```toml
[mcp_servers.k-deal-skill]
command = "node"
args = ["/경로/k_deal_skill/plugins/k-deal-skill/local/launch.mjs"]
env_vars = ["DART_API_KEY", "KRX_API_KEY", "DATA_GO_KR_KEY", "DATA_GO_KR_KEY_ENC", "LAW_OC"]
```

### 직접 실행

```bash
cd plugins/k-deal-skill && npm ci && npm start   # stdio로 MCP를 띄움
npm test                                          # 네트워크 없이 도는 테스트
```

## 4. 써 보기

- "DART에서 삼성전자 2025년 연결 재무제표를 조회해서 매출과 영업이익만 보여줘."
- "언일전자 2025년 감사보고서 재무상태표에서 자산총계를 확인해줘." (비상장 외감)
- "2026-10-30 기준 KRX 종가와 시가총액을 확인해줘."
- "상법 제382조의 2020년 1월 1일 시행 당시 문구와 현행을 비교해줘."

처음에는 `mrm_connection_status`로 어떤 키가 잡혔는지(값 없이 유무만) 확인할 수 있습니다.

## 5. 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| 도구가 안 보임 | 플러그인 미설치, 재시작 안 함, Node 없음 | `claude plugin list`, `node --version`(22.13 이상) 확인 후 재시작 |
| 첫 실행에서 실패 | npm 설치 실패(네트워크·권한) | `cd plugins/k-deal-skill && npm ci`를 직접 실행 |
| 키를 넣었는데 `not_connected` | 터미널·앱을 다시 열지 않음, 오타 | 새 터미널에서 AI 도구를 다시 실행. `mrm_connection_status`로 확인 |
| DART `rate_limited`(020) | 그 키의 하루 한도 초과 | 자정 이후 재시도 |
| DART 연결 끊김 | 단시간 대량 호출로 IP 차단(최대 약 1시간) | 20분 이상 기다린 뒤 한 번만 확인. 계속 다시 부르면 차단이 길어짐 |
| KRX `not_approved` | 그 서비스 이용신청 미승인 | openapi.krx.co.kr에서 서비스별 신청 |
| data.go.kr `not_registered` | 그 서비스 활용신청 안 함 | data.go.kr에서 서비스별 활용신청 |
| 법제처 `law_api_rejected` | OC 또는 등록 IP 불일치 | open.law.go.kr 신청 내용 확인 |

오류는 "자료가 없다"는 뜻이 아닙니다. AI가 오류를 "결과 없음"으로 요약하면 원문 오류를 다시 보여 달라고 요청합니다.

## 6. 구조와 유지보수

```
plugins/k-deal-skill/
  core/        조회 모듈(DART·KRX·법령·data.go.kr), MCP 처리, 카탈로그, 테스트
  local/       launch.mjs(첫 실행 설치) → stdio.mjs(로컬 MCP)
  skills/      스킬 4개(SKILL.md)
  .mcp.json    Claude Code용 MCP 선언
```

- 이 저장소는 호스팅 Market Research 서비스와 **같은 조회 코드**입니다. 운영자 저장소의 한 폴더를 `git subtree`로 내보낸 것이라, 변경은 운영자 저장소에서 먼저 반영된 뒤 이곳에 올라옵니다. 이슈와 제안은 이 저장소에 남겨 주세요.
- 호스팅판에만 있는 기능(토큰·고객사 한도·캐시·사용 기록, 회사 찾기용 공공데이터 스냅샷)은 이 저장소에 없습니다.

## 7. 출처와 라이선스

- 법제처 Open API 159개 명세는 [lexguard-mcp](https://github.com/SeoNaRu/lexguard-mcp)(MIT) 크롤링 결과를 정리했습니다. 판례·결정례 분야 매핑과 법령 분석 도구 구성은 [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)(MIT)를, 공시 원문 목차·장절 조회는 [korea-stock-mcp](https://github.com/jjlabsio/korea-stock-mcp)(MIT)를 참고했고 코드는 자체 작성했습니다. 자세한 내용은 [docs/provenance.md](docs/provenance.md).
- 이 저장소 자체의 라이선스는 아직 정하지 않았습니다.
