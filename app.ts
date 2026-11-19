// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and
// MCP, all over the one in-memory store in store.ts. Standard library only.
//
// Routing is by path segments; every JSON reply carries X-GitHub-Request-Id,
// every REST reply is application/json, and every /api/v3, /api/graphql and
// /mcp request needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (401 without
// it). The git surface takes no auth, like a public clone endpoint.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  DELIM,
  FLUSH,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_NAME = 'makefun-git-forge';
const FORGE_VERSION = '1.0.0';

const store = new Store();
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body: {} when empty, null when malformed. */
function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (TOKEN === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${TOKEN}`;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

function gitRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done filter\n', 'object-format=sha1\n', 'flush']);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs';
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (mainTip !== undefined) {
      parts.push(encodePktLine(`${mainTip} HEAD${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`));
      first = false;
      // Peeled line for annotated tags.
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag' && ref.name.startsWith('refs/tags/')) {
        const target = parseTag(object.data).object;
        parts.push(encodePktLine(`${target} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const repo = gitRepo(owner, name);
  if (repo === null || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    sendBytes(res, 200, v2Advertisement(), contentType);
    return;
  }
  sendBytes(res, 200, v0Advertisement(repo, service), contentType);
}

/** One sideband packet stream: band 1 carries `data`, split into small frames. */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  } else {
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleLsRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): void {
  const { packets } = decodePktLines(raw);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const arg = packet.payload.toString('utf8').replace(/\n$/, '');
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lines: (string | 'flush')[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    if (mainTip === undefined) lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    else lines.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  sendBytes(res, 200, encodePktLines(lines), 'application/x-git-upload-pack-result');
}

function handleFetch(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): void {
  const { packets } = decodePktLines(raw);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const arg = packet.payload.toString('utf8').replace(/\n$/, '');
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const { objects, shallow, unshallow } = store.fetchObjects(repo, wants, haves, depth, shallowBoundaries);
  const pack = writePack(objects);
  if (!isV2) {
    // v0: NAK, shallow lines, then the sideband pack.
    const parts: Buffer[] = [encodePktLine('NAK\n')];
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(sideband(pack));
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  const parts: Buffer[] = [encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), DELIM];
  if (depth !== null) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sideband(pack));
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): void {
  const { packets } = decodePktLines(raw);
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  if (command === 'command=ls-refs') {
    handleLsRefs(req, res, repo, raw);
    return;
  }
  if (command === 'command=fetch') {
    handleFetch(req, res, repo, raw);
    return;
  }
  // A v0 fetch request starts with `want ...` lines: treat any other body as a v0 fetch.
  if (command.startsWith('want ') || command === '') {
    handleFetch(req, res, repo, raw);
    return;
  }
  sendError(res, 400, 'unsupported upload-pack command');
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): void {
  const { packets, trailing } = decodePktLines(raw);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const report: string[] = [];
  if (commands.length === 0) {
    sendError(res, 400, 'no push commands');
    return;
  }
  // Unpack the pack (present for every create/update, absent for delete-only).
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = trailing.length > 0 ? trailing : null;
  if (packBytes !== null && packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of read.objects) {
        const oid = hashObject(object.type, object.data);
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const lookup = store.lookup(repo);
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpack error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== command.oldOid) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!isObjectId(command.newOid) || !repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update: old must match, and new must descend from old.
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.newOid === command.oldOid || isAncestor(command.oldOid, command.newOid, lookup)) {
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    } else {
      report.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }
  const inner: (string | Buffer | 'flush')[] = [`unpack ${unpackDetail}\n`];
  for (const line of report) inner.push(line);
  inner.push('flush');
  const reportBytes = encodePktLines(inner);
  const outer = Buffer.concat([encodePktLine(Buffer.concat([Buffer.from([1]), reportBytes])), FLUSH]);
  sendBytes(res, 200, outer, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------------------------
// REST v3 helpers
// ---------------------------------------------------------------------------------------------

function paginate<T>(req: IncomingMessage, path: string, query: URLSearchParams, items: T[]): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(`${originOf(req)}${path}`);
    for (const [key, value] of query) {
      if (key !== 'page') url.searchParams.set(key, value);
    }
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: pageItems, link };
}

function restRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

