// mcp.ts — the Model Context Protocol surface: POST /mcp, JSON-RPC 2.0 over
// Streamable HTTP, answered with plain JSON (no SSE). The tools work on the
// same store as REST and GraphQL, so a repo created through MCP is visible
// to every other surface and vice versa.
//
// Methods: server/discover (modern), initialize (legacy fallback),
// notifications/initialized (no-op), tools/list (a constant, byte-identical
// across calls), tools/call. Unknown methods and tools are JSON-RPC errors,
// never HTTP 500s. A body that is not JSON is HTTP 400 with -32700.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { State, PullRequest } from './store.ts';
import { findRepo, createRepo, createIssue, squashMerge } from './store.ts';
import { readBody, sendJson, sendError, authorized, isRecord } from './http.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
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
      },
      required: ['owner', 'repo'],
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
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
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
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch containing the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
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
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcError(res: ServerResponse, state: State, id: unknown, code: number, message: string): void {
  sendJson(res, state, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function rpcResult(res: ServerResponse, state: State, id: unknown, result: unknown): void {
  sendJson(res, state, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function toolResult(payload: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown } {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Execute one tool call. Throws a JsonRpcError ({code, message}) on failure. */
function callTool(state: State, name: string, args: Record<string, unknown>): unknown {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (repoName === '') throw { code: -32602, message: 'create_repo requires "name"' };
      const repo = createRepo(state, repoName, str('description'), args.private === true);
      if (!repo) throw { code: -32602, message: `repository "${repoName}" already exists` };
      const owner = repo.owner ?? state.viewerLogin ?? '';
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${owner}/${repo.name}`,
        owner: { login: owner },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = findRepo(state, str('owner'), str('repo'));
      if (!repo) throw { code: -32602, message: 'repository not found' };
      const owner = repo.owner ?? state.viewerLogin ?? '';
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${owner}/${repo.name}`,
        owner: { login: owner },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = findRepo(state, str('owner'), str('repo'));
      if (!repo) throw { code: -32602, message: 'repository not found' };
      const title = str('title');
      if (title === '') throw { code: -32602, message: 'create_issue requires "title"' };
      const result = createIssue(state, repo, title, str('body'));
      if ('error' in result) throw { code: -32602, message: result.error };
      const issue = result.issue;
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        user: { login: issue.user.login },
      });
    }
    case 'list_issues': {
      const repo = findRepo(state, str('owner'), str('repo'));
      if (!repo) throw { code: -32602, message: 'repository not found' };
      const stateFilter = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (stateFilter !== 'all') issues = issues.filter((i) => i.state === stateFilter);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
        user: { login: i.user.login },
      })));
    }
    case 'create_pull_request': {
      const repo = findRepo(state, str('owner'), str('repo'));
      if (!repo) throw { code: -32602, message: 'repository not found' };
      const head = str('head');
      const base = str('base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw { code: -32602, message: 'head or base branch not found' };
      const pr: PullRequest = {
        id: state.nextPullId++,
        number: repo.nextPullNumber++,
        title: str('title'),
        body: str('body'),
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
      return toolResult({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        merged: pr.merged,
        head: { ref: pr.head.ref, sha: pr.head.sha },
        base: { ref: pr.base.ref, sha: pr.base.sha },
      });
    }
    case 'merge_pull_request': {
      const repo = findRepo(state, str('owner'), str('repo'));
      if (!repo) throw { code: -32602, message: 'repository not found' };
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(str('pull_number'), 10);
      const pr = repo.pulls.get(num);
      if (!pr) throw { code: -32602, message: 'pull request not found' };
      if (pr.state !== 'open') throw { code: -32602, message: 'pull request is not open' };
      const result = squashMerge(state, repo, pr);
      if ('error' in result) throw { code: -32602, message: result.error };
      return toolResult({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        merged: pr.merged,
        merge_commit_sha: pr.merge_commit_sha,
        head: { ref: pr.head.ref, sha: pr.head.sha },
        base: { ref: pr.base.ref, sha: pr.base.sha },
      });
    }
    default:
      throw { code: -32601, message: `unknown tool "${name}"` };
  }
}

/** Handle POST /mcp. */
export async function handleMcp(
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
  let body: unknown;
  try {
    body = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    sendJson(res, state, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, state, 400, {
      jsonrpc: '2.0',
      id: isRecord(body) ? body.id ?? null : null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    return true;
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': `req-${++state.requestSeq}` });
    res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      rpcResult(res, state, id, {
        supportedVersions: [PROTOCOL_VERSION, '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      rpcResult(res, state, id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'tools/list': {
      rpcResult(res, state, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = callTool(state, name, args);
        rpcResult(res, state, id, result);
      } catch (err) {
        if (isRecord(err) && typeof err.code === 'number') {
          rpcError(res, state, id, err.code, typeof err.message === 'string' ? err.message : 'tool error');
        } else {
          rpcError(res, state, id, -32603, err instanceof Error ? err.message : 'internal error');
        }
      }
      return true;
    }
    default:
      rpcError(res, state, id, -32601, `method not found: ${method}`);
      return true;
  }
}
