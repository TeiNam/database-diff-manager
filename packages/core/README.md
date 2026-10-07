# @tdm/core

English | [한국어](README.ko.md)

A pure TypeScript package that reads td-export dumps (`.sql`, `.md`) into a schema model, compares two versions, and generates the MySQL 8.0/8.4 DDL that turns BASE into TARGET. It has no runtime dependencies and does not use `node:` modules, so it runs on both the server and in the browser. The app only displays the generated DDL and lets you copy it; it never executes it.

## Public API

| Function | Input → Output | Description |
|---|---|---|
| `parseSqlDump(text)` | SQL dump → `{ model, warnings }` | Parses the raw `SHOW CREATE` output. Only objects that fail to parse are kept as `parseError` and `rawDdl` |
| `parseMdDump(text)` | MD definition → `{ model, warnings }` | The format is lossy, so the result carries `fidelity: 'partial'` and an `unknown` list |
| `printTable(t)`, `printView(v)` | Model → DDL string | Prints back in `SHOW CREATE` format |
| `diffSchemas(base, target, renames?)` | Two models → `SchemaDiff` | Table and view changes, rename candidates, and renames that could not be applied (`ignoredRenames`) |
| `generateDdl(diff)` | `SchemaDiff` → `Statement[]` | Generates statements in a fixed order that accounts for FK and view dependencies |
| `renderDdl(stmts, partial?)` | `Statement[]` → string | Adds a header comment per object, `notes`, and the trailing `;` on each statement |

In a parse warning (`ParseWarning`), `code` is `'parse-error'` (parsing failed) or `'round-trip'` (the re-printed output differs from the original), and `kind` is `'table'` or `'view'`.

The fields of `Statement` are as follows.

- `object`, `kind`, `op`: the target object and the type of change
- `sql`: SQL without a trailing `;`
- `comment`: if `true`, the statement is a notice with no SQL to run. `sql` consists only of `-- ` comment lines
- `notes`: notes placed above the statement, such as attributes that could not be verified because the source is MD

```ts
import { diffSchemas, generateDdl, parseSqlDump, renderDdl } from '@tdm/core';

// Compare two dumps and build the DDL text to run
const base = parseSqlDump(baseText).model;
const target = parseSqlDump(targetText).model;
const diff = diffSchemas(base, target);
const sql = renderDdl(generateDdl(diff), diff.partial);
```

## fidelity and unknown

- A SQL dump has `fidelity: 'full'`. All attributes are compared.
- An MD dump has `fidelity: 'partial'`. Attributes that are absent from MD are listed in the per-object `unknown` list. Examples: character set and collation, defaults that appear only as blank cells in the legacy format, generated column expressions, the kind of a `[Normal]` index, CHECK, and partitions.
- The MD default value (Default column) format is detected per file. If the Columns table contains at least one `NULL` or `''` cell, the file is treated as td-export 0.1.15 or later (v2).
  - v2: `NULL` is a nullable column with no default (`DEFAULT NULL`; no DEFAULT clause for text/blob/geometry or auto_increment). A blank cell is NOT NULL with no default, and `''` is an empty-string default. The string default `'NULL'` cannot be distinguished from `DEFAULT NULL`.
  - legacy (0.1.14 or earlier): NULL, empty string, and no default all appear as blank cells, so unless the type is one that certainly has no default, `default` is set to `unknown`.
- The diff does not compare an attribute that is `unknown` on either side; it records it in `TableDiff.skipped`.
- When generating DDL, `unknown` attributes of TARGET are filled in with the values of the paired BASE object. Attributes that cannot be filled in are listed in the `notes` of the corresponding statement. If valid SQL cannot be produced, as with a generated column expression, a manual-check statement (`comment: true`) with the SQL commented out is generated.

## Testing

```bash
npm test -w @tdm/core        # unit and golden tests
npm run typecheck -w @tdm/core   # typecheck: whole package + src only (types: [], no node: imports)
npm run test:mysql -w @tdm/core  # verify base + generated DDL = target on real MySQL 8.0/8.4 containers
docker compose -f packages/core/docker-compose.test.yml down   # clean up containers
```

`test:mysql` uses `docker-compose.test.yml` to start `mysql:8.0` (port 33080) and `mysql:8.4` (port 33084), bound to `127.0.0.1` only. The root password is `test`, used for testing only. Pulling the images from Docker Hub requires `docker login`. If you cannot log in, pull the images from another registry and apply local tags.

```bash
docker pull public.ecr.aws/docker/library/mysql:8.0
docker tag public.ecr.aws/docker/library/mysql:8.0 mysql:8.0
docker pull public.ecr.aws/docker/library/mysql:8.4
docker tag public.ecr.aws/docker/library/mysql:8.4 mysql:8.4
```

Golden scenarios live in `test/fixtures/scenarios/<name>/` (base.sql, target.sql, expected.sql). Registering one in `SCENARIOS` in `test/helpers.ts` runs it in both the golden test and the real MySQL test. MD TARGET scenarios (`test/fixtures/scenarios-md/`) are not executable round trips, so register them separately in `MD_SCENARIOS`; they run only in the golden test.