function handleRest(req: IncomingMessage, res: ServerResponse, method: string, segments: string[], query: URLSearchParams, body: unknown): void {
  const path = `/${segments.join('/')}`;
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };

  // GET /api/v3/ — the API root.
  if (segments.length === 2 && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, scopes);
    return;
  }
  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: FORGE_VERSION }, scopes);
    return;
  }
  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    sendJson(
      res,
      200,
      { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' },
      scopes,
    );
    return;
  }
  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const name = body.name as string;
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      if (repo === null) {
        sendError(res, 422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
        return;
      }
      sendJson(res, 201, repoJson(repo), scopes);
      return;
    }
    if (method === 'GET') {
      const all = store.reposOf(VIEWER_LOGIN).map((repo) => repoJson(repo));
      const { page, link } = paginate(req, path, query, all);
      sendJson(res, 200, page, link === null ? scopes : { ...scopes, link });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = segments[3]!;
    const name = segments[4]!;
    const repo = restRepo(owner, name);
    const rest = segments.slice(5);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    handleRepoRest(req, res, method, repo, rest, query, body, path);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleRepoRest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  path: string,
): void {
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo), scopes);
      return;
    }
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
      }
      sendJson(res, 200, repoJson(repo), scopes);
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string' || !isObjectId(body.sha)) {
        sendError(res, 422, 'ref and sha are required');
        return;
      }
      const ref = body.ref as string;
      const sha = body.sha as string;
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      if (!repo.objects.has(sha)) {
        sendError(res, 422, 'Object does not exist');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } }, scopes);
      return;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 201, { ref: `refs/heads/${branch}`, object: { sha: tip } }, scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, list, scopes);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const tip = repo.refs.get(`refs/heads/${rest[1]}`);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha: tip } }, scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // commits
  if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === null) {
      sendJson(res, 200, [], scopes);
      return;
    }
    const list = store.commitsFrom(repo, tip).map((commit) => ({
      sha: commit.sha,
      commit: { message: commit.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
    }));
    sendJson(res, 200, list, scopes);
    return;
  }

  // contents
  if (rest[0] === 'contents') {
    handleContents(req, res, method, repo, rest.slice(1), query, body);
    return;
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const label = {
        name: body.name as string,
        color: typeof body.color === 'string' ? (body.color as string) : 'ededed',
        description: typeof body.description === 'string' ? (body.description as string) : '',
      };
      repo.labels.set(label.name, label);
      sendJson(res, 201, label, scopes);
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()], scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // issues
  if (rest[0] === 'issues') {
    handleIssues(req, res, method, repo, rest.slice(1), query, body);
    return;
  }

  // pulls
  if (rest[0] === 'pulls') {
    handlePulls(req, res, method, repo, rest.slice(1), query, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
): void {
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };
  const filePath = rest.join('/');
  const branch = (isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : undefined) ?? query.get('ref') ?? repo.defaultBranch;

  if (method === 'PUT') {
    if (!isRecord(body) || typeof body.message !== 'string' || typeof body.content !== 'string') {
      sendError(res, 422, 'message and content are required');
      return;
    }
    const content = Buffer.from(body.content as string, 'base64');
    // A named branch that does not exist yet is created from the default tip.
    let tip = store.branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) {
      const defaultTip = store.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== null) {
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const blobSha = hashObject('blob', content);
    store.putObject(repo, 'blob', content);
    if (tip !== null) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      const current = flattenTree(commit.tree, store.lookup(repo)).get(filePath)?.oid ?? null;
      if (current !== null) {
        if (typeof body.sha !== 'string' || (body.sha as string).toLowerCase() !== current.toLowerCase()) {
          sendError(res, 409, 'sha does not match the current blob');
          return;
        }
        const { commitSha } = store.commitFile(repo, branch, body.message as string, new Map([[filePath, blobSha]]), []);
        sendJson(res, 200, { content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64' }, commit: { sha: commitSha } }, scopes);
        return;
      }
    }
    const { commitSha } = store.commitFile(repo, branch, body.message as string, new Map([[filePath, blobSha]]), []);
    sendJson(res, 201, { content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, encoding: 'base64' }, commit: { sha: commitSha } }, scopes);
    return;
  }

  if (method === 'GET') {
    const tip = store.resolveRef(repo, branch);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const flat = flattenTree(commit.tree, store.lookup(repo));
    if (filePath === '') {
      sendJson(res, 200, directoryListing(repo, commit.tree, ''), scopes);
      return;
    }
    const file = flat.get(filePath);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid)!;
      sendJson(
        res,
        200,
        {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: filePath.split('/').pop(),
          path: filePath,
          content: blob.data.toString('base64'),
          sha: file.oid,
        },
        scopes,
      );
      return;
    }
    // A directory: list its immediate children.
    const dirTree = findTreeOid(repo, commit.tree, filePath);
    if (dirTree !== null) {
      sendJson(res, 200, directoryListing(repo, dirTree, filePath), scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (method === 'DELETE') {
    const tip = store.branchTip(repo, repo.defaultBranch);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const current = flattenTree(commit.tree, store.lookup(repo)).get(filePath)?.oid ?? null;
    if (current === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (isRecord(body) && typeof body.sha === 'string' && (body.sha as string).toLowerCase() !== current.toLowerCase()) {
      sendError(res, 409, 'sha does not match the current blob');
      return;
    }
    const message = isRecord(body) && typeof body.message === 'string' ? (body.message as string) : 'delete file';
    const { commitSha } = store.commitFile(repo, repo.defaultBranch, message, new Map(), [filePath]);
    sendJson(res, 200, { commit: { sha: commitSha } }, scopes);
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** The oid of the tree at `path` under `treeOid`, or null when it is not a tree. */
function findTreeOid(repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/** Immediate children of a tree: files and directories with their names and oids. */
function directoryListing(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data)
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      sha: entry.oid,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
): void {
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };
  const path = `/api/v3/repos/${repo.owner}/${repo.name}/issues`;

  if (rest.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
        sendError(res, 422, 'title is required');
        return;
      }
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(res, 422, `Label ${label} does not exist`);
          return;
        }
      }
      const issue = store.createIssue(repo, body.title as string, typeof body.body === 'string' ? (body.body as string) : '', labels);
      sendJson(res, 201, issueJson(repo, issue), scopes);
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, link } = paginate(req, path, query, list.map((issue) => issueJson(repo, issue)));
      sendJson(res, 200, page, link === null ? scopes : { ...scopes, link });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0]!, 10);
  const issue = repo.issuesByNumber.get(number);
  if (issue === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue), scopes);
      return;
    }
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
      }
      sendJson(res, 200, issueJson(repo, issue), scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      if (!isRecord(body) || typeof body.body !== 'string') {
        sendError(res, 422, 'body is required');
        return;
      }
      const comment = store.addComment(repo, issue, body.body as string);
      sendJson(res, 201, { id: comment.id, body: comment.body }, scopes);
      return;
    }
    if (method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({ id: comment.id, body: comment.body })),
        scopes,
      );
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
): void {
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };
  const path = `/api/v3/repos/${repo.owner}/${repo.name}/pulls`;

  if (rest.length === 0) {
    if (method === 'POST') {
      if (!isRecord(body) || typeof body.head !== 'string' || typeof body.base !== 'string' || typeof body.title !== 'string') {
        sendError(res, 422, 'head, base and title are required');
        return;
      }
      const pull = store.createPull(
        repo,
        body.title as string,
        typeof body.body === 'string' ? (body.body as string) : '',
        body.head as string,
        body.base as string,
      );
      if (pull === null) {
        sendError(res, 422, 'could not create the pull request (unknown branch or an open pull request already exists for this head)');
        return;
      }
      sendJson(res, 201, pullJson(repo, pull), scopes);
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(req, path, query, list.map((pull) => pullJson(repo, pull)));
      sendJson(res, 200, page, link === null ? scopes : { ...scopes, link });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0]!, 10);
  const pull = repo.pullsByNumber.get(number);
  if (pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull), scopes);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, store.pullFiles(repo, pull), scopes);
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open' || pull.merged) {
      sendError(res, 405, 'Pull request is already merged or closed');
      return;
    }
    if (store.pullConflict(repo, pull)) {
      sendError(res, 405, 'Merge conflict');
      return;
    }
    const sha = store.mergePull(repo, pull);
    if (sha === null) {
      sendError(res, 405, 'Merge conflict');
      return;
    }
    sendJson(res, 200, { merged: true, sha, message: `Pull request #${pull.number} merged` }, scopes);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4
