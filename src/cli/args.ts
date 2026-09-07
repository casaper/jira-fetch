import { parseArgs } from '@std/cli/parse-args';
import type { ConfigFile } from '../config/schema.ts';

export const VERSION = '0.5.5';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** `out` is the one flag that also exists as a config key, and it is derived from the schema so a
 * rename there is a compile error here. Everything else is CLI-only.
 *
 * Nothing that decides *which* issues may be fetched can be set from argv, in either mode: the
 * credentials and the filters live in the config file and only there. A flag for them would be a
 * way to talk the tool out of its own policy, which is the thing `jira-fetch mcp` exists to make
 * impossible. */
export type Args = Pick<ConfigFile, 'out'> & {
  /** `fetch` writes documents for the keys below; `mcp` serves the same pipeline over stdio and
   * takes its keys from tool calls instead; `configFile` prints where this project's
   * configuration lives, and `setup` edits it. */
  mode: 'fetch' | 'mcp' | 'configFile' | 'setup';
  keys: string[];
  jql?: string;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
};

/** Shared with the MCP server, which validates the keys a client sends against the same shape.
 * Anything looser reaches `GET /rest/api/3/issue/{key}` as path segments. */
export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Subcommands, matched as exact literals rather than "not an issue key", so a typo is a usage
 * error naming the bad key instead of a mode nobody asked for. */
const COMMANDS = {
  mcp: 'mcp',
  setup: 'setup',
  'config-file': 'configFile',
} as const satisfies Record<string, Args['mode']>;

/**
 * Flags that used to exist, and why each had to go.
 *
 * Kept as messages rather than dropped into the generic "unknown option" path because every one
 * of them was documented, and a reader who tries the old spelling deserves to be told where the
 * setting went rather than left guessing. They are not deprecations: none of them still works.
 */
const REMOVED: Record<string, string> = {
  '--config': '--config was removed: the config file is derived from the git repository you are ' +
    'in, so that nothing can point this tool at a different policy. Run `jira-fetch config-file` ' +
    'to see the path.',
  '-c': '-c was removed (it was short for --config); run `jira-fetch config-file` for the path.',
  '--token': '--token was removed: the API token belongs in the config file, not in a process ' +
    'table or a server definition. Run `jira-fetch setup`.',
  '--base-url': '--base-url was removed: set baseUrl in the config file. Run `jira-fetch setup`.',
  '--email': '--email was removed: set email in the config file. Run `jira-fetch setup`.',
};

export const HELP = `jira-fetch ${VERSION}
Fetch Jira Cloud issues into Markdown files with YAML frontmatter.

USAGE
  jira-fetch <ISSUE-KEY>...          fetch one or more issues by key
  jira-fetch --jql "<JQL>"           fetch every issue matching a query
  jira-fetch mcp                     serve the same pipeline over MCP on stdio
  jira-fetch setup                   configure this project, interactively
  jira-fetch config-file             print the path of this project's config file

OPTIONS
  -o, --out <dir>      output directory (default: current directory)
      --jql <query>    fetch by JQL; refused when the config sets allowJql: false
  -n, --dry-run        report what would be fetched and filtered; write nothing
  -v, --verbose        per-issue progress and filter decisions on stderr
  -h, --help           show this help
      --version        show the version

CONFIGURATION
  One YAML file per project, in your own config directory, and nothing else. No environment
  variables, no .env, no config file inside the project, no flag to point elsewhere.

    ~/.config/jira-fetch/<project-path>.yml     macOS and Linux
    %APPDATA%\\jira-fetch\\<project-path>.yml     Windows

  The name is derived from the git repository you are in, so jira-fetch config-file is the
  only way to be sure which file a run will read. It holds the credentials (baseUrl, email,
  token) and the policy:

    filters     which tickets are fetched, and which comments end up in the document
    people      which of reporter/assignee/commenter appear, and how much each says
    allowJql    when false, --jql is refused and search_issues is not offered at all

  Run jira-fetch setup to create or edit it.

  That the path is derived rather than searched for is the point, not a detail. A file appearing
  inside the project cannot shadow it, no flag can name a different one, and there is no
  environment variable to export — so what an agent may fetch is decided by a file outside the
  tree it works in. See MCP SERVER below.

MCP SERVER
  jira-fetch mcp speaks the Model Context Protocol on stdin/stdout, for Claude Code and other
  MCP clients. It offers two tools and no others:

    fetch_issues    write documents for the given issue keys
    search_issues   the same, for every issue a JQL query matches
                    (not offered at all when the config sets allowJql: false)

  Both write into the output directory fixed at startup and return links to what they wrote.
  There is no tool that changes anything in Jira, and none takes a path. The config's filters
  decide which issues may be fetched; a client cannot override them.

  Serving an agent that can also edit the project, register it once for your user:

    claude mcp add --scope user jira-fetch -- jira-fetch mcp --out docs/jira

  --scope user keeps the launch command out of the project tree. There is nothing else to pass:
  the server finds the same config file this CLI would, and neither a planted file nor an
  exported variable can change which one that is.

  jira-fetch setup also writes deny rules telling Claude Code to keep away from the config
  directory. Those stop the well-behaved path; they are not a sandbox. The only hard boundary is
  what the API token itself is permitted to see on Atlassian's side.

OUTPUT
  <out>/<ISSUE-KEY>.md         the document (overwritten if it already exists)
  <out>/.<ISSUE-KEY>/          its attachments

EXIT CODES
  0 success   1 runtime error   2 usage or config error
  3 nothing written because every issue was excluded by a filter
`;

export function parseCliArgs(argv: string[]): Args {
  const parsed = parseArgs(argv, {
    string: ['out', 'jql'],
    boolean: ['dry-run', 'verbose', 'help', 'version'],
    alias: {
      o: 'out',
      n: 'dry-run',
      v: 'verbose',
      h: 'help',
    },
    unknown: (arg) => {
      // `--flag=value` reaches here whole, so match on the name alone.
      const removed = REMOVED[arg.split('=')[0]];
      if (removed) throw new UsageError(removed);
      if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
      return true;
    },
  });

  const positional = parsed._.map((raw) => String(raw).trim());
  const command = Object.hasOwn(COMMANDS, positional[0] ?? '')
    ? COMMANDS[positional[0] as keyof typeof COMMANDS]
    : undefined;

  const args: Args = {
    mode: command ?? 'fetch',
    keys: [],
    jql: parsed.jql || undefined,
    out: parsed.out || undefined,
    dryRun: parsed['dry-run'],
    verbose: parsed.verbose,
    help: parsed.help,
    version: parsed.version,
  };

  if (args.help || args.version) return args;

  if (command !== undefined) {
    // Neither subcommand fetches anything, so an argument naming work is a mistake worth catching
    // at startup rather than one silently ignored for the life of a long-running server.
    const name = positional[0];
    if (positional.length > 1) {
      throw new UsageError(`"${positional[1]}": jira-fetch ${name} takes no issue keys`);
    }
    if (args.jql) {
      throw new UsageError(
        command === 'mcp'
          ? '--jql has no meaning for mcp; use the search_issues tool'
          : `--jql has no meaning for ${name}`,
      );
    }
    if (args.dryRun) throw new UsageError(`--dry-run has no meaning for ${name}`);
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
