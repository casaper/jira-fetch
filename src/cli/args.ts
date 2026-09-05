import { parseArgs } from '@std/cli/parse-args';
import type { ConfigFile } from '../config/schema.ts';

export const VERSION = '0.3.2';

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** The flags that also exist as config keys are derived from the schema; the rest are CLI-only
 * and have no config-file counterpart. */
export type Args = Pick<ConfigFile, 'baseUrl' | 'email' | 'token' | 'out'> & {
  keys: string[];
  jql?: string;
  config?: string;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
};

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export const HELP = `jira-fetch ${VERSION}
Fetch Jira Cloud issues into Markdown files with YAML frontmatter.

USAGE
  jira-fetch <ISSUE-KEY>...          fetch one or more issues by key
  jira-fetch --jql "<JQL>"           fetch every issue matching a query

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

  The config file is meant to be committed, so that a project's filters apply to everyone
  working in it. Your API token is not: keep it in .env.local, the environment, or --token.

  Only the file can set these:
    filters     which tickets are fetched, and which comments end up in the document
    people      which of reporter/assignee/commenter appear, and how much each says
    allowJql    when false, --jql is refused

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

  const args: Args = {
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

  const seen = new Set<string>();
  for (const raw of parsed._) {
    const key = String(raw).trim();
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