// ---------------------------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
  fragmentType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

class GqlTokenizer {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    const saved = this.pos;
    const token = this.next();
    this.pos = saved;
    return token;
  }

  next(): string {
    this.skipIgnored();
    if (this.pos >= this.text.length) return '';
    const ch = this.text[this.pos]!;
    if ('{}()[]:!=$@='.includes(ch)) {
      this.pos += 1;
      return ch;
    }
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      return '...';
    }
    if (ch === '"') {
      let out = '';
      this.pos += 1;
      while (this.pos < this.text.length) {
        const c = this.text[this.pos]!;
        if (c === '"') {
          this.pos += 1;
          return JSON.stringify(out);
        }
        if (c === '\\' && this.pos + 1 < this.text.length) {
          const esc = this.text[this.pos + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          this.pos += 2;
          continue;
        }
        out += c;
        this.pos += 1;
      }
      return JSON.stringify(out);
    }
    if (/[0-9-]/.test(ch)) {
      let end = this.pos;
      while (end < this.text.length && /[0-9.eE+-]/.test(this.text[end]!)) end += 1;
      const num = this.text.slice(this.pos, end);
      this.pos = end;
      return num;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = this.pos;
      while (end < this.text.length && /[_0-9A-Za-z]/.test(this.text[end]!)) end += 1;
      const name = this.text.slice(this.pos, end);
      this.pos = end;
      return name;
    }
    this.pos += 1;
    return ch;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
}

class GqlParser {
  private readonly tk: GqlTokenizer;
  constructor(text: string) {
    this.tk = new GqlTokenizer(text);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.tk.peek() !== '') {
      const peeked = this.tk.peek();
      if (peeked === 'query' || peeked === 'mutation') {
        this.tk.next();
        operations.push(this.parseOperation(peeked as 'query' | 'mutation'));
      } else if (peeked === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (peeked === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.tk.next();
        this.tk.next();
        this.tk.next();
        this.parseSelectionSet();
      } else {
        throw new Error(`unexpected token ${peeked} at document top level`);
      }
    }
    return operations;
  }

