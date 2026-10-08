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

## 운영(백업과 스키마 업그레이드)

- **백업**: `npm run backup -w @tdm/server -- <경로>` 는 `VACUUM INTO` 로 일관된 스냅샷을 만듭니다. 서버가 실행 중이어도 안전하고, 이미 있는 파일은 덮어쓰지 않습니다. Docker 에서는 `docker compose -f docker/compose.yaml exec app node --import tsx src/cli/backup.ts /data/backup-YYYYMMDD.db`. 서버 실행 중에 `tdm.db` 만 복사하면 안 됩니다 — 최근 커밋이 아직 `tdm.db-wal` 에 있을 수 있습니다.
- **스키마 업그레이드**: `src/db/migrations/NNN_*.sql` 을 기동 시 `PRAGMA user_version` 기준으로 적용합니다. 첫 줄이 `-- foreign_keys: off` 인 파일은 외래 키를 끈 채(테이블 재생성용) 실행하고, 커밋 전에 `PRAGMA foreign_key_check` 로 검증한 뒤 `VACUUM` 합니다. 업그레이드 전에 백업하세요.
- 마이그레이션 003(스키마 v3)은 사용자 계정을 보존하고(대소문자만 다른 사용자명은 먼저 만든 것만 남김), 모든 세션을 끊으며, **업로드 데이터**(Database·Schema·버전·rename·DMS 매핑)를 **비웁니다**. 정의서를 다시 올리세요.
- DB 의 `user_version` 이 서버가 아는 최신 마이그레이션보다 크면(구 버전 이미지로 내려간 경우 등) 기동을 거부합니다. 그 버전에서 받아 둔 백업으로 복원하세요.
- 연결 설정: WAL, `synchronous=NORMAL`, `journal_size_limit=64MB`, `busy_timeout=5000`, `foreign_keys=ON`. 종료 시 `PRAGMA optimize` 를 실행합니다.

## API 요약

모든 경로는 `/api` 아래에 있습니다. 상태를 바꾸는 요청에는 `X-Requested-With: tdm` 헤더가 있어야 합니다.

| 메서드 | 경로 | 권한 |
|---|---|---|
| POST | `/auth/login`, `/auth/logout` · GET `/auth/me` | — / 로그인 |
| GET·POST·PATCH | `/users[/:id]` | admin |
| GET | `/tree`, `/schemas/:id`, `/schemas/:id/versions` | 로그인 |
| POST·PATCH·DELETE | `/databases[/:id]` (삭제 시 `confirmName` 필요) | admin, dba |
| DELETE | `/schemas/:id` (`confirmName` 필요, 버전·객체 이력까지 연쇄 삭제) | admin, dba |
| POST | `/uploads` (multipart: `meta` JSON + `files`) | admin, dba |
| GET | `/versions/:id`, `/versions/:id/source` | 로그인 |
| DELETE | `/versions/:id` | admin, dba |
| GET | `/diff?base=&target=` | 로그인 |
| PUT | `/diff/renames` | admin, dba |
| GET | `/objects/:id/history` | 로그인 |
| POST | `/migrations` (JSON: `fromSchemaId`, `toSchemaId`, `filename`, `source`, `note?`, 파싱 경고를 함께 돌려줌) · DELETE `/migrations/:id` | admin, dba |
| GET | `/migrations?from=&to=`, `/migrations/:id/source`, `/migration-flow?base=&target=` | 로그인 |

역할: `admin`(계정 관리 포함 전부), `dba`(데이터 변경 전부), `viewer`(읽기 전용). `PUT /diff/renames`(rename 매핑 저장)는 admin·dba 만 할 수 있으며, 권한은 본문을 파싱하기 전(`onRequest`)에 확인하므로 viewer 는 본문을 읽기 전에 403 을 받습니다. BASE 와 TARGET 이 같은 버전이면 400 입니다.

전환 매핑은 Schema 쌍(As-Is → To-Be)에 붙습니다. 같은 쌍에 다시 올리면 리비전이 늘고, BASE 버전이 From Schema, TARGET 버전이 To Schema 에 속하면 최신 리비전이 자동 적용됩니다(역방향에는 적용하지 않음). `GET /diff` 의 `renames` 항목에는 `source: 'dms' | 'manual'` 이 붙습니다. `PUT /diff/renames` 는 수동 rename 만 저장하며, DMS 에서 온 rename 과 같은 항목은 500개 한도를 적용하기 전에 서버가 거릅니다.

## 테스트

```bash
npm test -w @tdm/server
npm run typecheck -w @tdm/server
```
