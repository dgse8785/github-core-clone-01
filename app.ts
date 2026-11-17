// The forge's HTTP server: four surfaces over one in-memory store.
//
//   - git smart HTTP (/<owner>/<repo>.git/...): protocol v2 for upload-pack
//     when the client asks for it, v0 otherwise; receive-pack with
//     report-status over sideband, fast-forward enforcement per ref.
//   - REST v3 (/api/v3/...): repositories, branches, refs, commits, contents,
//     labels, issues, comments and pull requests in GitHub's shapes.
//   - GraphQL v4 (POST /api/graphql) and MCP (POST /mcp), delegated to
//     graphql.ts and mcp.ts over the same store.
//
// Every response carries an X-GitHub-Request-Id; every surface except the
// health probe requires the shop token as a Bearer credential when one is
// configured. Handlers never throw out of the server: a malformed body is a
// 400, an unknown route a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  PKT_DELIM,
  PKT_FLUSH,
  PktReader,
  ZERO_OID,
  encodePkt,
  isAncestor,
  peelToCommit,
  planFetch,
  readPack,
  sidebandWrap,
  writePack,
  type StoredObject,
} from './gitcore.ts';
import {
  addComment,
  branchRef,
  commitJson,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  findRepo,
  flatTreeAtRef,
  issueJson,
  commentJson,
  labelJson,
  listCommits,
  listRepos,
  mergePull,
  pullFileChanges,
  pullJson,
  repoJson,
  resolveRef,
  userJson,
  writeFile,
  type RepoRec,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { executeGraphQLOperation } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'gitcore/1.0';

// ------------------------------------------------------------------ plumbing

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body: an empty body counts as {}, malformed JSON does not parse. */
function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(url: URL): PageParams {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const pageRaw = Number(url.searchParams.get('page'));
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

/** Answer a paginated list, with a Link header chaining the pages that remain. */
function sendPage(
  res: ServerResponse,
  req: IncomingMessage,
  url: URL,
  items: readonly unknown[],
  params: PageParams,
): void {
  const { page, perPage } = params;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(next.toString());
    last.searchParams.set('page', String(lastPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  sendJson(res, 200, slice, headers);
}

// ------------------------------------------------------------------ REST

function apiRoot(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}/api/v3`;
  sendJson(
    res,
    200,
    {
      current_user_url: `${base}/user`,
      current_user_repositories_url: `${base}/user/repos`,
      repository_url: `${base}/repos/{owner}/{repo}`,
      issue_search_url: `${base}/search/issues`,
      issues_url: `${base}/issues`,
      labels_url: `${base}/repos/{owner}/{repo}/labels`,
      rate_limit_url: `${base}/rate_limit`,
      emojis_url: `${base}/emojis`,
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, segments: readonly string[], rawBody: Buffer): void {
  const method = req.method ?? 'GET';
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') return apiRoot(req, res);
    return notFound(res);
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      github_services_sha: 'github-core-clone',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      packages: [],
    });
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, userJson());
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      return sendPage(res, req, url, listRepos().map((rec) => repoJson(rec)), pageParams(url));
    }
    if (method === 'POST') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = body.value.name;
      if (typeof name !== 'string' || name === '') return sendJson(res, 422, { message: 'name is required' });
      const rec = createRepo(name, body.value.private === true, typeof body.value.description === 'string' ? body.value.description : '');
      if (rec === null) return sendJson(res, 422, { message: 'name already exists on this account' });
      return sendJson(res, 201, repoJson(rec));
    }
    return notFound(res);
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const rec = findRepo(rest[1] as string, rest[2] as string);
    if (rec === null) return notFound(res);
    return handleRepo(req, res, url, rec, rest.slice(3), rawBody);
  }
  return notFound(res);
}

function handleRepo(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rec: RepoRec,
  rest: readonly string[],
  rawBody: Buffer,
): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(rec));
    if (method === 'PATCH') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (typeof body.value.description === 'string') rec.description = body.value.description;
      if (typeof body.value.private === 'boolean') rec.isPrivate = body.value.private;
      return sendJson(res, 200, repoJson(rec));
    }
    if (method === 'DELETE') {
      deleteRepo(rec);
      res.writeHead(204);
      return res.end();
    }
    return notFound(res);
  }

  if (rest[0] === 'branches') {
    if (method !== 'GET') return notFound(res);
    if (rest.length === 1) {
      const branches = [...rec.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: rec.refs.get(ref) as string }, protected: false }));
      return sendJson(res, 200, branches);
    }
    const name = rest.slice(1).join('/');
    const sha = rec.refs.get(branchRef(name));
    if (sha === undefined) return notFound(res);
    return sendJson(res, 200, { name, commit: { sha }, protected: false });
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const ref = body.value.ref;
      const sha = body.value.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/')) return sendJson(res, 422, { message: 'ref must be a full ref name' });
      if (typeof sha !== 'string' || rec.objects.get(sha) === undefined) return sendJson(res, 422, { message: 'sha does not name an object in the repository' });
      if (rec.refs.has(ref)) return sendJson(res, 422, { message: 'Reference already exists' });
      rec.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: rec.objects.get(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET') {
      const wanted = `refs/${rest.slice(2).join('/')}`;
      const exact = rec.refs.get(wanted);
      if (exact !== undefined) {
        return sendJson(res, 200, { ref: wanted, object: { sha: exact, type: rec.objects.get(exact)?.type ?? 'commit' } });
      }
      const prefix = wanted.endsWith('/') ? wanted : `${wanted}/`;
      const children = [...rec.refs.keys()]
        .filter((ref) => ref.startsWith(prefix))
        .sort()
        .map((ref) => ({ ref, object: { sha: rec.refs.get(ref) as string, type: rec.objects.get(ref)?.type ?? 'commit' } }));
      if (children.length > 0) return sendJson(res, 200, children);
      return notFound(res);
    }
    return notFound(res);
  }

  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam === null || shaParam === '' ? rec.refs.get(branchRef(rec.defaultBranch)) ?? null : resolveRef(rec, shaParam);
    if (tip === null) {
      // An unborn default branch lists no commits; an unknown ref is a 404.
      if (shaParam === null || shaParam === '') return sendJson(res, 200, []);
      return notFound(res);
    }
    const params = pageParams(url);
    const all = listCommits(rec, tip).map((oid) => commitJson(rec, oid));
    return sendPage(res, req, url, all, params);
  }

  if (rest[0] === 'contents') {
    return handleContents(req, res, url, rec, rest.slice(1).join('/'), rawBody);
  }

  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') return sendJson(res, 200, [...rec.labels.values()].map((label) => labelJson(rec, label)));
    if (method === 'POST') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = body.value.name;
      if (typeof name !== 'string' || name === '') return sendJson(res, 422, { message: 'name is required' });
      if (rec.labels.has(name)) return sendJson(res, 422, { message: 'Validation Failed: label already exists' });
      const label = { id: rec.nextLabelId++, name, color: typeof body.value.color === 'string' ? body.value.color : 'ededed' };
      rec.labels.set(name, label);
      return sendJson(res, 201, labelJson(rec, label));
    }
    return notFound(res);
  }

  if (rest[0] === 'issues') return handleIssues(req, res, url, rec, rest.slice(1), rawBody);
  if (rest[0] === 'pulls') return handlePulls(req, res, url, rec, rest.slice(1), rawBody);

  return notFound(res);
}

function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rec: RepoRec,
  path: string,
  rawBody: Buffer,
): void {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const refParam = url.searchParams.get('ref');
    const flat = flatTreeAtRef(rec, refParam ?? rec.defaultBranch);
    if (path !== '') {
      const entry = flat.get(path);
      if (entry !== undefined) {
        const object = rec.objects.get(entry.oid);
        const data = object?.data ?? Buffer.alloc(0);
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
          name: path.split('/').pop() as string,
          path,
          sha: entry.oid,
          size: data.length,
        });
      }
    }
    // A directory listing: the entries directly under `path` ('' is the root).
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [entryPath, entry] of flat) {
      if (!entryPath.startsWith(prefix)) continue;
      const remainder = entryPath.slice(prefix.length);
      if (remainder === '') continue;
      const slash = remainder.indexOf('/');
      if (slash < 0) {
        seen.set(remainder, { type: 'file', name: remainder, path: entryPath, sha: entry.oid });
      } else {
        const dirName = remainder.slice(0, slash);
        if (!seen.has(dirName)) seen.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: ZERO_OID });
      }
    }
    if (path === '' || seen.size > 0) {
      return sendJson(res, 200, [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }
    return notFound(res);
  }

  if (method === 'PUT') {
    const body = parseJsonBody(rawBody);
    if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    if (path === '') return sendJson(res, 422, { message: 'a file path is required' });
    const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : rec.defaultBranch;
    const effectiveBranch = rec.refs.has(branchRef(branch)) ? branch : rec.defaultBranch;
    const current = flatTreeAtRef(rec, effectiveBranch).get(path);
    const sha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
    if (current !== undefined) {
      if (sha === undefined) return sendJson(res, 422, { message: 'sha is required when updating an existing file' });
      if (sha !== current.oid) return sendJson(res, 409, { message: 'the given sha does not match the current blob' });
    }
    const content = Buffer.from(typeof body.value.content === 'string' ? body.value.content : '', 'base64');
    const message = typeof body.value.message === 'string' ? body.value.message : `Update ${path}`;
    const result = writeFile(rec, branch, path, content, message);
    const written = flatTreeAtRef(rec, branch).get(path);
    return sendJson(res, result.existed ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop() as string,
        path,
        sha: written?.oid ?? '',
        size: content.length,
      },
      commit: { sha: result.commit },
    });
  }

  if (method === 'DELETE') {
    const body = parseJsonBody(rawBody);
    if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : rec.defaultBranch;
    const effectiveBranch = rec.refs.has(branchRef(branch)) ? branch : rec.defaultBranch;
    const current = flatTreeAtRef(rec, effectiveBranch).get(path);
    if (current === undefined) return notFound(res);
    const sha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
    if (sha !== current.oid) return sendJson(res, 409, { message: 'the given sha does not match the current blob' });
    const message = typeof body.value.message === 'string' ? body.value.message : `Delete ${path}`;
    const result = writeFile(rec, branch, path, null, message);
    return sendJson(res, 200, { content: null, commit: { sha: result.commit } });
  }

  return notFound(res);
}

function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rec: RepoRec,
  rest: readonly string[],
  rawBody: Buffer,
): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...rec.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return sendPage(res, req, url, issues.map((issue) => issueJson(rec, issue)), pageParams(url));
    }
    if (method === 'POST') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = body.value.title;
      if (typeof title !== 'string' || title === '') return sendJson(res, 422, { message: 'title is required' });
      const labels = Array.isArray(body.value.labels) ? body.value.labels.map((label) => String(label)) : [];
      for (const label of labels) {
        if (!rec.labels.has(label)) return sendJson(res, 422, { message: `the label ${label} does not exist` });
      }
      const issue = createIssue(rec, title, typeof body.value.body === 'string' ? body.value.body : '', labels);
      return sendJson(res, 201, issueJson(rec, issue));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? rec.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, issueJson(rec, issue));
    if (method === 'PATCH') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (typeof body.value.title === 'string') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
      if (Array.isArray(body.value.labels)) {
        const labels = body.value.labels.map((label) => String(label));
        for (const label of labels) {
          if (!rec.labels.has(label)) return sendJson(res, 422, { message: `the label ${label} does not exist` });
        }
        issue.labels = labels;
      }
      return sendJson(res, 200, issueJson(rec, issue));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') {
      return sendPage(res, req, url, issue.comments.map((comment) => commentJson(comment)), pageParams(url));
    }
    if (method === 'POST') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const text = body.value.body;
      if (typeof text !== 'string') return sendJson(res, 422, { message: 'body is required' });
      const comment = addComment(rec, issue, text);
      return sendJson(res, 201, commentJson(comment));
    }
    return notFound(res);
  }

  return notFound(res);
}

function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rec: RepoRec,
  rest: readonly string[],
  rawBody: Buffer,
): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...rec.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed' || pull.merged);
      pulls.sort((a, b) => b.number - a.number);
      return sendPage(res, req, url, pulls.map((pull) => pullJson(rec, pull)), pageParams(url));
    }
    if (method === 'POST') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = body.value.title;
      const head = body.value.head;
      const base = body.value.base;
      if (typeof title !== 'string' || title === '') return sendJson(res, 422, { message: 'title is required' });
      if (typeof head !== 'string' || !rec.refs.has(branchRef(head))) return sendJson(res, 422, { message: 'the head branch does not exist' });
      if (typeof base !== 'string' || !rec.refs.has(branchRef(base))) return sendJson(res, 422, { message: 'the base branch does not exist' });
      const duplicate = [...rec.pulls.values()].some(
        (pull) => pull.state === 'open' && !pull.merged && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) return sendJson(res, 422, { message: `A pull request already exists for ${rec.owner}:${head} -> ${rec.owner}:${base}` });
      const pull = createPull(rec, title, typeof body.value.body === 'string' ? body.value.body : '', head, base);
      return sendJson(res, 201, pullJson(rec, pull));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? rec.pulls.get(number) : undefined;

  if (rest.length === 1) {
    if (pull === undefined) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, pullJson(rec, pull));
    if (method === 'PATCH') {
      const body = parseJsonBody(rawBody);
      if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (pull === undefined) return notFound(res);
      if (typeof body.value.title === 'string') pull.title = body.value.title;
      if (typeof body.value.body === 'string') pull.body = body.value.body;
      if (body.value.state === 'closed' && !pull.merged) pull.state = 'closed';
      if (body.value.state === 'open' && !pull.merged) pull.state = 'open';
      return sendJson(res, 200, pullJson(rec, pull));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) return notFound(res);
    if (method !== 'GET') return notFound(res);
    const files = pullFileChanges(rec, pull).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: change.oid ?? ZERO_OID,
    }));
    return sendPage(res, req, url, files, pageParams(url));
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) return sendJson(res, 404, { message: 'Not Found' });
    if (method !== 'PUT') return notFound(res);
    const body = parseJsonBody(rawBody);
    if (!body.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const mergeMethod = body.value.merge_method === 'merge' ? 'merge' : 'squash';
    const result = mergePull(rec, pull, mergeMethod);
    if ('error' in result) {
      return sendJson(res, 405, { message: result.error === 'conflict' ? 'Pull Request is not mergeable: conflict' : 'Pull Request is not mergeable' });
    }
    return sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}

// ------------------------------------------------------------------ git smart HTTP

interface RefEntry {
  name: string;
  oid: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

/** The refs a repository advertises: HEAD first, then every ref in name order. */
function advertisedRefs(rec: RepoRec): RefEntry[] {
  const entries: RefEntry[] = [];
  const headRef = branchRef(rec.defaultBranch);
  const headOid = rec.refs.get(headRef);
  entries.push({
    name: 'HEAD',
    oid: headOid ?? ZERO_OID,
    symrefTarget: headRef,
    unborn: headOid === undefined,
  });
  for (const name of [...rec.refs.keys()].sort()) {
    const oid = rec.refs.get(name) as string;
    const object = rec.objects.get(oid);
    const entry: RefEntry = { name, oid };
    if (object?.type === 'tag') {
      const peeled = peelToCommit(rec.objects, oid);
      if (peeled !== null && peeled !== oid) entry.peeled = peeled;
    }
    entries.push(entry);
  }
  return entries;
}

function uploadCaps(rec: RepoRec): string {
  return `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${branchRef(rec.defaultBranch)}`;
}

function receiveCaps(rec: RepoRec): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${branchRef(rec.defaultBranch)}`;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, url: URL, rec: RepoRec): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound(res);
  const protocol = req.headers['git-protocol'];
  const wantsV2 = service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2');

  if (wantsV2) {
    const body = Buffer.concat([
      encodePkt('version 2\n'),
      encodePkt(`agent=${AGENT}\n`),
      encodePkt('ls-refs=unborn\n'),
      encodePkt('fetch=shallow\n'),
      encodePkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
  }

  const caps = service === 'git-upload-pack' ? uploadCaps(rec) : receiveCaps(rec);
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const entries = advertisedRefs(rec);
  const born = entries.some((entry) => entry.name !== 'HEAD');
  if (!born) {
    parts.push(encodePkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    entries.forEach((entry, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(encodePkt(`${entry.oid} ${entry.name}${suffix}\n`));
      if (entry.peeled !== undefined) parts.push(encodePkt(`${entry.peeled} ${entry.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  const contentType =
    service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  return sendBuffer(res, 200, Buffer.concat(parts), contentType);
}

/** Parse the argument lines of a protocol v2 command until its flush. */
function readV2Args(reader: PktReader): string[] {
  const args: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') break;
    if (packet.kind === 'data') args.push(packet.payload.toString('latin1').replace(/\n$/, ''));
  }
  return args;
}

function handleLsRefs(res: ServerResponse, rec: RepoRec, reader: PktReader): void {
  // Skip the request's own argument section (agent=, object-format=) up to the delim.
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind !== 'data') break;
  }
  const args = readV2Args(reader);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  for (const entry of advertisedRefs(rec)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (entry.name === 'HEAD' && entry.unborn === true) {
      if (unborn) parts.push(encodePkt(`unborn HEAD symref-target:${entry.symrefTarget as string}\n`));
      continue;
    }
    let line = `${entry.oid} ${entry.name}`;
    if (symrefs && entry.symrefTarget !== undefined) line += ` symref-target:${entry.symrefTarget}`;
    if (peel && entry.peeled !== undefined) line += ` peeled:${entry.peeled}`;
    parts.push(encodePkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PackResult {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/**
 * Fetch plans are a pure function of (wants, haves, shallow, depth): the
 * object store is content-addressed and append-only, so a plan can never go
 * stale. Caching them turns a burst of identical clones into one walk.
 */
const packCaches = new WeakMap<RepoRec, Map<string, PackResult>>();

function buildPack(rec: RepoRec, wants: readonly string[], haves: readonly string[], clientShallow: readonly string[], depth: number | null): PackResult {
  let cache = packCaches.get(rec);
  if (cache === undefined) {
    cache = new Map();
    packCaches.set(rec, cache);
  }
  const key = `${depth ?? ''}|${wants.join(',')}|${haves.join(',')}|${clientShallow.join(',')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(rec.objects, wants, haves, clientShallow, depth);
  const result: PackResult = { pack: writePack(plan.send), shallow: plan.shallow, unshallow: plan.unshallow };
  if (cache.size >= 128) cache.clear();
  cache.set(key, result);
  return result;
}

function handleFetchV2(res: ServerResponse, rec: RepoRec, reader: PktReader): void {
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind !== 'data') break;
  }
  const args = readV2Args(reader);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7)) || null;
    else if (arg === 'done') done = true;
  }
  const { pack, shallow, unshallow } = buildPack(rec, wants, haves, clientShallow, depth);
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(encodePkt('acknowledgments\n'), encodePkt('ready\n'), PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePkt('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePkt('packfile\n'), sidebandWrap(pack), PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(res: ServerResponse, rec: RepoRec, reader: PktReader, firstLine: string): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  const consume = (line: string): void => {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7)) || null;
  };
  consume(firstLine);
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') break;
    if (packet.kind === 'data') consume(packet.payload.toString('latin1').replace(/\n$/, ''));
  }
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') break;
    if (packet.kind === 'data') consume(packet.payload.toString('latin1').replace(/\n$/, ''));
  }
  const { pack, shallow, unshallow } = buildPack(rec, wants, haves, clientShallow, depth);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  parts.push(encodePkt('NAK\n'), sidebandWrap(pack), PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPack(res: ServerResponse, rec: RepoRec, rawBody: Buffer): void {
  const reader = new PktReader(rawBody);
  const first = reader.next();
  if (first === null || first.kind !== 'data') return sendJson(res, 400, { message: 'malformed upload-pack request' });
  const firstLine = first.payload.toString('latin1').replace(/\n$/, '');
  if (firstLine === 'command=ls-refs') return handleLsRefs(res, rec, reader);
  if (firstLine === 'command=fetch') return handleFetchV2(res, rec, reader);
  if (firstLine.startsWith('want ')) return handleFetchV0(res, rec, reader, firstLine);
  return sendJson(res, 400, { message: 'unsupported upload-pack request' });
}

function handleReceivePack(res: ServerResponse, rec: RepoRec, rawBody: Buffer): void {
  const reader = new PktReader(rawBody);
  interface Command {
    old: string;
    next: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('latin1').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length >= 3) {
      commands.push({ old: parts[0] as string, next: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = reader.rest();
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => rec.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!rec.objects.has(oid)) rec.objects.set(oid, object as StoredObject);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const lines: string[] = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError.replace(/[\r\n]/g, ' ')}\n`);
    for (const command of commands) lines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    lines.push('unpack ok\n');
    for (const command of commands) {
      const current = rec.refs.get(command.ref) ?? ZERO_OID;
      let failure: string | null = null;
      if (command.old !== current) {
        failure = command.old === ZERO_OID ? 'reference already exists' : 'stale ref';
      } else if (command.next !== ZERO_OID) {
        const object = rec.objects.get(command.next);
        if (object === undefined) failure = 'missing object';
        else if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
          const newCommit = peelToCommit(rec.objects, command.next);
          if (newCommit === null) failure = 'not a commit';
          else if (newCommit !== current && !isAncestor(rec.objects, current, newCommit)) failure = 'non-fast-forward';
        }
      }
      if (failure !== null) {
        lines.push(`ng ${command.ref} ${failure}\n`);
      } else if (command.next === ZERO_OID) {
        rec.refs.delete(command.ref);
        lines.push(`ok ${command.ref}\n`);
      } else {
        rec.refs.set(command.ref, command.next);
        lines.push(`ok ${command.ref}\n`);
      }
    }
  }
  // The report-status stream is itself pkt-lined, and that stream travels
  // inside sideband band 1: two framings, nested.
  const report = Buffer.concat([...lines.map((line) => encodePkt(line)), PKT_FLUSH]);
  sendBuffer(res, 200, Buffer.concat([sidebandWrap(report), PKT_FLUSH]), 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------ the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const idPrefix = randomUUID().slice(0, 8);
  let requestCounter = 0;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `${idPrefix}-${requestCounter.toString(16)}`);
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const method = req.method ?? 'GET';
        const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);

        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (token !== '') {
          const authorization = req.headers.authorization;
          if (authorization !== `Bearer ${token}`) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (segments[0] === 'api' && segments[1] === 'v3') {
          handleRest(req, res, url, segments, rawBody);
          return;
        }
        if (url.pathname === '/api/graphql') {
          if (method !== 'POST') return notFound(res);
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
          } catch {
            return sendJson(res, 400, { message: 'Problems parsing JSON' });
          }
          if (Array.isArray(parsed)) {
            return sendJson(res, 200, parsed.map((entry) => executeGraphQLOperation((entry ?? {}) as { query: unknown })));
          }
          return sendJson(res, 200, executeGraphQLOperation((parsed ?? {}) as { query: unknown }));
        }
        if (url.pathname === '/mcp') {
          if (method !== 'POST') return notFound(res);
          const outcome = handleMcp(rawBody);
          if (outcome.payload === null || outcome.payload === undefined) {
            res.writeHead(outcome.status);
            return res.end();
          }
          return sendJson(res, outcome.status, outcome.payload);
        }

        // git smart HTTP: /<owner>/<repo>.git/<endpoint>
        if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
          const rec = findRepo(segments[0] as string, (segments[1] as string).slice(0, -'.git'.length));
          if (rec === null) return notFound(res);
          const endpoint = segments.slice(2).join('/');
          if (method === 'GET' && endpoint === 'info/refs') return handleInfoRefs(req, res, url, rec);
          if (method === 'POST' && endpoint === 'git-upload-pack') return handleUploadPack(res, rec, rawBody);
          if (method === 'POST' && endpoint === 'git-receive-pack') return handleReceivePack(res, rec, rawBody);
          return notFound(res);
        }

        return notFound(res);
      } catch {
        if (!res.headersSent) sendJson(res, 400, { message: 'Bad Request' });
        else res.end();
      }
    })();
  });
}
