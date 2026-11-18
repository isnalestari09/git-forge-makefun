// app.ts — a standalone GitHub-compatible git forge: git smart HTTP (v2 upload-pack,
// v0 receive-pack), REST v3, GraphQL v4 and MCP, from one in-memory store.
// Node standard library only. No UI, no git binary, no outside service.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  ZERO_OID, isOid, hashObject, pktLine, pktFlush, pktDelim, parsePktLines, pktDataLines,
  sidebandPack, parseCommit, buildCommit, parseTag, parseTree, buildTree, buildTreeFromFiles,
  flattenTree, collectReachable, peelToCommit, readPack, writePack, verifyPackChecksum,
  type GitObject, type GitObjectType,
} from './git.ts';

// -------------------------------------------------------------------------------------------
// identity: the scenario is fixed by the kit (SCENARIO_SEED 0x6a09e667f3bcc909n), so the
// viewer, the stranger and the org are deterministic and public. The bearer token is the
// trial's MAKEFUN_SHOP_TOKEN; the login it names is the viewer below.
// -------------------------------------------------------------------------------------------
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
const DEFAULT_BRANCH = 'main';
const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z; every generated timestamp derives from it
const AGENT = 'git-forge/1.0.0';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// -------------------------------------------------------------------------------------------
// store
// -------------------------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  databaseId: number;
  globalId: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number; // shared issue + pull-request numbering, GitHub-style
  nextCommentId: number;
}

const repos = new Map<string, Repo>();
let nextDatabaseId = 5000;
let nextRequestId = 1;
let clockSeq = 0;

function nextTimestamp(): { sec: number; iso: string } {
  clockSeq += 1;
  const sec = SCENARIO_EPOCH_SEC + clockSeq;
  return { sec, iso: new Date(sec * 1000).toISOString() };
}

function globalId(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function repoGlobalId(databaseId: number): string {
  return globalId('Repository', [databaseId]);
}

function issueGlobalId(repo: Repo, number: number): string {
  return globalId('Issue', [repo.databaseId, number]);
}

function pullGlobalId(repo: Repo, number: number): string {
  return globalId('PullRequest', [repo.databaseId, number]);
}

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', [repo.databaseId, issueNumber, commentId]);
}

/** Decode a global id this forge minted, or null. */
function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function findRepoByDatabaseId(databaseId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.databaseId === databaseId) return repo;
  return undefined;
}

// -------------------------------------------------------------------------------------------
// git object helpers bound to a repo
// -------------------------------------------------------------------------------------------

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Is `ancestor` reachable from `descendant` (walking commit parents)? */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The nearest common ancestor commit of two tips (first hit walking both sides). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackB.push(parent);
  }
  return null;
}

/** Resolve a ref-ish (branch name, full ref, or 40-hex oid) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return lookupObject(repo, ref)?.type === 'commit' ? ref : null;
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    return oid ?? null;
  }
  const oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (!oid) return null;
  const object = lookupObject(repo, oid);
  if (!object) return null;
  return object.type === 'tag' ? peelToCommit(oid, (id) => lookupObject(repo, id)) : oid;
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  segments: string[];
  body: Buffer;
  authed: boolean;
}

function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = status === 204 ? '' : JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': `req-${nextRequestId++}`,
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function readBody(req: IncomingMessage, maxBytes = 128 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(ctx: Ctx): { ok: true; value: unknown } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryInt(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse `?page=&per_page=` the way GitHub does (defaults 1 / 30, per_page clamped 1..100). */
function pagination(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, queryInt(url, 'page', 1));
  const perPage = Math.min(100, Math.max(1, queryInt(url, 'per_page', 30)));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], url: URL): { page: T[]; link: string | null } {
  const { page, perPage } = pagination(url);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const origin = url.origin;
    const next = new URL(url.pathname, origin);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const last = new URL(url.pathname, origin);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(totalPages));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
    if (page > 1) {
      const prev = new URL(url.pathname, origin);
      for (const [key, value] of url.searchParams) prev.searchParams.set(key, value);
      prev.searchParams.set('per_page', String(perPage));
      prev.searchParams.set('page', String(page - 1));
      link += `, <${prev.toString()}>; rel="prev"`;
    }
  }
  return { page: [...pageItems], link };
}

// -------------------------------------------------------------------------------------------
// REST shapes
// -------------------------------------------------------------------------------------------

function userObject(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: globalId('User', [id]),
    avatar_url: `https://example.invalid/avatar/${login}`,
    type: 'User',
    site_admin: false,
    name: login === VIEWER_LOGIN ? VIEWER_NAME : login,
    email: `${login}@example.invalid`,
  };
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updatedAt: repo.updatedAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelObject(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: '',
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue.number),
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelObject(repo, name)),
    user: userObject(VIEWER_LOGIN, VIEWER_ID),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGlobalId(repo, pull.number),
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull) ? true : undefined,
    user: userObject(VIEWER_LOGIN, VIEWER_ID),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
  };
}

/** The three-way merge analysis for a pull request: null when it cannot be computed. */
function pullMergeAnalysis(repo: Repo, pull: Pull): { conflict: boolean; resultFiles: Map<string, { oid: string; mode: string } | null> } | null {
  // The three-way merge compares against the CURRENT base tip, not the tip recorded
  // when the PR was opened: another PR may have merged since.
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo, pull.headSha, baseTip);
  if (base === null) return null;
  const baseCommit = lookupObject(repo, base);
  const headCommit = lookupObject(repo, pull.headSha);
  const tipCommit = lookupObject(repo, baseTip);
  if (!baseCommit || !headCommit || !tipCommit) return null;
  const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, (id) => lookupObject(repo, id));
  const headFiles = flattenTree(parseCommit(headCommit.data).tree, (id) => lookupObject(repo, id));
  const tipFiles = flattenTree(parseCommit(tipCommit.data).tree, (id) => lookupObject(repo, id));
  let conflict = false;
  const resultFiles = new Map<string, { oid: string; mode: string } | null>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const t = tipFiles.get(path);
    const bOid = b?.oid ?? null;
    const hOid = h?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (hOid === bOid) {
      resultFiles.set(path, t ? { oid: t.oid, mode: t.mode } : null);
    } else if (tOid === bOid) {
      resultFiles.set(path, h ? { oid: h.oid, mode: h.mode } : null);
    } else if (hOid === tOid) {
      resultFiles.set(path, h ? { oid: h.oid, mode: h.mode } : null);
    } else {
      conflict = true;
      resultFiles.set(path, t ? { oid: t.oid, mode: t.mode } : null);
    }
  }
  return { conflict, resultFiles };
}

/** Whether a pull request merges cleanly (false when conflicted or uncomputable). */
function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const analysis = pullMergeAnalysis(repo, pull);
  return analysis !== null && !analysis.conflict;
}

