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
- **비교**: 요약, 객체별 diff(SQL Split/Unified, Excel 같은 표 보기), 변경 객체만 거르는 트리.
- **DDL 생성**: 테이블·컬럼·인덱스·FK·뷰·파티션 변경을 ALTER/CREATE/DROP으로 만들고, 반대 방향(되돌리기) DDL도 함께 제공합니다. rename은 화면에서 매핑합니다.
- **DB 전환 매핑**: As-Is → To-Be Schema 쌍에 AWS DMS table-mapping JSON 을 올리면, 전환 탭에 테이블·컬럼 대응과 상태를 보여 주고 같은 매핑을 rename 으로 객체 diff·DDL 에 반영합니다. 같은 대상에 대한 수동 rename 매핑이 우선합니다.
- **이력**: 버전 이력, 객체별 변경 이력, 원본 파일 다운로드.
- **계정**: admin/viewer 두 역할. 다크·라이트 테마.

## 입력 파일

| 항목 | 내용 |
|---|---|
| 지원 버전 | td-export 0.1.15 ~ 0.1.30 (파일마다 출력 형식을 판별) |
| 형식 | `.sql`(권장, 손실 없음), `.md`(일부 정보 손실 — 화면에 표시) |
| 이름 제안 | `schema(host).sql` → Database `host`, `schema(host_port).sql`(0.1.30) → Database `host:port`. 예전 방식 이름(`host_port`)의 Database가 이미 있으면 그쪽을 고릅니다 |
| DMS 매핑 | AWS DMS table-mapping JSON: `selection` include/exclude(`%` 와일드카드), `transformation` 의 schema·table·column rename, `remove-column`. 그 밖의 action 은 경고로만 보여 주고 반영하지 않습니다. 룰 20,000개·20MB 까지 |

td-export 사용법은 [table-define-exporter](https://github.com/TeiNam/table-define-exporter)를 참고하세요.

## Docker로 실행

```bash
docker compose -f docker/compose.yaml up -d --build      # http://localhost:3000
docker compose -f docker/compose.yaml exec -it app \
  node --import tsx src/cli/create-admin.ts admin               # 최초 관리자 (비밀번호 프롬프트)
```

- 데이터(SQLite)는 `tdm-data` 볼륨의 `/data`에 저장됩니다.
- 빌드된 이미지는 GHCR에도 올라갑니다: `docker pull ghcr.io/teinam/database-diff-manager:latest`
- compose 파일은 HTTP 직접 접속용으로 `COOKIE_SECURE=false`를 둡니다. HTTPS 리버스 프록시 뒤에서 운영하면 이 값을 지우고, 필요하면 `TRUST_PROXY`를 설정하세요.

## 로컬 실행 (Node.js 22.13+)

```bash
npm install
npm run build                                   # 웹 빌드 (apps/web/dist)
npm run create-admin -w @tdm/server -- admin    # 최초 관리자 (터미널에서 비밀번호 입력)
COOKIE_SECURE=false npm start                   # http://127.0.0.1:3000
```

환경변수(`HOST`, `PORT`, `DATA_DIR`, `COOKIE_SECURE`, `WEB_DIST`, `TRUST_PROXY`)와 API 목록은 [apps/server/README.md](apps/server/README.md)에 있습니다.

## 권한

| 작업 | admin | viewer |
|---|---|---|
| 조회·비교·DDL 복사/다운로드 | O | O |
| rename 매핑 저장 (모든 사용자의 diff 결과에 반영) | O | O |
| 업로드, 버전·Schema·Database 삭제 | O | — |
| DMS 전환 매핑 올리기·삭제 | O | — |
| 계정 관리 | O | — |

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
npm run test:mysql -w @tdm/core   # 생성 DDL을 MySQL 8.0/8.4 컨테이너에서 실제로 적용해 검증 (Docker 필요)
```

## CI

`main` 브랜치에 푸시할 때마다 GitHub Actions가 타입 검사·테스트·빌드를 거친 뒤 제품 버전을 올려 `vX.Y.N` 태그와 GitHub Release를 만들고, 그 버전을 붙인 Docker 이미지(`linux/amd64`, `linux/arm64`)를 GHCR에 올립니다. 문서(`*.md`, `docs/`)만 바뀐 푸시에는 실행하지 않습니다.

**버전 규칙**: `major.minor`는 `apps/web/package.json`에서 가져오고, 패치 번호는 같은 `vX.Y.*` 태그 중 가장 큰 값 + 1입니다(처음은 0). 계산은 `scripts/next-version.mjs`가 합니다. 마이너·메이저를 올리려면 `apps/web/package.json`의 version을 바꾸면 됩니다. 상단·푸터에 보이는 버전은 빌드 때 넣은 값(`APP_VERSION`)이고, 로컬 빌드는 `X.Y.Z-dev`로 표시됩니다. `v*` 태그를 직접 푸시하면 새 버전을 만들지 않고 그 태그 버전으로 이미지만 빌드합니다.

---

Made by [TeiNam](https://github.com/TeiNam)
