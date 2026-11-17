// The MCP endpoint: JSON-RPC over POST /mcp. Modern clients probe
// server/discover first; older ones fall back to the initialize handshake, so
// both eras are answered. The tools are thin delegates over the same store
// the REST and GraphQL surfaces use, which is what makes an MCP-created
// issue readable over REST in the same breath.

import {
  branchRef,
  createIssue,
  createPull,
  createRepo,
  findRepo,
  mergePull,
  repoJson,
  issueJson,
  pullJson,
  type RepoRec,
} from './store.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Readonly<Record<string, { type: string; description: string }>>;
    required: readonly string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, { type: string; description: string }>>,
  required: readonly string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const STRING = (description: string): { type: string; description: string } => ({ type: 'string', description });
const BOOLEAN = (description: string): { type: string; description: string } => ({ type: 'boolean', description });
const INTEGER = (description: string): { type: string; description: string } => ({ type: 'integer', description });

/** The tool list, built once: two tools/list calls must be byte-identical. */
export const TOOLS: readonly ToolDef[] = [
  tool(
    'create_repo',
    'Create a new repository for the authenticated user.',
    {
      name: STRING('The name of the repository to create.'),
      description: STRING('A short description of the repository.'),
      private: BOOLEAN('Whether the repository is private.'),
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get the details of a repository by owner and name.',
    {
      owner: STRING('The owner of the repository.'),
      repo: STRING('The name of the repository.'),
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: STRING('The owner of the repository.'),
      repo: STRING('The name of the repository.'),
      title: STRING('The title of the issue.'),
      body: STRING('The body text of the issue.'),
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state.',
    {
      owner: STRING('The owner of the repository.'),
      repo: STRING('The name of the repository.'),
      state: STRING('Filter by state: open, closed or all.'),
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: STRING('The owner of the repository.'),
      repo: STRING('The name of the repository.'),
      title: STRING('The title of the pull request.'),
      head: STRING('The head branch to merge from.'),
      base: STRING('The base branch to merge into.'),
      body: STRING('The body text of the pull request.'),
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge an open pull request into its base branch.',
    {
      owner: STRING('The owner of the repository.'),
      repo: STRING('The name of the repository.'),
      pull_number: INTEGER('The number of the pull request to merge.'),
    },
    ['owner', 'repo', 'pull_number'],
  ),
];

class ToolProblem extends Error {}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolProblem(`the argument ${key} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function repoOrProblem(args: Record<string, unknown>): RepoRec {
  const owner = requiredString(args, 'owner');
  const name = requiredString(args, 'repo');
  const rec = findRepo(owner, name);
  if (rec === null) throw new ToolProblem(`repository ${owner}/${name} was not found`);
  return rec;
}

/** Run one tool by name against the store; throws ToolProblem for domain errors. */
function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = requiredString(args, 'name');
      const rec = createRepo(repoName, args.private === true, optionalString(args, 'description'));
      if (rec === null) throw new ToolProblem(`a repository named ${repoName} already exists`);
      return repoJson(rec);
    }
    case 'get_repo':
      return repoJson(repoOrProblem(args));
    case 'create_issue': {
      const rec = repoOrProblem(args);
      const title = requiredString(args, 'title');
      const issue = createIssue(rec, title, optionalString(args, 'body'), []);
      return issueJson(rec, issue);
    }
    case 'list_issues': {
      const rec = repoOrProblem(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...rec.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return issues.map((issue) => issueJson(rec, issue));
    }
    case 'create_pull_request': {
      const rec = repoOrProblem(args);
      const title = requiredString(args, 'title');
      const head = requiredString(args, 'head');
      const base = requiredString(args, 'base');
      if (!rec.refs.has(branchRef(head))) throw new ToolProblem(`the head branch ${head} does not exist`);
      if (!rec.refs.has(branchRef(base))) throw new ToolProblem(`the base branch ${base} does not exist`);
      const pull = createPull(rec, title, optionalString(args, 'body'), head, base);
      return pullJson(rec, pull);
    }
    case 'merge_pull_request': {
      const rec = repoOrProblem(args);
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isFinite(number)) throw new ToolProblem('the argument pull_number is required');
      const pull = rec.pulls.get(Math.trunc(number));
      if (pull === undefined) throw new ToolProblem(`pull request ${number} was not found`);
      const result = mergePull(rec, pull, 'squash');
      if ('error' in result) throw new ToolProblem(result.error === 'conflict' ? 'the pull request has conflicts' : 'the pull request is not mergeable');
      return pullJson(rec, pull);
    }
    default:
      throw new ToolProblem(`unknown tool ${name}`);
  }
}

export interface McpOutcome {
  status: number;
  payload: unknown;
}

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcError(id: unknown, code: number, message: string): { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): { jsonrpc: '2.0'; id: unknown; result: unknown } {
  return { jsonrpc: '2.0', id, result };
}

/** Handle one JSON-RPC message; null means "no response" (a notification). */
function handleMessage(message: RpcMessage): unknown {
  const id = message.id;
  const isNotification = id === undefined || id === null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id ?? null, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id ?? null, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
    }
    case 'ping':
      return rpcResult(id ?? null, {});
    case 'tools/list':
      return rpcResult(id ?? null, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const def = TOOLS.find((candidate) => candidate.name === name);
      if (def === undefined) return rpcError(id ?? null, -32602, `unknown tool ${name}`);
      for (const required of def.inputSchema.required) {
        const value = args[required];
        if (value === undefined || value === null || value === '') return rpcError(id ?? null, -32602, `missing required argument ${required}`);
      }
      try {
        const value = callTool(name, args);
        return rpcResult(id ?? null, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return rpcResult(id ?? null, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id ?? null, -32601, `method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body. A non-JSON body is the JSON-RPC parse error
 * (-32700) over HTTP 400; batches answer as an array; a lone notification
 * answers 202 with no body.
 */
export function handleMcp(rawBody: Buffer): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, payload: rpcError(null, -32700, 'parse error: the body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => handleMessage((entry ?? {}) as RpcMessage)).filter((entry) => entry !== null);
    return { status: 200, payload: responses };
  }
  const response = handleMessage((parsed ?? {}) as RpcMessage);
  if (response === null) return { status: 202, payload: null };
  return { status: 200, payload: response };
}