/** The changed files of a pull request, head tree vs merge-base tree. */
function pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo, pull.headSha, baseTip);
  const headCommit = lookupObject(repo, pull.headSha);
  if (!headCommit) return [];
  const headFiles = flattenTree(parseCommit(headCommit.data).tree, (id) => lookupObject(repo, id));
  const baseFiles = new Map<string, { oid: string; mode: string }>();
  if (base !== null) {
    const baseCommit = lookupObject(repo, base);
    if (baseCommit) flattenTree(parseCommit(baseCommit.data).tree, (id) => lookupObject(repo, id), '', baseFiles);
  }
  const lineCount = (oid: string | null): number => {
    if (oid === null) return 0;
    const object = lookupObject(repo, oid);
    if (!object) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const additions = Math.max(1, lineCount(h.oid));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const deletions = Math.max(1, lineCount(b.oid));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h) {
      const additions = Math.max(1, lineCount(h.oid));
      const deletions = Math.max(0, lineCount(b.oid));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// contents API (shared by REST and by the merge path)
// -------------------------------------------------------------------------------------------

interface ContentResult {
  status: number;
  contentSha?: string;
  commitSha?: string;
  message?: string;
}

/** Commit one file change on a branch: create (201) or update (200). */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha?: string,
): ContentResult {
  const refName = `refs/heads/${branch}`;
  const parentOid = repo.refs.get(refName);
  let files = new Map<string, { oid: string; mode: string }>();
  const parents: string[] = [];
  if (parentOid !== undefined) {
    const parent = lookupObject(repo, parentOid);
    if (!parent || parent.type !== 'commit') return { status: 422, message: 'branch tip is not a commit' };
    parents.push(parentOid);
    files = flattenTree(parseCommit(parent.data).tree, (id) => lookupObject(repo, id));
  }
  const existing = files.get(path);
  const blobOid = putObject(repo, 'blob', content);
  if (existing) {
    if (expectedSha !== undefined && expectedSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { status: 409, message: 'sha does not match the current blob' };
    }
    if (expectedSha === undefined) return { status: 422, message: 'sha is required to update a file' };
  }
  files.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTreeFromFiles(files, (type, data) => putObject(repo, type as GitObjectType, data));
  const { sec } = nextTimestamp();
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const commitData = buildCommit({ tree: treeOid, parents, message, author, committer: author, timestamp: sec });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitOid);
  return { status: existing ? 200 : 201, contentSha: blobOid, commitSha: commitOid };
}

function deleteFile(repo: Repo, branch: string, path: string, message: string): ContentResult {
  const refName = `refs/heads/${branch}`;
  const parentOid = repo.refs.get(refName);
  if (parentOid === undefined) return { status: 404, message: 'branch not found' };
  const parent = lookupObject(repo, parentOid);
  if (!parent || parent.type !== 'commit') return { status: 422, message: 'branch tip is not a commit' };
  const files = flattenTree(parseCommit(parent.data).tree, (id) => lookupObject(repo, id));
  if (!files.has(path)) return { status: 404, message: 'file not found' };
  files.delete(path);
  const treeOid = buildTreeFromFiles(files, (type, data) => putObject(repo, type as GitObjectType, data));
  const { sec } = nextTimestamp();
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const commitData = buildCommit({ tree: treeOid, parents: [parentOid], message, author, committer: author, timestamp: sec });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(refName, commitOid);
  return { status: 200, commitSha: commitOid };
}

/** Walk the commit graph from a tip, newest first (parents after children). */
function listCommits(repo: Repo, tip: string, limit = 100): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    // The GitHub API returns the message without the trailing newline git stores.
    const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
    out.push({ sha: oid, message });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

function requireRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  const repo = findRepo(owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

async function handleRest(ctx: Ctx): Promise<boolean> {
  const s = ctx.segments; // after 'api', 'v3'
  // GET /api/v3/
  if (s.length === 0) {
    if (ctx.method !== 'GET') return false;
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{username}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (s[0] === 'meta' && s.length === 1) {
    if (ctx.method !== 'GET') return false;
    sendJson(ctx, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (s[0] === 'user' && s.length === 1) {
    if (ctx.method !== 'GET') return false;
    sendJson(ctx, 200, userObject(VIEWER_LOGIN, VIEWER_ID));
    return true;
  }
  if (s[0] === 'user' && s[1] === 'repos') {
    if (ctx.method === 'GET') {
      const all = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq);
      const { page, link } = paginate(all.map((repo) => repoObject(repo)), ctx.url);
      sendJson(ctx, 200, page, link ? { link } : {});
      return true;
    }
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendError(ctx, 422, 'Invalid repository name');
        return true;
      }
      if (findRepo(VIEWER_LOGIN, name)) {
        sendError(ctx, 422, 'Repository already exists');
        return true;
      }
      const { sec, iso } = nextTimestamp();
      void sec;
      const databaseId = nextDatabaseId++;
      const repo: Repo = {
        owner: VIEWER_LOGIN,
        name,
        databaseId,
        globalId: repoGlobalId(databaseId),
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
        defaultBranch: DEFAULT_BRANCH,
        createdAt: iso,
        updatedAt: iso,
        seq: clockSeq,
        objects: new Map(),
        refs: new Map(),
        issues: [],
        pulls: [],
        labels: new Map(),
        nextNumber: 1,
        nextCommentId: 1,
      };
      repos.set(repoKey(VIEWER_LOGIN, name), repo);
      sendJson(ctx, 201, repoObject(repo));
      return true;
    }
    return false;
  }
  if (s[0] !== 'repos' || s.length < 3) return false;
  const owner = decodeURIComponent(s[1] as string);
  const repoName = decodeURIComponent(s[2] as string);
  const rest = s.slice(3);

  // GET /repos/{o}/{r} | PATCH | DELETE
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const repo = requireRepo(ctx, owner, repoName);
      if (!repo) return true;
      sendJson(ctx, 200, repoObject(repo));
      return true;
    }
    if (ctx.method === 'PATCH') {
      const repo = requireRepo(ctx, owner, repoName);
      if (!repo) return true;
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
      }
      repo.updatedAt = nextTimestamp().iso;
      sendJson(ctx, 200, repoObject(repo));
      return true;
    }
    if (ctx.method === 'DELETE') {
      const repo = requireRepo(ctx, owner, repoName);
      if (!repo) return true;
      repos.delete(repoKey(owner, repoName));
      ctx.res.writeHead(204, { 'x-github-request-id': `req-${nextRequestId++}` });
      ctx.res.end();
      return true;
    }
    return false;
  }

  const repo = requireRepo(ctx, owner, repoName);
  if (!repo) return true;

  // GET /repos/{o}/{r}/branches
  if (rest[0] === 'branches' && rest.length === 1 && ctx.method === 'GET') {
    const list = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    sendJson(ctx, 200, list);
    return true;
  }
  // GET /repos/{o}/{r}/branches/{branch}
  if (rest[0] === 'branches' && rest.length === 2 && ctx.method === 'GET') {
    const branch = decodeURIComponent(rest[1] as string);
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    sendJson(ctx, 200, { name: branch, commit: { sha }, protected: false });
    return true;
  }
  // GET /repos/{o}/{r}/commits
  if (rest[0] === 'commits' && rest.length === 1 && ctx.method === 'GET') {
    const ref = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) {
      sendJson(ctx, 200, []);
      return true;
    }
    const commits = listCommits(repo, tip).map(({ sha, message }) => ({
      sha,
      commit: { message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
      author: userObject(VIEWER_LOGIN, VIEWER_ID),
      committer: userObject(VIEWER_LOGIN, VIEWER_ID),
    }));
    sendJson(ctx, 200, commits);
    return true;
  }
  // POST /repos/{o}/{r}/git/refs  |  GET /repos/{o}/{r}/git/refs/heads/{branch}
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (ctx.method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !lookupObject(repo, sha)) {
        sendError(ctx, 422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(ctx, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(ctx, 201, { ref, object: { sha, type: lookupObject(repo, sha)?.type ?? 'commit' } });
      return true;
    }
    if (ctx.method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = decodeURIComponent(rest[3] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha, type: lookupObject(repo, sha)?.type ?? 'commit' } });
      return true;
    }
    return false;
  }
  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    if (ctx.method === 'PUT') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof body.message === 'string' ? body.message : 'update';
      const content = typeof body.content === 'string' ? body.content : '';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content, 'base64');
      } catch {
        sendError(ctx, 422, 'Invalid base64 content');
        return true;
      }
      if (branch !== repo.defaultBranch && !repo.refs.has(`refs/heads/${branch}`)) {
        // A contents write to a missing branch creates it from the default tip (or as root).
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
      }
      const result = commitFile(repo, branch, path, bytes, message, sha);
      if (result.status === 409 || result.status === 422) {
        sendError(ctx, result.status, result.message ?? 'Conflict');
        return true;
      }
      sendJson(ctx, result.status, {
        content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: bytes.length, type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
      return true;
    }
    if (ctx.method === 'GET') {
      const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (!tip) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const tipObject = lookupObject(repo, tip);
      if (!tipObject || tipObject.type !== 'commit') {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const files = flattenTree(parseCommit(tipObject.data).tree, (id) => lookupObject(repo, id));
      const file = files.get(path);
      if (file) {
        const blob = lookupObject(repo, file.oid);
        sendJson(ctx, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob?.data.length ?? 0,
          name: path.split('/').pop() ?? path,
          path,
          content: blob?.data.toString('base64') ?? '',
          sha: file.oid,
        });
        return true;
      }
      // Directory listing: the immediate children of `path`.
      const prefix = path === '' ? '' : `${path}/`;
      const children = new Map<string, { type: string; oid: string; name: string; path: string }>();
      for (const [filePath, entry] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const restPath = filePath.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash === -1) {
          children.set(restPath, { type: 'file', oid: entry.oid, name: restPath, path: filePath });
        } else {
          const dirName = restPath.slice(0, slash);
          if (!children.has(dirName)) {
            children.set(dirName, { type: 'dir', oid: '', name: dirName, path: `${prefix}${dirName}` });
          }
        }
      }
      if (children.size === 0) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const listing = [...children.values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((child) => ({
          type: child.type,
          name: child.name,
          path: child.path,
          sha: child.oid === '' ? hashObject('tree', buildTree([])) : child.oid,
        }));
      sendJson(ctx, 200, listing);
      return true;
    }
    if (ctx.method === 'DELETE') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof body.message === 'string' ? body.message : 'delete';
      const result = deleteFile(repo, repo.defaultBranch, path, message);
      if (result.status !== 200) {
        sendError(ctx, result.status, result.message ?? 'Not Found');
        return true;
      }
      sendJson(ctx, 200, { commit: { sha: result.commitSha } });
      return true;
    }
    return false;
  }
  // labels
  if (rest[0] === 'labels') {
    if (ctx.method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendError(ctx, 422, 'Label name is required');
        return true;
      }
      if (!repo.labels.has(name)) {
        repo.labels.set(name, { name, color: typeof body.color === 'string' ? body.color : 'ededed' });
      }
      sendJson(ctx, 201, labelObject(repo, name));
      return true;
    }
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, [...repo.labels.keys()].map((name) => labelObject(repo, name)));
      return true;
    }
    return false;
  }
  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (ctx.method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof body.title === 'string' ? body.title : '';
        const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(ctx, 422, `Label ${label} does not exist`);
            return true;
          }
        }
        const created = createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
        sendJson(ctx, 201, issueObject(repo, created));
        return true;
      }
      if (ctx.method === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        const sort = ctx.url.searchParams.get('sort') ?? 'created';
        const direction = ctx.url.searchParams.get('direction') ?? 'desc';
        let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, link } = paginate(list.map((issue) => issueObject(repo, issue)), ctx.url);
        sendJson(ctx, 200, page, link ? { link } : {});
        return true;
      }
      return false;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (ctx.method === 'GET') {
        if (!issue) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, issueObject(repo, issue));
        return true;
      }
      if (ctx.method === 'PATCH') {
        if (!issue) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((x): x is string => typeof x === 'string');
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(ctx, 422, `Label ${label} does not exist`);
              return true;
            }
          }
          issue.labels = labels;
        }
        issue.updatedAt = nextTimestamp().iso;
        sendJson(ctx, 200, issueObject(repo, issue));
        return true;
      }
      return false;
    }
    if (rest[2] === 'comments') {
      if (!issue) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (ctx.method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const comment: Comment = {
          id: repo.nextCommentId++,
          body: typeof body.body === 'string' ? body.body : '',
          user: VIEWER_LOGIN,
          createdAt: nextTimestamp().iso,
          seq: clockSeq,
        };
        issue.comments.push(comment);
        sendJson(ctx, 201, {
          id: comment.id,
          node_id: commentGlobalId(repo, issue.number, comment.id),
          body: comment.body,
          user: userObject(VIEWER_LOGIN, VIEWER_ID),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        });
        return true;
      }
      if (ctx.method === 'GET') {
        sendJson(ctx, 200, issue.comments.map((comment) => ({
          id: comment.id,
          node_id: commentGlobalId(repo, issue.number, comment.id),
          body: comment.body,
          user: userObject(VIEWER_LOGIN, VIEWER_ID),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        })));
        return true;
      }
      return false;
    }
    return false;
  }
  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (ctx.method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        const title = typeof body.title === 'string' ? body.title : '';
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          sendError(ctx, 422, 'Head or base branch not found');
          return true;
        }
        const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (existing) {
          sendError(ctx, 422, 'A pull request already exists for this head and base');
          return true;
        }
        const pull = createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base, headSha, baseSha);
        sendJson(ctx, 201, pullObject(repo, pull));
        return true;
      }
      if (ctx.method === 'GET') {
        const state = ctx.url.searchParams.get('state') ?? 'open';
        const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        const { page, link } = paginate(list.map((pull) => pullObject(repo, pull)), ctx.url);
        sendJson(ctx, 200, page, link ? { link } : {});
        return true;
      }
      return false;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (ctx.method === 'GET') {
        if (!pull) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, pullObject(repo, pull));
        return true;
      }
      return false;
    }
    if (rest[2] === 'files' && ctx.method === 'GET') {
      if (!pull) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, pullFiles(repo, pull));
      return true;
    }
    if (rest[2] === 'merge' && ctx.method === 'PUT') {
      if (!pull) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const merged = mergePull(repo, pull);
      if (merged.status === 404) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (merged.status === 405) {
        sendError(ctx, 405, merged.message ?? 'Merge conflict');
        return true;
      }
      sendJson(ctx, 200, { merged: true, sha: merged.sha, message: merged.message ?? 'Pull request successfully merged.' });
      return true;
    }
    return false;
  }
  return false;
}

