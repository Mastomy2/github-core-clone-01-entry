// graphql.ts — a small, dependency-free GraphQL executor for the exact
// document shapes gh and github-mcp-server send: queries, mutations,
// variables, input objects, lists, enums, aliases, inline fragments and
// operation batching. Unknown fields answer HTTP 200 with an `errors` array
// naming the field; an unknown repository answers `data.repository: null`
// with no errors. No auth is enforced here — the HTTP layer does that.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { State, Repo, Issue, PullRequest } from './store.ts';
import { findRepo, createIssue, createComment, squashMerge, diffTrees } from './store.ts';
import { readBody, sendJson, sendError, parseJsonBody, authorized, isRecord } from './http.ts';
import { parseCommit, getBlobOid, mergeBase } from './git.ts';

// ------------------------------------------------------------------- parser --

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum'; value: string | number | boolean | null }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

export interface GqlFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, GqlValue | null>; // defaults (unused, kept for shape)
  selections: GqlSelection[];
}

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos++;
      else if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private eat(expected: string): boolean {
    this.skipWs();
    if (this.src.startsWith(expected, this.pos)) {
      this.pos += expected.length;
      return true;
    }
    return false;
  }

  private expect(expected: string): void {
    if (!this.eat(expected)) throw new Error(`expected ${expected} at ${this.pos}`);
  }

  private readName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected a name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private readString(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new Error(`expected a string at ${this.pos}`);
    this.pos++;
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const esc = this.src[this.pos++];
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc;
      } else out += c;
    }
    throw new Error('unterminated string');
  }

  private readNumber(): GqlValue {
    this.skipWs();
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected a number at ${this.pos}`);
    this.pos += m[0].length;
    if (m[0].includes('.') || m[0].includes('e') || m[0].includes('E')) {
      return { kind: 'float', value: Number.parseFloat(m[0]) };
    }
    return { kind: 'int', value: Number.parseInt(m[0], 10) };
  }

  parseValue(): GqlValue {
    this.skipWs();
    const c = this.peek();
    if (c === '$') {
      this.pos++;
      return { kind: 'variable', name: this.readName() };
    }
    if (c === '"') return { kind: 'string', value: this.readString() };
    if (c === '[') {
      this.pos++;
      const items: GqlValue[] = [];
      while (!this.eat(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (c === '{') {
      this.pos++;
      const fields: Record<string, GqlValue> = {};
      while (!this.eat('}')) {
        const name = this.readName();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null', value: null };
    return { kind: 'enum', value: name };
  }

  private parseArgs(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (!this.eat('(')) return args;
    while (!this.eat(')')) {
      const name = this.readName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseSelections(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (!this.eat('}')) {
      if (this.eat('...')) {
        let typeCondition: string | null = null;
        if (this.eat('on')) typeCondition = this.readName();
        out.push({ kind: 'fragment', typeCondition, selections: this.parseSelections() });
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      if (this.eat(':')) {
        alias = first;
        name = this.readName();
      }
      const args = this.parseArgs();
      let selections: GqlSelection[] = [];
      if (this.peek() === '{') selections = this.parseSelections();
      out.push({ kind: 'field', alias, name, args, selections });
    }
    return out;
  }

  parseOperation(): GqlOperation {
    this.skipWs();
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const c = this.peek();
    if (c === '{') {
      return { type: 'query', name: null, variables: {}, selections: this.parseSelections() };
    }
    const keyword = this.readName();
    if (keyword === 'query' || keyword === 'mutation') type = keyword;
    else throw new Error(`unexpected operation ${keyword}`);
    if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
    // variable definitions — skipped (values come from the request body)
    if (this.eat('(')) {
      let depth = 1;
      while (depth > 0 && this.pos < this.src.length) {
        const ch = this.src[this.pos++];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === '"') {
          while (this.pos < this.src.length && this.src[this.pos] !== '"') {
            if (this.src[this.pos] === '\\') this.pos++;
            this.pos++;
          }
          this.pos++;
        }
      }
    }
    return { type, name, variables: {}, selections: this.parseSelections() };
  }
}

// -------------------------------------------------------------- value resolve --

function resolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable':
      return variables[v.name];
    case 'list':
      return v.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, variables);
      return out;
    }
    default:
      return v.value;
  }
}

// ------------------------------------------------------------------ globals --

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function repoGid(owner: string, name: string): string {
  return b64(`Repository:${owner}/${name}`);
}

function issueGid(owner: string, name: string, number: number): string {
  return b64(`Issue:${owner}/${name}#${number}`);
}

