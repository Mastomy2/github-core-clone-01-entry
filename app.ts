// app.ts — the forge's HTTP server: one process, one in-memory store, four
// surfaces. The entry <-> env lifecycle lives in main.ts (kept from the kit
// starter); this file is the server the suite scores.
//
// Routing:
//   GET  /healthz                     the env's boot probe: 200 {"ok": true}
//   /api/v3/...                       REST v3 (rest.ts)
//   POST /api/graphql                 GraphQL v4 (graphql.ts)
//   POST /mcp                         MCP, JSON-RPC 2.0 (mcp.ts)
//   /{owner}/{repo}.git/...           git smart HTTP (git-http.ts)
//   anything else                     JSON 404
//
// Auth: the suite presents Authorization: Bearer $MAKEFUN_SHOP_TOKEN on
// every API call. The same value reaches this process as the
// MAKEFUN_SHOP_TOKEN environment variable; when it is unset (local runs
// without a token) the guard passes everything through.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { newState } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git-http.ts';
import { sendJson } from './http.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const state = newState();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = urlOf(req);
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const segments = segmentsOf(path);
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, state, 200, { ok: true });
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          await handleGraphQL(state, TOKEN || null, req, res);
          return;
        }

        // MCP.
        if (method === 'POST' && path === '/mcp') {
          await handleMcp(state, TOKEN || null, req, res);
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const handled = await handleRest({ state, token: TOKEN || null, baseUrl, req, res, url, segments });
          if (handled) return;
        }

        // Git smart HTTP.
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const handled = await handleGit(state, req, res, segments, url);
          if (handled) return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, state, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one request kill the process: answer 500 and keep going.
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          }
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    })();
  });
}