function createIssue(repo: Repo, title: string, body: string, labels: string[] = []): Issue {
  const { iso } = nextTimestamp();
  const issue: Issue = {
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    user: VIEWER_LOGIN,
    createdAt: iso,
    updatedAt: iso,
    seq: clockSeq,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

function createPull(
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
  headSha: string,
  baseSha: string,
): Pull {
  const { iso } = nextTimestamp();
  const pull: Pull = {
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: VIEWER_LOGIN,
    createdAt: iso,
    updatedAt: iso,
    seq: clockSeq,
  };
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge a pull request onto its base branch. */
function mergePull(repo: Repo, pull: Pull): { status: number; sha?: string; message?: string } {
  if (pull.state !== 'open') return { status: 405, message: 'Pull request is already closed' };
  const analysis = pullMergeAnalysis(repo, pull);
  if (analysis === null) return { status: 405, message: 'Merge base not found' };
  if (analysis.conflict) return { status: 405, message: 'Merge conflict' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return { status: 404, message: 'Base branch not found' };
  const files = new Map<string, { oid: string; mode: string }>();
  for (const [path, value] of analysis.resultFiles) {
    if (value) files.set(path, value);
  }
  const treeOid = buildTreeFromFiles(files, (type, data) => putObject(repo, type as GitObjectType, data));
  const { sec, iso } = nextTimestamp();
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit({ tree: treeOid, parents: [baseTip], message, author, committer: author, timestamp: sec });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = iso;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = iso;
  return { status: 200, sha: mergeSha, message: 'Pull request successfully merged.' };
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

function v0RefLine(oid: string, name: string, capabilities?: string): Buffer {
  const line = capabilities ? `${oid} ${name}\0${capabilities}\n` : `${oid} ${name}\n`;
  return pktLine(line);
}

/** The v0 ref advertisement for a service, with the `# service=` preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip) {
    parts.push(v0RefLine(defaultTip, 'HEAD', caps));
    for (const name of sortedRefNames(repo)) {
      const oid = repo.refs.get(name) as string;
      parts.push(v0RefLine(oid, name));
      const object = lookupObject(repo, oid);
      if (object && object.type === 'tag') {
        parts.push(v0RefLine(peelToCommit(oid, (id) => lookupObject(repo, id)), `${name}^{}`));
      }
    }
  } else {
    parts.push(v0RefLine(ZERO_OID, 'capabilities^{}', caps));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Pick the objects a fetch sends: the closure of `wants`, minus what `haves` already reach,
 * cut at `depth` generations (the boundary commits are reported as shallow).
 */
/** The objects a client already holds, from its `haves`: the closure of each have, cut at
 * the client's shallow boundaries (a shallow commit's parents are NOT held). */
function heldObjects(repo: Repo, haves: string[], previousShallow: string[]): Set<string> {
  const stopAt = new Set(previousShallow);
  const held = new Set<string>();
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const object = lookupObject(repo, oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!stopAt.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return held;
}

function selectFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, previousShallow: string[]): FetchSelection {
  const haveReachable = heldObjects(repo, haves, previousShallow);
  // BFS over commits from the wants, tracking generations (want itself is generation 1).
  const included = new Map<string, number>(); // commit oid -> generation
  const tagRoots: string[] = [];
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) {
    const object = lookupObject(repo, want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagRoots.push(want);
      const commitOid = peelToCommit(want, (id) => lookupObject(repo, id));
      if (!included.has(commitOid)) {
        included.set(commitOid, 1);
        queue.push({ oid: commitOid, gen: 1 });
      }
    } else if (object.type === 'commit') {
      if (!included.has(want)) {
        included.set(want, 1);
        queue.push({ oid: want, gen: 1 });
      }
    }
  }
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (depth !== null && gen >= depth) {
      boundary.add(oid);
      continue;
    }
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent) && lookupObject(repo, parent)) {
        included.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of boundary) shallow.push(oid);
  for (const oid of previousShallow) {
    if (included.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }
  // Objects: the closure of the included commits, minus what the client already has.
  // Traversal still crosses held objects (a deepen fetch reaches its parent through a
  // held tip), but only unheld objects are sent. A boundary commit's parents are excluded,
  // so the closure stops at the boundary.
  const objects = new Map<string, GitObject>();
  const addClosure = (rootOid: string): void => {
    const stack: string[] = [rootOid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookupObject(repo, oid);
      if (!object) continue;
      if (!haveReachable.has(oid)) objects.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) {
          // Do not cross a boundary commit's edge, and never send a have's closure.
          if (boundary.has(oid)) continue;
          if (included.has(parent)) stack.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  };
  for (const oid of included.keys()) addClosure(oid);
  for (const oid of tagRoots) addClosure(oid);
  // Acks: every have that is an ancestor-or-equal of a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (!lookupObject(repo, have)) continue;
    for (const want of wants) {
      const wantCommit = lookupObject(repo, want)?.type === 'tag' ? peelToCommit(want, (id) => lookupObject(repo, id)) : want;
      if (isAncestor(repo, have, wantCommit)) {
        acks.push(have);
        break;
      }
    }
  }
  return { objects, shallow, unshallow, acks };
}

function v2FetchResponse(repo: Repo, wants: string[], haves: string[], depth: number | null, previousShallow: string[]): Buffer {
  const selection = selectFetch(repo, wants, haves, depth, previousShallow);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (selection.acks.length > 0) {
      for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (selection.objects.size > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(writePack(selection.objects.values())));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, wants: string[], haves: string[], depth: number | null, previousShallow: string[]): Buffer {
  const selection = selectFetch(repo, wants, haves, depth, previousShallow);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    if (selection.acks.length > 0) {
      for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.size > 0) {
    parts.push(sidebandPack(writePack(selection.objects.values())));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v2 upload-pack request body (ls-refs or fetch arguments). */
function parseV2Request(body: Buffer): { command: string; args: Map<string, string[]> } {
  const lines = pktDataLines(body);
  let command = '';
  const args = new Map<string, string[]>();
  let seenDelim = false;
  for (const pkt of parsePktLines(body)) {
    if (pkt.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  void lines;
  return { command, args };
}

function argOne(args: Map<string, string[]>, key: string): string | undefined {
  const list = args.get(key);
  return list && list.length > 0 ? list[0] : undefined;
}

/** The v2 ls-refs response. */
function v2LsRefsResponse(repo: Repo, args: Map<string, string[]>): Buffer {
  const peel = args.has('peel');
  const symrefs = args.has('symrefs');
  const unborn = args.has('unborn');
  const prefixes = args.get('ref-prefix') ?? [];
  const parts: Buffer[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // HEAD is a ref like any other for prefix matching: it is listed when a
  // requested prefix matches it ("HEAD" itself, or no prefixes at all).
  // A prefix such as "refs/heads/" does not match HEAD, so it stays hidden.
  const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headMatches && symrefs) {
    if (defaultTip) parts.push(pktLine(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const name of sortedRefNames(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = lookupObject(repo, oid);
      if (object && object.type === 'tag') {
        line += ` peeled:${peelToCommit(oid, (id) => lookupObject(repo, id))}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply a receive-pack command list. Returns the report lines (without framing). */
function applyPush(repo: Repo, commands: PushCommand[], packObjects: Map<string, GitObject> | null, unpackError: string | null): string[] {
  const lines: string[] = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError}`);
    for (const command of commands) lines.push(`ng ${command.ref} unpack failed`);
    return lines;
  }
  lines.push('unpack ok');
  if (packObjects) {
    for (const [oid, object] of packObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push(`ng ${command.ref} ref does not exist`);
      } else if (current.toLowerCase() !== command.oldOid.toLowerCase() && command.oldOid !== ZERO_OID) {
        lines.push(`ng ${command.ref} old ref value does not match`);
      } else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const newObject = lookupObject(repo, command.newOid);
    if (!newObject) {
      lines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        lines.push(`ng ${command.ref} old ref value does not match`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (current.toLowerCase() !== command.oldOid.toLowerCase()) {
      lines.push(`ng ${command.ref} old ref value does not match`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && newObject.type === 'commit') {
      if (!isAncestor(repo, current, command.newOid)) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  return lines;
}

function sendGit(ctx: Ctx, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  ctx.res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': `req-${nextRequestId++}`, ...extraHeaders });
  ctx.res.end(body);
}

async function handleGit(ctx: Ctx, owner: string, repoName: string, rest: string[]): Promise<boolean> {
  const repo = findRepo(owner, repoName);
  // GET /{owner}/{repo}.git/info/refs?service=...
  if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs' && ctx.method === 'GET') {
    if (!repo) {
      sendGit(ctx, 404, Buffer.from('Not Found', 'utf8'), 'text/plain');
      return true;
    }
    const service = ctx.url.searchParams.get('service');
    const wantsV2 = ctx.req.headers['git-protocol'] === 'version=2';
    if (service === 'git-upload-pack') {
      if (wantsV2) {
        sendGit(ctx, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendGit(ctx, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendGit(ctx, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendGit(ctx, 404, Buffer.from('Not Found', 'utf8'), 'text/plain');
    return true;
  }
  // POST /{owner}/{repo}.git/git-upload-pack | /git-receive-pack
  if (rest.length === 1 && ctx.method === 'POST' && (rest[0] === 'git-upload-pack' || rest[0] === 'git-receive-pack')) {
    if (!repo) {
      sendGit(ctx, 404, Buffer.from('Not Found', 'utf8'), 'text/plain');
      return true;
    }
    if (rest[0] === 'git-upload-pack') {
      let parsed: { command: string; args: Map<string, string[]> };
      try {
        parsed = parseV2Request(ctx.body);
      } catch {
        sendGit(ctx, 400, Buffer.from('bad pkt-line stream', 'utf8'), 'text/plain');
        return true;
      }
      const wantsV2 = ctx.req.headers['git-protocol'] === 'version=2';
      if (parsed.command === 'ls-refs') {
        if (!wantsV2) {
          sendGit(ctx, 400, Buffer.from('ls-refs requires protocol v2', 'utf8'), 'text/plain');
          return true;
        }
        sendGit(ctx, 200, v2LsRefsResponse(repo, parsed.args), 'application/x-git-upload-pack-result');
        return true;
      }
      if (parsed.command === 'fetch') {
        const wants = parsed.args.get('want') ?? [];
        const haves = parsed.args.get('have') ?? [];
        const previousShallow = parsed.args.get('shallow') ?? [];
        const deepenRaw = argOne(parsed.args, 'deepen');
        const depth = deepenRaw !== undefined ? Number.parseInt(deepenRaw, 10) : null;
        if (wantsV2) {
          sendGit(ctx, 200, v2FetchResponse(repo, wants, haves, Number.isFinite(depth) ? depth : null, previousShallow), 'application/x-git-upload-pack-result');
        } else {
          sendGit(ctx, 200, v0FetchResponse(repo, wants, haves, Number.isFinite(depth) ? depth : null, previousShallow), 'application/x-git-upload-pack-result');
        }
        return true;
      }
      // A v0-shaped fetch body (want/have lines with no command=) reaches here when the
      // client did not ask for v2: parse the raw pkt-lines as a v0 request.
      if (!wantsV2) {
        try {
          const lines = pktDataLines(ctx.body);
          const wants: string[] = [];
          const haves: string[] = [];
          const previousShallow: string[] = [];
          let depth: number | null = null;
          for (const line of lines) {
            if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
            else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
            else if (line.startsWith('shallow ')) previousShallow.push(line.slice(8).trim());
            else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
          }
          sendGit(ctx, 200, v0FetchResponse(repo, wants, haves, Number.isFinite(depth) ? depth : null, previousShallow), 'application/x-git-upload-pack-result');
          return true;
        } catch {
          sendGit(ctx, 400, Buffer.from('bad pkt-line stream', 'utf8'), 'text/plain');
          return true;
        }
      }
      sendGit(ctx, 400, Buffer.from('unknown command', 'utf8'), 'text/plain');
      return true;
    }
    // git-receive-pack: a pkt-line command list up to the first flush, then the pack bytes.
    // The pack is binary and must never be parsed as pkt-lines.
    const commands: PushCommand[] = [];
    let packStart = ctx.body.length;
    let malformed = false;
    {
      let cursor = 0;
      while (cursor + 4 <= ctx.body.length) {
        const lenText = ctx.body.subarray(cursor, cursor + 4).toString('ascii');
        if (!/^[0-9a-fA-F]{4}$/.test(lenText)) {
          malformed = true;
          break;
        }
        const len = parseInt(lenText, 16);
        if (len === 0) {
          packStart = cursor + 4;
          break;
        }
        if (len < 4 || cursor + len > ctx.body.length) {
          malformed = true;
          break;
        }
        const line = ctx.body.subarray(cursor + 4, cursor + len).toString('utf8').replace(/\n$/, '');
        const nul = line.indexOf('\0');
        const head = nul === -1 ? line : line.slice(0, nul);
        const parts = head.split(' ');
        if (parts.length === 3 && isOid(parts[0]) && isOid(parts[1])) {
          commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
        }
        cursor += len;
      }
      if (cursor + 4 > ctx.body.length && packStart === ctx.body.length && commands.length > 0) {
        // No flush found: the whole body was the command list (delete-only pushes).
        packStart = ctx.body.length;
      }
    }
    let packObjects: Map<string, GitObject> | null = null;
    let unpackError: string | null = malformed ? 'bad pkt-line stream' : null;
    const packBytes = ctx.body.subarray(packStart);
    if (packBytes.length > 0) {
      try {
        const read = readPack(Buffer.from(packBytes), { resolveBase: (oid) => lookupObject(repo, oid) });
        packObjects = read.objects;
      } catch (err) {
        unpackError = (err as Error).message;
      }
    }
    const reportLines = applyPush(repo, commands, packObjects, unpackError);
    const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
    sendGit(ctx, 200, Buffer.concat([sidebandPack(report), pktFlush()]), 'application/x-git-receive-pack-result');
    return true;
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// GraphQL v4 — a small executor for the documents gh and github-mcp-server send.
// -------------------------------------------------------------------------------------------

interface GqlSelection {
  kind: 'field' | 'inline-fragment';
  name?: string;
  alias?: string;
  args?: Record<string, unknown>;
  selections?: GqlSelection[];
  typeCondition?: string;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, unknown>; // variable name -> default value (or undefined)
  selections: GqlSelection[];
}

function gqlTokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = gqlTokenize(input);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token} in GraphQL document, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName !== '(' && maybeName !== '{') {
      name = this.next();
    }
    const variables: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        this.parseType();
        if (this.peek() === '=') {
          this.next();
          variables[varName] = this.parseValue({});
        } else {
          variables[varName] = undefined;
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        return { kind: 'inline-fragment', typeCondition, selections };
      }
      throw new Error('named fragments are not supported');
    }
    const first = this.next();
    let alias: string | undefined;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    let args: Record<string, unknown> | undefined;
    if (this.peek() === '(') {
      args = this.parseArguments();
    }
    let selections: GqlSelection[] | undefined;
    if (this.peek() === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expect('(');
    const args: Record<string, unknown> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue({});
    }
    this.expect(')');
    return args;
  }

  private parseValue(variables: Record<string, unknown>): unknown {
    const token = this.next();
    if (token === '$') return { __variable: this.next() };
    if (token === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']') list.push(this.parseValue(variables));
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        object[name] = this.parseValue(variables);
      }
      this.expect('}');
      return object;
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (/^-?[0-9]/.test(token)) return Number(token);
    return { __enum: token };
  }
}

/** Substitute variables and unwrap enums in a parsed argument value. */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (isRecord(value)) {
    if (typeof value.__variable === 'string') return variables[value.__variable] ?? null;
    if (typeof value.__enum === 'string') return value.__enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  return value;
}

interface GqlCtx {
  errors: { message: string }[];
}

// The schema surface gh feature-detects (for __type introspection).
const INTROSPECTION: Record<string, { fields: string[]; enumValues: string[] }> = {
  Issue: {
    fields: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
    enumValues: [],
  },
  PullRequest: {
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'comments'],
    enumValues: [],
  },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

type GqlValue = Record<string, unknown> & { __type: string };

function wrap(type: string, fields: Record<string, unknown>): GqlValue {
  return { __type: type, ...fields };
}

function repoWrapper(repo: Repo): GqlValue {
  return wrap('Repository', { repo });
}

function issueWrapper(repo: Repo, issue: Issue): GqlValue {
  return wrap('Issue', { repo, issue });
}

function pullWrapper(repo: Repo, pull: Pull): GqlValue {
  return wrap('PullRequest', { repo, pull });
}

function resolveNode(id: string): GqlValue | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository' && decoded.parts[0] !== undefined) {
    const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
    return repo ? repoWrapper(repo) : null;
  }
  if (decoded.kind === 'Issue' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
    const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[1]));
    return repo && issue ? issueWrapper(repo, issue) : null;
  }
  if (decoded.kind === 'PullRequest' && decoded.parts[0] !== undefined && decoded.parts[1] !== undefined) {
    const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
    const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
    return repo && pull ? pullWrapper(repo, pull) : null;
  }
  return null;
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let list = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states) list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const cursorText = Buffer.from(args.after, 'base64').toString('utf8');
      const cursorNumber = Number(cursorText.replace('cursor:', ''));
      const index = list.findIndex((issue) => issue.number === cursorNumber);
      if (index >= 0) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? Buffer.from(`cursor:${(page[page.length - 1] as Issue).number}`, 'utf8').toString('base64') : null;
  return wrap('IssueConnection', {
    nodes: page.map((issue) => issueWrapper(repo, issue)),
    pageInfo: wrap('PageInfo', { hasNextPage, endCursor, hasPreviousPage: start > 0, startCursor: null }),
    totalCount: list.length,
  });
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  let list = [...repo.pulls].filter((pull) => pull.state === 'open');
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states) {
    list = [...repo.pulls].filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  }
  list.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return wrap('PullRequestConnection', {
    nodes: page.map((pull) => pullWrapper(repo, pull)),
    pageInfo: wrap('PageInfo', { hasNextPage: page.length < list.length, endCursor: null, hasPreviousPage: false, startCursor: null }),
    totalCount: list.length,
  });
}

function prState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

const GQL_RESOLVERS: Record<string, Record<string, (parent: GqlValue, args: Record<string, unknown>) => unknown>> = {
  Query: {
    viewer: () => wrap('User', { login: VIEWER_LOGIN }),
    repository: (_parent, args) => {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? findRepo(args.owner, args.name) : undefined;
      return repo ? repoWrapper(repo) : null;
    },
    node: (_parent, args) => (typeof args.id === 'string' ? resolveNode(args.id) : null),
    __type: (_parent, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const entry = INTROSPECTION[name];
      if (!entry) return null;
      return wrap('__Type', { name, fields: entry.fields, enumValues: entry.enumValues });
    },
  },
  User: {
    login: (parent) => parent.login ?? null,
  },
  Repository: {
    id: (parent) => (parent.repo as Repo).globalId,
    databaseId: (parent) => (parent.repo as Repo).databaseId,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    owner: (parent) => wrap('User', { login: (parent.repo as Repo).owner }),
    defaultBranchRef: (parent) => wrap('GitRef', { name: (parent.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent) => (parent.repo as Repo).description,
    private: (parent) => (parent.repo as Repo).private,
    url: (parent) => `https://example.invalid/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    createdAt: (parent) => (parent.repo as Repo).createdAt,
    updatedAt: (parent) => (parent.repo as Repo).updatedAt,
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const issue = repo.issues.find((entry) => entry.number === args.number);
      return issue ? issueWrapper(repo, issue) : null;
    },
    issues: (parent, args) => issueConnection(parent.repo as Repo, args),
    pullRequests: (parent, args) => pullConnection(parent.repo as Repo, args),
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = repo.pulls.find((entry) => entry.number === args.number);
      return pull ? pullWrapper(repo, pull) : null;
    },
  },
  GitRef: {
    name: (parent) => parent.name ?? null,
  },
  Issue: {
    id: (parent) => issueGlobalId(parent.repo as Repo, (parent.issue as Issue).number),
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    body: (parent) => (parent.issue as Issue).body,
    state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (parent) => (parent.issue as Issue).createdAt,
    updatedAt: (parent) => (parent.issue as Issue).updatedAt,
    url: (parent) => `https://example.invalid/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}/issues/${(parent.issue as Issue).number}`,
    author: () => wrap('User', { login: VIEWER_LOGIN }),
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes ?? [],
    pageInfo: (parent) => parent.pageInfo ?? null,
    totalCount: (parent) => parent.totalCount ?? 0,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes ?? [],
    pageInfo: (parent) => parent.pageInfo ?? null,
    totalCount: (parent) => parent.totalCount ?? 0,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage ?? false,
    endCursor: (parent) => parent.endCursor ?? null,
    hasPreviousPage: (parent) => parent.hasPreviousPage ?? false,
    startCursor: (parent) => parent.startCursor ?? null,
  },
  PullRequest: {
    id: (parent) => pullGlobalId(parent.repo as Repo, (parent.pull as Pull).number),
    number: (parent) => (parent.pull as Pull).number,
    title: (parent) => (parent.pull as Pull).title,
    body: (parent) => (parent.pull as Pull).body,
    state: (parent) => prState(parent.pull as Pull),
    merged: (parent) => (parent.pull as Pull).merged,
    mergeable: (parent) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      const analysis = pullMergeAnalysis(repo, pull);
      if (analysis === null) return 'UNKNOWN';
      return analysis.conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (parent) => (parent.pull as Pull).headRef,
    baseRefName: (parent) => (parent.pull as Pull).baseRef,
    headRefOid: (parent) => (parent.pull as Pull).headSha,
    baseRefOid: (parent) => (parent.pull as Pull).baseSha,
    createdAt: (parent) => (parent.pull as Pull).createdAt,
    updatedAt: (parent) => (parent.pull as Pull).updatedAt,
    url: (parent) => `https://example.invalid/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}/pull/${(parent.pull as Pull).number}`,
    author: () => wrap('User', { login: VIEWER_LOGIN }),
    files: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      const files = pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      return wrap('PullRequestChangedFileConnection', {
        nodes: files.slice(0, first).map((file) => wrap('PullRequestChangedFile', { path: file.filename })),
      });
    },
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes ?? [],
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path ?? null,
  },
  __Type: {
    name: (parent) => parent.name ?? null,
    kind: () => 'OBJECT',
    fields: (parent) => ((parent.fields as string[]) ?? []).map((name) => wrap('__Field', { name })),
    enumValues: (parent) => ((parent.enumValues as string[]) ?? []).map((name) => wrap('__EnumValue', { name })),
  },
  __Field: {
    name: (parent) => parent.name ?? null,
  },
  __EnumValue: {
    name: (parent) => parent.name ?? null,
  },
  Mutation: {
    createIssue: (_parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (!decoded || decoded.kind !== 'Repository' || decoded.parts[0] === undefined) {
        throw new Error('Invalid repository id');
      }
      const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
      if (!repo) throw new Error('Repository not found');
      const issue = createIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '');
      return wrap('CreateIssuePayload', { issue: issueWrapper(repo, issue) });
    },
    closeIssue: (_parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (!decoded || decoded.kind !== 'Issue' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) {
        throw new Error('Invalid issue id');
      }
      const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
      const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[1]));
      if (!repo || !issue) throw new Error('Issue not found');
      issue.state = 'closed';
      issue.updatedAt = nextTimestamp().iso;
      return wrap('CloseIssuePayload', { issue: issueWrapper(repo, issue) });
    },
    createPullRequest: (_parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (!decoded || decoded.kind !== 'Repository' || decoded.parts[0] === undefined) {
        throw new Error('Invalid repository id');
      }
      const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
      if (!repo) throw new Error('Repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new Error('Head or base branch not found');
      const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing) throw new Error('A pull request already exists for this head and base');
      const pull = createPull(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrapper(repo, pull) });
    },
    mergePullRequest: (_parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (!decoded || decoded.kind !== 'PullRequest' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) {
        throw new Error('Invalid pull request id');
      }
      const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
      const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
      if (!repo || !pull) throw new Error('Pull request not found');
      const merged = mergePull(repo, pull);
      if (merged.status !== 200) throw new Error(merged.message ?? 'Merge failed');
      return wrap('MergePullRequestPayload', { pullRequest: pullWrapper(repo, pull) });
    },
    addComment: (_parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (!decoded || decoded.kind !== 'Issue' || decoded.parts[0] === undefined || decoded.parts[1] === undefined) {
        throw new Error('Invalid subject id');
      }
      const repo = findRepoByDatabaseId(Number(decoded.parts[0]));
      const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[1]));
      if (!repo || !issue) throw new Error('Issue not found');
      const comment: Comment = {
        id: repo.nextCommentId++,
        body: typeof input.body === 'string' ? input.body : '',
        user: VIEWER_LOGIN,
        createdAt: nextTimestamp().iso,
        seq: clockSeq,
      };
      issue.comments.push(comment);
      const node = wrap('IssueComment', { id: commentGlobalId(repo, issue.number, comment.id), body: comment.body });
      return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node }) });
    },
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue ?? null,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest ?? null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge ?? null,
  },
  IssueCommentEdge: {
    node: (parent) => parent.node ?? null,
    cursor: () => null,
  },
  IssueComment: {
    id: (parent) => parent.id ?? null,
    body: (parent) => parent.body ?? null,
  },
};

function executeSelections(
  typeName: string,
  parent: GqlValue,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
  ctx: GqlCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const resolvers = GQL_RESOLVERS[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'inline-fragment') {
      const condition = selection.typeCondition;
      if (condition && condition !== typeName && condition !== parent.__type) continue;
      const nested = executeSelections(parent.__type, parent, selection.selections ?? [], variables, ctx);
      Object.assign(out, nested);
      continue;
    }
    const fieldName = selection.name as string;
    const outputKey = selection.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[outputKey] = parent.__type;
      continue;
    }
    const resolver = resolvers[fieldName];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
      out[outputKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(selection.args ?? {})) {
      args[key] = resolveValue(value, variables);
    }
    let value: unknown;
    try {
      value = resolver(parent, args);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      out[outputKey] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[outputKey] = null;
      continue;
    }
    if (selection.selections && selection.selections.length > 0) {
      if (Array.isArray(value)) {
        out[outputKey] = value.map((entry) => {
          if (isRecord(entry) && typeof entry.__type === 'string') {
            return executeSelections(entry.__type, entry as GqlValue, selection.selections as GqlSelection[], variables, ctx);
          }
          return entry;
        });
      } else if (isRecord(value) && typeof value.__type === 'string') {
        out[outputKey] = executeSelections(value.__type, value as GqlValue, selection.selections, variables, ctx);
      } else {
        out[outputKey] = value;
      }
    } else {
      out[outputKey] = value;
    }
  }
  return out;
}