function prGid(owner: string, name: string, number: number): string {
  return b64(`PullRequest:${owner}/${name}#${number}`);
}

function commentGid(owner: string, name: string, issueNumber: number, commentId: number): string {
  return b64(`IssueComment:${owner}/${name}#${issueNumber}#${commentId}`);
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const n = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    return Number.isNaN(n) ? -1 : n;
  } catch {
    return -1;
  }
}

function encodeCursor(index: number): string {
  return b64(String(index));
}

// ------------------------------------------------------------------- schema --

/** The fields each type exposes, for the unknown-field error. */
const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'type', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  Actor: ['login'],
};

const INTROSPECTION: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'], enumValues: [] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

// ----------------------------------------------------------------- executor --

interface GqlCtx {
  state: State;
  variables: Record<string, unknown>;
}

class GqlError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function fieldError(typeName: string, field: string): GqlError {
  return new GqlError(`Cannot query field "${field}" on type "${typeName}".`);
}

function checkField(typeName: string, field: string): void {
  const allowed = SCHEMA[typeName];
  if (allowed && !allowed.includes(field)) throw fieldError(typeName, field);
}

function argsOf(field: GqlField, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveValue(v, ctx.variables);
  return out;
}

function selectFields(
  selections: GqlSelection[],
  typeName: string,
  value: Record<string, unknown> | null,
  ctx: GqlCtx,
  resolve: (parent: Record<string, unknown>, field: GqlField, ctx: GqlCtx) => unknown,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      Object.assign(out, selectFields(sel.selections, typeName, value, ctx, resolve) ?? {});
      continue;
    }
    checkField(typeName, sel.name);
    const key = sel.alias ?? sel.name;
    const child = resolve(value, sel, ctx);
    out[key] = child;
  }
  return out;
}

// -------------------------------------------------------------- pagination --

/**
 * Resolve a connection field (`issues`, `pullRequests`, `files`, ...): the
 * sub-selections name `nodes`, `edges`, `pageInfo` and `totalCount`, and the
 * node's own selections are resolved per item. `first`/`after` paginate
 * with opaque base64 index cursors.
 */