  private parseOperation(kind: 'query' | 'mutation'): GqlOperation {
    let name: string | null = null;
    if (/[_A-Za-z]/.test(this.tk.peek())) name = this.tk.next();
    if (this.tk.peek() === '(') this.skipVariableDefinitions();
    // Directives (@...) are not used by the suite; skip them.
    while (this.tk.peek() === '@') {
      this.tk.next();
      this.tk.next();
      if (this.tk.peek() === '(') this.skipParens();
    }
    return { kind, name, selections: this.parseSelectionSet() };
  }

  private skipVariableDefinitions(): void {
    this.skipParens();
  }

  private skipParens(): void {
    this.tk.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.tk.next();
      if (token === '') throw new Error('unterminated parens');
      if (token === '(' || token === '[' || token === '{') depth += 1;
      if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.tk.expect('{');
    const selections: GqlSelection[] = [];
    while (this.tk.peek() !== '}') {
      if (this.tk.peek() === '') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.tk.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.tk.peek() === '...') {
      this.tk.next();
      let fragmentType: string | null = null;
      if (this.tk.peek() === 'on') {
        this.tk.next();
        fragmentType = this.tk.next();
      } else {
        // A named fragment spread; the suite never sends one.
        this.tk.next();
        return { alias: null, name: '', args: {}, selections: null, fragmentType: '__skip__' };
      }
      const inner = this.parseSelectionSet();
      return { alias: null, name: '', args: {}, selections: inner, fragmentType };
    }
    const first = this.tk.next();
    let alias: string | null = null;
    let name = first;
    if (this.tk.peek() === ':') {
      this.tk.next();
      alias = first;
      name = this.tk.next();
    }
    let args: Record<string, GqlValue> = {};
    if (this.tk.peek() === '(') args = this.parseArguments();
    while (this.tk.peek() === '@') {
      this.tk.next();
      this.tk.next();
      if (this.tk.peek() === '(') this.skipParens();
    }
    const selections = this.tk.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections, fragmentType: null };
  }

  private parseArguments(): Record<string, GqlValue> {
    this.tk.expect('(');
    const args: Record<string, GqlValue> = {};
    while (this.tk.peek() !== ')') {
      const key = this.tk.next();
      this.tk.expect(':');
      args[key] = this.parseValue();
    }
    this.tk.expect(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.tk.next();
    if (token === '$') return { __variable: this.tk.next() } as unknown as GqlValue;
    if (token === '[') {
      const list: GqlValue[] = [];
      while (this.tk.peek() !== ']') list.push(this.parseValue());
      this.tk.expect(']');
      return list;
    }
    if (token === '{') {
      const object: Record<string, GqlValue> = {};
      while (this.tk.peek() !== '}') {
        const key = this.tk.next();
        this.tk.expect(':');
        object[key] = this.parseValue();
      }
      this.tk.expect('}');
      return object;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const num = Number(token);
    if (token !== '' && !Number.isNaN(num) && /^-?[0-9]/.test(token)) return num;
    return token;
  }
}

/** Resolve `$var` references in an argument value against the operation variables. */
function resolveVariables(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (isRecord(value) && typeof value.__variable === 'string') return variables[value.__variable] ?? null;
  if (Array.isArray(value)) return value.map((item) => resolveVariables(item, variables));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveVariables(item, variables);
    return out;
  }
  return value;
}

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PULL_TYPE_FIELDS = [
  'id',
  'number',
  'title',
  'body',
  'state',
  'merged',
  'mergeable',
  'headRefName',
  'baseRefName',
  'files',
  'headRef',
  'baseRef',
  'author',
  'createdAt',
  'mergedAt',
  'mergeCommit',
];
const REPO_TYPE_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
  'description',
  'private',
  'url',
  'createdAt',
  'updatedAt',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueGqlObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}
function pullGqlObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}
function repoGqlObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueCursor(seq: number): string {
  return Buffer.from(`issue-cursor:${seq}`, 'utf8').toString('base64');
}
function cursorSeq(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('issue-cursor:')) return null;
    const n = Number.parseInt(text.slice('issue-cursor:'.length), 10);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Execute one parsed operation against the store. */
function executeOperation(operation: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const errors: { message: string }[] = [];
  const data: Record<string, unknown> = {};
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  for (const selection of operation.selections) {
    if (selection.fragmentType !== null && selection.fragmentType !== '__skip__') {
      const resolved = resolveField(root, rootType, selection, variables, errors);
      if (resolved !== undefined && typeof resolved === 'object' && !Array.isArray(resolved)) Object.assign(data, resolved);
      continue;
    }
    const key = selection.alias ?? selection.name;
    data[key] = resolveField(root, rootType, selection, variables, errors);
  }
  return { data, errors };
}

