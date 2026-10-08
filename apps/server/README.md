# @tdm/server

English | [한국어](README.ko.md)

An API server that manages td-export definition files (.sql/.md) as versions and provides the diff and DDL between any two versions. Parsing, diffing, and DDL generation are handled by `@tdm/core`.

## Running

```bash
npm install                                         # from the repository root
npm run create-admin -w @tdm/server -- admin       # first admin (password is entered at the prompt)
npm run dev -w @tdm/server                          # http://127.0.0.1:3000
```

| Environment variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | Port |
| `DATA_DIR` | `./data` | Location of the SQLite file (`tdm.db`) |
| `COOKIE_SECURE` | `true` | Set to `false` only when developing over HTTP. If you access the server through an address other than localhost, the Secure cookie is not sent. When `false`, HSTS and `upgrade-insecure-requests` are also disabled |
| `WEB_DIST` | `<cwd>/../web/dist` | Location of the built web app (`apps/web/dist`). Running `npm start` from the repository root works with the default. After rebuilding the web app, restart the server for the change to take effect |
| `TRUST_PROXY` | `false` | Scope in which `X-Forwarded-For` is trusted behind a reverse proxy. `true`/`false`, a hop count (e.g. `1`), or a comma-separated list of IPs/CIDRs (e.g. `10.0.0.0/8,127.0.0.1`) |

## Operations (reverse proxy)

Behind a reverse proxy such as nginx or ALB, the socket address of every request is the proxy IP, so the login rate limit (5 per minute) applies to all clients as a single bucket. A single attacker who repeatedly fails to log in can then lock every user out.

- Configure the proxy to append `X-Forwarded-For`, and tell the server which proxies to trust with `TRUST_PROXY`. Specifying a hop count (`1`) or the proxy IP/CIDR is recommended.
- If the server is directly reachable without going through the proxy and you trust everything with `TRUST_PROXY=true`, a client can forge `X-Forwarded-For` to bypass the limit. Block access to the server port from anything other than the proxy.
- The login limit key is `IP:username` (username in lowercase), so other users behind the same NAT do not affect each other.

## API summary

All paths are under `/api`. Requests that change state must include the `X-Requested-With: tdm` header.

| Method | Path | Permission |
|---|---|---|
| POST | `/auth/login`, `/auth/logout` · GET `/auth/me` | — / logged in |
| GET·POST·PATCH | `/users[/:id]` | admin |
| GET | `/tree`, `/schemas/:id`, `/schemas/:id/versions` | logged in |
| POST·PATCH·DELETE | `/databases[/:id]` (`confirmName` required for deletion) | admin |
| DELETE | `/schemas/:id` (`confirmName` required; cascades to versions and object history) | admin |
| POST | `/uploads` (multipart: `meta` JSON + `files`) | admin |
| GET | `/versions/:id`, `/versions/:id/source` | logged in |
| DELETE | `/versions/:id` | admin |
| GET | `/diff?base=&target=` · PUT `/diff/renames` | logged in |
| GET | `/objects/:id/history` | logged in |
| POST | `/migrations` (JSON: `fromSchemaId`, `toSchemaId`, `filename`, `source`, `note?`; returns parse warnings) · DELETE `/migrations/:id` | admin |
| GET | `/migrations?from=&to=`, `/migrations/:id/source`, `/migration-flow?base=&target=` | logged in |

`PUT /diff/renames` (saves rename mappings) is open to all logged-in users, including viewers. This is the policy set in the design document.

A migration mapping belongs to a Schema pair (As-Is → To-Be). Uploading again for the same pair adds a revision, and the latest revision is applied automatically whenever the BASE version belongs to the From Schema and the TARGET version to the To Schema (never in the reverse direction). Renames in `GET /diff` carry `source: 'dms' | 'manual'`. `PUT /diff/renames` saves manual renames only: entries identical to a DMS-derived rename are dropped on the server before the 500-entry limit is applied.

## Testing

```bash
npm test -w @tdm/server
npm run typecheck -w @tdm/server
```
