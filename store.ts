// The forge's state: repositories (with their git object stores and refs), labels,
// issues, comments and pull requests, plus the operations every surface shares —
// contents commits, pull-request diffs and merges. One in-memory database; the
// REST, GraphQL, MCP and git surfaces all read and write through here, so an
// object created on one surface is the same object on every other.

import {
  ZERO_OID,
  buildCommit,
  commitTree,
  diffFlatTrees,
  flattenTree,
  identityLine,
  isAncestor,
  mergeBase,
  mergeFlatTrees,
  parseCommit,
  storeObject,
  unflattenTree,
  type FileChange,
  type FlatEntry,
  type ObjectStore,
} from './gitcore.ts';
import { VIEWER } from './scenario.ts';

export interface LabelRec {
  id: number;
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  /** The global id REST reports (shared counter with pull requests). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  /** Branch tips when the pull request was opened (a fallback if a branch moves). */
  headShaAtCreate: string;
  baseShaAtCreate: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one per-repository number counter. */
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

const reposByKey = new Map<string, RepoRec>();
const reposById = new Map<number, RepoRec>();
let nextRepoId = 1;
let nextIssueGlobalId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Create a repository owned by the viewer; null when the name is taken. */
export function createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
  const key = repoKey(VIEWER.login, name);
  if (reposByKey.has(key)) return null;
  const rec: RepoRec = {
    id: nextRepoId++,
    owner: VIEWER.login,
    name,
    isPrivate,
    description,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextLabelId: 1,
  };
  reposByKey.set(key, rec);
  reposById.set(rec.id, rec);
  return rec;
}

/** A repository by owner and name; only the viewer's repositories exist. */
export function findRepo(owner: string, name: string): RepoRec | null {
  return reposByKey.get(repoKey(owner, name)) ?? null;
}

export function findRepoById(id: number): RepoRec | null {
  return reposById.get(id) ?? null;
}

/** Every repository the viewer owns, in creation order. */
export function listRepos(): RepoRec[] {
  return [...reposByKey.values()];
}

export function deleteRepo(rec: RepoRec): void {
  reposByKey.delete(repoKey(rec.owner, rec.name));
  reposById.delete(rec.id);
}

