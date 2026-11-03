# 에이전트 작업 지침 (k_deal_skill)

공개 저장소다. 사람이 읽는 개요·설치·문제 해결은 [README.md](README.md)에 있다. 이 파일은 AI 에이전트가 이 저장소를 고칠 때 지킬 규칙만 담는다.

## 공개 저장소 주의

- 누구나 읽는다. 운영자 키, 서버 운영 설정(토큰·고객사·비밀 경로·도메인 내부 설정), 고객사 이름·정보, 개인 PC 경로, 회사 도메인을 넣지 않는다.
- 운영자 키로 대신 조회해 주는 프록시를 넣지 않는다(KRX 약관의 제3자 제공·상업 이용 금지, DART 키 한도·IP 차단).
- 외부 패키지는 `fast-xml-parser` 하나뿐이다. 늘리지 않는다.

## 이 저장소의 원본

이 저장소는 운영자 비공개 저장소의 `selfhost/` 폴더를 `git subtree push`로 내보낸 것이다. 조회 코드(`plugins/k-deal-skill/core/`)는 호스팅 서버가 그대로 import해 쓰는 같은 파일이다.

- 스킬 `skills/*/SKILL.md`는 운영자 저장소의 호스팅판 스킬에서 생성한다(연결 문구만 다름). 이 저장소에서 직접 고치면 다음 내보내기 때 덮어써진다.
- 이 저장소에 직접 커밋이 생기면 운영자 저장소에서 `git subtree pull`로 먼저 받아야 다음 내보내기가 된다.

## 비밀값

- 사용자 환경변수의 키 값을 출력·인용하지 않는다. 확인은 `mrm_connection_status`(값 없이 유무만)로 한다.
- 테스트는 가짜 키와 가짜 응답을 쓰고 네트워크를 쓰지 않는다.
- 커밋 전에 변경분에서 키 형태 문자열과 회사 도메인을 검색한다.

## Git

- 커밋·푸시는 사용자가 요청할 때만 한다.
- 버전은 `plugins/k-deal-skill/plugin.json`, `plugins/k-deal-skill/.claude-plugin/plugin.json`, `plugins/k-deal-skill/package.json`, `.claude-plugin/marketplace.json` 네 곳을 같은 번호로 올린다.

## 고친 뒤 확인

```bash
cd plugins/k-deal-skill && npm ci && npm test
claude plugin validate .
```
