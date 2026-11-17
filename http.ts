// http.ts — small shared helpers for the forge's HTTP surface: body reading,
// JSON replies (always application/json with a deterministic request id),
// pagination with a Link header, and the bearer-token guard.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { State } from './store.ts';

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function requestId(state: State): string {
  state.requestSeq += 1;
  return `req-${state.requestSeq}`;
}

export function sendJson(
  res: ServerResponse,
  state: State,
  status: number,
  obj: unknown,
  extra: Record<string, string> = {},
): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(state),
    ...extra,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, state: State, status: number, message: string): void {
  sendJson(res, state, status, { message, documentation_url: '' });
}

export function parseJsonBody(
  body: Buffer,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, error: 'Problems parsing JSON' };
  }
}

export interface PageParams {
  page: number;
  perPage: number;
}

/** Parse ?page=&per_page= (GitHub defaults: page 1, per_page 30). */
export function pageParams(url: URL): PageParams {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

export function paginate<T>(items: T[], p: PageParams): { slice: T[]; link: string | null } {
  const total = items.length;
  const start = (p.page - 1) * p.perPage;
  const slice = items.slice(start, start + p.perPage);
  // The Link header needs the base path; callers build it from the URL.
  const lastPage = Math.max(1, Math.ceil(total / p.perPage));
  return { slice, link: lastPage > 1 ? String(lastPage) : null };
}

/** Build a GitHub-style Link header for a paginated collection. */
export function linkHeader(base: string, p: PageParams, lastPage: number | null): string | null {
  if (lastPage === null || lastPage <= 1) return null;
  const urlFor = (page: number) => {
    const u = new URL(base);
    u.searchParams.set('page', String(page));
    u.searchParams.set('per_page', String(p.perPage));
    return `<${u.toString()}>`;
  };
  const parts: string[] = [];
  if (p.page < lastPage) {
    parts.push(`${urlFor(p.page + 1)}; rel="next"`);
    parts.push(`${urlFor(lastPage)}; rel="last"`);
  }
  if (p.page > 1) {
    parts.push(`${urlFor(1)}; rel="first"`);
    parts.push(`${urlFor(p.page - 1)}; rel="prev"`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Check the bearer token. When no token is configured, everything passes. */
export function authorized(req: IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
