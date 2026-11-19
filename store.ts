// store.ts — the forge's whole state, in memory. One Store holds every
// repository, and every surface (git, REST, GraphQL, MCP) reads and writes the
// same objects, so a change over one surface is visible on the others at once.
//
// Determinism: no wall clock and no randomness anywhere in state. Server-made
// commits use a fixed identity and a per-repository counter as their timestamp,
// so the same sequence of operations always builds the same objects.

import {
  buildCommit,
  buildTree,
  collectReachable,
  collectReachableBounded,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const SERVER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
/** Fixed epoch for server-made commits; a per-repo counter keeps each unique. */
export const COMMIT_EPOCH = 1735689600;
/** Fixed timestamps for the REST/GraphQL views (never a clock). */
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issuesByNumber: Map<number, Issue>;
  issueSeq: number;
  pulls: Pull[];
  pullsByNumber: Map<number, Pull>;
  pullSeq: number;
  commitSeq: number;
}

export function fullName(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Opaque, stable Relay global ids (never the plain numeric id/number). */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join('/')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split('/') };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueIdSeq = 0;
  private commentIdSeq = 0;
  private pullIdSeq = 0;
  private opSeq = 0;

  nextOpSeq(): number {
    this.opSeq += 1;
    return this.opSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** All repositories of one owner, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextOpSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      issueSeq: 0,
      pulls: [],
      pullsByNumber: new Map(),
      pullSeq: 0,
      commitSeq: 0,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  lookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The tip oid of a branch (or null when the branch does not exist). */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a ref name, branch name or commit sha to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (!object) return null;
      return peelToCommit(ref, this.lookup(repo));
    }
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return peelToCommit(direct, this.lookup(repo));
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return peelToCommit(branch, this.lookup(repo));
    if (ref === 'HEAD') {
      const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return main === undefined ? null : peelToCommit(main, this.lookup(repo));
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (discovery order from the tip). */
  commitsFrom(repo: Repo, tip: string): { sha: string; message: string; tree: string }[] {
    const out: { sha: string; message: string; tree: string }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, tree: commit.tree });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -- trees ---------------------------------------------------------------

  /** Build nested trees for `files` (path -> blob oid) under `parentTree` (or empty). */
  buildTreeForFiles(repo: Repo, parentTree: string | null, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    if (parentTree !== null) {
      const flat = flattenTree(parentTree, this.lookup(repo));
      for (const [path, entry] of flat) {
        const segments = path.split('/');
        let node = root;
        for (let i = 0; i < segments.length - 1; i += 1) {
          const name = segments[i]!;
          if (!node.dirs.has(name)) node.dirs.set(name, make());
          node = node.dirs.get(name)!;
        }
        node.files.set(segments[segments.length - 1]!, entry.oid);
      }
    }
    for (const [path, blobOid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, blobOid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** A tree with `path` removed (null when the path is absent). */
  removePathFromTree(repo: Repo, parentTree: string, path: string): string | null {
    const flat = flattenTree(parentTree, this.lookup(repo));
    if (!flat.has(path)) return null;
    flat.delete(path);
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [p, entry] of flat) {
      const segments = p.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry.oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a server commit on `branch` (creating the branch when needed). */
  commitFile(
    repo: Repo,
    branch: string,
    message: string,
    changes: Map<string, string>,
    deletions: string[],
  ): { commitSha: string; treeSha: string } {
    const tip = this.branchTip(repo, branch);
    let parentTree: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      parentTree = commit.tree;
      parents.push(tip);
    }
    let tree = parentTree;
    if (changes.size > 0) tree = this.buildTreeForFiles(repo, parentTree, changes);
    for (const path of deletions) {
      if (tree === null) break;
      const next = this.removePathFromTree(repo, tree, path);
      if (next !== null) tree = next;
    }
    if (tree === null) tree = this.putObject(repo, 'tree', buildTree([]));
    repo.commitSeq += 1;
    const commitSha = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree,
        parents,
        message,
        author: SERVER_IDENTITY,
        committer: SERVER_IDENTITY,
        timestamp: COMMIT_EPOCH + repo.commitSeq,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, treeSha: tree };
  }

  // -- issues ---------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    this.issueIdSeq += 1;
    repo.issueSeq += 1;
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextOpSeq(),
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    this.commentIdSeq += 1;
    const comment: Comment = { id: this.commentIdSeq, body };
    issue.comments.push(comment);
    return comment;
  }

  // -- pull requests ----------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (headSha === null || baseSha === null) return null;
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) return null;
    }
    this.pullIdSeq += 1;
    repo.pullSeq += 1;
    const pull: Pull = {
      id: this.pullIdSeq,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: this.nextOpSeq(),
    };
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return pull;
  }

  /** The three-way conflict test: a path changed on both sides, differently. */
  pullConflict(repo: Repo, pull: Pull): boolean {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return true;
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    if (base === null) return false;
    const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const atBase = flattenTree(baseTree, this.lookup(repo));
    const atHead = flattenTree(headTree, this.lookup(repo));
    const atTip = flattenTree(baseTipTree, this.lookup(repo));
    const paths = new Set([...atBase.keys(), ...atHead.keys(), ...atTip.keys()]);
    for (const path of paths) {
      const b = atBase.get(path)?.oid ?? null;
      const h = atHead.get(path)?.oid ?? null;
      const t = atTip.get(path)?.oid ?? null;
      if (h !== b && t !== b && h !== t) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge sha or null. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflict(repo, pull)) return null;
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return null;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    repo.commitSeq += 1;
    const mergeSha = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: headTree,
        parents: [baseTip],
        message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
        author: SERVER_IDENTITY,
        committer: SERVER_IDENTITY,
        timestamp: COMMIT_EPOCH + repo.commitSeq,
      }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }

  /** Diff base tip -> head tip: path -> {status, additions, deletions}. */
  pullFiles(
    repo: Repo,
    pull: Pull,
  ): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return [];
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const atHead = flattenTree(headTree, this.lookup(repo));
    const atBase = flattenTree(baseTree, this.lookup(repo));
    const paths = new Set([...atBase.keys(), ...atHead.keys()]);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const path of [...paths].sort()) {
      const h = atHead.get(path)?.oid ?? null;
      const b = atBase.get(path)?.oid ?? null;
      if (h === b) continue;
      let status = 'modified';
      let additions = 0;
      let deletions = 0;
      if (b === null) {
        status = 'added';
        additions = countLines(repo.objects.get(h!)?.data);
      } else if (h === null) {
        status = 'removed';
        deletions = countLines(repo.objects.get(b)?.data);
      } else {
        const headLines = splitLines(repo.objects.get(h)?.data);
        const baseLines = splitLines(repo.objects.get(b)?.data);
        const diff = lineDiff(baseLines, headLines);
        additions = diff.additions;
        deletions = diff.deletions;
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Reachable objects for a fetch, honouring depth, haves and the old shallow boundary. */
  fetchObjects(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth: number | null,
    oldShallow: string[] = [],
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const lookup = this.lookup(repo);
    // A have the client holds as shallow counts only for itself and its tree:
    // the walk must not cross the client's shallow boundary, or the parent the
    // deepen is asking for would look already held.
    const haveSet = collectReachableBounded(haves, lookup, new Set(oldShallow));
    const send = new Map<string, GitObject>();
    const shallow: string[] = [];
    if (depth === null) {
      for (const oid of collectReachable(wants, lookup)) {
        if (haveSet.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (object) send.set(oid, object);
      }
      return { objects: [...send.values()], shallow, unshallow: [] };
    }
    // Depth-limited walk: commits at depth 1..N, each with its full tree closure.
    const included = new Set<string>();
    const boundary: string[] = [];
    const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid: peelToCommit(oid, lookup), depth: 1 }));
    // A wanted tag object travels with its target.
    for (const oid of wants) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') included.add(oid);
    }
    const seenCommit = new Set<string>();
    while (queue.length > 0) {
      const { oid, depth: d } = queue.shift()!;
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      included.add(oid);
      for (const treeOid of collectReachable([commit.tree], lookup)) included.add(treeOid);
      if (d >= depth) {
        if (commit.parents.length > 0) boundary.push(oid);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, depth: d + 1 });
    }
    for (const oid of included) {
      if (haveSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) send.set(oid, object);
    }
    // An old shallow boundary is unshallowed once it and all its parents are included.
    const unshallow: string[] = [];
    for (const oid of oldShallow) {
      if (!included.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => included.has(parent))) unshallow.push(oid);
    }
    return { objects: [...send.values()], shallow: boundary, unshallow };
  }
}

function splitLines(data: Buffer | undefined): string[] {
  if (!data || data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLines(data: Buffer | undefined): number {
  return splitLines(data).length;
}

/** Multiset line diff: lines in `after` not in `before`, and vice versa. */
function lineDiff(before: string[], after: string[]): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of after) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

export { isAncestor };
