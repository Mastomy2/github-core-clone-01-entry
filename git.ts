// git.ts — pure git plumbing: object model, pkt-line framing, pack v2 (plain
// objects only; the suite's client never emits deltas), reachability and
// shallow/deepen fetch computation. No I/O, no network: every function here
// works on buffers and plain maps so the store and the HTTP handlers can
// reuse it.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO = '0000000000000000000000000000000000000000';
export const FIXED_EPOCH = 1767225600; // 2026-01-01T00:00:00Z — deterministic timestamps
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export type ObjectMap = Map<string, GitObject>;

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(objects: ObjectMap, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- pkt-line --

/** Encode one data line: 4 hex digits of (length + 4), then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Decode a pkt-line stream into a list of {kind: 'data'|'flush'|'delim', text}. */
export interface PktChunk {
  kind: 'data' | 'flush' | 'delim';
  text: string;
  raw: Buffer;
}

export function decodePktLines(buf: Buffer, start = 0): { chunks: PktChunk[]; offset: number } {
  const chunks: PktChunk[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      chunks.push({ kind: 'flush', text: '', raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len === 1) {
      chunks.push({ kind: 'delim', text: '', raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    const raw = buf.subarray(off, off + len);
    chunks.push({ kind: 'data', text: raw.subarray(4).toString('utf8'), raw });
    off += len;
  }
  return { chunks, offset: off };
}

/** Split a pkt-line stream into sections delimited by delim/flush markers. */
export function sectionsOf(buf: Buffer): string[][] {
  const { chunks } = decodePktLines(buf);
  const sections: string[][] = [];
  let cur: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'data') cur.push(c.text);
    else {
      sections.push(cur);
      cur = [];
      if (c.kind === 'flush') break;
    }
  }
  if (cur.length > 0) sections.push(cur);
  return sections;
}

/** Parse a capability list after a NUL byte into a Map<name, value>. */
export function parseCapabilities(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.trim().split(/\s+/u)) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) out.set(part, '');
    else out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

// ---------------------------------------------------------------- objects --

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[]; // other header lines (gpgsig etc.), kept verbatim
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line !== '') extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

export function buildCommit(c: CommitData): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  for (const e of c.extra) lines.push(e);
  return Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
}

export function formatIdent(name: string, email: string, ts = FIXED_EPOCH): string {
  return `${name} <${email}> ${ts} +0000`;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ----------------------------------------------------------- reachability --

/**
 * Walk commit ancestry from `roots`, collecting every reachable commit oid
 * (and, when `collectObjects` is set, the closure of objects reachable from
 * them: trees and blobs). `stopAt` commits are included but their parents
 * are not followed (used for shallow boundaries).
 */
export function walkCommits(
  objects: ObjectMap,
  roots: string[],
  opts: { stopAt?: Set<string>; maxDepth?: number } = {},
): { commits: string[]; depth: Map<string, number> } {
  const commits: string[] = [];
  const depth = new Map<string, number>();
  const seen = new Set<string>();
  const queue: { oid: string; d: number }[] = roots.map((r) => ({ oid: r, d: 1 }));
  while (queue.length > 0) {
    const { oid, d } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (opts.maxDepth !== undefined && d > opts.maxDepth) continue;
    commits.push(oid);
    depth.set(oid, d);
    if (opts.stopAt?.has(oid)) continue;
    const c = parseCommit(obj.data);
    for (const p of c.parents) {
      if (!seen.has(p)) queue.push({ oid: p, d: d + 1 });
    }
  }
  return { commits, depth };
}

/** True when `anc` is an ancestor of `desc` (or equal), following parents. */
export function isAncestor(objects: ObjectMap, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue = [desc];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c.parents.includes(anc)) return true;
    queue.push(...c.parents);
  }
  return false;
}

/** Collect the full object closure (commits + trees + blobs) of given roots. */
export function closure(objects: ObjectMap, roots: string[]): Set<string> {
  const out = new Set<string>();
  const { commits } = walkCommits(objects, roots);
  const stack: string[] = [...commits];
  const visitTree = (treeOid: string) => {
    const t = objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    if (out.has(treeOid)) return;
    out.add(treeOid);
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') visitTree(e.oid);
      else out.add(e.oid);
    }
  };
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      visitTree(c.tree);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) stack.push(t.object);
    }
  }
  return out;
}

/**
 * Collect the objects of exactly the given commits — the commits themselves
 * plus their trees and blobs — WITHOUT following commit parents. This is the
 * closure a depth-limited (shallow) fetch needs: only the generations the
 * depth asked for, never the history below them.
 */
export function closureOfCommits(objects: ObjectMap, commits: string[]): Set<string> {
  const out = new Set<string>();
  const visitTree = (treeOid: string) => {
    const t = objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    if (out.has(treeOid)) return;
    out.add(treeOid);
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') visitTree(e.oid);
      else out.add(e.oid);
    }
  };
  for (const oid of commits) {
    const obj = objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      visitTree(parseCommit(obj.data).tree);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) out.add(t.object);
    }
  }
  return out;
}

/** Find a merge base: the newest common ancestor of a and b (BFS by depth). */
export function mergeBase(objects: ObjectMap, a: string, b: string): string | null {
  const ancA = new Set(walkCommits(objects, [a]).commits);
  const { commits } = walkCommits(objects, [b]);
  return commits.find((c) => ancA.has(c)) ?? null;
}

// ---------------------------------------------------------------- packs --

export interface PackObject {
  type: ObjType;
  data: Buffer;
}