function executeGraphQLOperation(operation: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: GqlCtx = { errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const mergedVariables: Record<string, unknown> = { ...operation.variables };
  for (const [key, value] of Object.entries(variables)) mergedVariables[key] = value;
  const root = wrap(rootType, {});
  const data = executeSelections(rootType, root, operation.selections, mergedVariables, ctx);
  const result: { data: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

async function handleGraphQL(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST') return false;
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const runOne = (body: unknown): Record<string, unknown> => {
    if (!isRecord(body) || typeof body.query !== 'string') {
      return { errors: [{ message: 'No query provided' }] };
    }
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(body.query).parseDocument();
    } catch (err) {
      return { errors: [{ message: `Syntax error: ${(err as Error).message}` }] };
    }
    const operation = operations[0];
    if (!operation) return { errors: [{ message: 'No query provided' }] };
    const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
    const result = executeGraphQLOperation(operation, variables);
    return result;
  };
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map((entry) => runOne(entry));
    sendJson(ctx, 200, results);
    return true;
  }
  const result = runOne(parsed.value);
  sendJson(ctx, 200, result);
  return true;
}

// -------------------------------------------------------------------------------------------
// MCP (Model Context Protocol, streamable HTTP, revision 2026-07-28)
// -------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
  run: (args: Record<string, unknown>) => { ok: boolean; data: unknown; error?: string };
}

