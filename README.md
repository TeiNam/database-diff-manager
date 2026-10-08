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
- **Comparison**: summary, per-object diff (SQL split/unified and a spreadsheet-like grid), and a tree that can filter to changed objects only.
- **DDL generation**: ALTER/CREATE/DROP for tables, columns, indexes, foreign keys, views, and partitions, plus the reverse (rollback) direction. Renames are mapped in the UI.
- **DB migration mapping**: upload an AWS DMS table-mapping JSON for an As-Is → To-Be Schema pair. The Migration (전환) tab shows table and column correspondence with a status for each, and the same mapping is applied as renames to the object diff and DDL. Manual rename mappings still win for the same object.
- **History**: version history, per-object change history, original file download.
- **Accounts**: admin/viewer roles. Dark and light themes.

## Input files

| Item | Details |
|---|---|
| Supported versions | td-export 0.1.15 – 0.1.30 (output format is detected per file) |
| Formats | `.sql` (recommended, lossless), `.md` (partially lossy — flagged in the UI) |
| Name suggestion | `schema(host).sql` → Database `host`; `schema(host_port).sql` (0.1.30) → Database `host:port`. If a Database with the older `host_port` name already exists, that one is selected |
| DMS mapping | AWS DMS table-mapping JSON: `selection` include/exclude (`%` wildcard), `transformation` rename of schema/table/column, and `remove-column`. Other actions are listed as warnings and not applied. Up to 20,000 rules, 20MB |

See [table-define-exporter](https://github.com/TeiNam/table-define-exporter) for how to run td-export.

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

## Permissions

| Action | admin | viewer |
|---|---|---|
| Browse, compare, copy/download DDL | ✓ | ✓ |
| Save rename mappings (affects everyone's diff results) | ✓ | ✓ |
| Upload; delete versions, Schemas, Databases | ✓ | — |
| Upload or delete DMS migration mappings | ✓ | — |
| Manage accounts | ✓ | — |

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
npm run test:mysql -w @tdm/core   # applies generated DDL on MySQL 8.0/8.4 containers (requires Docker)
```

## CI

On every push to `main`, GitHub Actions runs typecheck, tests, and the build, then computes the product version, publishes a Docker image (`linux/amd64`, `linux/arm64`) tagged with that version to GHCR, and finally creates the `vX.Y.N` tag and a GitHub Release. Re-running a workflow for the same commit reuses that commit's tag, and `latest` only moves when the commit is still the head of `main`. The `X.Y` image tag only moves when the version is the highest `vX.Y.*` patch on the remote (`X.Y.Z` and the short-SHA tags are always pushed). If the `vX.Y.Z` tag already exists on another commit (another commit shipped that version before a failed job was re-run), the image and release jobs fail before pushing; re-run the whole workflow so the version is recomputed. Manual `workflow_dispatch` runs on other branches only run the tests. Pushes that only change documentation (`*.md`, `docs/`) do not trigger it.

**Versioning**: `major.minor` comes from `apps/web/package.json`; the patch number is the latest `vX.Y.*` tag + 1 (starting at 0) — see `scripts/next-version.mjs`. To start a new minor/major line, change the version in `apps/web/package.json`. The version shown in the header and footer is the one injected at build time (`APP_VERSION`); local builds show `X.Y.Z-dev`. Pushing a `v*` tag manually (it must be `vX.Y.Z`) builds an image for that tag without creating a new version, and creates its Release if missing.

---

Made by [TeiNam](https://github.com/TeiNam)
