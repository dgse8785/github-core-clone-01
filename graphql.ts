// A small GraphQL executor for the v4 surface: a lexer and parser for the
// document shapes gh and github-mcp-server send (operations with names and
// variable definitions, aliases, inline fragments, enum lists, input objects,
// null variables), and a resolver layer over the forge's shared store, so a
// mutation here is the same object the REST surface reads back.
//
// Global ids are opaque base64 of a typed prefix (`Repository:12`,
// `Issue:12:3`), stable across reads and never the plain numeric id.

import {
  addComment,
  branchRef,
  createIssue,
  createPull,
  findRepo,
  findRepoById,
  mergePull,
  pullFileChanges,
  trialMerge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { VIEWER, type ScenarioUser } from './scenario.ts';

// ------------------------------------------------------------------ global ids

/** An opaque Relay-style global id for one stored object. */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':')).toString('base64');
}

/** Decode a global id into its kind and parts, or null when it is not one of ours. */
export function parseGlobalId(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2 || parts[0] === '') return null;
  return { kind: parts[0] as string, parts: parts.slice(1) };
}

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i += text.length;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueAst =
  | { k: 'var'; name: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'string'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; items: ValueAst[] }
  | { k: 'object'; fields: Array<readonly [string, ValueAst]> };

interface FieldAst {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<readonly [string, ValueAst]>;
  selectionSet: SelectionAst[] | null;
}
interface InlineFragmentAst {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionAst[];
}
interface FragmentSpreadAst {
  kind: 'spread';
  name: string;
}
type SelectionAst = FieldAst | InlineFragmentAst | FragmentSpreadAst;

interface OperationAst {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionAst[];
}

interface DocumentAst {
  operations: OperationAst[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionAst[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    return this.tokens[this.pos++] as Token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  /** Skip a balanced (...) group (variable definitions, directive arguments). */
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
    }
  }

