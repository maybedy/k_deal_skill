# 재사용 출처

외부 MCP 패키지의 코드나 배포 파일을 넣지 않았다. 원천 API 계약을 직접 구현했고, 외부 공개 법령 서버나 운영자 서버를 호출하지 않는다.

| 부분 | 근거 | 재사용·변경 내용 |
|---|---|---|
| DART | [OpenDART 개발가이드](https://opendart.fss.or.kr/guide/main.do), [korea-stock-mcp](https://github.com/jjlabsio/korea-stock-mcp)(MIT) 1.4.1 | 보고서 79종 카탈로그는 실제 호출로 이름 확인. 공시 원문 목차·장절 조회(`dart_document`의 `toc`·`section_id`)는 korea-stock-mcp의 설계를 참고해 자체 작성. 감사보고서 재무제표 표 파싱(`dart-audit.mjs`)은 자체 작성 |
| KRX | korea-stock-mcp의 공식 KRX 호출 계약, [KRX Open API](https://openapi.krx.co.kr/) 서비스 목록 | 31개 서비스 ID는 미등록 404, 미승인 401로 구분해 확인 |
| 공공데이터 | data.go.kr 서비스 상세 페이지와 내장 명세(swagger) | 29개 서비스 카탈로그(`core/catalog/datago-apis.json`)는 상세 페이지 명세와 실제 호출 결과로 작성 |
| 법령 | [korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)(MIT, v4.15.22 확인 2026-11-03), [lexguard-mcp](https://github.com/SeoNaRu/lexguard-mcp)(MIT) | 판례·결정례 분야 → DRF target 매핑과 분석 도구 구성은 korean-law-mcp 기준, 코드는 자체 작성. 법제처 API 159개 명세(`core/catalog/law-apis.json`)는 lexguard-mcp 크롤링 결과를 정리 |

카탈로그의 확인 날짜는 기록 시점의 값이다. API 결과, 자료 기준일, 패키지 버전은 각각 구분한다.
