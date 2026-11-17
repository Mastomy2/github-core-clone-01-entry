// git-http.ts — the git smart-HTTP surface: info/refs advertisements
// (protocol v2 for upload-pack, v0 for receive-pack), the v2 ls-refs and
// fetch commands, the v0 fetch, and the v0 receive-pack (push) with a
// sideband report-status answer.
//
// Capability advertisement (v2 upload-pack):
//   version 2, agent, ls-refs=unborn, fetch=shallow, object-format=sha1
// The ls-refs value is exactly `unborn`: the suite's client gates its
// `unborn` argument on `.split(' ').includes('unborn')` of that value, and
// it sends `peel` and `symrefs` unconditionally.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { State } from './store.ts';
import { findRepo, addPackObjects, applyRefUpdate, planFetch, allRefs, headTarget } from './store.ts';
import {
  ZERO, pktLine, pktFlush, pktDelim, decodePktLines, sectionsOf,
  writePack,
} from './git.ts';
import { readBody } from './http.ts';

const AGENT = 'forge/1.0';

// ------------------------------------------------------------------ helpers --

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-cache' });
  res.end(body);
}

/** Frame a payload into sideband band-1 packets. A pkt-line is at most
 * 65520 bytes including its 4 length bytes, so a banded packet (1 band byte
 * + data) is capped at 65516 bytes. */
