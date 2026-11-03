# 재사용 출처

외부 MCP 패키지의 배포 파일을 통째로 넣지 않았다. 원천 API 계약을 구현한 표준 라이브러리 클라이언트를 쓰고, 법령은 OC가 없을 때만 공개 원격 서버를 호출한다.

| 부분 | 근거 | 재사용·변경 내용 |
|---|---|---|
| DART | 이전에 쓰던 `korean-dart-research` 스킬과 `dart_fetch.py`, [OpenDART 개발가이드](https://opendart.fss.or.kr/guide/main.do) | 법인 식별·공시·CFS/OFS·XBRL 절차를 휴대 가능하게 조정. 설정 파일 자동 탐색 제거. 보고서 75종 카탈로그(`references/dart-reports.json`)는 2026-10-26 실제 호출로 이름 확인 |
| KRX | [korea-stock-mcp](https://github.com/jjlabsio/korea-stock-mcp) 1.4.1의 공식 KRX 호출 계약, [KRX Open API](https://openapi.krx.co.kr/) 서비스 목록 | 일별·종목기본정보 호출 계약 사용. 31개 서비스 ID(`references/krx-apis.json`)는 2026-10-26 미등록 ID 404, 미승인 401로 구분해 확인 |
| 공공데이터 | data.go.kr 서비스 명세 | 금융위·관세청 응답 파싱·페이지·오류 구분. 19개 서비스 카탈로그(`references/datago-apis.json`)는 2026-10-26 호출 결과와 응답 필드를 기록. DB·캐시·키 제외 |
| 법령 | [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)(MIT), [lexguard-mcp](https://github.com/SeoNaRu/lexguard-mcp)(MIT) | 원격 서버 클라이언트(`mcp_http.py`)와 판례·결정례 분야 → DRF target 매핑은 korean-law-mcp 기준. 법제처 API 159개 명세(`references/law-apis.json`)는 lexguard-mcp 크롤링 결과를 정리. 직접 조회 클라이언트(`law_fetch.py`)는 자체 작성 |

카탈로그의 확인 날짜는 기록 시점의 값이다. API 결과, 원격 서버 버전, 자료 기준일, 패키지 버전은 각각 구분한다.
