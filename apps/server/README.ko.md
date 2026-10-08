# @tdm/server

[English](README.md) | 한국어

td-export 정의서(.sql/.md)를 버전으로 관리하고, 두 버전의 diff와 DDL을 제공하는 API 서버입니다. 파싱·diff·DDL 생성은 `@tdm/core`가 담당합니다.

## 실행

```bash
npm install                                         # 저장소 루트에서
npm run create-admin -w @tdm/server -- admin       # 최초 관리자 (비밀번호는 프롬프트로 입력)
npm run dev -w @tdm/server                          # http://127.0.0.1:3000
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `HOST` | `127.0.0.1` | 바인딩 주소 |
| `PORT` | `3000` | 포트 |
| `DATA_DIR` | `./data` | SQLite 파일(`tdm.db`) 위치 |
| `COOKIE_SECURE` | `true` | 평문 HTTP로 접속할 때만 `false`로 설정(로컬 개발, 또는 `127.0.0.1`에만 바인딩하는 `docker/compose.yaml`). LAN에 열 때 권장하는 HTTPS 리버스 프록시 뒤에서는 `true`로 둡니다. localhost가 아닌 주소로 접속하면 Secure 쿠키가 전송되지 않습니다. `false`이면 HSTS와 `upgrade-insecure-requests`도 꺼집니다 |
| `WEB_DIST` | `<cwd>/../web/dist` | 빌드된 웹(`apps/web/dist`) 위치. 루트에서 `npm start` 하면 기본값 그대로 동작합니다. 웹을 다시 빌드하면 서버를 재시작해야 반영됩니다 |
| `TRUST_PROXY` | `false` | 리버스 프록시 뒤에서 `X-Forwarded-For`를 신뢰할 범위. `true`/`false`, 홉 수(예: `1`), 또는 쉼표로 구분한 IP/CIDR 목록(예: `10.0.0.0/8,127.0.0.1`) |

## 운영(리버스 프록시)

nginx·ALB 같은 리버스 프록시 뒤에 두면 모든 요청의 소켓 주소가 프록시 IP가 되어, 로그인 rate limit(분당 5회)이 접속자 전체에 하나로 적용됩니다. 이때 공격자 한 명이 실패를 반복하면 모든 사용자가 로그인할 수 없게 됩니다.

- 프록시가 `X-Forwarded-For`를 덧붙이도록 설정하고, 서버에는 `TRUST_PROXY`로 신뢰할 프록시를 알려 주세요. 홉 수(`1`) 또는 프록시 IP/CIDR 지정을 권장합니다.
- 프록시를 거치지 않고 서버에 직접 접근할 수 있는 상태에서 `TRUST_PROXY=true`로 모두 신뢰하면 클라이언트가 `X-Forwarded-For`를 위조해 제한을 우회할 수 있습니다. 서버 포트는 프록시에서만 접근되게 막으세요.
- 로그인 제한 키는 `IP:사용자명`(사용자명은 소문자)이라 같은 NAT 뒤의 다른 사용자는 서로 영향을 주지 않습니다.

## API 요약

모든 경로는 `/api` 아래에 있습니다. 상태를 바꾸는 요청에는 `X-Requested-With: tdm` 헤더가 있어야 합니다.

| 메서드 | 경로 | 권한 |
|---|---|---|
| POST | `/auth/login`, `/auth/logout` · GET `/auth/me` | — / 로그인 |
| GET·POST·PATCH | `/users[/:id]` | admin |
| GET | `/tree`, `/schemas/:id`, `/schemas/:id/versions` | 로그인 |
| POST·PATCH·DELETE | `/databases[/:id]` (삭제 시 `confirmName` 필요) | admin |
| DELETE | `/schemas/:id` (`confirmName` 필요, 버전·객체 이력까지 연쇄 삭제) | admin |
| POST | `/uploads` (multipart: `meta` JSON + `files`) | admin |
| GET | `/versions/:id`, `/versions/:id/source` | 로그인 |
| DELETE | `/versions/:id` | admin |
| GET | `/diff?base=&target=` · PUT `/diff/renames` | 로그인 |
| GET | `/objects/:id/history` | 로그인 |
| POST | `/migrations` (JSON: `fromSchemaId`, `toSchemaId`, `filename`, `source`, `note?`, 파싱 경고를 함께 돌려줌) · DELETE `/migrations/:id` | admin |
| GET | `/migrations?from=&to=`, `/migrations/:id/source`, `/migration-flow?base=&target=` | 로그인 |

`PUT /diff/renames`(rename 매핑 저장)는 viewer를 포함한 로그인 사용자 모두에게 열려 있습니다. 설계서에서 정한 정책입니다.

전환 매핑은 Schema 쌍(As-Is → To-Be)에 붙습니다. 같은 쌍에 다시 올리면 리비전이 늘고, BASE 버전이 From Schema, TARGET 버전이 To Schema 에 속하면 최신 리비전이 자동 적용됩니다(역방향에는 적용하지 않음). `GET /diff` 의 `renames` 항목에는 `source: 'dms' | 'manual'` 이 붙습니다. `PUT /diff/renames` 는 수동 rename 만 저장하며, DMS 에서 온 rename 과 같은 항목은 500개 한도를 적용하기 전에 서버가 거릅니다.

## 테스트

```bash
npm test -w @tdm/server
npm run typecheck -w @tdm/server
```
