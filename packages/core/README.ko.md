# @tdm/core

[English](README.md) | 한국어

td-export 덤프(`.sql`, `.md`)를 스키마 모델로 읽고, 두 버전을 비교해 BASE를 TARGET으로 바꾸는 MySQL 8.0/8.4 DDL을 만드는 순수 TypeScript 패키지다. 런타임 의존성이 없고 `node:` 모듈을 쓰지 않으므로 서버와 브라우저에서 함께 쓴다. 앱은 생성한 DDL을 보여 주고 복사하게 할 뿐, 직접 실행하지 않는다.

## 공개 API

| 함수 | 입력 → 출력 | 설명 |
|---|---|---|
| `parseSqlDump(text)` | SQL 덤프 → `{ model, warnings }` | `SHOW CREATE` 원문을 파싱한다. 실패한 객체만 `parseError`·`rawDdl`로 남긴다 |
| `parseMdDump(text)` | MD 정의서 → `{ model, warnings }` | 손실 있는 형식이라 `fidelity: 'partial'`과 `unknown` 목록을 단다 |
| `printTable(t)`, `printView(v)` | 모델 → DDL 문자열 | `SHOW CREATE` 형식으로 다시 출력한다 |
| `diffSchemas(base, target, renames?)` | 두 모델 → `SchemaDiff` | 테이블·뷰 변경, rename 후보, 적용하지 못한 rename(`ignoredRenames`) |
| `generateDdl(diff)` | `SchemaDiff` → `Statement[]` | FK·뷰 의존성을 고려한 고정 순서로 문장을 만든다 |
| `renderDdl(stmts, partial?)` | `Statement[]` → 문자열 | 객체별 머리 주석, `notes`, 문장 끝 `;`를 붙인다 |

파싱 경고(`ParseWarning`)의 `code`는 `'parse-error'`(파싱 실패) 또는 `'round-trip'`(재출력 결과가 원문과 다름)이고, `kind`는 `'table'` 또는 `'view'`다.

`Statement`의 필드는 다음과 같다.

- `object`, `kind`, `op`: 대상 객체와 변경 종류
- `sql`: 끝에 `;`가 없는 SQL
- `comment`: `true`면 실행할 SQL이 없는 안내 문장이다. `sql`은 `-- ` 주석 줄로만 이루어진다
- `notes`: 문장 위에 붙는 안내. MD 출처라 확인하지 못한 속성 등을 적는다

```ts
import { diffSchemas, generateDdl, parseSqlDump, renderDdl } from '@tdm/core';

// 두 덤프를 비교해 실행할 DDL 텍스트를 만든다
const base = parseSqlDump(baseText).model;
const target = parseSqlDump(targetText).model;
const diff = diffSchemas(base, target);
const sql = renderDdl(generateDdl(diff), diff.partial);
```

## fidelity와 unknown

- SQL 덤프는 `fidelity: 'full'`이다. 모든 속성을 비교한다.
- MD 덤프는 `fidelity: 'partial'`이다. MD에 없는 속성은 객체별 `unknown` 목록에 적는다. 예: 문자셋·콜레이션, legacy 형식에서 빈 칸으로만 나오는 기본값, 생성 컬럼 표현식, `[Normal]` 인덱스의 종류, CHECK, 파티션.
- MD 기본값(Default 칸) 형식은 파일마다 판별한다. Columns 표에 `NULL` 또는 `''` 칸이 하나라도 있으면 td-export 0.1.15 이상(v2)으로 본다.
  - v2: `NULL`은 기본값 없는 nullable 컬럼이다(`DEFAULT NULL`, text/blob/geometry·auto_increment는 DEFAULT 절 없음). 빈 칸은 기본값 없는 NOT NULL, `''`는 빈 문자열 기본값이다. 문자열 기본값 `'NULL'`은 `DEFAULT NULL`과 구분할 수 없다.
  - legacy(0.1.14 이하): NULL·빈 문자열·기본값 없음이 모두 빈 칸이므로, 기본값이 없음이 확실한 타입이 아니면 `default`를 `unknown`으로 둔다.
- diff는 한쪽이라도 `unknown`인 속성을 비교하지 않고 `TableDiff.skipped`에 기록한다.
- DDL을 만들 때는 TARGET의 `unknown` 속성을 짝지어진 BASE 객체 값으로 채운다. 채우지 못한 속성은 해당 문장의 `notes`에 적는다. 생성 컬럼 표현식처럼 올바른 SQL을 만들 수 없으면 SQL을 주석 처리한 수동 확인 문장(`comment: true`)을 만든다.

## 테스트

```bash
npm test -w @tdm/core        # 단위·골든 테스트
npm run typecheck -w @tdm/core   # 전체 + src 전용(types: [], node: 사용 금지) 타입 검사
npm run test:mysql -w @tdm/core  # 실 MySQL 8.0/8.4 컨테이너에서 base + 생성 DDL = target 확인
docker compose -f packages/core/docker-compose.test.yml down   # 컨테이너 정리
```

`test:mysql`은 `docker-compose.test.yml`로 `mysql:8.0`(포트 33080)과 `mysql:8.4`(포트 33084)를 `127.0.0.1`에만 띄운다. 루트 비밀번호는 테스트 전용 `test`다. Docker Hub에서 이미지를 받으려면 `docker login`이 필요하다. 로그인할 수 없으면 다른 레지스트리의 이미지를 받아 로컬 태그를 붙인다.

```bash
docker pull public.ecr.aws/docker/library/mysql:8.0
docker tag public.ecr.aws/docker/library/mysql:8.0 mysql:8.0
docker pull public.ecr.aws/docker/library/mysql:8.4
docker tag public.ecr.aws/docker/library/mysql:8.4 mysql:8.4
```

골든 시나리오는 `test/fixtures/scenarios/<이름>/`(base.sql, target.sql, expected.sql)에 있고 `test/helpers.ts`의 `SCENARIOS`에 등록하면 골든 테스트와 실 MySQL 테스트가 모두 돈다. MD TARGET 시나리오(`test/fixtures/scenarios-md/`)는 실행 가능한 왕복이 아니므로 `MD_SCENARIOS`에 따로 등록하고 골든 테스트만 돈다.
