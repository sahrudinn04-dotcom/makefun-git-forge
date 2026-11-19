# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sahrudinn04-dotcom/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sahrudinn04-dotcom/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only —
no git binary, no package manager, no outside service. Built for the make.fun
bounty "Build a GitHub-compatible git forge" (github-core-clone-01):
https://make.fun/bounty/github-core-clone-01

Try make.fun with my referral: https://make.fun/r/2c51b8pr

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must name the environment origin and `MAKEFUN_SHOP_TOKEN`
the bearer token the suite uses. The process binds an ephemeral port, POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, serves, and polls
`$MAKEFUN_ENV_URL/done` until `{"done": true}`, then exits 0. It never binds
8080.

## Surfaces (one in-memory store, deterministic state)

- **Git smart HTTP** — `/{owner}/{repo}.git`: upload-pack protocol v2 (and v0
  when the client does not ask for v2), receive-pack v0 with `report-status`,
  `side-band-64k`, `delete-refs`. Every update must fast-forward; a
  non-fast-forward push is refused per ref with `ng <ref> non-fast-forward`.
  The pack protocol (pkt-lines, SHA-1 objects, trees, commits, tags, pack
  read/write incl. deltas) is implemented by hand in `git.ts`.
- **REST v3** — `/api/v3`: repos, refs, branches, commits, contents, labels,
  issues, comments, pull requests (incl. squash merge). Every reply is
  `application/json` with a non-empty `X-GitHub-Request-Id`; missing token is
  401, malformed JSON is 400, unknown route is 404 JSON.
- **GraphQL v4** — `/api/graphql`: `viewer`, `repository`, `node`, `__type`
  introspection, cursor pagination, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment` mutations, plus
  batched operations.
- **MCP** — `/mcp`: JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  (`server/discover`, legacy `initialize` fallback), with `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Files

- `main.ts` — the entry <-> env lifecycle (bind ephemeral port, register,
  poll done).
- `app.ts` — the HTTP server: git smart HTTP, REST v3, GraphQL, MCP.
- `store.ts` — the in-memory store: repos, refs, objects, issues, pull
  requests, deterministic ids and timestamps.
- `git.ts` — SHA-1 object model, pkt-lines, pack read/write, reachability,
  merge-base, tree diffing.
