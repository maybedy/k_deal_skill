# 에이전트 작업 지침 (k_deal_skill)

공개 스킬 저장소다. 사람이 읽는 개요·설치·문제 해결은 [README.md](README.md)에 있다. 이 파일은 AI 에이전트가 이 저장소를 고칠 때 지킬 규칙만 담는다.

## 공개 저장소 주의

- 누구나 읽는다. 운영자 키, 서버 내부 설정, 고객사 이름·정보, 개인 PC 경로, 회사 도메인, 비공개 저장소의 내부 문서를 넣지 않는다.
- 운영자 키로 대신 조회해 주는 프록시를 넣지 않는다(KRX 약관의 제3자 제공·상업 이용 금지, DART 키 한도·IP 차단, 법제처 OC IP 등록). 예외는 법령 전용 공용 연결 `/law` 하나다.
- 스크립트는 Python 3.10 이상 표준 라이브러리만 쓴다. 외부 패키지를 추가하지 않는다.

## 관련 저장소

운영자 서버판은 별도 비공개 저장소다. 로컬 경로는 작업 PC마다 다르므로 사용자에게 확인한다. 실행할 때 서로의 코드를 쓰지 않는다. 서버판의 워크스페이스용 스킬은 서버 도구만 쓰는 설명서라 이 저장소의 사본이 아니다. 아래 파일만 서버판에 같은 로직이나 같은 파일이 있어, 고치면 서버판도 확인한다(README 7장 표).

- `korean-law-search/scripts/law_fetch.py` ↔ 서버 `server/law-direct.mjs`: 같은 동작, 양쪽 테스트 추가
- `references/law-apis.json`, `references/datago-apis.json` ↔ 서버 `server/catalog/`: 같은 파일

`/law` 응답 형식을 바꾸는 작업은 서버를 먼저 고쳐 배포한 뒤 이 저장소를 배포한다.

## 비밀값

- 사용자 환경변수의 키 값을 출력·인용하지 않는다. 확인은 `env-status`·`status`(값 없이 유무만)로 한다.
- 테스트는 가짜 키와 가짜 응답을 쓰고 네트워크를 쓰지 않는다.
- 커밋 전에 변경분에서 키 형태 문자열과 회사 도메인을 검색한다.

## Git

- 커밋·푸시는 사용자가 요청할 때만 한다.
- 버전은 `plugins/k-deal-skill/plugin.json`, `plugins/k-deal-skill/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` 세 곳을 같은 번호로 올린다. 동작이 바뀌면 해당 `SKILL.md`의 `metadata.version`도 올린다.

## 고친 뒤 확인

```bash
python3 -m unittest discover -s tests
python3 tools/package.py
```

README의 테스트 수와 확인 기록 날짜를 같이 갱신한다.

## 원천 API 호출

- 실제 키로 확인할 때는 최소 건수로 한다.
- DART: 분당 100회 이하. 연결 끊김이면 IP 차단이므로 20분 이상 간격으로만 재확인한다.
- data.go.kr·open.law.go.kr·KRX 사이트에 로그인하거나 신청 양식을 제출하지 않는다.
- 오류·거절을 0건으로 바꾸지 않는다. 응답에 원천 주소, 요청 파라미터, 조회 시각을 남긴다.

## 코드 출처와 라이선스

- 외부 MCP 저장소는 설계만 참고하고 코드를 복사하지 않는다. 참고한 경우 [docs/provenance.md](docs/provenance.md)에 적는다.
- 라이선스 파일을 임의로 추가하지 않는다. 사용자가 정할 미결 사항이다.