function buildConnection<T>(
  field: GqlField,
  items: T[],
  args: Record<string, unknown>,
  ctx: GqlCtx,
  nodeType: string,
  toRecord: (item: T) => Record<string, unknown>,
  nodeResolver: (parent: Record<string, unknown>, f: GqlField, c: GqlCtx) => unknown,
): Record<string, unknown> {
  const connType = `${nodeType}Connection`;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = decodeCursor(typeof args.after === 'string' ? args.after : null);
  const start = after + 1;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? encodeCursor(start + page.length - 1) : null;
  const pageInfo: Record<string, unknown> = {
    hasNextPage,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? encodeCursor(start) : null,
    endCursor,
  };
  const out: Record<string, unknown> = {};
  for (const sel of field.selections) {
    if (sel.kind !== 'field') continue;
    checkField(connType, sel.name);
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') {
      out[key] = page.map((item) => selectFields(sel.selections, nodeType, toRecord(item), ctx, nodeResolver));
    } else if (sel.name === 'edges') {
      out[key] = page.map((item, i) => {
        const edge: Record<string, unknown> = {};
        for (const e of sel.selections) {
          if (e.kind !== 'field') continue;
          if (e.name === 'node') edge[e.alias ?? 'node'] = selectFields(e.selections, nodeType, toRecord(item), ctx, nodeResolver);
          else if (e.name === 'cursor') edge[e.alias ?? 'cursor'] = encodeCursor(start + i);
          else throw fieldError(`${nodeType}Edge`, e.name);
        }
        return edge;
      });
    } else if (sel.name === 'pageInfo') {
      out[key] = selectFields(sel.selections, 'PageInfo', pageInfo, ctx, (parent, f) => {
        if (['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(f.name)) return parent[f.name];
        throw fieldError('PageInfo', f.name);
      });
    } else if (sel.name === 'totalCount') {
      out[key] = items.length;
    }
  }
  return out;
}

// ------------------------------------------------------------- resolvers ---

function resolveRepo(
  state: State,
  repo: Repo,
  field: GqlField,
  ctx: GqlCtx,
): unknown {
  const owner = repo.owner ?? state.viewerLogin ?? '';
  const args = argsOf(field, ctx);
  switch (field.name) {
    case 'id': return repoGid(owner, repo.name);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${owner}/${repo.name}`;
    case 'owner': return selectFields(field.selections, 'User', { login: owner }, ctx, resolveUser);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return selectFields(field.selections, 'Ref', { name: repo.defaultBranch }, ctx, resolveRef);
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'issue': {
      const issue = repo.issues.get(typeof args.number === 'number' ? args.number : -1) ?? null;
      return selectFields(field.selections, 'Issue', issue ? issueRecord(state, repo, issue) : null, ctx, resolveIssue);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((s) => String(s)));
        issues = issues.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const direction = String(orderBy.direction ?? 'ASC');
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      return buildConnection(field, issues, args, ctx, 'Issue', (i) => issueRecord(state, repo, i), resolveIssue);
    }
    case 'pullRequest': {
      const pr = repo.pulls.get(typeof args.number === 'number' ? args.number : -1) ?? null;
      return selectFields(field.selections, 'PullRequest', pr ? prRecord(state, repo, pr) : null, ctx, resolvePullRequest);
    }
    case 'pullRequests': {
      const prs = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      return buildConnection(field, prs, args, ctx, 'PullRequest', (p) => prRecord(state, repo, p), resolvePullRequest);
    }
    default: throw fieldError('Repository', field.name);
  }
}

function resolveUser(
  parent: Record<string, unknown>,
  field: GqlField,
  _ctx: GqlCtx,
): unknown {
  switch (field.name) {
    case 'login': return parent.login;
    case 'id': return b64(`User:${String(parent.login)}`);
    case 'name': return parent.login;
    default: throw fieldError('User', field.name);
  }
}

function resolveRef(
  parent: Record<string, unknown>,
  field: GqlField,
  _ctx: GqlCtx,
): unknown {
  if (field.name === 'name') return parent.name;
  throw fieldError('Ref', field.name);
}

function issueRecord(state: State, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? state.viewerLogin ?? '';
  return {
    __typename: 'Issue',
    __repo: repo,
    __owner: owner,
    id: issueGid(owner, repo.name, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: { login: issue.user.login },
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}

function resolveIssue(
  parent: Record<string, unknown>,
  field: GqlField,
  ctx: GqlCtx,
): unknown {
  switch (field.name) {
    case 'id': case 'databaseId': case 'number': case 'title': case 'body': case 'state': case 'createdAt': case 'updatedAt':
      return parent[field.name];
    case 'author':
      return selectFields(field.selections, 'Actor', { login: (parent.author as { login: string }).login }, ctx, resolveUser);
    default: throw fieldError('Issue', field.name);
  }
}

function prRecord(state: State, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const owner = repo.owner ?? state.viewerLogin ?? '';
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __owner: owner,
    id: prGid(owner, repo.name, pr.number),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergedAt: pr.merged_at,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    author: { login: pr.user.login },
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  };
}

function resolvePullRequest(
  parent: Record<string, unknown>,
  field: GqlField,
  ctx: GqlCtx,
): unknown {
  const repo = parent.__repo as Repo;
  const pr = repo.pulls.get(parent.number as number)!;
  const args = argsOf(field, ctx);
  switch (field.name) {
    case 'id': case 'databaseId': case 'number': case 'title': case 'body': case 'state': case 'merged': case 'mergedAt': case 'headRefName': case 'baseRefName': case 'createdAt': case 'updatedAt':
      return parent[field.name];
    case 'author':
      return selectFields(field.selections, 'Actor', { login: (parent.author as { login: string }).login }, ctx, resolveUser);
    case 'mergeable': {
      if (pr.state !== 'open') return 'UNKNOWN';
      const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
      const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
      if (!headTip || !baseTip) return 'UNKNOWN';
      const base = mergeBase(repo.objects, headTip, baseTip);
      if (base === null) return 'UNKNOWN';
      const headCommit = parseCommit(repo.objects.get(headTip)!.data);
      const baseCommit = parseCommit(repo.objects.get(baseTip)!.data);
      const mergeCommit = parseCommit(repo.objects.get(base)!.data);
      const headChanges = new Map(diffTrees(repo.objects, mergeCommit.tree, headCommit.tree).map((d: { filename: string }) => [d.filename, true]));
      for (const d of diffTrees(repo.objects, mergeCommit.tree, baseCommit.tree)) {
        if (headChanges.has(d.filename)) {
          const headOid = getBlobOid(repo.objects, headCommit.tree, d.filename.split('/'));
          const baseOid = getBlobOid(repo.objects, baseCommit.tree, d.filename.split('/'));
          if (headOid !== baseOid) return 'CONFLICTING';
        }
      }
      return 'MERGEABLE';
    }
    case 'files': {
      const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
      const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
      let files: { path: string; additions: number; deletions: number; changeType: string }[] = [];
      if (headTip && baseTip) {
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
        files = diffTrees(repo.objects, baseTree, headTree).map((d: { filename: string; status: string; additions: number; deletions: number }) => ({
          path: d.filename,
          additions: d.additions,
          deletions: d.deletions,
          changeType: d.status === 'added' ? 'ADDED' : d.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
      }
      return buildConnection(field, files, args, ctx, 'PullRequestChangedFile', (f) => f as unknown as Record<string, unknown>, resolveChangedFile);
    }
    default: throw fieldError('PullRequest', field.name);
  }
}

function resolveChangedFile(
  parent: Record<string, unknown>,
  field: GqlField,
  _ctx: GqlCtx,
): unknown {
  switch (field.name) {
    case 'path': case 'additions': case 'deletions': case 'changeType':
      return parent[field.name];
    default: throw fieldError('PullRequestChangedFile', field.name);
  }
}

function resolveIntrospection(
  parent: Record<string, unknown>,
  field: GqlField,
  ctx: GqlCtx,
): unknown {
  switch (field.name) {
    case 'name': return parent.name;
    case 'kind': return parent.kind;
    case 'fields': {
      const fields = (parent.fields as string[]).map((name) => ({ name, type: { name: 'String', kind: 'SCALAR' }, description: null }));
      return fields.map((f) => selectFields(field.selections, '__Field', f as unknown as Record<string, unknown>, ctx, resolveIntrospectionField));
    }
    case 'enumValues': {
      const values = (parent.enumValues as string[]).map((name) => ({ name, description: null }));
      return values.map((v) => selectFields(field.selections, '__EnumValue', v as unknown as Record<string, unknown>, ctx, resolveIntrospectionEnum));
    }
    case 'description': return null;
    default: throw fieldError('__Type', field.name);
  }
}

function resolveIntrospectionField(
  parent: Record<string, unknown>,
  field: GqlField,
  ctx: GqlCtx,
): unknown {
  switch (field.name) {
    case 'name': return parent.name;
    case 'description': return null;
    case 'type': {
      const t = parent.type as Record<string, unknown>;
      return selectFields(field.selections, '__Type', { name: t.name, kind: t.kind, fields: [], enumValues: [] }, ctx, resolveIntrospection);
    }
    default: throw fieldError('__Field', field.name);
  }
}

function resolveIntrospectionEnum(
  parent: Record<string, unknown>,
  field: GqlField,
  _ctx: GqlCtx,
): unknown {
  if (field.name === 'name') return parent.name;
  if (field.name === 'description') return null;
  throw fieldError('__EnumValue', field.name);
}

// ------------------------------------------------------------- root resolve --

function findRepoByGid(state: State, gid: string): { repo: Repo; kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment'; number?: number; commentId?: number } | null {
  let decoded = '';
  try {
    decoded = Buffer.from(gid, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const mRepo = /^Repository:([^/]+)\/(.+)$/.exec(decoded);
  if (mRepo) {
    const repo = findRepo(state, mRepo[1], mRepo[2]);
    return repo ? { repo, kind: 'Repository' } : null;
  }
  const mIssue = /^Issue:([^/]+)\/(.+)#(\d+)$/.exec(decoded);
  if (mIssue) {
    const repo = findRepo(state, mIssue[1], mIssue[2]);
    if (!repo) return null;
    const issue = repo.issues.get(Number.parseInt(mIssue[3], 10));
    return issue ? { repo, kind: 'Issue', number: issue.number } : null;
  }
  const mPr = /^PullRequest:([^/]+)\/(.+)#(\d+)$/.exec(decoded);
  if (mPr) {
    const repo = findRepo(state, mPr[1], mPr[2]);
    if (!repo) return null;
    const pr = repo.pulls.get(Number.parseInt(mPr[3], 10));
    return pr ? { repo, kind: 'PullRequest', number: pr.number } : null;
  }
  const mComment = /^IssueComment:([^/]+)\/(.+)#(\d+)#(\d+)$/.exec(decoded);
  if (mComment) {
    const repo = findRepo(state, mComment[1], mComment[2]);
    if (!repo) return null;
    const comment = repo.comments.get(Number.parseInt(mComment[4], 10));
    return comment ? { repo, kind: 'IssueComment', number: Number.parseInt(mComment[3], 10), commentId: comment.id } : null;
  }
  return null;
}

function resolveQueryRoot(state: State, field: GqlField, ctx: GqlCtx): unknown {
  const args = argsOf(field, ctx);
  switch (field.name) {
    case 'viewer': {
      if (!state.viewerLogin) return null;
      return selectFields(field.selections, 'User', { login: state.viewerLogin }, ctx, resolveUser);
    }
    case 'repository': {
      const repo = findRepo(state, String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      return selectFields(field.selections, 'Repository', { __repo: repo } as unknown as Record<string, unknown>, ctx, (parent, f, c) => resolveRepo(state, repo, f, c));
    }
    case 'node': {
      const found = findRepoByGid(state, String(args.id ?? ''));
      if (!found) return null;
      if (found.kind === 'Repository') {
        return selectFields(field.selections, 'Repository', { __repo: found.repo } as unknown as Record<string, unknown>, ctx, (parent, f, c) => resolveRepo(state, found.repo, f, c));
      }
      if (found.kind === 'Issue') {
        const issue = found.repo.issues.get(found.number!)!;
        return selectFields(field.selections, 'Issue', issueRecord(state, found.repo, issue), ctx, resolveIssue);
      }
      if (found.kind === 'PullRequest') {
        const pr = found.repo.pulls.get(found.number!)!;
        return selectFields(field.selections, 'PullRequest', prRecord(state, found.repo, pr), ctx, resolvePullRequest);
      }
      return null;
    }
    case '__type': {
      const info = INTROSPECTION[String(args.name ?? '')];
      if (!info) return null;
      return selectFields(field.selections, '__Type', { name: String(args.name), kind: info.kind, fields: info.fields, enumValues: info.enumValues }, ctx, resolveIntrospection);
    }
    case '__schema': {
      return selectFields(field.selections, '__Schema', { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] }, ctx, (_p, f) => {
        if (f.name === 'queryType' || f.name === 'mutationType') {
          return selectFields(f.selections, '__Type', { name: (f.name === 'queryType' ? 'Query' : 'Mutation'), kind: 'OBJECT', fields: [], enumValues: [] }, ctx, resolveIntrospection);
        }
        if (f.name === 'types') return [];
        throw fieldError('__Schema', f.name);
      });
    }
    default: throw fieldError('Query', field.name);
  }
}

function resolveMutationRoot(state: State, field: GqlField, ctx: GqlCtx): unknown {
  const args = argsOf(field, ctx);
  const input = isRecord(args.input) ? args.input : {};
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (field.name) {
    case 'createIssue': {
      const found = findRepoByGid(state, String(input.repositoryId ?? ''));
      if (!found || found.kind !== 'Repository') throw new GqlError('repository not found');
      const repo = found.repo;
      const result = createIssue(state, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      if ('error' in result) throw new GqlError(result.error);
      const issue = result.issue;
      const payload: Record<string, unknown> = { clientMutationId };
      return selectFields(field.selections, 'CreateIssuePayload', payload, ctx, (parent, f, c) => {
        if (f.name === 'issue') return selectFields(f.selections, 'Issue', issueRecord(state, repo, issue), c, resolveIssue);
        if (f.name === 'clientMutationId') return clientMutationId;
        throw fieldError('CreateIssuePayload', f.name);
      });
    }
    case 'closeIssue': {
      const found = findRepoByGid(state, String(input.issueId ?? ''));
      if (!found || found.kind !== 'Issue') throw new GqlError('issue not found');
      const issue = found.repo.issues.get(found.number!)!;
      issue.state = 'closed';
      issue.updated_at = '2026-01-01T00:00:00Z';
      const payload: Record<string, unknown> = { clientMutationId };
      return selectFields(field.selections, 'CloseIssuePayload', payload, ctx, (parent, f, c) => {
        if (f.name === 'issue') return selectFields(f.selections, 'Issue', issueRecord(state, found.repo, issue), c, resolveIssue);
        if (f.name === 'clientMutationId') return clientMutationId;
        throw fieldError('CloseIssuePayload', f.name);
      });
    }
    case 'createPullRequest': {
      const found = findRepoByGid(state, String(input.repositoryId ?? ''));
      if (!found || found.kind !== 'Repository') throw new GqlError('repository not found');
      const repo = found.repo;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new GqlError('head or base branch not found');
      const pr: PullRequest = {
        id: state.nextPullId++,
        number: repo.nextPullNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        user: { login: state.viewerLogin ?? '' },
      };
      repo.pulls.set(pr.number, pr);
      const payload: Record<string, unknown> = { clientMutationId };
      return selectFields(field.selections, 'CreatePullRequestPayload', payload, ctx, (parent, f, c) => {
        if (f.name === 'pullRequest') return selectFields(f.selections, 'PullRequest', prRecord(state, repo, pr), c, resolvePullRequest);
        if (f.name === 'clientMutationId') return clientMutationId;
        throw fieldError('CreatePullRequestPayload', f.name);
      });
    }
    case 'mergePullRequest': {
      const found = findRepoByGid(state, String(input.pullRequestId ?? ''));
      if (!found || found.kind !== 'PullRequest') throw new GqlError('pull request not found');
      const pr = found.repo.pulls.get(found.number!)!;
      const result = squashMerge(state, found.repo, pr);
      if ('error' in result) throw new GqlError(result.error);
      const payload: Record<string, unknown> = { clientMutationId };
      return selectFields(field.selections, 'MergePullRequestPayload', payload, ctx, (parent, f, c) => {
        if (f.name === 'pullRequest') return selectFields(f.selections, 'PullRequest', prRecord(state, found.repo, pr), c, resolvePullRequest);
        if (f.name === 'clientMutationId') return clientMutationId;
        throw fieldError('MergePullRequestPayload', f.name);
      });
    }
    case 'addComment': {
      const found = findRepoByGid(state, String(input.subjectId ?? ''));
      if (!found || found.kind !== 'Issue') throw new GqlError('issue not found');
      const comment = createComment(state, found.repo, found.number!, String(input.body ?? ''));
      const owner = found.repo.owner ?? state.viewerLogin ?? '';
      const commentRecord: Record<string, unknown> = {
        id: commentGid(owner, found.repo.name, found.number!, comment.id),
        databaseId: comment.id,
        body: comment.body,
        author: { login: comment.user.login },
        createdAt: comment.created_at,
        updatedAt: comment.created_at,
      };
      const payload: Record<string, unknown> = { clientMutationId };
      return selectFields(field.selections, 'AddCommentPayload', payload, ctx, (parent, f, c) => {
        if (f.name === 'commentEdge') {
          return selectFields(f.selections, 'IssueCommentEdge', { node: commentRecord, cursor: encodeCursor(0) }, c, (p2, f2, c2) => {
            if (f2.name === 'node') return selectFields(f2.selections, 'IssueComment', commentRecord, c2, (p3, f3) => {
              if (f3.name === 'author') return selectFields(f3.selections, 'Actor', { login: comment.user.login }, c2, resolveUser);
              if (['id', 'databaseId', 'body', 'createdAt', 'updatedAt'].includes(f3.name)) return commentRecord[f3.name];
              throw fieldError('IssueComment', f3.name);
            });
            if (f2.name === 'cursor') return encodeCursor(0);
            throw fieldError('IssueCommentEdge', f2.name);
          });
        }
        if (f.name === 'clientMutationId') return clientMutationId;
        throw fieldError('AddCommentPayload', f.name);
      });
    }
    default: throw fieldError('Mutation', field.name);
  }
}

// -------------------------------------------------------------- entry point --

function executeOne(state: State, query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  let operation: GqlOperation;
  try {
    operation = new Parser(query).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const ctx: GqlCtx = { state, variables };
  const data: Record<string, unknown> = {};
  const errors: { message: string }[] = [];
  for (const sel of operation.selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    try {
      const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
      checkField(rootType, sel.name);
      const value = operation.type === 'mutation'
        ? resolveMutationRoot(state, sel, ctx)
        : resolveQueryRoot(state, sel, ctx);
      data[key] = value;
    } catch (err) {
      if (err instanceof GqlError) {
        errors.push({ message: err.message });
        data[key] = null;
      } else throw err;
    }
  }
  return errors.length > 0 ? { data, errors } : { data };
}

/** Handle POST /api/graphql (single operation or a batched array). */
export async function handleGraphQL(
  state: State,
  token: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!authorized(req, token)) {
    sendError(res, state, 401, 'Requires authentication');
    return true;
  }
  const bodyBuf = await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendError(res, state, 400, parsed.error);
    return true;
  }
  const body = parsed.value;
  if (Array.isArray(body)) {
    const results = body.map((op) => {
      if (!isRecord(op) || typeof op.query !== 'string') {
        return { data: null, errors: [{ message: 'invalid operation' }] };
      }
      return executeOne(state, op.query, isRecord(op.variables) ? (op.variables as Record<string, unknown>) : {});
    });
    sendJson(res, state, 200, results);
    return true;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendError(res, state, 400, 'query is required');
    return true;
  }
  const result = executeOne(state, body.query, isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {});
  sendJson(res, state, 200, result);
  return true;
}
