# Database Diff (MySQL ver.)

![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-22.13+-339933.svg)
![React](https://img.shields.io/badge/React-19.3-61DAFB.svg)
![Fastify](https://img.shields.io/badge/Fastify-5.12-000000.svg)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57.svg)
![MySQL](https://img.shields.io/badge/MySQL-8.0%20%7C%208.4-4479A1.svg)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)
![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-CI/CD-2088FF.svg)

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/teinam)

[English](README.md) | 한국어

[td-export](https://github.com/TeiNam/table-define-exporter)로 추출한 MySQL 스키마 정의서(`.sql`/`.md`)를 버전으로 쌓아 두고 관리하는 팀용 웹 도구입니다. 두 버전 사이에 무엇이 바뀌었는지 보여 주고, 그 변경을 만드는 MySQL 8.0/8.4 DDL을 생성합니다. DDL은 화면에 보여 주고 복사·다운로드만 하며, DB에 직접 실행하지 않습니다.

## 주요 기능

- **버전 관리**: Database(물리 엔진 인스턴스) → Schema 단위로 정의서를 업로드해 버전을 쌓습니다. 내용이 직전 버전과 같으면 새 버전을 만들지 않습니다.
- **ALTER 적용**: 저장된 SQL 버전에 ALTER 스크립트를 붙여 넣거나 올려, td-export를 다시 뽑지 않고 다음 버전을 만듭니다 (컬럼·인덱스·FK·테이블 옵션·CREATE/DROP/RENAME TABLE·루틴. 결과는 CI에서 실제 MySQL 8.0/8.4와 비교해 검증합니다). 범위와 한계는 [ALTER 적용](#alter-적용)을 참고하세요.
- **비교**: 요약, 객체별 diff(SQL Split/Unified, Excel 같은 표 보기), 변경 객체만 거르는 트리.
- **HTML 리포트**: 지금 보는 비교(요약과 객체 diff, 고른 보기 방식)를 HTML 파일 하나로 내려받습니다. 이 도구에 접속하지 않고 열 수 있고, 공유·보관·인쇄(브라우저 인쇄로 PDF)할 수 있습니다.
- **DDL 생성**: 테이블·컬럼·인덱스·FK·뷰·파티션·저장 함수/프로시저 변경을 ALTER/CREATE/DROP으로 만들고, 반대 방향(되돌리기) DDL도 함께 제공합니다. rename은 화면에서 매핑합니다. 맞바꾸기·연쇄(a↔b, a→b→c, 테이블 교체)는 한 `RENAME TABLE` 문장이나 한 ALTER 의 `RENAME COLUMN` 절로 만들고, 한 방향에 저장한 수동 rename 은 반대 방향 비교에 뒤집어 반영합니다.
- **DB 전환 매핑**: As-Is → To-Be Schema 쌍에 AWS DMS table-mapping JSON 을 올리면, 전환 탭에 테이블·컬럼 대응과 상태를 보여 주고 같은 매핑을 rename 으로 객체 diff·DDL 에 반영합니다. 같은 대상에 대한 수동 rename 매핑이 우선합니다.
- **이력**: 버전 이력, 객체별 변경 이력, 원본 파일 다운로드.
- **계정**: admin / dba / viewer 세 역할. 다크·라이트 테마.

## 입력 파일

| 항목 | 내용 |
|---|---|
| 지원 버전 | td-export 0.1.15 ~ 0.1.52의 MySQL 출력 (파일마다 형식을 판별, 0.1.30 ~ 0.1.36 사이 MySQL 출력은 같음) |
| 완전성 확인 | TARGET 에 없다는 이유로 나오는 객체·컬럼·파티션 삭제 문장은 TARGET 이 완전한 덤프임을 확인할 수 있을 때만 실행 SQL 로 냅니다: td-export 0.1.30+ SQL(헤더·트레일러) 또는 구조가 완결된 MD. td-export 0.1.15 SQL 은 트레일러가 없어 파일 끝을 확인할 수 없으므로 그 문장은 수동 확인 주석으로 나옵니다 (0.1.30+ 로 다시 추출하면 실행 SQL 로 나옵니다) |
| 루틴 | td-export 0.1.52+ `.sql` 출력의 MySQL 함수·프로시저(`DELIMITER ;;` 구간). 테이블·뷰처럼 저장·비교합니다(DEFINER 는 비교하지 않고 SQL_MODE 는 비교). `.md` 출력에는 루틴이 없어 한쪽이라도 `.md` 버전이면 루틴은 비교하지 않습니다(화면에 안내). 트리거·이벤트는 td-export 가 아직 내보내지 않아 범위 밖입니다 |
| 형식 | `.sql`(권장, 손실 없음), `.md`(일부 정보 손실 — 화면에 표시) |
| 이름 제안 | `schema(host).sql` → Database `host`, `schema(host_port).sql`(0.1.30) → Database `host:port`. 예전 방식 이름(`host_port`)의 Database가 이미 있으면 그쪽을 고릅니다 |
| DMS 매핑 | AWS DMS table-mapping JSON: `selection` include/exclude(`%` 와일드카드), `transformation` 의 schema·table·column rename, `remove-column`. 그 밖의 action 은 경고로만 보여 주고 반영하지 않습니다. 룰 20,000개·20MB 까지 |

td-export 사용법은 [table-define-exporter](https://github.com/TeiNam/table-define-exporter)를 참고하세요.

## ALTER 적용

ALTER 문 몇 개 때문에 실제 DB에 적용하고 td-export로 다시 뽑는 대신, 저장된 버전에 ALTER 스크립트를 적용합니다. admin이나 dba가 Schema의 버전 이력에서 **ALTER 적용**을 누르고 기준 버전을 고른 뒤, `.sql` 파일을 고르거나 스크립트를 붙여 넣습니다. **미리보기**는 적용한 문장 수와 바뀌는 객체를 보여 주고, 문장이 실패하면 대신 그 문장의 번호·줄·이유가 담긴 메시지를 보여 줍니다. **저장**하면 다음 버전이 만들어지고 이력에 `ALTER 적용 (기준 vN)` 배지가 붙으며, 배지를 누르면 스크립트를 볼 수 있습니다. 이 버전의 원본 파일 다운로드는 스크립트가 아니라 결과를 td-export 형식으로 출력한 덤프이고, 파일 이름은 올린 스크립트 파일의 이름입니다(붙여 넣었으면 `alter.sql`). 스크립트 안의 테이블·컬럼·인덱스 rename은 두 버전 사이의 rename 매핑으로 저장됩니다.

적용은 `@tdm/core`가 저장된 스키마 모델 위에서 하며, 같은 문장을 MySQL 8.0/8.4가 처리하는 방식(타입·기본값 정규화, 자동 인덱스·제약 이름, 연쇄 변경)을 따릅니다. 서버에 MySQL이 필요 없고, 이 도구는 DDL을 실행하지 않습니다. 덤프에는 Schema의 기본 문자셋·콜레이션이 없는데 MySQL은 이를 문자셋 없는 `CREATE TABLE`과 문자열을 반환하는 함수에 쓰므로, 대화상자에서 입력받습니다(처음에는 `utf8mb4` / `utf8mb4_0900_ai_ci`, 그 뒤로는 마지막 ALTER 적용에 쓴 값).

| 항목 | 내용 |
|---|---|
| 받는 문장 | `ALTER TABLE`(컬럼·인덱스·PK/FK·테이블 옵션·`RENAME`), `CREATE INDEX`, `DROP INDEX`, `CREATE`/`DROP`/`RENAME TABLE`, `CREATE`/`DROP FUNCTION`·`PROCEDURE`, `DROP VIEW`. `SET FOREIGN_KEY_CHECKS`·`SET SQL_MODE`는 반영합니다. `SET SQL_MODE` 없이 만든 루틴에는 기준 버전 루틴이 가장 많이 쓴 SQL_MODE(td-export가 루틴마다 남기는 서버의 값)를, 기록이 없으면 MySQL 기본 모드를 붙입니다. `SET NAMES`·`SET CHARACTER SET`과 `character_set_client`·`character_set_connection`·`character_set_results`·`collation_connection` 변수는 세션 문자셋으로 따라갑니다(처음은 UTF-8이고, mysqldump·phpMyAdmin 머리·꼬리처럼 `@@` 변수로 저장했다 되돌리는 것도 따라갑니다). 문자셋이 UTF-8이 아니거나 알 수 없는 동안에는 ASCII 밖 글자(한글 이름·COMMENT·기본값 등)가 든 DDL을 거부합니다. 스키마를 바꾸지 않는 문장은 무시합니다: 테이블 정의에 영향이 없는 그 밖의 세션 `SET`, 서버 변수 `SET GLOBAL`·`SET PERSIST`, 트랜잭션 제어(`START TRANSACTION`·`BEGIN`·`COMMIT`·`ROLLBACK`), `LOCK`·`UNLOCK TABLES`, 데이터 문장(`INSERT`·`UPDATE`·`DELETE`·`REPLACE`·`TRUNCATE`), `GRANT`·`REVOKE`, 주석, 현재 Schema의 `USE`. 이후 테이블 정의를 바꾸는 세션 변수(`default_storage_engine` 등)와 식으로 쓴 `SET SQL_MODE`는 거부합니다. 스크립트 하나에 1,000,000자까지 |
| 기준 버전 | SQL 출처 버전만: 올린 td-export `.sql`이거나 앞선 ALTER 적용으로 만든 버전. `.md` 버전은 모델 정보가 부분적이고, 예전 파서로 저장된 버전(stale)은 모델이 현재 파서와 달라 둘 다 거부합니다 — stale이면 같은 덤프를 다시 올린 버전을 기준으로 쓰세요. 새 버전의 완전성 판정은 출력한 덤프에서 다시 하지 않고 기준 버전의 판정을 물려받습니다(위 입력 파일의 "완전성 확인" 참고) |
| InnoDB만 | InnoDB가 아닌 `ENGINE`을 쓰는 `CREATE TABLE`·`ALTER TABLE`, 다른 엔진 테이블을 바꾸는 문장은 거부합니다. `DROP TABLE`·`RENAME TABLE`은 받습니다 |
| 범위 밖 | "받는 문장"에 없는 문장은 모두 거부합니다. 특히 `CREATE`/`ALTER VIEW`(`DROP VIEW`는 받음), `CREATE TABLE … LIKE`·`CREATE TABLE … SELECT`, `CHECK` 추가, 생성 컬럼 정의(`GENERATED ALWAYS AS`, `AS (…)`), 식 기본값, 파티션 절, `CONVERT TO CHARACTER SET`과 테이블 `CHARACTER SET`·`COLLATE` 옵션, FK로 이어진 컬럼의 타입 변경, 트리거·이벤트, 다른 Schema를 붙인 이름, MySQL이 다시 써서 저장하는 기본값(표준이 아닌 날짜·시간 꼴, MySQL이 반올림하거나 지수 표기로 찍는 `FLOAT`·`DOUBLE` 값), 뒤 문장을 다르게 읽게 하는 SQL_MODE(`ANSI`·`TRADITIONAL`·`REAL_AS_FLOAT`·`ANSI_QUOTES`). 추측해서 적용하지 않고, 이유와 td-export로 다시 뽑아 올리라는 안내를 붙여 거부합니다 |
| 테이블 한도 | MySQL 한도인 테이블당 키 64개(오류 1069)·컬럼 1,017개(오류 1117)를 그대로 적용합니다. FK가 64개를 넘는 테이블은 재추출 안내와 함께 거부합니다: MySQL에는 한도가 없지만 이 도구는 문장마다 테이블의 FK를 모두 다시 확인하므로, 요청 하나의 계산량을 묶으려는 한도입니다 |
| FK 자동 인덱스 | 덤프에는 MySQL이 FK 때문에 자동으로 만든 인덱스가 표시되지 않아 이름으로 추정합니다. FK와 같은 이름의 인덱스는 자동으로 보고(직접 만든 `KEY f`를 `CONSTRAINT f`와 함께 쓴 경우도 이렇게 잘못 봅니다) 나머지는 직접 만든 것으로 봅니다. FK 이름이 `<테이블>_ibfk_N` 꼴이고 인덱스 이름이 FK의 첫 컬럼인 경우도 직접 만든 것으로 보므로, FK 컬럼으로 시작하는 복합 인덱스 추가나 FK 이름 정리를 그대로 적용합니다. 한계: 그 인덱스가 실제로는 MySQL이 FK와 함께 자동으로 만든 것이면(FK만 써서 만든 라이브 스키마), 같은 컬럼에 키나 FK를 더하는 문장에서 MySQL은 그 인덱스를 지우거나 바꾸지만 이 도구는 남깁니다. FK가 이미 지워져 남은 자동 인덱스와, 파생 버전 사이(한 번의 ALTER 적용에서 만든 자동 인덱스도 다음 적용에서는 이름으로 다시 추정)도 같습니다 |
| MySQL 검사 | MySQL의 모든 검사를 재현하지는 않습니다(키 길이·행 크기 한도 등). 그래서 이 도구가 받은 스크립트도 실제 DB에서는 거부될 수 있습니다. 결과를 MySQL과 맞추려고, CI와 `npm run test:mysql -w @tdm/core`에서 시나리오 87개(MySQL 8.0은 8.4 전용 시나리오 하나를 빼고 86개)의 스크립트를 실제 MySQL 8.0.46과 8.4.11에 실행해 이 도구의 결과와 비교합니다 |
| 저장 전 확인 | 저장(과 미리보기) 전에 서버가 출력한 덤프를 다시 읽어 적용 결과와 객체마다 비교합니다. 스크립트가 건드리지 않은 객체는 기준 버전과 비교하므로, 기준에 파싱하지 못한 객체가 있어도 그 객체를 건드리지 않는 ALTER 스크립트는 적용할 수 있습니다. 어긋나면 스크립트가 아니라 이 도구의 결함이라, 어긋난 객체와 요청 ID를 알려 주며 거부하고 서버 로그에도 남깁니다 |

주요 규칙과 거부하는 문장은 [설계 문서](docs/superpowers/specs/2026-10-13-alter-apply-design.md)에 있습니다.

## Docker로 실행

```bash
docker compose -f docker/compose.yaml up -d --build      # http://127.0.0.1:3000 (이 호스트에서만)
docker compose -f docker/compose.yaml exec -it app \
  node --import tsx src/cli/create-admin.ts admin               # 최초 관리자 (비밀번호 프롬프트)
```

- 데이터(SQLite)는 `tdm-data` 볼륨의 `/data`에 저장됩니다.
- 빌드된 이미지는 GHCR에도 올라갑니다: `docker pull ghcr.io/teinam/database-diff-manager:latest`
- compose 파일은 포트를 `127.0.0.1`에만 열고, 이 호스트에서 HTTP로 직접 접속하도록 `COOKIE_SECURE=false`를 둡니다. LAN에 열려면 HTTPS 리버스 프록시를 앞에 두고 `COOKIE_SECURE`를 지운 뒤(기본 `true`), 필요하면 `TRUST_PROXY`를 설정하세요.

## 로컬 실행 (Node.js 22.13+)

```bash
npm install
npm run build                                   # 웹 빌드 (apps/web/dist)
npm run create-admin -w @tdm/server -- admin    # 최초 관리자 (터미널에서 비밀번호 입력)
COOKIE_SECURE=false npm start                   # http://127.0.0.1:3000
```

환경변수(`HOST`, `PORT`, `DATA_DIR`, `COOKIE_SECURE`, `WEB_DIST`, `TRUST_PROXY`)와 API 목록은 [apps/server/README.md](apps/server/README.md)에 있습니다.

## 백업

데이터는 WAL 모드의 SQLite 파일 하나입니다. 서버가 실행 중이면 최근 커밋이 아직 `tdm.db-wal` 에 있을 수 있으므로 **`.db` 파일만 복사하면 안 됩니다** — 데이터가 빠지거나 깨진 사본이 될 수 있습니다. 대신 백업 명령을 쓰세요. `VACUUM INTO` 로 한 시점의 일관된 스냅샷을 만들며, 서버가 실행 중이어도 안전합니다.

```bash
# Docker
docker compose -f docker/compose.yaml exec app node --import tsx src/cli/backup.ts /data/backup-$(date +%Y%m%d).db
docker compose -f docker/compose.yaml cp app:/data/backup-$(date +%Y%m%d).db .   # 볼륨 밖으로 꺼내기

# 로컬
npm run backup -w @tdm/server -- ./backup-$(date +%Y%m%d).db
```

이미 있는 파일은 덮어쓰지 않습니다. 복원할 때는 서버를 멈추고 `tdm.db` 를 백업 파일로 바꾼 뒤 남아 있는 `tdm.db-wal`·`tdm.db-shm` 을 지웁니다. 더 새 버전이 만든 DB 로는 서버가 기동하지 않습니다(구 버전 이미지로 내려간 경우 등). 그때는 그 구 버전에서 받아 둔 백업으로 복원하세요.

## 권한

| 작업 | admin | dba | viewer |
|---|---|---|---|
| 조회·비교·DDL 복사/다운로드·HTML 리포트 내보내기 | O | O | O |
| rename 매핑 저장 (모든 사용자의 diff 결과에 반영) | O | O | — |
| 업로드, ALTER 적용, Database 생성·수정·삭제, 버전·Schema 삭제 | O | O | — |
| DMS 전환 매핑 올리기·삭제 | O | O | — |
| 계정 관리 | O | — | — |

viewer 는 읽기 전용입니다. rename 후보는 보이지만 처리·해제는 dba 나 admin 만 할 수 있습니다.

Schema·Database 삭제는 이름을 직접 입력해야 진행되며, 그 아래 모든 버전과 객체 이력이 함께 지워집니다.

## 구조

| 패키지 | 역할 |
|---|---|
| `packages/core` | 파서·프린터·diff·DDL 생성 (런타임 의존성 0, 서버·브라우저 공용) — [README](packages/core/README.md) |
| `apps/server` | Fastify + node:sqlite API, 인증, 업로드, 빌드된 웹 서빙 — [README](apps/server/README.md) |
| `apps/web` | React 화면 (트리, GitHub 스타일 diff, DDL, 업로드, 이력, 계정) |
| `docker/` | Dockerfile, compose.yaml |

## 개발

```bash
npm run dev:server   # API (127.0.0.1:3000, HTTP 개발용 쿠키)
npm run dev:web      # Vite (http://localhost:5173, /api 는 3000으로 프록시)
npm test             # 전체 테스트
npm run typecheck
npm run test:mysql -w @tdm/core   # 생성 DDL과 ALTER 적용 결과를 MySQL 8.0/8.4 컨테이너에서 실제로 적용해 검증 (Docker 필요)
                                  #   (포트는 MYSQL80_PORT / MYSQL84_PORT 로 변경, 기본 33080 / 33084)
```

## CI

`main` 브랜치에 푸시할 때마다 GitHub Actions가 타입 검사·테스트·빌드를 거친 뒤 제품 버전을 계산해 그 버전을 붙인 Docker 이미지(`linux/amd64`, `linux/arm64`)를 GHCR에 올리고, 마지막에 `vX.Y.N` 태그와 GitHub Release를 만듭니다. 같은 커밋을 다시 실행하면 그 커밋의 태그를 재사용하고, `latest`는 그 커밋이 아직 `main`의 HEAD일 때만 옮깁니다. `X.Y` 이미지 태그는 그 버전이 원격 `vX.Y.*` 태그 중 가장 큰 패치일 때만 옮기고, `X.Y.Z`와 짧은 SHA 태그는 항상 올립니다. 원격의 `vX.Y.Z` 태그가 다른 커밋을 가리키면(실패한 잡만 재실행하는 사이 다른 커밋이 그 버전을 먼저 출시한 경우) image·release 잡이 push 전에 실패하니, 워크플로 전체를 다시 실행해 버전을 새로 계산하세요. 다른 브랜치에서 `workflow_dispatch`로 실행하면 테스트만 돕니다. 문서(`*.md`, `docs/`)만 바뀐 푸시에는 실행하지 않습니다.

**버전 규칙**: `major.minor`는 `apps/web/package.json`에서 가져오고, 패치 번호는 같은 `vX.Y.*` 태그 중 가장 큰 값 + 1입니다(처음은 0). 계산은 `scripts/next-version.mjs`가 합니다. 마이너·메이저를 올리려면 `apps/web/package.json`의 version을 바꾸면 됩니다. 상단·푸터에 보이는 버전은 빌드 때 넣은 값(`APP_VERSION`)이고, 로컬 빌드는 git 태그로 정합니다(`scripts/local-version.mjs`). 태그가 붙은 커밋이면 `0.1.2`, 태그 뒤로 커밋이 3개 더 있으면 `0.1.2-dev+3.44e9b27`(커밋하지 않은 변경이 있으면 끝에 `.dirty`), git이나 태그가 없으면(예: 로컬 `docker compose` 빌드) `<package.json 버전>-dev`로 표시됩니다. `v*` 태그를 직접 푸시하면(형식은 `vX.Y.Z`) 새 버전을 만들지 않고 그 태그 버전으로 이미지를 빌드하며, Release가 없으면 만듭니다.

---

Made by [TeiNam](https://github.com/TeiNam)