function sideband(packets: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const payload of packets) {
    let off = 0;
    while (off < payload.length) {
      const chunk = payload.subarray(off, off + 65515);
      const banded = Buffer.concat([Buffer.from([1]), chunk]);
      parts.push(pktLine(banded));
      off += chunk.length;
    }
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------- advertise --

function v2Advertisement(repo: ReturnType<typeof findRepo>): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function v0Advertisement(
  service: 'git-upload-pack' | 'git-receive-pack',
  repo: NonNullable<ReturnType<typeof findRepo>>,
): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed agent=${AGENT} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = allRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    const head = headTarget(repo);
    // The HEAD line carries the capabilities; every ref — including the
    // default branch HEAD points at — is then listed on its own line.
    const first = head
      ? `${head.oid} HEAD\0${caps}\n`
      : `${refs[0].oid} ${refs[0].name}\0${caps}\n`;
    parts.push(pktLine(first));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs ---

interface LsRefsOpts {
  peel: boolean;
  unborn: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: NonNullable<ReturnType<typeof findRepo>>, opts: LsRefsOpts): Buffer {
  const parts: Buffer[] = [];
  const refs = allRefs(repo);
  const head = headTarget(repo);
  const include = (name: string) => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (opts.prefixes.length === 0) {
    if (head) {
      let line = `${head.oid} HEAD`;
      if (opts.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pktLine(`${line}\n`));
    } else if (opts.unborn) {
      let line = `unborn HEAD`;
      if (opts.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  for (const r of refs) {
    if (!include(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (opts.peel && r.peeled) line += ` peeled:${r.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------- fetch --

interface FetchOpts {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  thinPack: boolean;
}

/** Build the v2 fetch response sections for a plan. */
function fetchResponse(plan: ReturnType<typeof planFetch>, wants: string[], repo: NonNullable<ReturnType<typeof findRepo>>): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    if (plan.ready) parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  // wanted-refs
  const wantedRefs = allRefs(repo).filter((r) => wants.includes(r.oid) || wants.includes(r.peeled ?? ''));
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const r of wantedRefs) parts.push(pktLine(`${r.oid} ${r.name}\n`));
    parts.push(pktDelim());
  }
  // packfile — only when there are objects: the client throws when a
  // packfile section header carries no sideband packets.
  if (plan.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(plan.objects);
    parts.push(sideband([pack]));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Build the v0 fetch response: NAK/ACK + shallow lines, then sideband pack. */
function fetchResponseV0(plan: ReturnType<typeof planFetch>): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(sideband([pack]));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ router --

/** Handle a git smart-HTTP request. Returns true when matched. */
export async function handleGit(
  state: State,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<boolean> {
  // Path: /{owner}/{repo}.git/info/refs or /{owner}/{repo}.git/git-<service>
  if (segments.length < 2) return false;
  const repoSeg = segments[1];
  if (!repoSeg.endsWith('.git')) return false;
  const owner = segments[0];
  const repoName = repoSeg.slice(0, -4);
  const repo = findRepo(state, owner, repoName);
  const method = req.method ?? 'GET';
  const tail = segments.slice(2);

  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    if (!repo) {
      sendGit(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
      return true;
    }
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      if (v2) sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement(repo));
      else sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement('git-upload-pack', repo));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendGit(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo));
      return true;
    }
    sendGit(res, 400, 'application/json', Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8'));
    return true;
  }

  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (!repo) {
      sendGit(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
      return true;
    }
    const body = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    if (v2) {
      const sections = sectionsOf(body);
      const first = sections[0] ?? [];
      const commandLine = first[0] ?? '';
      const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).trim() : '';
      if (command === 'ls-refs') {
        // The request is two sections: the command section, a delim, then
        // the arguments (peel, symrefs, unborn, ref-prefix ...).
        const args = sections.length > 1 ? sections[1] : first.slice(1);
        const opts: LsRefsOpts = { peel: false, unborn: false, symrefs: false, prefixes: [] };
        for (const arg of args) {
          const a = arg.trim();
          if (a === 'peel') opts.peel = true;
          else if (a === 'unborn') opts.unborn = true;
          else if (a === 'symrefs') opts.symrefs = true;
          else if (a.startsWith('ref-prefix ')) opts.prefixes.push(a.slice('ref-prefix '.length));
        }
        sendGit(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, opts));
        return true;
      }
      if (command === 'fetch') {
        const args = sections.length > 1 ? sections[1] : first.slice(1);
        const opts: FetchOpts = { wants: [], haves: [], shallow: [], deepen: null, thinPack: false };
        for (const arg of args) {
          const a = arg.trim();
          if (a.startsWith('want ')) opts.wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) opts.haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) opts.shallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) opts.deepen = Number.parseInt(a.slice(7).trim(), 10) || null;
          else if (a === 'thin-pack') opts.thinPack = true;
        }
        const plan = planFetch(repo, opts.wants, opts.haves, opts.shallow, opts.deepen);
        sendGit(res, 200, 'application/x-git-upload-pack-result', fetchResponse(plan, opts.wants, repo));
        return true;
      }
      sendGit(res, 400, 'application/json', Buffer.from(JSON.stringify({ message: 'unknown command' }), 'utf8'));
      return true;
    }
    // v0 fetch: two sections (wants + shallow/deepen, then haves + done)
    const sections = sectionsOf(body);
    const opts: FetchOpts = { wants: [], haves: [], shallow: [], deepen: null, thinPack: false };
    for (const sec of sections) {
      for (const arg of sec) {
        const a = arg.trim();
        if (a.startsWith('want ')) opts.wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) opts.haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) opts.shallow.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) opts.deepen = Number.parseInt(a.slice(7).trim(), 10) || null;
      }
    }
    const plan = planFetch(repo, opts.wants, opts.haves, opts.shallow, opts.deepen);
    sendGit(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(plan));
    return true;
  }

  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    if (!repo) {
      sendGit(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
      return true;
    }
    const body = await readBody(req);
    const result = handleReceivePack(repo, body);
    sendGit(res, 200, 'application/x-git-receive-pack-result', result);
    return true;
  }

  return false;
}

// ------------------------------------------------------------ receive-pack --

/**
 * Parse a receive-pack request body: a command list of pkt-lines until a
 * flush, then the raw pack. Unpack the pack first (objects are kept even for
 * refused refs), apply each ref update, and answer with a sideband
 * report-status stream.
 */
function handleReceivePack(repo: NonNullable<ReturnType<typeof findRepo>>, body: Buffer): Buffer {
  // The command list is pkt-lines up to the first flush; the pack is the
  // raw bytes after it. Decode only the command portion — the pack is
  // binary and must never be fed to the pkt-line decoder.
  const packOffset = offsetAfterFirstFlush(body);
  const { chunks } = decodePktLines(body.subarray(0, packOffset));
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const c of chunks) {
    if (c.kind === 'flush') break;
    if (c.kind !== 'data') continue;
    const line = c.text;
    const nul = line.indexOf('\0');
    const text = nul === -1 ? line : line.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text.trim());
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3].trim() });
  }
  const pack = body.subarray(packOffset);
  let unpackOk = true;
  let unpackDetail = '';
  if (commands.length > 0 && pack.length > 0) {
    try {
      addPackObjects(repo, pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const lines: string[] = [];
  if (unpackOk) lines.push('unpack ok\n');
  else lines.push(`unpack ${unpackDetail}\n`);
  for (const cmd of commands) {
    if (!unpackOk) {
      lines.push(`ng ${cmd.ref} unpack failed\n`);
      continue;
    }
    const result = applyRefUpdate(repo, cmd.ref, cmd.oldOid, cmd.newOid);
    if (result.ok) lines.push(`ok ${cmd.ref}\n`);
    else lines.push(`ng ${cmd.ref} ${result.reason ?? 'failed'}\n`);
  }
  // report-status is framed as pkt-lines inside sideband band 1.
  const framed = Buffer.concat(lines.map((l) => pktLine(l)));
  return Buffer.concat([sideband([framed]), pktFlush()]);
}

/** Byte offset just past the first flush packet in a pkt-line stream. */
function offsetAfterFirstFlush(body: Buffer): number {
  let off = 0;
  while (off + 4 <= body.length) {
    const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len === 0) return off + 4;
    if (len === 1) {
      off += 4;
      continue;
    }
    off += len;
  }
  return off;
}
