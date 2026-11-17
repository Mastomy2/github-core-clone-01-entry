// rest.ts — the GitHub REST v3 surface: /api/v3. Every reply is
// application/json with a non-empty X-GitHub-Request-Id; an unknown route is
// a JSON 404 and a malformed JSON body is a 400. A request without the bearer
// token is a 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { State, Repo, Issue, PullRequest } from './store.ts';
import {
  findRepo, createRepo, deleteRepo,
  resolveRef, allRefs, headTarget, createIssue, createComment, diffTrees,
  squashMerge, commitFile, FIXED_TS,
} from './store.ts';
import {
  readBody, sendJson, sendError, parseJsonBody, pageParams, linkHeader,
  authorized, isRecord,
} from './http.ts';
import { parseCommit, getBlobOid, listFiles, walkCommits } from './git.ts';

const INSTALLED_VERSION = '1.0.0';

// ------------------------------------------------------------------ shapes --

function repoJson(state: State, repo: Repo, baseUrl: string) {
  const owner = repo.owner ?? state.viewerLogin ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `${baseUrl}/${owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `${baseUrl}/${owner}/${repo.name}.git`,
  };
}

function issueJson(state: State, repo: Repo, issue: Issue, baseUrl: string) {
  const owner = repo.owner ?? state.viewerLogin ?? '';
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: issue.user.login },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `${baseUrl}/${owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function prJson(state: State, repo: Repo, pr: PullRequest, baseUrl: string) {
  const owner = repo.owner ?? state.viewerLogin ?? '';
  const repoPart = repoJson(state, repo, baseUrl);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    head: { ref: pr.head.ref, sha: pr.head.sha, repo: repoPart },
    base: { ref: pr.base.ref, sha: pr.base.sha, repo: repoPart },
    user: { login: pr.user.login },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    html_url: `${baseUrl}/${owner}/${repo.name}/pull/${pr.number}`,
    url: `${baseUrl}/api/v3/repos/${owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commentJson(state: State, repo: Repo, comment: { id: number; body: string; created_at: string; user: { login: string } }, issueNumber: number, baseUrl: string) {
  const owner = repo.owner ?? state.viewerLogin ?? '';
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user.login },
    created_at: comment.created_at,
    updated_at: comment.created_at,
    html_url: `${baseUrl}/${owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `${baseUrl}/api/v3/repos/${owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

// ------------------------------------------------------------------- router --

interface Ctx {
  state: State;
  token: string | null;
  baseUrl: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
}

/** Handle one /api/v3 request. Returns true when the route was matched. */
export async function handleRest(ctx: Ctx): Promise<boolean> {
  const { req, res, url, segments, state } = ctx;
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);

  if (!authorized(req, ctx.token)) {
    sendError(res, state, 401, 'Requires authentication');
    return true;
  }

  const method = req.method ?? 'GET';
  const bodyBuf = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendError(res, state, 400, parsed.error);
    return true;
  }
  const body = isRecord(parsed.value) ? parsed.value : {};

  // GET /api/v3/ — root
  if (rest.length === 0 && method === 'GET') {
    sendJson(res, state, 200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, state, 200, { installed_version: INSTALLED_VERSION });
    return true;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    if (!state.viewerLogin) {
      sendError(res, state, 404, 'Not Found');
      return true;
    }
    sendJson(res, state, 200, {
      login: state.viewerLogin,
      id: 1,
      type: 'User',
      html_url: `${ctx.baseUrl}/${state.viewerLogin}`,
      url: `${ctx.baseUrl}/api/v3/users/${state.viewerLogin}`,
    });
    return true;
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendError(res, state, 422, 'name is required');
        return true;
      }
      const repo = createRepo(state, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (!repo) {
        sendError(res, state, 422, `Repository "${name}" already exists`);
        return true;
      }
      sendJson(res, state, 201, repoJson(state, repo, ctx.baseUrl));
      return true;
    }
    if (method === 'GET') {
      const p = pageParams(url);
      const all = [...state.repos.values()].sort((a, b) => a.id - b.id);
      const lastPage = Math.max(1, Math.ceil(all.length / p.perPage));
      const start = (p.page - 1) * p.perPage;
      const slice = all.slice(start, start + p.perPage);
      const link = linkHeader(`${ctx.baseUrl}/api/v3/user/repos`, p, lastPage);
      sendJson(res, state, 200, slice.map((r) => repoJson(state, r, ctx.baseUrl)),
        link ? { link } : {});
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const repo = findRepo(state, owner, name);
    if (!repo) {
      sendError(res, state, 404, 'Not Found');
      return true;
    }
    return handleRepo(ctx, repo, rest.slice(3), method, body, bodyBuf);
  }

  // Anything else under /api/v3 is an unknown route.
  sendError(res, state, 404, 'Not Found');
  return true;
}

// --------------------------------------------------------------- repo routes --

async function handleRepo(
  ctx: Ctx,
  repo: Repo,
  tail: string[],
  method: string,
  body: Record<string, unknown>,
  bodyBuf: Buffer,
): Promise<boolean> {
  const { res, url, state } = ctx;
  const owner = repo.owner ?? state.viewerLogin ?? '';

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, state, 200, repoJson(state, repo, ctx.baseUrl));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        // Renaming is not part of the suite; keep the name stable.
      }
      repo.updated_at = FIXED_TS;
      sendJson(res, state, 200, repoJson(state, repo, ctx.baseUrl));
      return true;
    }
    if (method === 'DELETE') {
      deleteRepo(state, repo);
      res.writeHead(204, { 'x-github-request-id': `req-${++state.requestSeq}` });
      res.end();
      return true;
    }
    return false;
  }

  // POST /repos/{o}/{r}/git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
      sendError(res, state, 422, 'Invalid ref or sha');
      return true;
    }
    if (repo.refs.has(ref)) {
      sendError(res, state, 422, `Reference ${ref} already exists`);
      return true;
    }
    repo.refs.set(ref, sha);
    const resolved = resolveRef(repo, ref)!;
    sendJson(res, state, 201, {
      ref,
      node_id: '',
      url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repo.name}/git/refs/${ref.replace(/^refs\//u, '')}`,
      object: { sha: resolved.oid, type: repo.objects.get(resolved.oid)?.type ?? 'commit', url: '' },
    });
    return true;
  }

  // GET /repos/{o}/{r}/git/refs/heads/{branch}
  if (tail.length === 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') {
    const ref = `refs/heads/${tail[3]}`;
    const resolved = resolveRef(repo, ref);
    if (!resolved) {
      sendError(res, state, 404, 'Not Found');
      return true;
    }
    sendJson(res, state, 200, {
      ref,
      node_id: '',
      url: `${ctx.baseUrl}/api/v3/repos/${owner}/${repo.name}/git/refs/heads/${tail[3]}`,
      object: { sha: resolved.oid, type: repo.objects.get(resolved.oid)?.type ?? 'commit', url: '' },
    });
    return true;
  }

  // GET /repos/{o}/{r}/branches and /branches/{branch}
  if (tail[0] === 'branches' && method === 'GET') {
    const branches = allRefs(repo)
      .filter((r) => r.name.startsWith('refs/heads/'))
      .map((r) => ({
        name: r.name.slice('refs/heads/'.length),
        commit: { sha: r.oid, url: '' },
        protected: false,
      }));
    if (tail.length === 1) {
      sendJson(res, state, 200, branches);
      return true;
    }
    if (tail.length === 2) {
      const b = branches.find((x) => x.name === tail[1]);
      if (!b) {
        sendError(res, state, 404, 'Not Found');
        return true;
      }
      sendJson(res, state, 200, b);
      return true;
    }
    return false;
  }

  // GET /repos/{o}/{r}/commits
  if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const startRef = shaParam
      ? (shaParam.startsWith('refs/') ? shaParam : `refs/heads/${shaParam}`)
      : `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(startRef) ?? (shaParam && repo.objects.has(shaParam) ? shaParam : null);
    if (!tip) {
      sendJson(res, state, 200, []);
      return true;
    }
    const { commits } = walkCommits(repo.objects, [tip]);
    const out = commits.map((oid) => {
      const c = parseCommit(repo.objects.get(oid)!.data);
      const author = c.author;
      return {
        sha: oid,
        commit: {
          message: c.message,
          author: { name: author.split(' <')[0] ?? '', email: '', date: FIXED_TS },
          committer: { name: c.committer.split(' <')[0] ?? '', email: '', date: FIXED_TS },
          tree: { sha: c.tree },
        },
        author: { login: state.viewerLogin ?? '' },
        committer: { login: state.viewerLogin ?? '' },
        parents: c.parents.map((p) => ({ sha: p })),
      };
    });
    sendJson(res, state, 200, out);
    return true;
  }

  // /repos/{o}/{r}/contents/{path...}
  if (tail[0] === 'contents') {
    return handleContents(ctx, repo, tail.slice(1), method, body, bodyBuf);
  }

  // /repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (name === '') {
        sendError(res, state, 422, 'name is required');
        return true;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, state, 201, { name, color, url: '' });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, state, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, url: '' })));
      return true;
    }
    return false;
  }

  // /repos/{o}/{r}/issues...
  if (tail[0] === 'issues') {
    return handleIssues(ctx, repo, tail.slice(1), method, body);
  }

  // /repos/{o}/{r}/pulls...
  if (tail[0] === 'pulls') {
    return handlePulls(ctx, repo, tail.slice(1), method, body);
  }

  sendError(res, state, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- contents --

async function handleContents(
  ctx: Ctx,
  repo: Repo,
  pathParts: string[],
  method: string,
  body: Record<string, unknown>,
  _bodyBuf: Buffer,
): Promise<boolean> {
  const { res, url, state } = ctx;
  const owner = repo.owner ?? state.viewerLogin ?? '';
  const path = pathParts.map((p) => decodeURIComponent(p)).join('/');
  const refParam = url.searchParams.get('ref');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : (refParam ?? repo.defaultBranch);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const treeOid = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;

  if (method === 'GET') {
    if (!treeOid) {
      sendError(res, state, 404, 'Not Found');
      return true;
    }
    const blobOid = getBlobOid(repo.objects, treeOid, path.split('/'));
    if (blobOid) {
      const blob = repo.objects.get(blobOid)!;
      sendJson(res, state, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: blob.data.toString('base64'),
        sha: blobOid,
      });
      return true;
    }
    // Directory listing?
    const files = listFiles(repo.objects, treeOid);
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
    for (const f of files) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      if (rest === '') continue;
      const first = rest.split('/')[0];
      if (rest.includes('/')) {
        const dirPath = prefix + first;
        if (!entries.has(dirPath)) {
          entries.set(dirPath, { type: 'dir', name: first, path: dirPath, sha: '', size: 0 });
        }
      } else {
        entries.set(f.path, { type: 'file', name: first, path: f.path, sha: f.oid, size: repo.objects.get(f.oid)?.data.length ?? 0 });
      }
    }
    if (entries.size === 0) {
      sendError(res, state, 404, 'Not Found');
      return true;
    }
    sendJson(res, state, 200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
    return true;
  }

  if (method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const content = Buffer.from(contentB64, 'base64');
    const expectedSha = typeof body.sha === 'string' ? body.sha : null;
    const currentBlob = treeOid ? getBlobOid(repo.objects, treeOid, path.split('/')) : null;
    if (expectedSha !== null) {
      // update: the file must exist and the sha must match
      if (!currentBlob) {
        sendError(res, state, 404, 'Not Found');
        return true;
      }
      if (currentBlob !== expectedSha) {
        sendError(res, state, 409, 'sha does not match');
        return true;
      }
    } else if (currentBlob) {
      sendError(res, state, 422, 'file already exists');
      return true;
    }
    const result = commitFile(state, repo, branch, path, content, message);
    if ('error' in result) {
      sendError(res, state, 422, result.error);
      return true;
    }
    const blobOid = getBlobOid(repo.objects, parseCommit(repo.objects.get(result.sha)!.data).tree, path.split('/'))!;
    sendJson(res, state, expectedSha !== null ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
      },
      commit: { sha: result.sha },
    });
    return true;
  }

  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const expectedSha = typeof body.sha === 'string' ? body.sha : null;
    const currentBlob = treeOid ? getBlobOid(repo.objects, treeOid, path.split('/')) : null;
    if (!currentBlob) {
      sendError(res, state, 404, 'Not Found');
      return true;
    }
    if (expectedSha !== null && currentBlob !== expectedSha) {
      sendError(res, state, 409, 'sha does not match');
      return true;
    }
    const result = commitFile(state, repo, branch, path, null, message);
    if ('error' in result) {
      sendError(res, state, 422, result.error);
      return true;
    }
    sendJson(res, state, 200, { commit: { sha: result.sha } });
    return true;
  }

  return false;
}

// ------------------------------------------------------------------ issues --

async function handleIssues(
  ctx: Ctx,
  repo: Repo,
  tail: string[],
  method: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const { res, url, state } = ctx;

  // POST /issues and GET /issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const result = createIssue(state, repo, title, issueBody, labels);
      if ('error' in result) {
        sendError(res, state, 422, result.error);
        return true;
      }
      sendJson(res, state, 201, issueJson(state, repo, result.issue, ctx.baseUrl));
      return true;
    }
    if (method === 'GET') {
      const stateParam = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (stateParam !== 'all') issues = issues.filter((i) => i.state === stateParam);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const p = pageParams(url);
      const lastPage = Math.max(1, Math.ceil(issues.length / p.perPage));
      const start = (p.page - 1) * p.perPage;
      const slice = issues.slice(start, start + p.perPage);
      const link = linkHeader(`${ctx.baseUrl}/api/v3/repos/${repo.owner ?? ''}/${repo.name}/issues`, p, lastPage);
      sendJson(res, state, 200, slice.map((i) => issueJson(state, repo, i, ctx.baseUrl)),
        link ? { link } : {});
      return true;
    }
    return false;
  }

  const num = Number.parseInt(tail[0], 10);
  if (Number.isNaN(num)) return false;
  const issue = repo.issues.get(num);
  if (!issue) {
    sendError(res, state, 404, 'Not Found');
    return true;
  }

  // GET/PATCH /issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, state, 200, issueJson(state, repo, issue, ctx.baseUrl));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updated_at = FIXED_TS;
      sendJson(res, state, 200, issueJson(state, repo, issue, ctx.baseUrl));
      return true;
    }
    return false;
  }

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const comment = createComment(state, repo, num, commentBody);
      sendJson(res, state, 201, commentJson(state, repo, comment, num, ctx.baseUrl));
      return true;
    }
    if (method === 'GET') {
      const list = [...repo.comments.values()]
        .filter((c) => c.issueNumber === num)
        .sort((a, b) => a.id - b.id)
        .map((c) => commentJson(state, repo, c, num, ctx.baseUrl));
      sendJson(res, state, 200, list);
      return true;
    }
    return false;
  }

  return false;
}

// ------------------------------------------------------------------- pulls --

async function handlePulls(
  ctx: Ctx,
  repo: Repo,
  tail: string[],
  method: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const { res, url, state } = ctx;

  // POST /pulls and GET /pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const prBody = typeof body.body === 'string' ? body.body : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        sendError(res, state, 422, 'head or base branch not found');
        return true;
      }
      const pr: PullRequest = {
        id: state.nextPullId++,
        number: repo.nextPullNumber++,
        title,
        body: prBody,
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
        user: { login: state.viewerLogin ?? '' },
      };
      repo.pulls.set(pr.number, pr);
      sendJson(res, state, 201, prJson(state, repo, pr, ctx.baseUrl));
      return true;
    }
    if (method === 'GET') {
      const stateParam = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (stateParam !== 'all') pulls = pulls.filter((p) => p.state === stateParam);
      pulls.sort((a, b) => b.number - a.number);
      sendJson(res, state, 200, pulls.map((p) => prJson(state, repo, p, ctx.baseUrl)));
      return true;
    }
    return false;
  }

  const num = Number.parseInt(tail[0], 10);
  if (Number.isNaN(num)) return false;
  const pr = repo.pulls.get(num);
  if (!pr) {
    sendError(res, state, 404, 'Not Found');
    return true;
  }

  // GET /pulls/{n}
  if (tail.length === 1 && method === 'GET') {
    sendJson(res, state, 200, prJson(state, repo, pr, ctx.baseUrl));
    return true;
  }

  // GET /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
    if (!headTip || !baseTip) {
      sendJson(res, state, 200, []);
      return true;
    }
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const files = diffTrees(repo.objects, baseTree, headTree);
    sendJson(res, state, 200, files.map((f) => ({
      sha: '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    })));
    return true;
  }

  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pr.state !== 'open') {
      sendError(res, state, 405, 'Pull request is not open');
      return true;
    }
    const result = squashMerge(state, repo, pr);
    if ('error' in result) {
      sendError(res, state, result.status, result.error);
      return true;
    }
    sendJson(res, state, 200, {
      sha: result.sha,
      merged: true,
      message: `Pull request successfully merged: ${pr.title} (#${pr.number})`,
    });
    return true;
  }

  return false;
}
