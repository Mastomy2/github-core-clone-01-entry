# forge — a GitHub-compatible git forge in one process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Mastomy2/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Mastomy2/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone entry for [github-core-clone-01](https://make.fun/bounty/github-core-clone-01): a
single Node process that serves git smart HTTP, the REST v3 API, GraphQL v4 and MCP from its own
in-memory store, with no dependencies, no git binary, no database and no network access at run
time. It is deterministic: fixed timestamps, counters for ids, no clock or randomness in state, so
two runs on the same instance export byte-identical state.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and
its own modules only.

## The lifecycle (main.ts)

Kept from the kit starter. The env is a server the harness starts beside yours; its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, including batching and introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs` (v2 upload-pack, v0 receive-pack), `git-upload-pack` (ls-refs, fetch, shallow/deepen), `git-receive-pack` (push, report-status) |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in the entry's environment); `/healthz` takes none. A missing or wrong token is refused with 401.

## Layout

- `main.ts`: the lifecycle above. Kept from the kit starter.
- `app.ts`: the server and router.
- `git.ts`: pure git plumbing — objects, pkt-lines, pack v2 (plain objects), reachability, shallow/deepen.
- `store.ts`: the state — repositories, objects and refs, issues, labels, comments, pull requests — and the operations on them (fetch plans, squash merges, contents commits).
- `rest.ts`: the REST v3 surface.
- `graphql.ts`: a dependency-free GraphQL parser and executor.
- `mcp.ts`: the MCP endpoint and its six tools.
- `git-http.ts`: the git smart-HTTP surface.
- `http.ts`: shared HTTP helpers (JSON replies, pagination, the token guard).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Notes on the implementation

- **Git objects are real.** Commits, trees, blobs and annotated tags are hashed with SHA-1 over
  `<type> <size>\0<data>`, packs are written as plain objects (no deltas; the suite's client never
  emits them), and pushes are validated as fast-forward-only per ref, with a per-ref `ok`/`ng`
  report-status answer in sideband band 1.
- **Shallow fetches are exact.** A `deepen` fetch delivers only the generations asked for, reports
  the new shallow boundary and the commits that stopped being shallow, and never sends objects the
  client already holds (its shallow boundary stops the have-walk).
- **Contents and merges are real git operations.** A `PUT /contents` builds a new tree and a real
  commit on the branch; a squash merge builds a real commit whose tree is the head tip's, with a
  three-way conflict check against the merge base.
- **GraphQL ids are opaque and stable:** `base64("Repository:owner/name")`,
  `base64("Issue:owner/name#number")`, and so on — never a bare database id or number.
- **MCP, REST and GraphQL share one store**, so a repository created through one surface is visible
  to the others, and the tools' ids match the REST ids.

MIT licensed.