function mcpTextResult(data: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function mcpErrorResult(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpTools(): McpToolDef[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a repository owned by the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The repository name.' },
          description: { type: 'string', description: 'A short description of the repository.' },
          private: { type: 'boolean', description: 'Whether the repository is private.' },
        },
        required: ['name'],
      },
      required: ['name'],
      run: (args) => {
        const name = typeof args.name === 'string' ? args.name : '';
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return { ok: false, data: null, error: 'Invalid repository name' };
        if (findRepo(VIEWER_LOGIN, name)) return { ok: false, data: null, error: 'Repository already exists' };
        const { iso } = nextTimestamp();
        const databaseId = nextDatabaseId++;
        const repo: Repo = {
          owner: VIEWER_LOGIN, name, databaseId, globalId: repoGlobalId(databaseId),
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true, defaultBranch: DEFAULT_BRANCH,
          createdAt: iso, updatedAt: iso, seq: clockSeq,
          objects: new Map(), refs: new Map(), issues: [], pulls: [], labels: new Map(),
          nextNumber: 1, nextCommentId: 1,
        };
        repos.set(repoKey(VIEWER_LOGIN, name), repo);
        return { ok: true, data: repoObject(repo) };
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
        },
        required: ['owner', 'repo'],
      },
      required: ['owner', 'repo'],
      run: (args) => {
        const repo = typeof args.owner === 'string' && typeof args.repo === 'string' ? findRepo(args.owner, args.repo) : undefined;
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        return { ok: true, data: repoObject(repo) };
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
        },
        required: ['owner', 'repo', 'title'],
      },
      required: ['owner', 'repo', 'title'],
      run: (args) => {
        const repo = typeof args.owner === 'string' && typeof args.repo === 'string' ? findRepo(args.owner, args.repo) : undefined;
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const issue = createIssue(repo, typeof args.title === 'string' ? args.title : '', typeof args.body === 'string' ? args.body : '');
        return { ok: true, data: issueObject(repo, issue) };
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
        },
        required: ['owner', 'repo'],
      },
      required: ['owner', 'repo'],
      run: (args) => {
        const repo = typeof args.owner === 'string' && typeof args.repo === 'string' ? findRepo(args.owner, args.repo) : undefined;
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        return { ok: true, data: { issues: list.map((issue) => issueObject(repo, issue)) } };
      },
    },
    {
      name: 'create_pull_request',
      description: 'Open a pull request from a head branch to a base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          title: { type: 'string', description: 'The pull request title.' },
          head: { type: 'string', description: 'The head branch name.' },
          base: { type: 'string', description: 'The base branch name.' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      run: (args) => {
        const repo = typeof args.owner === 'string' && typeof args.repo === 'string' ? findRepo(args.owner, args.repo) : undefined;
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const head = typeof args.head === 'string' ? args.head : '';
        const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return { ok: false, data: null, error: 'Head or base branch not found' };
        const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (existing) return { ok: false, data: null, error: 'A pull request already exists for this head and base' };
        const pull = createPull(repo, typeof args.title === 'string' ? args.title : '', '', head, base, headSha, baseSha);
        return { ok: true, data: pullObject(repo, pull) };
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request with a squash merge.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'The repository owner login.' },
          repo: { type: 'string', description: 'The repository name.' },
          pull_number: { type: 'integer', description: 'The pull request number.' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      required: ['owner', 'repo', 'pull_number'],
      run: (args) => {
        const repo = typeof args.owner === 'string' && typeof args.repo === 'string' ? findRepo(args.owner, args.repo) : undefined;
        if (!repo) return { ok: false, data: null, error: 'Repository not found' };
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (!pull) return { ok: false, data: null, error: 'Pull request not found' };
        const merged = mergePull(repo, pull);
        if (merged.status !== 200) return { ok: false, data: null, error: merged.message ?? 'Merge failed' };
        return { ok: true, data: { merged: true, sha: merged.sha, number: pull.number } };
      },
    },
  ];
}