  private parseValue(): ValueAst {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { k: 'int', v: token.value };
      case 'float':
        return { k: 'float', v: token.value };
      case 'string':
        return { k: 'string', v: token.value };
      case 'name':
        if (token.value === 'true') return { k: 'bool', v: true };
        if (token.value === 'false') return { k: 'bool', v: false };
        if (token.value === 'null') return { k: 'null' };
        return { k: 'enum', v: token.value };
      case 'punct':
        if (token.value === '$') return { k: 'var', name: this.expectName() };
        if (token.value === '[') {
          const items: ValueAst[] = [];
          while (!this.skipPunct(']')) items.push(this.parseValue());
          return { k: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<readonly [string, ValueAst]> = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push([name, this.parseValue()]);
          }
          return { k: 'object', fields };
        }
        throw new Error(`unexpected ${token.value} in a value`);
      default:
        throw new Error('unexpected token in a value');
    }
  }

  private parseArguments(): Array<readonly [string, ValueAst]> {
    const args: Array<readonly [string, ValueAst]> = [];
    if (!this.skipPunct('(')) return args;
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push([name, this.parseValue()]);
    }
    return args;
  }

  private parseSelectionSet(): SelectionAst[] {
    this.expectPunct('{');
    const selections: SelectionAst[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionAst {
    if (this.peek().kind === 'spread') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionAst[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  /** Skip a type annotation (for fragment definitions and variable definitions). */
  private skipType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  parseDocument(): DocumentAst {
    const operations: OperationAst[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionAst[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
        this.skipDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment definition is missing "on"');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }
}

// ------------------------------------------------------------------ values

type Variables = Readonly<Record<string, unknown>>;

function evalValue(ast: ValueAst, variables: Variables): unknown {
  switch (ast.k) {
    case 'var':
      return variables[ast.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return ast.v;
    case 'null':
      return null;
    case 'list':
      return ast.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, value] of ast.fields) out[name] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(args: readonly (readonly [string, ValueAst])[], variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of args) {
    const evaluated = evalValue(value, variables);
    if (evaluated !== undefined) out[name] = evaluated;
  }
  return out;
}

// ------------------------------------------------------------------ schema (introspection data)

interface TypeDef {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INTERFACE' | 'INPUT_OBJECT';
  fields?: readonly string[];
  enumValues?: readonly string[];
}

const OBJECT = (name: string, fields: readonly string[]): TypeDef => ({ name, kind: 'OBJECT', fields });
const ENUM = (name: string, enumValues: readonly string[]): TypeDef => ({ name, kind: 'ENUM', enumValues });
const SCALAR = (name: string): TypeDef => ({ name, kind: 'SCALAR' });

export const TYPE_DEFS: Readonly<Record<string, TypeDef>> = {
  Query: OBJECT('Query', ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'meta', 'organization', 'user']),
  Mutation: OBJECT('Mutation', ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository']),
  User: OBJECT('User', ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt', 'repositories', 'issues', 'pullRequests']),
  Repository: OBJECT('Repository', [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'isFork', 'url', 'createdAt', 'updatedAt',
    'labels', 'refs', 'ref', 'object', 'stargazerCount', 'forkCount', 'primaryLanguage', 'diskUsage', 'pushedAt',
  ]),
  Ref: OBJECT('Ref', ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests']),
  Commit: OBJECT('Commit', ['id', 'oid', 'message', 'messageHeadline', 'author', 'committer', 'committedDate', 'authoredDate', 'tree', 'parents', 'url']),
  Issue: OBJECT('Issue', [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'repository', 'comments', 'labels',
    'createdAt', 'updatedAt', 'closed', 'closedAt', 'url', 'viewerCanUpdate', 'assignees', 'participants', 'reactions',
  ]),
  PullRequest: OBJECT('PullRequest', [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'mergeCommit', 'mergeCommitSha', 'files', 'commits', 'comments', 'author',
    'repository', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'url', 'additions', 'deletions', 'changedFiles', 'isDraft',
  ]),
  IssueConnection: OBJECT('IssueConnection', ['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: OBJECT('IssueEdge', ['node', 'cursor']),
  PullRequestConnection: OBJECT('PullRequestConnection', ['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestEdge: OBJECT('PullRequestEdge', ['node', 'cursor']),
  PullRequestChangedFileConnection: OBJECT('PullRequestChangedFileConnection', ['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: OBJECT('PullRequestChangedFile', ['path', 'additions', 'deletions', 'changeType']),
  PageInfo: OBJECT('PageInfo', ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  IssueComment: OBJECT('IssueComment', ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue']),
  CreateIssuePayload: OBJECT('CreateIssuePayload', ['issue', 'clientMutationId']),
  CloseIssuePayload: OBJECT('CloseIssuePayload', ['issue', 'clientMutationId']),
  CreatePullRequestPayload: OBJECT('CreatePullRequestPayload', ['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: OBJECT('MergePullRequestPayload', ['pullRequest', 'clientMutationId']),
  AddCommentPayload: OBJECT('AddCommentPayload', ['commentEdge', 'subject', 'clientMutationId']),
  IssueCommentEdge: OBJECT('IssueCommentEdge', ['node', 'cursor']),
  GitActor: OBJECT('GitActor', ['name', 'email', 'date', 'avatarUrl', 'user']),
  Node: { name: 'Node', kind: 'INTERFACE', fields: ['id'] },
  __Type: OBJECT('__Type', ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'interfaces', 'ofType', 'inputFields', 'specifiedByURL']),
  __Field: OBJECT('__Field', ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason']),
  __EnumValue: OBJECT('__EnumValue', ['name', 'description', 'isDeprecated', 'deprecationReason']),
  __Schema: OBJECT('__Schema', ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives']),
  __Directive: OBJECT('__Directive', ['name', 'description', 'locations', 'args']),
  __InputValue: OBJECT('__InputValue', ['name', 'description', 'type', 'defaultValue']),
  IssueState: ENUM('IssueState', ['OPEN', 'CLOSED']),
  PullRequestState: ENUM('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']),
  MergeableState: ENUM('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  PullRequestMergeMethod: ENUM('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']),
  RepositoryPermission: ENUM('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  IssueOrderField: ENUM('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
  OrderDirection: ENUM('OrderDirection', ['ASC', 'DESC']),
  SearchType: ENUM('SearchType', ['ISSUE', 'REPOSITORY', 'USER']),
  String: SCALAR('String'),
  Int: SCALAR('Int'),
  Float: SCALAR('Float'),
  Boolean: SCALAR('Boolean'),
  ID: SCALAR('ID'),
};

// ------------------------------------------------------------------ execution

/** A value tagged with the GraphQL type it resolves fields as. */
interface GqlObject {
  __t: string;
  v: unknown;
}

function wrap(type: string, value: unknown): GqlObject {
  return { __t: type, v: value };
}

class FieldProblem extends Error {}

interface ExecCtx {
  variables: Variables;
  fragments: DocumentAst['fragments'];
  errors: Array<{ message: string }>;
}

interface RepoIssue {
  rec: RepoRec;
  issue: IssueRec;
}
interface RepoPull {
  rec: RepoRec;
  pull: PullRec;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

/** The issues connection: states filter, orderBy, and first/after cursor paging. */
function issuesConnection(rec: RepoRec, args: Record<string, unknown>): GqlObject {
  let items = [...rec.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as { direction?: unknown };
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  const endCursor = slice.length > 0 ? cursorOf(start + slice.length - 1) : null;
  return wrap('IssueConnection', {
    nodes: slice.map((issue) => wrap('Issue', { rec, issue } satisfies RepoIssue)),
    edges: slice.map((issue, i) => wrap('IssueEdge', { node: wrap('Issue', { rec, issue } satisfies RepoIssue), cursor: cursorOf(start + i) })),
    pageInfo: wrap('PageInfo', { hasNextPage, hasPreviousPage: start > 0, startCursor: slice.length > 0 ? cursorOf(start) : null, endCursor }),
    totalCount: items.length,
  });
}

function pullRequestsConnection(rec: RepoRec, args: Record<string, unknown>): GqlObject {
  let items = [...rec.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    items = items.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  items.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : items.length;
  const slice = items.slice(0, first);
  return wrap('PullRequestConnection', {
    nodes: slice.map((pull) => wrap('PullRequest', { rec, pull } satisfies RepoPull)),
    edges: slice.map((pull, i) => wrap('PullRequestEdge', { node: wrap('PullRequest', { rec, pull } satisfies RepoPull), cursor: cursorOf(i) })),
    pageInfo: wrap('PageInfo', { hasNextPage: slice.length < items.length, hasPreviousPage: false, startCursor: slice.length > 0 ? cursorOf(0) : null, endCursor: slice.length > 0 ? cursorOf(slice.length - 1) : null }),
    totalCount: items.length,
  });
}

function nodeFromGlobalId(id: unknown): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const rec = findRepoById(Number(parsed.parts[0]));
    return rec === null ? null : wrap('Repository', rec);
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const rec = findRepoById(Number(parsed.parts[0]));
    if (rec === null) return null;
    const number = Number(parsed.parts[1]);
    if (parsed.kind === 'Issue') {
      const issue = rec.issues.get(number);
      return issue === undefined ? null : wrap('Issue', { rec, issue } satisfies RepoIssue);
    }
    const pull = rec.pulls.get(number);
    return pull === undefined ? null : wrap('PullRequest', { rec, pull } satisfies RepoPull);
  }
  if (parsed.kind === 'User') return wrap('User', VIEWER);
  return null;
}

function repoFromGlobalId(id: unknown): RepoRec {
  const parsed = parseGlobalId(id);
  const rec = parsed !== null && parsed.kind === 'Repository' ? findRepoById(Number(parsed.parts[0])) : null;
  if (rec === null) throw new FieldProblem('the repository id does not name a repository');
  return rec;
}

function issueFromGlobalId(id: unknown): RepoIssue {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') throw new FieldProblem('the issue id does not name an issue');
  const rec = findRepoById(Number(parsed.parts[0]));
  const issue = rec?.issues.get(Number(parsed.parts[1]));
  if (rec === null || rec === undefined || issue === undefined) throw new FieldProblem('the issue id does not name an issue');
  return { rec, issue };
}

function pullFromGlobalId(id: unknown): RepoPull {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') throw new FieldProblem('the pull request id does not name a pull request');
  const rec = findRepoById(Number(parsed.parts[0]));
  const pull = rec?.pulls.get(Number(parsed.parts[1]));
  if (rec === null || rec === undefined || pull === undefined) throw new FieldProblem('the pull request id does not name a pull request');
  return { rec, pull };
}

/** Resolve one field of one object to its raw value (wrappers for objects). */
function resolveField(typeName: string, source: GqlObject, field: string, args: Record<string, unknown>): unknown {
  const v = source.v as never;
  switch (typeName) {
    case 'Query':
      switch (field) {
        case 'viewer':
          return wrap('User', VIEWER);
        case 'repository': {
          const rec = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return rec === null ? null : wrap('Repository', rec);
        }
        case 'node':
          return nodeFromGlobalId(args.id);
        case 'nodes':
          return Array.isArray(args.ids) ? args.ids.map((id) => nodeFromGlobalId(id)) : [];
        case '__type': {
          const def = TYPE_DEFS[String(args.name ?? '')];
          return def === undefined ? null : wrap('__Type', def);
        }
        case '__schema':
          return wrap('__Schema', null);
        case 'user':
          return wrap('User', VIEWER);
        case 'rateLimit':
          return null;
        case 'meta':
          return null;
      }
      break;
    case 'Mutation':
      switch (field) {
        case 'createIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const rec = repoFromGlobalId(input.repositoryId);
          const issue = createIssue(rec, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
          return wrap('CreateIssuePayload', { rec, issue } satisfies RepoIssue);
        }
        case 'closeIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromGlobalId(input.issueId);
          found.issue.state = 'closed';
          return wrap('CloseIssuePayload', found);
        }
        case 'createPullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const rec = repoFromGlobalId(input.repositoryId);
          const head = String(input.headRefName ?? '');
          const base = String(input.baseRefName ?? '');
          if (!rec.refs.has(branchRef(head))) throw new FieldProblem(`the head branch ${head} does not exist`);
          if (!rec.refs.has(branchRef(base))) throw new FieldProblem(`the base branch ${base} does not exist`);
          const pull = createPull(rec, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
          return wrap('CreatePullRequestPayload', { rec, pull } satisfies RepoPull);
        }
        case 'mergePullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = pullFromGlobalId(input.pullRequestId);
          const method = String(input.mergeMethod ?? 'SQUASH');
          const result = mergePull(found.rec, found.pull, method === 'MERGE' ? 'merge' : 'squash');
          if ('error' in result) throw new FieldProblem(result.error === 'conflict' ? 'Pull Request is not mergeable: conflict' : 'Pull Request is not mergeable');
          return wrap('MergePullRequestPayload', found);
        }
        case 'addComment': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromGlobalId(input.subjectId);
          const comment = addComment(found.rec, found.issue, String(input.body ?? ''));
          const commentObject = wrap('IssueComment', { rec: found.rec, issue: found.issue, comment });
          return wrap('AddCommentPayload', { edge: wrap('IssueCommentEdge', { node: commentObject, cursor: cursorOf(0) }), subject: wrap('Issue', found) });
        }
      }
      break;
    case 'User': {
      const user = v as ScenarioUser;
      switch (field) {
        case 'id':
          return globalId('User', user.id);
        case 'databaseId':
          return user.id;
        case 'login':
          return user.login;
        case 'name':
          return user.name;
        case 'email':
          return user.email;
        case 'isViewer':
          return true;
        case 'url':
          return `https://forge.invalid/${user.login}`;
        case 'avatarUrl':
          return '';
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
      }
      break;
    }
    case 'Repository': {
      const rec = v as RepoRec;
      switch (field) {
        case 'id':
          return globalId('Repository', rec.id);
        case 'databaseId':
          return rec.id;
        case 'name':
          return rec.name;
        case 'nameWithOwner':
          return `${rec.owner}/${rec.name}`;
        case 'owner':
          return wrap('User', VIEWER);
        case 'defaultBranchRef':
          return rec.refs.has(branchRef(rec.defaultBranch)) ? wrap('Ref', { name: rec.defaultBranch, rec }) : null;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return rec.description;
        case 'isPrivate':
          return rec.isPrivate;
        case 'isFork':
          return false;
        case 'url':
          return `https://forge.invalid/${rec.owner}/${rec.name}`;
        case 'createdAt':
        case 'updatedAt':
        case 'pushedAt':
          return '2026-01-01T00:00:00Z';
        case 'issue': {
          const issue = rec.issues.get(Number(args.number));
          return issue === undefined ? null : wrap('Issue', { rec, issue } satisfies RepoIssue);
        }
        case 'issues':
          return issuesConnection(rec, args);
        case 'pullRequest': {
          const pull = rec.pulls.get(Number(args.number));
          return pull === undefined ? null : wrap('PullRequest', { rec, pull } satisfies RepoPull);
        }
        case 'pullRequests':
          return pullRequestsConnection(rec, args);
      }
      break;
    }
    case 'Ref': {
      const ref = v as { name: string; rec: RepoRec };
      switch (field) {
        case 'id':
          return globalId('Ref', ref.rec.id, ref.name);
        case 'name':
          return ref.name;
        case 'prefix':
          return 'refs/heads/';
        case 'repository':
          return wrap('Repository', ref.rec);
        case 'target':
          return null;
        case 'associatedPullRequests':
          return wrap('PullRequestConnection', { nodes: [], edges: [], pageInfo: wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }), totalCount: 0 });
      }
      break;
    }
    case 'Issue': {
      const { rec, issue } = v as RepoIssue;
      switch (field) {
        case 'id':
          return globalId('Issue', rec.id, issue.number);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
        case 'bodyText':
          return issue.body;
        case 'author':
          return wrap('User', VIEWER);
        case 'repository':
          return wrap('Repository', rec);
        case 'closed':
          return issue.state === 'closed';
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
        case 'closedAt':
          return issue.state === 'closed' ? '2026-01-01T00:00:00Z' : null;
        case 'url':
          return `https://forge.invalid/${rec.owner}/${rec.name}/issues/${issue.number}`;
        case 'viewerCanUpdate':
          return true;
      }
      break;
    }
    case 'PullRequest': {
      const { rec, pull } = v as RepoPull;
      switch (field) {
        case 'id':
          return globalId('PullRequest', rec.id, pull.number);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
        case 'bodyText':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return wrap('Ref', { name: pull.headRef, rec });
        case 'baseRef':
          return wrap('Ref', { name: pull.baseRef, rec });
        case 'mergeable': {
          if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
          const trial = trialMerge(rec, pull);
          return 'conflict' in trial ? 'CONFLICTING' : 'impossible' in trial ? 'UNKNOWN' : 'MERGEABLE';
        }
        case 'mergeCommitSha':
          return pull.mergeCommitSha;
        case 'mergeCommit':
          return null;
        case 'author':
          return wrap('User', VIEWER);
        case 'repository':
          return wrap('Repository', rec);
        case 'closed':
          return pull.state === 'closed';
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
        case 'closedAt':
          return pull.state === 'closed' ? (pull.mergedAt ?? '2026-01-01T00:00:00Z') : null;
        case 'url':
          return `https://forge.invalid/${rec.owner}/${rec.name}/pull/${pull.number}`;
        case 'isDraft':
          return false;
        case 'files': {
          const changes = pullFileChanges(rec, pull);
          const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : changes.length;
          const slice = changes.slice(0, first);
          return wrap('PullRequestChangedFileConnection', {
            nodes: slice.map((change) => wrap('PullRequestChangedFile', change)),
            edges: [],
            pageInfo: wrap('PageInfo', { hasNextPage: slice.length < changes.length, hasPreviousPage: false, startCursor: null, endCursor: null }),
            totalCount: changes.length,
          });
        }
        case 'additions':
          return pullFileChanges(rec, pull).reduce((sum, change) => sum + change.additions, 0);
        case 'deletions':
          return pullFileChanges(rec, pull).reduce((sum, change) => sum + change.deletions, 0);
        case 'changedFiles':
          return pullFileChanges(rec, pull).length;
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const connection = v as { nodes: GqlObject[]; edges: GqlObject[]; pageInfo: GqlObject; totalCount: number };
      switch (field) {
        case 'nodes':
          return connection.nodes;
        case 'edges':
          return connection.edges;
        case 'pageInfo':
          return connection.pageInfo;
        case 'totalCount':
          return connection.totalCount;
      }
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge': {
      const edge = v as { node: GqlObject; cursor: string };
      if (field === 'node') return edge.node;
      if (field === 'cursor') return edge.cursor;
      break;
    }
    case 'PageInfo': {
      const pageInfo = v as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      switch (field) {
        case 'hasNextPage':
          return pageInfo.hasNextPage;
        case 'hasPreviousPage':
          return pageInfo.hasPreviousPage;
        case 'startCursor':
          return pageInfo.startCursor;
        case 'endCursor':
          return pageInfo.endCursor;
      }
      break;
    }
    case 'PullRequestChangedFile': {
      const change = v as { filename: string; additions: number; deletions: number; status: string };
      switch (field) {
        case 'path':
          return change.filename;
        case 'additions':
          return change.additions;
        case 'deletions':
          return change.deletions;
        case 'changeType':
          return change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED';
      }
      break;
    }
    case 'IssueComment': {
      const commentV = v as { rec: RepoRec; issue: IssueRec; comment: { id: number; body: string } };
      switch (field) {
        case 'id':
          return globalId('IssueComment', commentV.rec.id, commentV.issue.number, commentV.comment.id);
        case 'databaseId':
          return commentV.comment.id;
        case 'body':
        case 'bodyText':
          return commentV.comment.body;
        case 'author':
          return wrap('User', VIEWER);
        case 'issue':
          return wrap('Issue', { rec: commentV.rec, issue: commentV.issue } satisfies RepoIssue);
        case 'createdAt':
        case 'updatedAt':
          return '2026-01-01T00:00:00Z';
        case 'url':
          return `https://forge.invalid/${commentV.rec.owner}/${commentV.rec.name}/issues/${commentV.issue.number}`;
      }
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = v as RepoIssue;
      if (field === 'issue') return wrap('Issue', payload);
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = v as RepoPull;
      if (field === 'pullRequest') return wrap('PullRequest', payload);
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      const payload = v as { edge: GqlObject; subject: GqlObject };
      if (field === 'commentEdge') return payload.edge;
      if (field === 'subject') return payload.subject;
      if (field === 'clientMutationId') return null;
      break;
    }
    case '__Type': {
      const def = v as TypeDef;
      switch (field) {
        case 'name':
          return def.name;
        case 'kind':
          return def.kind;
        case 'description':
          return null;
        case 'fields':
          return def.fields === undefined ? null : def.fields.map((name) => wrap('__Field', { name }));
        case 'enumValues':
          return def.enumValues === undefined ? null : def.enumValues.map((name) => wrap('__EnumValue', { name }));
        case 'possibleTypes':
        case 'interfaces':
          return [];
        case 'ofType':
        case 'inputFields':
        case 'specifiedByURL':
          return null;
      }
      break;
    }
    case '__Field': {
      const fieldDef = v as { name: string };
      switch (field) {
        case 'name':
          return fieldDef.name;
        case 'description':
        case 'deprecationReason':
          return null;
        case 'isDeprecated':
          return false;
        case 'args':
          return [];
        case 'type':
          return wrap('__Type', TYPE_DEFS.String as TypeDef);
      }
      break;
    }
    case '__EnumValue': {
      const enumDef = v as { name: string };
      switch (field) {
        case 'name':
          return enumDef.name;
        case 'description':
        case 'deprecationReason':
          return null;
        case 'isDeprecated':
          return false;
      }
      break;
    }
    case '__Schema':
      switch (field) {
        case 'types':
          return Object.values(TYPE_DEFS).map((def) => wrap('__Type', def));
        case 'queryType':
          return wrap('__Type', TYPE_DEFS.Query as TypeDef);
        case 'mutationType':
          return wrap('__Type', TYPE_DEFS.Mutation as TypeDef);
        case 'subscriptionType':
          return null;
        case 'directives':
          return [];
      }
      break;
    case 'Node':
      if (field === 'id') return resolveField(source.__t, source, 'id', args);
      break;
  }
  throw new FieldProblem(`Cannot query field "${field}" on type "${typeName}"`);
}

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Ref', 'PullRequestChangedFile']);

/** Whether a fragment with this type condition applies to an object of `actual` type. */
function fragmentApplies(condition: string | null, actual: string): boolean {
  if (condition === null) return true;
  if (condition === actual) return true;
  if (condition === 'Node' && NODE_TYPES.has(actual)) return true;
  return false;
}

/** Execute one selection set against one object, building the response object. */
function executeSelectionSet(typeName: string, source: GqlObject, selections: readonly SelectionAst[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const run = (set: readonly SelectionAst[], ownerType: string): void => {
    for (const selection of set) {
      if (selection.kind === 'inline') {
        if (fragmentApplies(selection.typeCondition, source.__t)) run(selection.selectionSet, selection.typeCondition ?? ownerType);
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment !== undefined && fragmentApplies(fragment.typeCondition, source.__t)) run(fragment.selectionSet, fragment.typeCondition);
        continue;
      }
      const responseKey = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[responseKey] = source.__t;
        continue;
      }
      let raw: unknown;
      try {
        raw = resolveField(ownerType, source, selection.name, evalArgs(selection.args, ctx.variables));
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = completeValue(raw, selection.selectionSet, ctx);
    }
  };
  run(selections, typeName);
  return out;
}

/** Complete a raw resolver value against the field's selection set. */
function completeValue(raw: unknown, selectionSet: SelectionAst[] | null, ctx: ExecCtx): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(item, selectionSet, ctx));
  if (typeof raw === 'object' && '__t' in raw) {
    const object = raw as GqlObject;
    if (selectionSet === null) return null;
    return executeSelectionSet(object.__t, object, selectionSet, ctx);
  }
  return raw;
}

/** One operation document in, its {data} / {data, errors} envelope out. */
export function executeGraphQLOperation(operation: { query: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  if (typeof operation.query !== 'string') return { errors: [{ message: 'the GraphQL document is not a string' }] };
  let document: DocumentAst;
  try {
    document = new Parser(lex(operation.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const variables: Variables = (typeof operation.variables === 'object' && operation.variables !== null ? operation.variables : {}) as Variables;
  const wanted = typeof operation.operationName === 'string' ? operation.operationName : null;
  const op = document.operations.find((candidate) => wanted === null || candidate.name === wanted) ?? document.operations[0];
  if (op === undefined) return { errors: [{ message: 'the document holds no operation' }] };
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, wrap(rootType, null), op.selectionSet, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
