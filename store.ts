// store.ts — the forge's single in-memory state: repositories, their git
// objects and refs, issues, labels, comments and pull requests. Everything
// is deterministic: fixed timestamps, counters for ids, no Date.now() or
// Math.random() anywhere in state. The HTTP layers (rest/graphql/mcp) read
// and write through these functions only.

import type { ObjType, GitObject, ObjectMap } from './git.ts';
import {
  ZERO, FIXED_EPOCH, DEFAULT_BRANCH,
  hashObject, storeObject, parseCommit, buildCommit, parseTree, buildTree,
  parseTag, walkCommits, isAncestor, closureOfCommits, mergeBase, readPack, writePack,
  getBlobOid, listFiles, setPath, formatIdent,
} from './git.ts';

export const FIXED_TS = '2026-01-01T00:00:00Z';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  created_at: string;
  user: { login: string };
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
  user: { login: string };
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null; // null until the first path names the viewer login
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: ObjectMap;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  labels: Map<string, Label>;
  comments: Map<number, Comment>;
  pulls: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  created_at: string;
  updated_at: string;
}

export interface State {
  viewerLogin: string | null;
  repos: Map<string, Repo>; // keyed by name; owner is the viewer login
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  requestSeq: number;
}

export function newState(): State {
  return { viewerLogin: null, repos: new Map(), nextRepoId: 1, nextIssueId: 1, nextPullId: 1, requestSeq: 0 };
}

/** Learn the viewer login from the first owner that appears in a path. */
export function learnViewer(state: State, owner: string): void {
  if (state.viewerLogin === null) {
    state.viewerLogin = owner;
    for (const repo of state.repos.values()) {
      if (repo.owner === null) repo.owner = owner;
    }
  }
}

/** Look a repo up by (owner, name). A name under a foreign owner is a 404. */
export function findRepo(state: State, owner: string, name: string): Repo | null {
  learnViewer(state, owner);
  if (state.viewerLogin !== owner) return null;
  const repo = state.repos.get(name);
  if (!repo) return null;
  if (repo.owner === null) repo.owner = owner;
  if (repo.owner !== owner) return null;
  return repo;
}

/** A repo created through POST /user/repos: owner is pending until learned. */
export function createRepo(state: State, name: string, description = '', isPrivate = false): Repo | null {
  if (state.repos.has(name)) return null;
  const repo: Repo = {
    id: state.nextRepoId++,
    name,
    owner: state.viewerLogin,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    labels: new Map(),
    comments: new Map(),
    pulls: new Map(),
    nextIssueNumber: 1,
    nextPullNumber: 1,
    nextCommentId: 1,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  };
  state.repos.set(name, repo);
  return repo;
}

export function deleteRepo(state: State, repo: Repo): void {
  state.repos.delete(repo.name);
}

// ------------------------------------------------------------- git objects --

export function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

/** The oid a ref resolves to, following an annotated tag to its target. */
export function resolveRef(repo: Repo, ref: string): { oid: string; peeled: string | null } | null {
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  const obj = repo.objects.get(oid);
  if (obj && obj.type === 'tag') {
    const t = parseTag(obj.data);
    return { oid, peeled: t.object };
  }
  return { oid, peeled: null };
}

/** All refs sorted by name, with their resolved (peeled) targets. */
export function allRefs(repo: Repo): { name: string; oid: string; peeled: string | null }[] {
  const out: { name: string; oid: string; peeled: string | null }[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const r = resolveRef(repo, name);
    if (r) out.push({ name, oid: r.oid, peeled: r.peeled });
  }
  return out;
}

/** HEAD's target: the default branch tip, or null for an empty repo. */
export function headTarget(repo: Repo): { oid: string; ref: string } | null {
  const ref = `refs/heads/${repo.defaultBranch}`;
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  return { oid, ref };
}

/** Add every object of a parsed pack into the repo's object store. */
export function addPackObjects(repo: Repo, pack: Buffer): Map<string, { type: ObjType; data: Buffer }> {
  const objs = readPack(pack);
  for (const [oid, o] of objs) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: o.type, data: o.data });
  }
  return objs;
}

/**
 * Apply one ref update. Returns {ok, reason}. Only fast-forward moves (or
 * creates/deletes) are accepted on branches; tags may be set freely.
 */