const MCP_TOOLS = mcpTools();

function mcpRpcResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function mcpRpcError(ctx: Ctx, status: number, id: unknown, code: number, message: string): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleMcp(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST') return false;
  // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
  let body: unknown;
  try {
    body = ctx.body.length === 0 ? null : JSON.parse(ctx.body.toString('utf8'));
  } catch {
    mcpRpcError(ctx, 400, null, -32700, 'Parse error');
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    mcpRpcError(ctx, 400, isRecord(body) ? body.id ?? null : null, -32600, 'Invalid Request');
    return true;
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};
  const method = body.method;
  if (method === 'server/discover') {
    mcpRpcResult(ctx, id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-forge', version: '1.0.0' } },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    mcpRpcResult(ctx, id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
    });
    return true;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'x-github-request-id': `req-${nextRequestId++}` });
    ctx.res.end();
    return true;
  }
  if (method === 'tools/list') {
    mcpRpcResult(ctx, id, {
      tools: MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    });
    return true;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((entry) => entry.name === name);
    if (!tool) {
      mcpRpcError(ctx, 200, id, -32602, `Unknown tool: ${name}`);
      return true;
    }
    const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      mcpRpcResult(ctx, id, mcpErrorResult(`Missing required argument(s): ${missing.join(', ')}`));
      return true;
    }
    let outcome: { ok: boolean; data: unknown; error?: string };
    try {
      outcome = tool.run(args);
    } catch (err) {
      mcpRpcResult(ctx, id, mcpErrorResult((err as Error).message));
      return true;
    }
    if (!outcome.ok) {
      mcpRpcResult(ctx, id, mcpErrorResult(outcome.error ?? 'Tool call failed'));
      return true;
    }
    mcpRpcResult(ctx, id, mcpTextResult(outcome.data));
    return true;
  }
  mcpRpcError(ctx, 200, id, -32601, `Method not found: ${method}`);
  return true;
}