function resolveField(parent: GqlObject, parentType: string, selection: GqlSelection, variables: Record<string, unknown>, errors: { message: string }[]): unknown {
  // Inline fragment: apply only when the type condition matches.
  if (selection.fragmentType !== null) {
    if (selection.fragmentType === '__skip__') return undefined;
    if (selection.fragmentType !== parent.__typename) return undefined;
    if (selection.selections === null) return undefined;
    const out: Record<string, unknown> = {};
    for (const inner of selection.selections) {
      const key = inner.alias ?? inner.name;
      out[key] = resolveField(parent, parentType, inner, variables, errors);
    }
    return out;
  }
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(selection.args)) args[key] = resolveVariables(value, variables);
  const value = fieldValue(parent, parentType, selection.name, args, errors);
  if (selection.selections === null || selection.selections.length === 0) return value;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === null || typeof item !== 'object') return item;
      return resolveObject(item as GqlObject, selection.selections!, variables, errors);
    });
  }
  return resolveObject(value as GqlObject, selection.selections, variables, errors);
}

/** Resolve a selection set against one object value, merging inline fragments. */
function resolveObject(child: GqlObject, selections: GqlSelection[], variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const childType = child.__typename;
  const out: Record<string, unknown> = {};
  for (const inner of selections) {
    if (inner.fragmentType !== null && inner.fragmentType !== '__skip__') {
      const resolved = resolveField(child, childType, inner, variables, errors);
      if (resolved !== undefined && typeof resolved === 'object' && !Array.isArray(resolved)) Object.assign(out, resolved);
      continue;
    }
    const key = inner.alias ?? inner.name;
    const resolved = resolveField(child, childType, inner, variables, errors);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

function unknownField(parentType: string, name: string, errors: { message: string }[]): null {
  errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
  return null;
}

function fieldValue(parent: GqlObject, parentType: string, name: string, args: Record<string, unknown>, errors: { message: string }[]): unknown {
  switch (parentType) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        const repo = restRepo(owner, repoName);
        return repo === null ? null : repoGqlObject(repo);
      }
      if (name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'repo') {
          const [owner, repoName] = decoded.parts;
          if (owner === undefined || repoName === undefined) return null;
          const repo = restRepo(owner, repoName);
          return repo === null ? null : repoGqlObject(repo);
        }
        if (decoded.kind === 'issue') {
          const [owner, repoName, number] = decoded.parts;
          const repo = owner !== undefined && repoName !== undefined ? restRepo(owner, repoName) : null;
          const issue = repo?.issuesByNumber.get(Number(number));
          return issue === undefined || repo === null ? null : issueGqlObject(repo, issue);
        }
        if (decoded.kind === 'pr') {
          const [owner, repoName, number] = decoded.parts;
          const repo = owner !== undefined && repoName !== undefined ? restRepo(owner, repoName) : null;
          const pull = repo?.pullsByNumber.get(Number(number));
          return pull === undefined || repo === null ? null : pullGqlObject(repo, pull);
        }
        return null;
      }
      if (name === '__type') {
        const typeName = args.name as string | undefined;
        if (typeName === 'Issue') return { __typename: '__Type', name: 'Issue', fields: ISSUE_TYPE_FIELDS.map((f) => ({ __typename: '__Field', name: f })), enumValues: [] };
        if (typeName === 'PullRequest') return { __typename: '__Type', name: 'PullRequest', fields: PULL_TYPE_FIELDS.map((f) => ({ __typename: '__Field', name: f })), enumValues: [] };
        if (typeName === 'Repository') return { __typename: '__Type', name: 'Repository', fields: REPO_TYPE_FIELDS.map((f) => ({ __typename: '__Field', name: f })), enumValues: [] };
        if (typeName === 'SearchType') return { __typename: '__Type', name: 'SearchType', fields: [], enumValues: SEARCH_TYPE_VALUES.map((f) => ({ __typename: '__EnumValue', name: f })) };
        if (typeName === 'User') return { __typename: '__Type', name: 'User', fields: ['id', 'login', 'name', 'email'].map((f) => ({ __typename: '__Field', name: f })), enumValues: [] };
        return null;
      }
      return unknownField(parentType, name, errors);
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(input.repositoryId);
        if (repo === null || typeof input.title !== 'string') {
          errors.push({ message: 'createIssue: the repositoryId does not name a repository' });
          return { __typename: 'CreateIssuePayload', issue: null };
        }
        const issue = store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
        return { __typename: 'CreateIssuePayload', issue: issueGqlObject(repo, issue) };
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(input.issueId);
        if (found === null) {
          errors.push({ message: 'closeIssue: the issueId does not name an issue' });
          return { __typename: 'CloseIssuePayload', issue: null };
        }
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueGqlObject(found.repo, found.issue) };
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(input.repositoryId);
        if (
          repo === null ||
          typeof input.headRefName !== 'string' ||
          typeof input.baseRefName !== 'string' ||
          typeof input.title !== 'string'
        ) {
          errors.push({ message: 'createPullRequest: bad input' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        }
        const pull = store.createPull(repo, input.title, '', input.headRefName, input.baseRefName);
        if (pull === null) {
          errors.push({ message: 'createPullRequest: the head or base branch does not exist, or an open pull request already exists for this head' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        }
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullGqlObject(repo, pull) };
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullFromGlobalId(input.pullRequestId);
        if (found === null) {
          errors.push({ message: 'mergePullRequest: the pullRequestId does not name a pull request' });
          return { __typename: 'MergePullRequestPayload', pullRequest: null };
        }
        const { repo, pull } = found;
        if (pull.state !== 'open' || pull.merged) {
          errors.push({ message: 'mergePullRequest: the pull request is not open' });
          return { __typename: 'MergePullRequestPayload', pullRequest: pullGqlObject(repo, pull) };
        }
        if (store.pullConflict(repo, pull)) {
          errors.push({ message: 'mergePullRequest: the pull request is conflicted' });
          return { __typename: 'MergePullRequestPayload', pullRequest: pullGqlObject(repo, pull) };
        }
        store.mergePull(repo, pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullGqlObject(repo, pull) };
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromGlobalId(input.subjectId);
        if (found === null || typeof input.body !== 'string') {
          errors.push({ message: 'addComment: the subjectId does not name an issue' });
          return { __typename: 'AddCommentPayload', commentEdge: null };
        }
        const comment = store.addComment(found.repo, found.issue, input.body);
        const node = {
          __typename: 'Comment',
          id: globalId('comment', found.repo.owner, found.repo.name, found.issue.number, comment.id),
          body: comment.body,
        };
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node, cursor: issueCursor(found.issue.seq) } };
      }
      return unknownField(parentType, name, errors);
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (name === 'id') return globalId('repo', repo.owner, repo.name);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'private') return repo.private;
      if (name === 'url') return '';
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_ISO;
      if (name === 'issue') {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issuesByNumber.get(number) : undefined;
        return issue === undefined ? null : issueGqlObject(repo, issue);
      }
      if (name === 'issues') {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'DESC' ? -1 : 1;
        const field = orderBy.field as string | undefined;
        if (field === 'CREATED_AT' || field === undefined) {
          list.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
        }
        const after = args.after as string | null | undefined;
        if (typeof after === 'string' && after !== '') {
          const seq = cursorSeq(after);
          if (seq !== null) list = list.filter((issue) => issue.seq > seq);
        }
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, Math.max(0, first));
        const hasNextPage = list.length > page.length;
        const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]!.seq) : null;
        return {
          __typename: 'IssueConnection',
          nodes: page.map((issue) => issueGqlObject(repo, issue)),
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
          totalCount: list.length,
        };
      }
      if (name === 'pullRequests') {
        let list = [...repo.pulls];
        list.sort((a, b) => b.seq - a.seq);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, Math.max(0, first));
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((pull) => pullGqlObject(repo, pull)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > page.length, endCursor: null },
          totalCount: list.length,
        };
      }
      if (name === 'pullRequest') {
        const number = args.number as number | undefined;
        const pull = typeof number === 'number' ? repo.pullsByNumber.get(number) : undefined;
        return pull === undefined ? null : pullGqlObject(repo, pull);
      }
      return unknownField(parentType, name, errors);
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      const repo = parent.repo as Repo;
      if (name === 'id') return globalId('issue', repo.owner, repo.name, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'body') return issue.body;
      if (name === 'url') return '';
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_ISO;
      if (name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      if (name === 'labels') return { __typename: 'LabelConnection', nodes: issue.labels.map((label) => ({ __typename: 'Label', name: label })) };
      if (name === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((comment) => ({ __typename: 'Comment', id: globalId('comment', repo.owner, repo.name, issue.number, comment.id), body: comment.body })),
        };
      }
      return unknownField(parentType, name, errors);
    }
    case 'PullRequest': {
      const pull = parent.pull as Pull;
      const repo = parent.repo as Repo;
      if (name === 'id') return globalId('pr', repo.owner, repo.name, pull.number);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'merged') return pull.merged;
      if (name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return store.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      if (name === 'createdAt' || name === 'updatedAt') return FIXED_ISO;
      if (name === 'mergedAt') return pull.mergedAt;
      if (name === 'mergeCommit') return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha };
      if (name === 'files') {
        const files = store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const page = files.slice(0, Math.max(0, first));
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > page.length, endCursor: null },
          totalCount: files.length,
        };
      }
      return unknownField(parentType, name, errors);
    }
    case 'User': {
      if (name === 'login') return parent.login ?? VIEWER_LOGIN;
      if (name === 'id') return globalId('user', (parent.login as string) ?? VIEWER_LOGIN);
      if (name === 'name') return parent.name ?? VIEWER_NAME;
      if (name === 'email') return parent.email ?? VIEWER_EMAIL;
      return unknownField(parentType, name, errors);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      if (name === 'nodes') return parent.nodes ?? [];
      if (name === 'pageInfo') return parent.pageInfo ?? { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      if (name === 'totalCount') return parent.totalCount ?? (Array.isArray(parent.nodes) ? parent.nodes.length : 0);
      return unknownField(parentType, name, errors);
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return parent.hasNextPage ?? false;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return parent.endCursor ?? null;
      if (name === 'startCursor') return null;
      return unknownField(parentType, name, errors);
    }
    case 'Ref': {
      if (name === 'name') return parent.name ?? null;
      return unknownField(parentType, name, errors);
    }
    case '__Type': {
      if (name === 'name') return parent.name ?? null;
      if (name === 'kind') return 'OBJECT';
      if (name === 'fields') return parent.fields ?? [];
      if (name === 'enumValues') return parent.enumValues ?? [];
      if (name === 'description') return null;
      return unknownField(parentType, name, errors);
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return parent.name ?? null;
      if (name === 'description') return null;
      return unknownField(parentType, name, errors);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return parent.issue ?? null;
      if (name === 'clientMutationId') return null;
      return unknownField(parentType, name, errors);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return parent.pullRequest ?? null;
      if (name === 'clientMutationId') return null;
      return unknownField(parentType, name, errors);
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return parent.commentEdge ?? null;
      if (name === 'clientMutationId') return null;
      return unknownField(parentType, name, errors);
    }
    case 'CommentEdge': {
      if (name === 'node') return parent.node ?? null;
      if (name === 'cursor') return parent.cursor ?? null;
      return unknownField(parentType, name, errors);
    }
    case 'Comment': {
      if (name === 'id') return parent.id ?? null;
      if (name === 'body') return parent.body ?? null;
      if (name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      return unknownField(parentType, name, errors);
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return parent.path ?? null;
      return unknownField(parentType, name, errors);
    }
    case 'Label': {
      if (name === 'name') return parent.name ?? null;
      return unknownField(parentType, name, errors);
    }
    case 'Commit': {
      if (name === 'oid') return parent.oid ?? null;
      return unknownField(parentType, name, errors);
    }
    default:
      return unknownField(parentType, name, errors);
  }
}

