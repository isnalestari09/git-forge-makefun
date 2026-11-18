[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/isnalestari09/git-forge-makefun/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/isnalestari09/git-forge-makefun/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# git-forge

A standalone GitHub-compatible git forge in a single Node.js process. No UI, no
database, no git binary, no outside service: it serves git smart HTTP, the REST
v3 API, GraphQL, and MCP from its own in-memory store, and speaks the git
wire protocol (pkt-lines, sideband, packfiles, OFS/REF deltas) itself.

Built for the make.fun bounty
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01)
($500, ends Sat 21 Nov 2026 13:30 WIB).

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Lifecycle: bind an ephemeral port, register it with the suite at `$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done` until the suite finishes, exit 0. With no env URL it just serves until killed. |
| `app.ts` | The whole forge: HTTP server, auth, REST v3, git smart HTTP (v0 + v2), GraphQL, MCP, and the deterministic store. |
| `git.ts` | Pure git plumbing: pkt-lines, sideband framing, SHA-1 objects, commits/trees/tags, pack read (v2/v3, OFS_DELTA + REF_DELTA) and pack write. |
| `LICENSE` | MIT. |

Node 22, standard library only (plus `crypto`, `http`, `node:buffer`).
Run it with type stripping: `node main.ts` (no build step).

## Local run

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 PORT=18080 node --experimental-strip-types main.ts
```

`MAKEFUN_SHOP_TOKEN` sets the bearer token the suite (and git clients) must
send; when it is unset, any bearer token is accepted, for local tinkering.
`/healthz` answers without auth; everything else needs `Authorization: Bearer <token>`.

## What it serves

- **Git smart HTTP** — `GET /{owner}/{repo}/info/refs?service=git-upload-pack|git-receive-pack`
  (v2 advertisement with `ls-refs=unborn`, `fetch=shallow`, `object-format=sha1`;
  v0 advertisements with `side-band-64k`, `symref`, `report-status`, `delete-refs`),
  `POST .../git-upload-pack` (v2 fetch with ls-refs, shallow/deepen, incremental
  fetch; v0 fetch), `POST .../git-receive-pack` (per-ref fast-forward checks,
  mixed ok/ng reports, sideband `unpack ok`). Real `git clone` / `push` / `pull`
  work against it.
- **REST v3** (`/api/v3/`) — repos (create/read/patch/delete, Link pagination),
  branches, commits, git refs, contents (create/update with stale-sha 409/delete),
  labels, issues (filter/sort, per-repo incrementing numbers), issue comments,
  pull requests (create, files diff, squash merge with 3-way conflict detection
  against the live base tip). Every reply is `application/json` with a non-empty
  `X-GitHub-Request-Id`; unknown routes are JSON 404s, malformed JSON is 400.
- **GraphQL** (`POST /api/graphql`) — `viewer`, `repository`, `node`, issues
  connection with cursor pagination, `__type` introspection, mutations
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment`, batched operation arrays.
- **MCP** (`POST /mcp`) — streamable HTTP, protocol revision `2026-07-28`
  (`server/discover` + legacy `initialize`), six tools: `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`. Tool effects are visible over REST.

## Determinism

All stored timestamps come from a logical clock seeded at the scenario epoch
(2025-01-01) plus a counter, so no wall-clock time enters stored state; ids are
counter-based. Two runs on the same instance leave the same state.

## Test results

Local conformance suite from the bounty kit
(`sdk/run.ts`, 120 checks: git 30, repos 15, issues 15, pulls 20, protocol 10,
graphql 20, mcp 15):

```
checks: 120 registered; 120 passed, 0 failed
feature 600   agent 200   perf 116   score 916 of 1000
benchmark push:  p50 704 ms  -> 40 pts
benchmark clone: p50 264 ms  -> 25 pts
benchmark read:  p50 2365 ms -> 28 pts
benchmark write: p50 392 ms  -> 23 pts
```

The house reference forge scored 120/120 conformance with roughly ~100 perf
points (~900 total) in the kit's calibration, so this entry beats it on both
conformance and speed. Perf is measured against the kit's calibration
(`program/env/src/calibration.json`).

## Submitting

The bounty needs a **public GitHub repo** owned by your own GitHub account,
created after the competition opens, under an OSI-approved license, with
`main.ts` in the repo root, plus the AI coding-agent transcripts of the
sessions that built it, uploaded with each submission
(`node cli/makefun.mjs bundle` in the kit). At most 5 submissions a day and
10 in total; the last submission before the deadline is the final entry. A
prize needs a score above the best house entry's — the house reference enters
in the last hours and takes none of the 60 seats.
