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

English | [한국어](README.ko.md)

A team web tool for managing MySQL schema definitions exported with [td-export](https://github.com/TeiNam/table-define-exporter) (`.sql` / `.md`) as versions. It shows what changed between two versions and generates the MySQL 8.0/8.4 DDL that produces the change. The DDL is only displayed, copied, or downloaded — never executed against a database.

## Features

- **Versioning**: upload definitions per Database (a physical engine instance) → Schema. An upload identical to the latest version does not create a new version.
- **Apply ALTER scripts**: paste or upload an ALTER script against a stored SQL version to create the next version without re-exporting (columns, indexes, foreign keys, table options, CREATE/DROP/RENAME TABLE, routines; results are verified against real MySQL 8.0/8.4 in CI). Scope and limits: [Apply ALTER scripts](#apply-alter-scripts).
- **Comparison**: summary, per-object diff (SQL split/unified and a spreadsheet-like grid), and a tree that can filter to changed objects only.
- **HTML report**: export the current comparison (summary and object diff, in the selected view) as one self-contained HTML file. It opens without access to this tool and can be shared, archived, or printed (print to PDF from the browser).
- **DDL generation**: ALTER/CREATE/DROP for tables, columns, indexes, foreign keys, views, partitions, and stored functions/procedures, plus the reverse (rollback) direction. Renames are mapped in the UI; swaps and chains (a↔b, a→b→c, replacing a table with another) become one `RENAME TABLE` statement or `RENAME COLUMN` clauses in one ALTER, and manual renames saved for one direction are inverted for the reverse diff.
- **DB migration mapping**: upload an AWS DMS table-mapping JSON for an As-Is → To-Be Schema pair. The Migration (전환) tab shows table and column correspondence with a status for each, and the same mapping is applied as renames to the object diff and DDL. Manual rename mappings still win for the same object.
- **History**: version history, per-object change history, original file download.
- **Accounts**: admin / dba / viewer roles. Dark and light themes.

## Input files

| Item | Details |
|---|---|
| Supported versions | td-export 0.1.15 – 0.1.52, MySQL output (format is detected per file; MySQL output is unchanged from 0.1.30 to 0.1.36) |
| Completeness | Statements that drop objects, columns, or partitions because they are absent from TARGET are emitted as runnable SQL only when TARGET is a verifiably complete dump: td-export 0.1.30+ SQL (header and trailer) or a structurally complete MD. td-export 0.1.15 SQL has no trailer, so its end cannot be verified — those statements become manual-review comments (re-export with 0.1.30+ to get them as SQL) |
| Routines | MySQL stored functions and procedures in `.sql` output from td-export 0.1.52 (`DELIMITER ;;` blocks). They are stored and compared like tables and views (DEFINER is ignored; SQL_MODE is compared). `.md` output has no routines, so routines are not compared when either version is `.md` (the UI says so). Triggers and events are out of scope — td-export does not export them yet |
| Formats | `.sql` (recommended, lossless), `.md` (partially lossy — flagged in the UI) |
| Name suggestion | `schema(host).sql` → Database `host`; `schema(host_port).sql` (0.1.30) → Database `host:port`. If a Database with the older `host_port` name already exists, that one is selected |
| DMS mapping | AWS DMS table-mapping JSON: `selection` include/exclude (`%` wildcard), `transformation` rename of schema/table/column, and `remove-column`. Other actions are listed as warnings and not applied. Up to 20,000 rules, 20MB |

See [table-define-exporter](https://github.com/TeiNam/table-define-exporter) for how to run td-export.

## Apply ALTER scripts

To make a few schema changes without applying them to a real database and re-exporting with td-export, apply an ALTER script to a stored version. An admin or dba opens a Schema's version history, clicks **Apply ALTER** (ALTER 적용), chooses a base version, and picks a `.sql` file or pastes the script. **Preview** (미리보기) shows the number of applied statements and the objects that change; if a statement fails, it shows a message with that statement's number, line, and reason instead. **Save** (저장) creates the next version, marked `ALTER 적용 (기준 vN)` in the history; the badge opens the script. The original-file download of that version is not the script but the td-export-format dump printed from the result, named after the uploaded script file (`alter.sql` for pasted text). Table, column, and index renames in the script are saved as rename mappings between the two versions.

`@tdm/core` applies the script to the stored schema model, following how MySQL 8.0/8.4 handles the same statements (type and default normalization, automatic index and constraint names, cascading changes). The server needs no MySQL, and the tool never executes DDL. The dialog also asks for the Schema's default character set and collation (`utf8mb4` / `utf8mb4_0900_ai_ci` at first, then the value of the last ALTER apply), because a dump does not record them and MySQL uses them for a `CREATE TABLE` without a character set and for functions that return strings.

| Item | Details |
|---|---|
| Statements | `ALTER TABLE` (columns, indexes, primary and foreign keys, table options, `RENAME`), `CREATE INDEX`, `DROP INDEX`, `CREATE`/`DROP`/`RENAME TABLE`, `CREATE`/`DROP FUNCTION` and `PROCEDURE`, `DROP VIEW`. `SET FOREIGN_KEY_CHECKS` and `SET SQL_MODE` take effect; a routine created without `SET SQL_MODE` gets the SQL mode most of the base version's routines were created with (the server's mode, as td-export records it per routine), or MySQL's default mode if none is recorded. `SET NAMES`, `SET CHARACTER SET`, and the `character_set_client`/`character_set_connection`/`character_set_results`/`collation_connection` variables are tracked as the session character set (UTF-8 at first, including save-and-restore through `@@` variables as in mysqldump and phpMyAdmin headers and footers); while it is not UTF-8 or not known, DDL containing non-ASCII characters (Korean names, comments, defaults) is rejected. Statements that do not change the schema are ignored: other session `SET`s that do not affect table definitions, server-scope `SET GLOBAL`/`SET PERSIST`, transaction control (`START TRANSACTION`, `BEGIN`, `COMMIT`, `ROLLBACK`), `LOCK`/`UNLOCK TABLES`, data statements (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `TRUNCATE`), `GRANT`/`REVOKE`, comments, and a `USE` of the current Schema. Session variables that change later table definitions (`default_storage_engine` and others) and `SET SQL_MODE` with an expression value are rejected. Up to 1,000,000 characters per script |
| Base version | SQL-sourced versions only: an uploaded td-export `.sql`, or a version created by an earlier ALTER apply. `.md` versions are refused because their model is partial, and so are versions stored by an older parser (stale) — use a version re-uploaded from the same dump instead. A new version inherits its base version's completeness judgment (see Completeness above) instead of being judged again from the printed dump |
| InnoDB only | `CREATE TABLE` or `ALTER TABLE` with another `ENGINE`, and changes to a table that uses another engine, are rejected. `DROP TABLE` and `RENAME TABLE` are accepted |
| Out of scope | Any statement not listed under Statements is rejected, in particular `CREATE`/`ALTER VIEW` (`DROP VIEW` works), `CREATE TABLE … LIKE` and `CREATE TABLE … SELECT`, adding `CHECK` constraints, generated column definitions (`GENERATED ALWAYS AS`, `AS (…)`), expression defaults, partition clauses, `CONVERT TO CHARACTER SET` and table-level `CHARACTER SET`/`COLLATE`, type changes of foreign-key columns, triggers, events, names qualified with another Schema, default values that MySQL rewrites (non-standard date and time forms; `FLOAT`/`DOUBLE` values it rounds or prints in exponent form), and SQL modes that change how later statements are read (`ANSI`, `TRADITIONAL`, `REAL_AS_FLOAT`, `ANSI_QUOTES`). The tool does not guess: it rejects the statement with the reason and a hint to re-export with td-export |
| Table limits | MySQL's limits of 64 keys (error 1069) and 1,017 columns (error 1117) per table apply. A table with more than 64 foreign keys is rejected with the re-export hint: MySQL has no such limit, but the tool rechecks every foreign key of a table on each statement, so this bounds the work of one request |
| Foreign key auto indexes | A dump does not mark the index MySQL creates automatically for a foreign key, so the tool infers it from names. An index named like its foreign key counts as automatic (a hand-made `KEY f` next to `CONSTRAINT f` is misjudged this way), and other indexes count as user-created — including an index named after the first column of a foreign key named `<table>_ibfk_N`, so adding a composite index that starts with the foreign key column or renaming the foreign key works. Limit: if such an index was in fact created automatically by MySQL (a live schema built with foreign keys only), MySQL may drop or rename it in a statement that adds a key or foreign key on the same columns while this tool keeps it. The same applies to automatic indexes whose foreign key is already gone, and across derived versions: an automatic index created by one ALTER apply is judged by its name again in the next one |
| MySQL checks | Not every MySQL check is reproduced (key length and row size limits, for example), so a script this tool accepts can still be rejected by a real database. To keep results aligned with MySQL, 87 scenarios (86 on MySQL 8.0, where one 8.4-only scenario is skipped) run each script on real MySQL 8.0.46 and 8.4.11 and compare the outcome with this tool's, in CI and with `npm run test:mysql -w @tdm/core` |
| Save check | Before saving (and for a preview), the server reads the printed dump back and compares it with the applied result object by object. Objects the script did not touch are compared with the base version, so a base that already contains an unparsable object can still take ALTER scripts that leave that object alone. A mismatch is a defect in this tool, not in the script: the request is refused with the differing objects and the request ID, which is also logged on the server |

The design document lists the main rules and rejected statements: [docs/superpowers/specs/2026-10-13-alter-apply-design.md](docs/superpowers/specs/2026-10-13-alter-apply-design.md) (Korean).

## Run with Docker

```bash
docker compose -f docker/compose.yaml up -d --build      # http://127.0.0.1:3000 (this host only)
docker compose -f docker/compose.yaml exec -it app \
  node --import tsx src/cli/create-admin.ts admin         # first admin (password prompt)
```

- Data (SQLite) is stored in `/data` on the `tdm-data` volume.
- Images are published to GHCR: `docker pull ghcr.io/teinam/database-diff-manager:latest`
- The compose file publishes the port on `127.0.0.1` only and sets `COOKIE_SECURE=false` for direct HTTP access from this host. To expose it on a LAN, put an HTTPS reverse proxy in front, remove `COOKIE_SECURE` (default `true`), and set `TRUST_PROXY` if needed.

## Run locally (Node.js 22.13+)

```bash
npm install
npm run build                                   # build the web app (apps/web/dist)
npm run create-admin -w @tdm/server -- admin    # first admin (enter the password in a terminal)
COOKIE_SECURE=false npm start                   # http://127.0.0.1:3000
```

Environment variables (`HOST`, `PORT`, `DATA_DIR`, `COOKIE_SECURE`, `WEB_DIST`, `TRUST_PROXY`) and the API list are in [apps/server/README.md](apps/server/README.md).

## Backup

The data is a single SQLite file in WAL mode. While the server is running, recent commits may still live in `tdm.db-wal`, so **do not copy only the `.db` file** — the copy can miss data or be corrupted. Use the backup command instead; it writes a consistent snapshot with `VACUUM INTO` and is safe while the server runs.

```bash
# Docker
docker compose -f docker/compose.yaml exec app node --import tsx src/cli/backup.ts /data/backup-$(date +%Y%m%d).db
docker compose -f docker/compose.yaml cp app:/data/backup-$(date +%Y%m%d).db .   # copy it out of the volume

# Local
npm run backup -w @tdm/server -- ./backup-$(date +%Y%m%d).db
```

The command refuses to overwrite an existing file. To restore, stop the server, replace `tdm.db` with the backup, and delete any leftover `tdm.db-wal`/`tdm.db-shm` files. The server refuses to start on a database created by a newer version (for example after rolling back to an older image) — restore a backup taken with that older version instead.

## Permissions

| Action | admin | dba | viewer |
|---|---|---|---|
| Browse, compare, copy/download DDL, export HTML report | ✓ | ✓ | ✓ |
| Save rename mappings (affects everyone's diff results) | ✓ | ✓ | — |
| Upload; apply ALTER scripts; create, edit, delete Databases; delete versions and Schemas | ✓ | ✓ | — |
| Upload or delete DMS migration mappings | ✓ | ✓ | — |
| Manage accounts | ✓ | — | — |

viewers are read-only: rename candidates are shown, but only a dba or admin can apply or remove them.

Deleting a Schema or Database requires typing its name, and removes every version and object history below it.

## Project layout

| Package | Role |
|---|---|
| `packages/core` | Parser, printer, diff, DDL generator (zero runtime dependencies, shared by server and browser) — [README](packages/core/README.md) |
| `apps/server` | Fastify + node:sqlite API, auth, uploads, serves the built web app — [README](apps/server/README.md) |
| `apps/web` | React UI (tree, GitHub-style diff, DDL, upload, history, accounts) |
| `docker/` | Dockerfile, compose.yaml |

## Development

```bash
npm run dev:server   # API (127.0.0.1:3000, HTTP dev cookies)
npm run dev:web      # Vite (http://localhost:5173, proxies /api to 3000)
npm test             # all tests
npm run typecheck
npm run test:mysql -w @tdm/core   # applies generated DDL and ALTER-apply scripts on MySQL 8.0/8.4 containers (requires Docker)
                                  #   (override ports with MYSQL80_PORT / MYSQL84_PORT, default 33080 / 33084)
```

## CI

On every push to `main`, GitHub Actions runs typecheck, tests, and the build, then computes the product version, publishes a Docker image (`linux/amd64`, `linux/arm64`) tagged with that version to GHCR, and finally creates the `vX.Y.N` tag and a GitHub Release. Re-running a workflow for the same commit reuses that commit's tag, and `latest` only moves when the commit is still the head of `main`. The `X.Y` image tag only moves when the version is the highest `vX.Y.*` patch on the remote (`X.Y.Z` and the short-SHA tags are always pushed). If the `vX.Y.Z` tag already exists on another commit (another commit shipped that version before a failed job was re-run), the image and release jobs fail before pushing; re-run the whole workflow so the version is recomputed. Manual `workflow_dispatch` runs on other branches only run the tests. Pushes that only change documentation (`*.md`, `docs/`) do not trigger it.

**Versioning**: `major.minor` comes from `apps/web/package.json`; the patch number is the latest `vX.Y.*` tag + 1 (starting at 0) — see `scripts/next-version.mjs`. To start a new minor/major line, change the version in `apps/web/package.json`. The version shown in the header and footer is the one injected at build time (`APP_VERSION`); local builds derive it from git tags (`scripts/local-version.mjs`): `0.1.2` on a tagged commit, `0.1.2-dev+3.44e9b27` when 3 commits past the tag (`.dirty` if there are uncommitted changes), and `<package.json version>-dev` when git or tags are unavailable (e.g. a local `docker compose` build). Pushing a `v*` tag manually (it must be `vX.Y.Z`) builds an image for that tag without creating a new version, and creates its Release if missing.

---

Made by [TeiNam](https://github.com/TeiNam)