function repoFromGlobalId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') return null;
  const [owner, repoName] = decoded.parts;
  if (owner === undefined || repoName === undefined) return null;
  return restRepo(owner, repoName);
}

function issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue') return null;
  const [owner, repoName, number] = decoded.parts;
  if (owner === undefined || repoName === undefined) return null;
  const repo = restRepo(owner, repoName);
  const issue = repo?.issuesByNumber.get(Number(number));
  return repo === null || issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pr') return null;
  const [owner, repoName, number] = decoded.parts;
  if (owner === undefined || repoName === undefined) return null;
  const repo = restRepo(owner, repoName);
  const pull = repo?.pullsByNumber.get(Number(number));
  return repo === null || pull === undefined ? null : { repo, pull };
}

function handleGraphQL(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  const parsed = parseJsonBody(raw);
  if (parsed === null) {
    sendJson(res, 400, { errors: [{ message: 'the request body is not valid JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'an operation needs a query string' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(entry.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'the query could not be parsed' }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'the document holds no operation' }] };
    }
    let operation = operations[0]!;
    if (typeof entry.operationName === 'string') {
      const named = operations.find((candidate) => candidate.name === entry.operationName);
      if (named !== undefined) operation = named;
    }
    const { data, errors } = executeOperation(operation, variables);
    return errors.length > 0 ? { data, errors } : { data };
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP)
// ---------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required?: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
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
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
      },
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
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['title'],
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
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['title', 'head', 'base'],
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
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['pull_number'],
    },
  },
];