// -------------------------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------------------------

function isAuthed(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string') return false;
  const trimmed = header.trim();
  const bearer = /^Bearer (.+)$/.exec(trimmed);
  if (bearer) {
    if (TOKEN === '') return true; // no token configured (local runs): any bearer token is the viewer
    return bearer[1] === TOKEN;
  }
  // Basic auth, as real git clients send it: the token may be the username
  // (git clone https://<token>@host/...) or the password (oauth2:<token>).
  const basic = /^Basic (.+)$/.exec(trimmed);
  if (basic) {
    let decoded: string;
    try {
      decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
    } catch {
      return false;
    }
    const sep = decoded.indexOf(':');
    const username = sep === -1 ? decoded : decoded.slice(0, sep);
    const password = sep === -1 ? '' : decoded.slice(sep + 1);
    if (TOKEN === '') return true;
    return username === TOKEN || password === TOKEN;
  }
  return false;
}

export function createForgeServer(): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const ctx: Ctx = {
      req,
      res,
      url: new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`),
      method: req.method ?? 'GET',
      segments: [],
      body: Buffer.alloc(0),
      authed: false,
    };
    try {
      ctx.body = await readBody(req);
    } catch {
      sendJson(ctx, 413, { message: 'Request body too large' });
      return;
    }
    const rawSegments = ctx.url.pathname.split('/').filter((part) => part !== '');
    ctx.segments = rawSegments;
    try {
      // GET /healthz: no auth, 200 {"ok": true}.
      if (ctx.url.pathname === '/healthz' && ctx.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      ctx.authed = isAuthed(ctx);
      // Git smart HTTP: /{owner}/{repo}.git/...
      if (rawSegments.length >= 2 && (rawSegments[1] as string).endsWith('.git')) {
        if (!ctx.authed) {
          // WWW-Authenticate is what makes a real git client retry with the
          // credentials from the URL; without it git just reports the 401 body.
          sendGit(ctx, 401, Buffer.from('Unauthorized', 'utf8'), 'text/plain', { 'www-authenticate': 'Basic realm="git-forge"' });
          return;
        }
        const owner = decodeURIComponent(rawSegments[0] as string);
        const repoName = decodeURIComponent((rawSegments[1] as string).slice(0, -4));
        if (await handleGit(ctx, owner, repoName, rawSegments.slice(2))) return;
        sendGit(ctx, 404, Buffer.from('Not Found', 'utf8'), 'text/plain');
        return;
      }
      // REST + GraphQL + MCP all require the bearer token.
      if (!ctx.authed) {
        sendError(ctx, 401, 'Requires authentication');
        return;
      }
      if (rawSegments[0] === 'api' && rawSegments[1] === 'v3') {
        ctx.segments = rawSegments.slice(2);
        if (await handleRest(ctx)) return;
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (rawSegments[0] === 'api' && rawSegments[1] === 'graphql' && rawSegments.length === 2) {
        if (await handleGraphQL(ctx)) return;
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (rawSegments[0] === 'mcp' && rawSegments.length === 1) {
        if (await handleMcp(ctx)) return;
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendError(ctx, 404, 'Not Found');
    } catch (err) {
      if (!res.writableEnded) {
        try {
          sendError(ctx, 500, (err as Error).message);
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    }
  });
  return server;
}