// ------------------------------------------------------------------ refs and commits

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The commit a ref name resolves to: a branch, a tag, a full ref, HEAD, or a sha. */
export function resolveRef(rec: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') return rec.refs.get(branchRef(rec.defaultBranch)) ?? null;
  if (ref.startsWith('refs/')) return rec.refs.get(ref) ?? null;
  const asBranch = rec.refs.get(branchRef(ref));
  if (asBranch !== undefined) return asBranch;
  const asTag = rec.refs.get(`refs/tags/${ref}`);
  if (asTag !== undefined) return asTag;
  if (/^[0-9a-f]{40}$/.test(ref) && rec.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

/** The identity server-side commits (contents writes, merges) carry. */
function serverIdentity(): string {
  return identityLine(VIEWER.name, VIEWER.email, Math.floor(Date.now() / 1000));
}

/** Make one commit on a branch from a flattened tree; advances the branch ref. */
export function commitFlatTree(rec: RepoRec, branch: string, flat: ReadonlyMap<string, FlatEntry>, message: string, extraParents: readonly string[] = []): string {
  const tree = unflattenTree(rec.objects, flat);
  const parent = rec.refs.get(branchRef(branch));
  const parents = [...(parent === undefined ? [] : [parent]), ...extraParents];
  const identity = serverIdentity();
  const commit = storeObject(rec.objects, 'commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
  rec.refs.set(branchRef(branch), commit);
  return commit;
}

/** The flattened tree at a branch's tip (empty when the branch is unborn). */
export function flatTreeAtRef(rec: RepoRec, refName: string): Map<string, FlatEntry> {
  const tip = resolveRef(rec, refName);
  if (tip === null) return new Map();
  const tree = commitTree(rec.objects, tip);
  return flattenTree(rec.objects, tree);
}

/**
 * Create or replace (or, with `content` null, delete) one file on a branch,
 * committing on top of the branch tip. A branch that does not exist yet is
 * started from the default branch's tip. Answers the commit and whether the
 * file already existed on that branch.
 */
export function writeFile(
  rec: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commit: string; existed: boolean; previousBlob: string | null } {
  let flat: Map<string, FlatEntry>;
  if (rec.refs.has(branchRef(branch))) {
    flat = flatTreeAtRef(rec, branch);
  } else if (rec.refs.has(branchRef(rec.defaultBranch))) {
    flat = flatTreeAtRef(rec, rec.defaultBranch);
    // The new branch starts at the default branch's tip: stage that parentage by
    // pointing the ref first, so the commit below builds on it.
    rec.refs.set(branchRef(branch), rec.refs.get(branchRef(rec.defaultBranch)) as string);
  } else {
    flat = new Map();
  }
  const previous = flat.get(path);
  if (content === null) flat.delete(path);
  else flat.set(path, { oid: storeObject(rec.objects, 'blob', content), mode: '100644' });
  const commit = commitFlatTree(rec, branch, flat, message);
  return { commit, existed: previous !== undefined, previousBlob: previous?.oid ?? null };
}

/** Commits reachable from a tip, newest first (a parent always follows its child). */
export function listCommits(rec: RepoRec, tip: string, limit = 10_000): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && order.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = rec.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return order;
}

// ------------------------------------------------------------------ issues and labels

export function createIssue(rec: RepoRec, title: string, body: string, labels: readonly string[]): IssueRec {
  const issue: IssueRec = {
    id: nextIssueGlobalId++,
    number: rec.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
  };
  rec.issues.set(issue.number, issue);
  return issue;
}

export function addComment(rec: RepoRec, issue: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: rec.nextCommentId++, body };
  issue.comments.push(comment);
  return comment;
}

// ------------------------------------------------------------------ pull requests

export function createPull(rec: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const pull: PullRec = {
    id: nextIssueGlobalId++,
    number: rec.nextNumber++,
    title,
    body,
    headRef,
    baseRef,
    headShaAtCreate: rec.refs.get(branchRef(headRef)) ?? ZERO_OID,
    baseShaAtCreate: rec.refs.get(branchRef(baseRef)) ?? ZERO_OID,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  rec.pulls.set(pull.number, pull);
  return pull;
}

/** A pull request's current head/base tips (falling back to the creation snapshot). */
export function pullTips(rec: RepoRec, pull: PullRec): { headTip: string | null; baseTip: string | null } {
  return {
    headTip: rec.refs.get(branchRef(pull.headRef)) ?? (pull.headShaAtCreate === ZERO_OID ? null : pull.headShaAtCreate),
    baseTip: rec.refs.get(branchRef(pull.baseRef)) ?? (pull.baseShaAtCreate === ZERO_OID ? null : pull.baseShaAtCreate),
  };
}

/** The changed files of a pull request: its merge-base tree against its head tree. */
export function pullFileChanges(rec: RepoRec, pull: PullRec): FileChange[] {
  const { headTip, baseTip } = pullTips(rec, pull);
  if (headTip === null) return [];
  const base = baseTip === null ? null : mergeBase(rec.objects, baseTip, headTip);
  const fromFlat = base === null ? new Map<string, FlatEntry>() : flattenTree(rec.objects, commitTree(rec.objects, base));
  const toFlat = flattenTree(rec.objects, commitTree(rec.objects, headTip));
  return diffFlatTrees(rec.objects, fromFlat, toFlat);
}

/** The three-way merge a pull request would perform, or the conflicting path. */
export function trialMerge(rec: RepoRec, pull: PullRec): { merged: Map<string, FlatEntry> } | { conflict: string } | { impossible: string } {
  const { headTip, baseTip } = pullTips(rec, pull);
  if (headTip === null || baseTip === null) return { impossible: 'a branch tip is missing' };
  const base = mergeBase(rec.objects, baseTip, headTip);
  const baseFlat = base === null ? new Map<string, FlatEntry>() : flattenTree(rec.objects, commitTree(rec.objects, base));
  const oursFlat = flattenTree(rec.objects, commitTree(rec.objects, baseTip));
  const theirsFlat = flattenTree(rec.objects, commitTree(rec.objects, headTip));
  return mergeFlatTrees(baseFlat, oursFlat, theirsFlat);
}

/**
 * Merge a pull request into its base branch. Squash makes a one-parent commit;
 * merge makes a two-parent commit; both carry the three-way merged tree.
 */
export function mergePull(
  rec: RepoRec,
  pull: PullRec,
  method: 'squash' | 'merge',
): { sha: string } | { error: 'conflict' | 'not-mergeable' } {
  if (pull.state !== 'open' || pull.merged) return { error: 'not-mergeable' };
  const { headTip, baseTip } = pullTips(rec, pull);
  if (headTip === null || baseTip === null) return { error: 'not-mergeable' };
  if (headTip === baseTip || isAncestor(rec.objects, headTip, baseTip)) return { error: 'not-mergeable' };
  const trial = trialMerge(rec, pull);
  if ('conflict' in trial) return { error: 'conflict' };
  if ('impossible' in trial) return { error: 'not-mergeable' };
  const tree = unflattenTree(rec.objects, trial.merged);
  const identity = serverIdentity();
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.headRef}`
      : `${pull.title} (#${pull.number})`;
  const commit = storeObject(rec.objects, 'commit', buildCommit({ tree, parents, author: identity, committer: identity, message }));
  rec.refs.set(branchRef(pull.baseRef), commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = commit;
  return { sha: commit };
}

// ------------------------------------------------------------------ JSON views (REST shapes)

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false };
}

export function repoJson(rec: RepoRec): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: Buffer.from(`Repository:${rec.id}`).toString('base64'),
    name: rec.name,
    full_name: `${rec.owner}/${rec.name}`,
    owner: { login: rec.owner, id: VIEWER.id, type: 'User' },
    private: rec.isPrivate,
    description: rec.description,
    default_branch: rec.defaultBranch,
    fork: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
  };
}

export function labelJson(rec: RepoRec, label: LabelRec): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, default: false, description: null };
}

export function issueJson(rec: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${rec.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = rec.labels.get(name);
      return label === undefined ? { name } : labelJson(rec, label);
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
  };
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

export function pullJson(rec: RepoRec, pull: PullRec): Record<string, unknown> {
  const { headTip, baseTip } = pullTips(rec, pull);
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${rec.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: headTip ?? ZERO_OID,
      label: `${rec.owner}:${pull.headRef}`,
      user: { login: rec.owner, id: VIEWER.id, type: 'User' },
      repo: repoJson(rec),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip ?? ZERO_OID,
      label: `${rec.owner}:${pull.baseRef}`,
      user: { login: rec.owner, id: VIEWER.id, type: 'User' },
      repo: repoJson(rec),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? '2026-01-01T00:00:00Z') : null,
  };
}

/** Parse a commit's identity line into the REST author/committer shape. */
export function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: '2026-01-01T00:00:00Z' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

export function commitJson(rec: RepoRec, oid: string): Record<string, unknown> {
  const object = rec.objects.get(oid);
  const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      author: identityJson(commit?.author ?? ''),
      committer: identityJson(commit?.committer ?? ''),
      message: commit?.message ?? '',
      tree: { sha: commit?.tree ?? ZERO_OID },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: (commit?.parents ?? []).map((sha) => ({ sha })),
  };
}