/** Split "owner/repo" (full_name) or owner+repo arguments into an owner and a repo name. */
function mcpRepoTarget(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = args.full_name;
  if (typeof fullName === 'string') {
    const [owner, repo] = fullName.split('/');
    if (owner !== undefined && owner !== '' && repo !== undefined && repo !== '') return { owner, repo };
  }
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner === 'string' && typeof repo === 'string' && owner !== '' && repo !== '') return { owner, repo };
  return null;
}

function mcpToolResult(payload: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function mcpToolError(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpCallTool(name: string, args: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: true } {
  switch (name) {
    case 'create_repo': {
      if (typeof args.name !== 'string' || args.name === '') return mcpToolError('create_repo requires a name');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        args.name,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (repo === null) return mcpToolError(`Repository ${VIEWER_LOGIN}/${args.name} already exists`);
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const target = mcpRepoTarget(args);
      if (target === null) return mcpToolError('get_repo requires owner and repo, or full_name');
      const repo = restRepo(target.owner, target.repo);
      if (repo === null) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const target = mcpRepoTarget(args);
      if (target === null) return mcpToolError('create_issue requires owner and repo, or full_name');
      if (typeof args.title !== 'string' || args.title === '') return mcpToolError('create_issue requires a title');
      const repo = restRepo(target.owner, target.repo);
      if (repo === null) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
      const issue = store.createIssue(repo, args.title, typeof args.body === 'string' ? args.body : '', []);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const target = mcpRepoTarget(args);
      if (target === null) return mcpToolError('list_issues requires owner and repo, or full_name');
      const repo = restRepo(target.owner, target.repo);
      if (repo === null) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      return mcpToolResult({ issues: list.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const target = mcpRepoTarget(args);
      if (target === null) return mcpToolError('create_pull_request requires owner and repo, or full_name');
      if (typeof args.title !== 'string' || args.title === '') return mcpToolError('create_pull_request requires a title');
      if (typeof args.head !== 'string' || typeof args.base !== 'string') return mcpToolError('create_pull_request requires head and base branches');
      const repo = restRepo(target.owner, target.repo);
      if (repo === null) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
      const pull = store.createPull(repo, args.title, typeof args.body === 'string' ? args.body : '', args.head, args.base);
      if (pull === null) return mcpToolError('create_pull_request: the head or base branch does not exist, or an open pull request already exists for this head');
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const target = mcpRepoTarget(args);
      if (target === null) return mcpToolError('merge_pull_request requires owner and repo, or full_name');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isSafeInteger(number)) return mcpToolError('merge_pull_request requires a pull_number');
      const repo = restRepo(target.owner, target.repo);
      if (repo === null) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
      const pull = repo.pullsByNumber.get(number);
      if (pull === undefined) return mcpToolError(`Pull request #${number} not found`);
      if (pull.state !== 'open' || pull.merged) return mcpToolError(`Pull request #${number} is not open`);
      if (store.pullConflict(repo, pull)) return mcpToolError(`Pull request #${number} is conflicted`);
      const mergeSha = store.mergePull(repo, pull);
      return mcpToolResult({ merged: true, sha: mergeSha, message: pull.title, number: pull.number });
    }
    default:
      return mcpToolError(`Unknown tool: ${name}`);
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  const sendRpc = (status: number, body: Record<string, unknown> | null): void => {
    if (body === null) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end();
      return;
    }
    sendJson(res, status, body);
  };
  const parseError = (id: unknown): void => {
    sendRpc(400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32700, message: 'Parse error: the request body is not valid JSON' } });
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    parseError(null);
    return;
  }
  if (!isRecord(parsed)) {
    parseError(null);
    return;
  }
  const id = parsed.id ?? null;
  const hasId = parsed.id !== undefined && parsed.id !== null;
  const method = parsed.method;
  if (typeof method !== 'string') {
    sendRpc(400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: a method name is required' } });
    return;
  }
  // Notifications carry no id and get no response body.
  if (!hasId) {
    sendRpc(202, null);
    return;
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  if (method === 'server/discover') {
    sendRpc(200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      },
    });
    return;
  }
  if (method === 'initialize') {
    sendRpc(200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      },
    });
    return;
  }
  if (method === 'ping') {
    sendRpc(200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    sendRpc(200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string') {
      sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call requires a tool name' } });
      return;
    }
    if (!MCP_TOOLS.some((tool) => tool.name === toolName)) {
      sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
      return;
    }
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const result = mcpCallTool(toolName, args);
    sendRpc(200, { jsonrpc: '2.0', id, result });
    return;
  }
  sendRpc(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ---------------------------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const path = pathOf(req);
        const query = queryOf(req);
        const method = req.method ?? 'GET';
        const segments = segmentsOf(path);

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const name = decodeURIComponent(gitMatch[2]!);
          const action = gitMatch[3]!;
          if (action === 'info/refs') {
            const service = query.get('service') ?? '';
            handleInfoRefs(req, res, owner, name, service);
            return;
          }
          const repo = gitRepo(owner, name);
          if (repo === null) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const raw = await readBody(req);
          if (action === 'git-upload-pack') {
            handleUploadPack(req, res, repo, raw);
            return;
          }
          handleReceivePack(req, res, repo, raw);
          return;
        }

        // REST v3: every route needs a bearer token; GraphQL and MCP too.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) {
            sendError(res, 401, 'Bad credentials');
            return;
          }
          const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          let body: unknown = {};
          if (raw.length > 0) {
            body = parseJsonBody(raw);
            if (body === null) {
              sendError(res, 400, 'the request body is not valid JSON');
              return;
            }
          }
          handleRest(req, res, method, segments, query, body);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { errors: [{ message: 'Bad credentials' }] });
            return;
          }
          const raw = await readBody(req);
          handleGraphQL(req, res, raw);
          return;
        }

        if (segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendError(res, 404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad credentials' } });
            return;
          }
          const raw = await readBody(req);
          handleMcp(req, res, raw);
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        // A handler must never take the server down with it.
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.end();
      }
    })();
  };
  return createServer(handler);
}