export function applyRefUpdate(
  repo: Repo,
  ref: string,
  oldOid: string,
  newOid: string,
): { ok: boolean; reason?: string } {
  const current = repo.refs.get(ref) ?? ZERO;
  if (oldOid !== ZERO && oldOid !== current) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  if (newOid === ZERO) {
    // delete
    if (!repo.refs.has(ref)) return { ok: false, reason: 'reference does not exist' };
    repo.refs.delete(ref);
    return { ok: true };
  }
  if (oldOid === ZERO && repo.refs.has(ref)) {
    return { ok: false, reason: 'already exists' };
  }
  if (ref.startsWith('refs/heads/') && oldOid !== ZERO) {
    // fast-forward check: old must be an ancestor of new
    const newObj = repo.objects.get(newOid);
    if (!newObj || newObj.type !== 'commit') return { ok: false, reason: 'object not a commit' };
    if (!isAncestor(repo.objects, oldOid, newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ok: true };
}

// ------------------------------------------------------- fetch computation --

export interface FetchPlan {
  /** Oids to send, in pack order (commits first, then their trees/blobs). */
  objects: { type: ObjType; data: Buffer }[];
  /** New shallow boundary commits. */
  shallow: string[];
  /** Formerly shallow commits that are now fully present. */
  unshallow: string[];
  /** Acks for the haves the server holds. */
  acks: string[];
  ready: boolean;
}

/**
 * Compute what a fetch must deliver.
 * - wants: the wanted oids (commits or tags, peeled to commits).
 * - haves: commits the client already holds.
 * - existingShallow: the client's current shallow boundary.
 * - depth: a deepen limit (1 = only the tips).
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  existingShallow: string[],
  depth: number | null,
): FetchPlan {
  const objects = repo.objects;
  // Peel wants to commits.
  const wantCommits: string[] = [];
  for (const w of wants) {
    const obj = objects.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') wantCommits.push(w);
    else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      const target = objects.get(t.object);
      if (target?.type === 'commit') wantCommits.push(t.object);
    }
  }
  const shallowSet = new Set(existingShallow);
  // Closure the client already holds: walk from haves, but do not follow
  // the parents of shallow commits (the client does not hold them).
  const haveClosure = new Set<string>();
  {
    const { commits } = walkCommits(objects, haves, { stopAt: shallowSet });
    const stack: string[] = [...commits];
    const visitTree = (treeOid: string) => {
      const t = objects.get(treeOid);
      if (!t || t.type !== 'tree' || haveClosure.has(treeOid)) return;
      haveClosure.add(treeOid);
      for (const e of parseTree(t.data)) {
        if (e.mode === '40000') visitTree(e.oid);
        else haveClosure.add(e.oid);
      }
    };
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveClosure.has(oid)) continue;
      const obj = objects.get(oid);
      if (!obj) continue;
      haveClosure.add(oid);
      if (obj.type === 'commit') visitTree(parseCommit(obj.data).tree);
      else if (obj.type === 'tag') {
        const t = parseTag(obj.data);
        if (t.object) stack.push(t.object);
      }
    }
  }
  // The closure the client wants: exactly the commits the walk (depth
  // limited or full) reached, plus their trees and blobs — never the
  // parents below a depth limit.
  const wantDepth = depth !== null
    ? walkCommits(objects, wantCommits, { maxDepth: depth })
    : walkCommits(objects, wantCommits);
  const wantClosure = closureOfCommits(objects, wantDepth.commits);
  // Also include the wanted tag objects themselves.
  for (const w of wants) {
    const obj = objects.get(w);
    if (obj?.type === 'tag') wantClosure.add(w);
  }
  // Objects to send: wanted minus held.
  const toSend = [...wantClosure].filter((oid) => !haveClosure.has(oid));
  // Order: commits first (newest first), then trees, then blobs — any order
  // is valid for a pack, but deterministic ordering keeps the output stable.
  const ordered: { type: ObjType; data: Buffer }[] = [];
  const byType = (t: ObjType) => toSend.filter((oid) => objects.get(oid)?.type === t);
  const commitOrder = [...wantDepth.commits].filter((c) => toSend.includes(c));
  for (const oid of commitOrder) {
    const o = objects.get(oid)!;
    ordered.push({ type: o.type, data: o.data });
  }
  for (const oid of byType('tag')) {
    const o = objects.get(oid)!;
    ordered.push({ type: o.type, data: o.data });
  }
  for (const oid of byType('tree')) {
    const o = objects.get(oid)!;
    ordered.push({ type: o.type, data: o.data });
  }
  for (const oid of byType('blob')) {
    const o = objects.get(oid)!;
    ordered.push({ type: o.type, data: o.data });
  }
  // Shallow boundary: with a depth limit, the commits at exactly `depth`
  // generations from the wants; without one, no new boundary.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of wantDepth.depth) {
      if (d === depth) shallow.push(oid);
    }
    // Formerly shallow commits whose parent is now delivered are unshallow.
    for (const s of existingShallow) {
      if (wantDepth.commits.includes(s)) {
        const obj = objects.get(s);
        if (obj?.type === 'commit') {
          const parents = parseCommit(obj.data).parents;
          if (parents.every((p) => wantDepth.commits.includes(p))) unshallow.push(s);
        }
      }
    }
  } else if (existingShallow.length > 0) {
    // A full fetch delivers the whole history: every shallow commit whose
    // ancestry is now included becomes unshallow.
    for (const s of existingShallow) {
      const { commits } = walkCommits(objects, [s]);
      if (commits.every((c) => wantDepth.commits.includes(c))) unshallow.push(s);
    }
  }
  // Acks: every have the server holds, in order.
  const acks = haves.filter((h) => objects.has(h));
  const ready = haves.length > 0 && acks.length === haves.length;
  return { objects: ordered, shallow, unshallow, acks, ready };
}

// ------------------------------------------------------------------ issues --

export function createIssue(
  state: State,
  repo: Repo,
  title: string,
  body = '',
  labels: string[] = [],
): { issue: Issue } | { error: string } {
  const resolved: Label[] = [];
  for (const name of labels) {
    const l = repo.labels.get(name);
    if (!l) return { error: `label "${name}" does not exist` };
    resolved.push(l);
  }
  const issue: Issue = {
    id: state.nextIssueId++,
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    labels: resolved,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    user: { login: state.viewerLogin ?? '' },
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

export function createComment(state: State, repo: Repo, issueNumber: number, body: string): Comment {
  const comment: Comment = {
    id: repo.nextCommentId++,
    issueNumber,
    body,
    created_at: FIXED_TS,
    user: { login: state.viewerLogin ?? '' },
  };
  repo.comments.set(comment.id, comment);
  return comment;
}

// -------------------------------------------------------------------- pulls --

/** The files changed between two trees, with line-level additions/deletions. */
export function diffTrees(
  objects: ObjectMap,
  baseTree: string | null,
  headTree: string | null,
): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
  const baseFiles = baseTree ? new Map(listFiles(objects, baseTree).map((f) => [f.path, f.oid])) : new Map<string, string>();
  const headFiles = headTree ? new Map(listFiles(objects, headTree).map((f) => [f.path, f.oid])) : new Map<string, string>();
  const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
  const linesOf = (oid: string): string[] => {
    const obj = objects.get(oid);
    if (!obj) return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    return text.split('\n');
  };
  const countDiff = (a: string[], b: string[]): { additions: number; deletions: number } => {
    // Simple multiset line diff: lines in b not matched in a are additions.
    const counts = new Map<string, number>();
    for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of b) {
      const c = counts.get(l) ?? 0;
      if (c > 0) counts.set(l, c - 1);
      else additions++;
    }
    let deletions = 0;
    for (const c of counts.values()) deletions += c;
    return { additions, deletions };
  };
  const all = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...all].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === undefined && h !== undefined) {
      const lines = linesOf(h);
      out.push({ filename: path, status: 'added', additions: lines.length, deletions: 0, changes: lines.length });
    } else if (b !== undefined && h === undefined) {
      const lines = linesOf(b);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines.length, changes: lines.length });
    } else if (b !== undefined && h !== undefined && b !== h) {
      const { additions, deletions } = countDiff(linesOf(b), linesOf(h));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Create a squash-merge commit for a PR and move the base branch to it. */
export function squashMerge(
  state: State,
  repo: Repo,
  pr: PullRequest,
): { sha: string } | { error: string; status: number } {
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  if (!headTip || !baseTip) return { error: 'branch not found', status: 404 };
  const base = mergeBase(repo.objects, headTip, baseTip);
  const headCommit = parseCommit(repo.objects.get(headTip)!.data);
  const baseCommit = parseCommit(repo.objects.get(baseTip)!.data);
  const mergeCommit = parseCommit(repo.objects.get(base ?? baseTip)!.data);
  // Conflict: a file changed on both sides since the merge base, with
  // different contents.
  if (base !== null) {
    const headChanges = new Map(
      diffTrees(repo.objects, mergeCommit.tree, headCommit.tree).map((d) => [d.filename, d.status]),
    );
    const baseChanges = diffTrees(repo.objects, mergeCommit.tree, baseCommit.tree);
    for (const d of baseChanges) {
      if (headChanges.has(d.filename)) {
        const headOid = getBlobOid(repo.objects, headCommit.tree, d.filename.split('/'));
        const baseOid = getBlobOid(repo.objects, baseCommit.tree, d.filename.split('/'));
        if (headOid !== baseOid) return { error: 'Merge conflict', status: 405 };
      }
    }
  }
  const author = formatIdent(state.viewerLogin ?? 'forge', `${state.viewerLogin ?? 'forge'}@example.invalid`);
  const commit = buildCommit({
    tree: headCommit.tree,
    parents: [baseTip],
    author,
    committer: author,
    message: `${pr.title} (#${pr.number})`,
    extra: [],
  });
  const sha = storeObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${pr.base.ref}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = FIXED_TS;
  pr.merge_commit_sha = sha;
  pr.updated_at = FIXED_TS;
  return { sha };
}

// ------------------------------------------------------------ contents commit --

/** Commit a file change (create/update/delete) on a branch; returns the commit oid. */
export function commitFile(
  state: State,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { sha: string } | { error: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  let tree: string | null = null;
  const parents: string[] = [];
  if (tip) {
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') return { error: 'branch tip is not a commit' };
    tree = parseCommit(obj.data).tree;
    parents.push(tip);
  }
  let blobOid: string | null = null;
  if (content !== null) blobOid = storeObject(repo.objects, 'blob', content);
  const newTree = setPath(repo.objects, tree, path.split('/'), blobOid);
  const author = formatIdent(state.viewerLogin ?? 'forge', `${state.viewerLogin ?? 'forge'}@example.invalid`);
  const commit = buildCommit({
    tree: newTree,
    parents,
    author,
    committer: author,
    message,
    extra: [],
  });
  const sha = storeObject(repo.objects, 'commit', commit);
  repo.refs.set(ref, sha);
  return { sha };
}
