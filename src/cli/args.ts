import { parseArgs } from '@std/cli/parse-args';
import type { ConfigFile } from '../config/schema.ts';

export const VERSION = '0.4.0';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** The flags that also exist as config keys are derived from the schema; the rest are CLI-only
 * and have no config-file counterpart. */
export type Args = Pick<ConfigFile, 'baseUrl' | 'email' | 'token' | 'out'> & {
  /** `fetch` writes documents for the keys below; `mcp` serves the same pipeline over stdio and
   * takes its keys from tool calls instead. */
  mode: 'fetch' | 'mcp';
  keys: string[];
  jql?: string;
  config?: string;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
};

/** Shared with the MCP server, which validates the keys a client sends against the same shape.
 * Anything looser reaches `GET /rest/api/3/issue/{key}` as path segments. */
export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** The one subcommand. Matched as an exact literal rather than "not an issue key", so a typo is a
 * usage error naming the bad key instead of a server nobody asked for. */
const MCP_COMMAND = 'mcp';

export const HELP = `jira-fetch ${VERSION}
Fetch Jira Cloud issues into Markdown files with YAML frontmatter.

USAGE
  jira-fetch <ISSUE-KEY>...          fetch one or more issues by key
  jira-fetch --jql "<JQL>"           fetch every issue matching a query
  jira-fetch mcp                     serve the same pipeline over MCP on stdio

OPTIONS
  -o, --out <dir>      output directory (default: current directory)
  -c, --config <path>  config file to use, skipping discovery
      --base-url <url> Jira site, e.g. https://your-site.atlassian.net
      --email <email>  Atlassian account email
      --token <token>  Atlassian API token
      --jql <query>    fetch by JQL; refused when the config sets allowJql: false
  -n, --dry-run        report what would be fetched and filtered; write nothing
  -v, --verbose        per-issue progress and filter decisions on stderr
  -h, --help           show this help
      --version        show the version

CONFIGURATION
  Resolved per key: CLI flags, then environment, then .env, then the config file.
    JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_FETCH_OUT
    .env and .env.local           nearest ancestor directory that has either
    .jira-fetch[.conf].yml|.yaml|.json    searched upward from the working directory
    jira-fetch.conf.yml|.yaml|.json       same, without the leading dot
    ~/.config/jira-fetch[.conf].yml|.yaml|.json
    ~/.jira-fetch.conf.yml|.yaml|.json

  The nearest config file found is the only one read; configurations never layer. Commit one
  to a project and its filters apply to everyone working in that tree. Your API token is not
  part of that: keep it in .env.local, the environment, or --token.

  Or keep both in ~/.config/jira-fetch.yaml, the token key included, so that nothing about your
  Jira access lives in the project. A token there raises no warning; chmod 600 the file. That
  is the setup that matters when the caller is an agent; see MCP SERVER below.

  Only the file can set these:
    filters     which tickets are fetched, and which comments end up in the document
    people      which of reporter/assignee/commenter appear, and how much each says
    allowJql    when false, --jql is refused

MCP SERVER
  jira-fetch mcp speaks the Model Context Protocol on stdin/stdout, for Claude Code and other
  MCP clients. It offers two tools and no others:

    fetch_issues    write documents for the given issue keys
    search_issues   the same, for every issue a JQL query matches
                    (not offered at all when the config sets allowJql: false)

  Both write into the output directory fixed at startup and return links to what they wrote.
  There is no tool that changes anything in Jira, and none takes a path. The config's filters
  decide which issues may be fetched; a client cannot override them.

  Serving an agent that can also edit the project, start it like this:

    claude mcp add --scope user jira-fetch -- \\
      jira-fetch mcp --config /home/you/.config/jira-fetch.yaml

  --config skips discovery, so a .jira-fetch.yml appearing in the tree cannot shadow the
  policy, and --scope user keeps the launch command out of the tree too. Spell the path in
  full: a spawned process does not expand ~. Put the token in that file and unset
  JIRA_API_TOKEN: the environment outranks the file, and an exported token is one the
  agent's own shell can send to Jira without going through this server at all. See the README.

OUTPUT
  <out>/<ISSUE-KEY>.md         the document (overwritten if it already exists)
  <out>/.<ISSUE-KEY>/          its attachments

EXIT CODES
  0 success   1 runtime error   2 usage or config error
  3 nothing written because every issue was excluded by a filter
`;

export function parseCliArgs(argv: string[]): Args {
  const parsed = parseArgs(argv, {
    string: ['out', 'config', 'base-url', 'email', 'token', 'jql'],
    boolean: ['dry-run', 'verbose', 'help', 'version'],
    alias: {
      o: 'out',
      c: 'config',
      n: 'dry-run',
      v: 'verbose',
      h: 'help',
    },
    unknown: (arg) => {
      if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
      return true;
    },
  });

  const positional = parsed._.map((raw) => String(raw).trim());
  const mcp = positional[0] === MCP_COMMAND;

  const args: Args = {
    mode: mcp ? 'mcp' : 'fetch',
    keys: [],
    jql: parsed.jql || undefined,
    out: parsed.out || undefined,
    config: parsed.config || undefined,
    baseUrl: parsed['base-url'] || undefined,
    email: parsed.email || undefined,
    token: parsed.token || undefined,
    dryRun: parsed['dry-run'],
    verbose: parsed.verbose,
    help: parsed.help,
    version: parsed.version,
  };

  if (args.help || args.version) return args;

  if (mcp) {
    // The tools are the interface in this mode, so anything that names work up front is a
    // mistake worth catching at startup rather than an argument silently ignored for the life
    // of a long-running server.
    if (positional.length > 1) {
      throw new UsageError(`"${positional[1]}": jira-fetch mcp takes no issue keys`);
    }
    if (args.jql) throw new UsageError('--jql has no meaning for mcp; use the search_issues tool');
    if (args.dryRun) throw new UsageError('--dry-run has no meaning for mcp');
    return args;
  }

  const seen = new Set<string>();
  for (const key of positional) {
    if (!ISSUE_KEY.test(key)) {
      throw new UsageError(`"${key}" is not an issue key (expected something like DN-1243)`);
    }
    const normalized = key.toUpperCase();
    // Duplicates would fetch and overwrite the same file twice.
    if (!seen.has(normalized)) {
      seen.add(normalized);
      args.keys.push(normalized);
    }
  }

  if (args.keys.length === 0 && !args.jql) {
    throw new UsageError('nothing to fetch: pass an issue key or --jql');
  }

  return args;
}