/**
 * Parse a pack v2 buffer. Only plain objects (type 1-4); deltas (6, 7) are
 * rejected with an Error — the suite's client never emits them.
 */
export function readPack(buf: Buffer): Map<string, PackObject> {
  if (buf.length < 12) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const out = new Map<string, PackObject>();
  let off = 12;
  const typeNames: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let i = 0; i < count; i++) {
    const typeNum = (buf[off] >> 4) & 0x7;
    let size = buf[off] & 0x0f;
    let shift = 4;
    off++;
    while (buf[off - 1] & 0x80) {
      size |= (buf[off] & 0x7f) << shift;
      shift += 7;
      off++;
    }
    if (typeNum === 6) throw new Error('ofs-delta unsupported');
    if (typeNum === 7) throw new Error('ref-delta unsupported');
    const type = typeNames[typeNum];
    if (!type) throw new Error(`unknown pack object type ${typeNum}`);
    // Inflate once and locate the stream's end (see inflateObject).
    const { data: inflated, consumed } = inflateObject(buf.subarray(off), size);
    off += consumed;
    const oid = hashObject(type, inflated);
    out.set(oid, { type, data: inflated });
  }
  return out;
}

/**
 * Inflate one zlib stream starting at the head of `input`, returning the
 * data and the bytes consumed. A zlib stream (RFC 1950) ends with the
 * Adler-32 of its data, so one inflate gives the data and scanning for its
 * Adler-32 locates the stream's end; a candidate is verified by inflating
 * exactly up to it. The exponential + binary search is the fallback when
 * no candidate verifies (never in practice for zlib packs).
 */
function inflateObject(input: Buffer, expected: number): { data: Buffer; consumed: number } {
  const data = inflateSync(input);
  if (data.length !== expected) throw new Error('pack object size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let idx = input.indexOf(needle, 2);
  while (idx !== -1) {
    const end = idx + 4;
    try {
      const check = inflateSync(input.subarray(0, end));
      if (check.length === expected && check.equals(data)) return { data, consumed: end };
    } catch {
      // Not the stream end; keep looking.
    }
    idx = input.indexOf(needle, idx + 1);
  }
  // Fallback: exponential growth to find a working size, then binary search.
  const ok = (n: number): boolean => {
    try {
      return inflateSync(input.subarray(0, n)).length === expected;
    } catch {
      return false;
    }
  };
  let hi = 16;
  while (hi < input.length && !ok(hi)) hi *= 2;
  if (hi >= input.length) {
    if (!ok(input.length)) throw new Error('cannot locate pack object boundary');
    hi = input.length;
  }
  let lo = 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data, consumed: lo };
}

/** Adler-32 (RFC 1950) of a buffer. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/** Write a pack v2 of plain objects, with the SHA-1 trailer. */
export function writePack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const typeNums: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const head = Buffer.alloc(12);
  head.write('PACK', 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const o of objects) {
    const typeNum = typeNums[o.type];
    let size = o.data.length;
    const first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    const headerBytes: number[] = [first];
    while (size > 0) {
      headerBytes[headerBytes.length - 1] |= 0x80;
      headerBytes.push(size & 0x7f);
      size >>= 7;
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------- tree helpers --

/** Read a file's blob oid from a tree, following path segments. */
export function getBlobOid(objects: ObjectMap, rootTree: string, segments: string[]): string | null {
  let treeOid = rootTree;
  for (let i = 0; i < segments.length; i++) {
    const t = objects.get(treeOid);
    if (!t || t.type !== 'tree') return null;
    const entry = parseTree(t.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? null : entry.oid;
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/** List every file (path, blob oid) under a tree, recursively. */
export function listFiles(objects: ObjectMap, rootTree: string): { path: string; oid: string }[] {
  const out: { path: string; oid: string }[] = [];
  const walk = (treeOid: string, prefix: string) => {
    const t = objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, p);
      else out.push({ path: p, oid: e.oid });
    }
  };
  walk(rootTree, '');
  return out;
}

/**
 * Return a new root tree oid with `segments` set to `blobOid` (or removed
 * when blobOid is null), creating intermediate trees as needed. The store is
 * mutated with the new tree objects.
 */
export function setPath(objects: ObjectMap, rootTree: string | null, segments: string[], blobOid: string | null): string {
  if (segments.length === 0) return rootTree ?? '';
  const seg = segments[0];
  const entries = rootTree ? parseTree(objects.get(rootTree)?.data ?? Buffer.alloc(0)) : [];
  const existing = entries.find((e) => e.name === seg);
  if (segments.length === 1) {
    if (blobOid === null) {
      // remove
      const rest = entries.filter((e) => e.name !== seg);
      return storeObject(objects, 'tree', buildTree(rest));
    }
    const rest = entries.filter((e) => e.name !== seg);
    rest.push({ mode: '100644', name: seg, oid: blobOid });
    return storeObject(objects, 'tree', buildTree(rest));
  }
  const sub = existing && existing.mode === '40000' ? existing.oid : null;
  const newSub = setPath(objects, sub, segments.slice(1), blobOid);
  const rest = entries.filter((e) => e.name !== seg);
  // prune an empty directory
  const subEntries = parseTree(objects.get(newSub)?.data ?? Buffer.alloc(0));
  if (subEntries.length === 0 && blobOid === null) {
    return storeObject(objects, 'tree', buildTree(rest));
  }
  rest.push({ mode: '40000', name: seg, oid: newSub });
  return storeObject(objects, 'tree', buildTree(rest));
}
