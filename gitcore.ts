// The git object model: blobs, trees, commits and tags addressed by SHA-1, packfile
// reading and writing, pkt-line framing, reachability, and the tree arithmetic the
// merge and diff paths need. Pure functions over a caller-owned object map; no I/O.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

/** One repository's object database: object id -> object. */
export type ObjectStore = Map<string, StoredObject>;

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const HEX40 = /^[0-9a-f]{40}$/;

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object (idempotently) and answer its id. */
export function storeObject(store: ObjectStore, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry order: byte order of the name, a directory compared as name + '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. Throws on a malformed header block. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  if (!HEX40.test(view.tree)) throw new Error('commit has no valid tree header');
  return view;
}

/** `Name <email> 1700000000 +0000` — one identity line of a commit. */
export function identityLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

/** Build a commit object's bytes. The message is stored exactly as given. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

/** Parse an annotated tag object's headers. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: headers.get('object') ?? '', type: headers.get('type') ?? '', tag: headers.get('tag') ?? '' };
}

/** Follow tag objects to the commit they ultimately name, or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The commit a tag object peels to (any non-tag target answers itself). */
export function peelTag(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

// ------------------------------------------------------------------ reachability

/**
 * Every object reachable from `roots`: commit -> tree + parents, tag -> target,
 * tree -> entries (gitlinks skipped). Commits in `parentless` are included with
 * their trees but their parents are not walked (the client's shallow boundary).
 * Missing objects are skipped silently.
 */
export function closure(store: ObjectStore, roots: Iterable<string>, parentless?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (HEX40.test(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (parentless === undefined || !parentless.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` by parent links alone. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The best common ancestor of two commits (nearest by BFS distance), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOf = (tip: string): Map<string, number> => {
    const distance = new Map<string, number>();
    const queue: Array<readonly [string, number]> = [[tip, 0]];
    while (queue.length > 0) {
      const [oid, depth] = queue.shift() as readonly [string, number];
      if (distance.has(oid)) continue;
      distance.set(oid, depth);
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
    return distance;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ------------------------------------------------------------------ flat trees, diff, merge

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** A tree flattened to path -> entry, recursively. An absent tree flattens empty. */
export function flattenTree(store: ObjectStore, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

/** Rebuild nested tree objects from a flattened map; answers the root tree id. */
export function unflattenTree(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree of a commit, or null when the commit is unknown. */
export function commitTree(store: ObjectStore, commitOid: string): string | null {
  const object = store.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Line counts of a text diff: an LCS over lines for small files, a coarse count past that. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp: number[] = new Array(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      const above = dp[j] as number;
      if (oldLines[i - 1] === newLines[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(above, dp[j - 1] as number);
      diagonal = above;
    }
  }
  const common = dp[newLines.length] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two flattened trees, sorted by path. */
export function diffFlatTrees(store: ObjectStore, from: ReadonlyMap<string, FlatEntry>, to: ReadonlyMap<string, FlatEntry>): FileChange[] {
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid && before.mode === after.mode) continue;
    const oldText = before === undefined ? '' : (store.get(before.oid)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (store.get(after.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

function sameEntry(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

/**
 * A three-way merge of flattened trees. Per path: an unchanged side yields to the
 * changed side; both sides changed differently is a conflict. Answers the merged
 * map, or the first conflicting path.
 */
export function mergeFlatTrees(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): { merged: Map<string, FlatEntry> } | { conflict: string } {
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FlatEntry>();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let winner: FlatEntry | undefined;
    if (sameEntry(o, t)) winner = o;
    else if (sameEntry(b, o)) winner = t;
    else if (sameEntry(b, t)) winner = o;
    else return { conflict: path };
    if (winner !== undefined) merged.set(path, winner);
  }
  return { merged };
}

// ------------------------------------------------------------------ packfiles

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain (non-delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly StoredObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream at `offset`; answers its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten || result.engine.bytesWritten <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length || written + literal > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA entries and
 * REF_DELTA entries whose base is either in the pack or supplied by `resolveBase`
 * (a thin pack's base the client already holds). Verifies the trailer checksum.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => StoredObject | undefined): Map<string, StoredObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== computed) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry is truncated');
    let byte = pack[offset] as number;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++] as number;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++] as number;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, StoredObject>();
  const resolvedByOid = new Map<string, { type: ObjType; data: Buffer }>();
  const resolve = (entry: RawEntry, depth: number): { type: ObjType; data: Buffer; oid: string } => {
    if (depth > 512) throw new Error('delta chain too deep');
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry, depth + 1);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const inPack = resolvedByOid.get(wanted);
      if (inPack !== undefined) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, { type, data });
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry, 0);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ------------------------------------------------------------------ fetch planning

export interface FetchPlan {
  /** The objects to pack, each with its id. */
  send: Array<{ oid: string } & StoredObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * What a fetch must send: the closure of `wants` minus the closure of `haves`
 * (the client's shallow-listed commits counting as parentless there). With a
 * depth, only that many commit generations from the wants are included, and the
 * boundary is reported the way git reports it: newly-boundary commits as
 * `shallow`, client-shallow commits the deepening freed as `unshallow`.
 */
export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const haveClosure = closure(store, haves, shallowSet);
  const send: Array<{ oid: string } & StoredObject> = [];
  const emit = (set: Set<string>): void => {
    for (const oid of set) {
      if (haveClosure.has(oid)) continue;
      const object = store.get(oid);
      if (object !== undefined) send.push({ oid, type: object.type, data: object.data });
    }
  };
  if (depth === null || depth <= 0) {
    emit(closure(store, wants));
    return { send, shallow: [], unshallow: [] };
  }
  // Generation-limited inclusion: wants' commits are generation 1.
  const generations = new Map<string, number>();
  const queue: Array<readonly [string, number]> = [];
  for (const want of wants) {
    const commit = peelToCommit(store, want);
    if (commit !== null && !generations.has(commit)) queue.push([commit, 1]);
  }
  while (queue.length > 0) {
    const [oid, generation] = queue.shift() as readonly [string, number];
    if (generations.has(oid) || generation > depth) continue;
    generations.set(oid, generation);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, generation + 1]);
  }
  const included = new Set<string>();
  for (const commit of generations.keys()) {
    const object = store.get(commit);
    if (object === undefined) continue;
    included.add(commit);
    const tree = parseCommit(object.data).tree;
    for (const oid of closure(store, [tree])) included.add(oid);
  }
  // Tag objects that point (transitively) at an included commit ride along.
  for (const oid of closure(store, wants)) {
    const object = store.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = peelToCommit(store, oid);
      if (target !== null && generations.has(target)) included.add(oid);
    }
  }
  emit(included);
  const boundary: string[] = [];
  const unshallow: string[] = [];
  for (const commit of generations.keys()) {
    const object = store.get(commit);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const isBoundary = parents.some((parent) => !generations.has(parent) && !haveClosure.has(parent));
    if (isBoundary) boundary.push(commit);
    else if (shallowSet.has(commit)) unshallow.push(commit);
  }
  return { send, shallow: boundary.sort(), unshallow: unshallow.sort() };
}

// ------------------------------------------------------------------ pkt-line

/** Encode one data packet: 4 hex length digits (payload + 4) then the payload. */
export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line payload too large');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** An incremental pkt-line reader over a complete buffer. */
export class PktReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  /** The next packet, or null at the end of the buffer. Throws on bad framing. */
  next(): PktPacket | null {
    if (this.offset >= this.buffer.length) return null;
    if (this.offset + 4 > this.buffer.length) throw new Error('truncated pkt-line header');
    const header = this.buffer.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'response-end' };
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (this.offset + length > this.buffer.length) throw new Error('truncated pkt-line');
    const payload = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Every byte not yet consumed (a receive-pack body keeps its pack here). */
  rest(): Buffer {
    return this.buffer.subarray(this.offset);
  }
}

/** Wrap a byte stream in sideband band-1 packets of at most `chunk` payload bytes. */
export function sidebandWrap(stream: Buffer, chunk = 32768): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < stream.length; offset += chunk) {
    const slice = stream.subarray(offset, Math.min(stream.length, offset + chunk));
    parts.push(encodePkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}
