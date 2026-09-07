import { parseArgs } from '@std/cli/parse-args';
import type { ConfigFile } from '../config/schema.ts';

export const VERSION = '0.5.6';

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
   * configuration lives, `setup` edits it, and `cache` reads this project's Jira metadata so the
   * menus can offer what the site actually contains. */
  mode: 'fetch' | 'mcp' | 'configFile' | 'setup' | 'cache';
  keys: string[];
  jql?: string;
  dryRun: boolean;
  verbose: boolean;
  /** Which page to print, decided here so `main.ts` has one branch rather than a precedence
   * rule spread over two flags and a subcommand. `mcp` is the only subcommand with a page of
   * its own; the CLI page documents the rest. */
  help: 'cli' | 'mcp' | false;
  version: boolean;
  /** What `jira-fetch cache` was asked to do, resolved here so `main.ts` has one branch rather
   * than three flags to weigh against each other. Meaningless in every other mode, and the
   * parser refuses the flags there rather than ignoring them. */
  cacheAction: CacheAction;
  /** Jira project keys named on the line: `jira-fetch cache DN SUP`. Empty means "whichever were
   * chosen last", which is what the cache's own manifest records. These are project keys, not
   * issue keys, and they are the one place a subcommand takes positional arguments. */
  cacheProjects: string[];
};

/** `choose` is the bare `jira-fetch cache`: make sure a project selection exists, then read
 * whatever has gone stale. The other three are the flags. */
export type CacheAction = 'choose' | 'refresh' | 'show' | 'clear';

/** Shared with the MCP server, which validates the keys a client sends against the same shape.
 * Anything looser reaches `GET /rest/api/3/issue/{key}` as path segments. */
export const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** A Jira project key.
 *
 * Shared with `src/cache/`, which validates one before it becomes a filename, and shape-checked for
 * the same reason `ISSUE_KEY` is: it reaches `GET /rest/api/3/issue/createmeta/{key}/issuetypes` as
 * a path segment. One definition, so there is only one place to widen it.
 */
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,30}$/;

/** Subcommands, matched as exact literals rather than "not an issue key", so a typo is a usage
 * error naming the bad key instead of a mode nobody asked for. */
const COMMANDS = {
  mcp: 'mcp',
  setup: 'setup',
  cache: 'cache',
  'config-file': 'configFile',
} as const satisfies Record<string, Args['mode']>;

/** Deliberately not in `COMMANDS`: `help` needs no mode, because it is answered and returned
 * before anything dispatches on one. */
const HELP_COMMAND = 'help';

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

/**
 * Which help page an invocation asks for, if any.
 *
 * `jira-fetch help <command>` and `jira-fetch <command> --help` are alternative spellings of one
 * thing, so they are resolved here together rather than left to agree by coincidence. `mcp` is the
 * only subcommand with a page of its own, so `help setup` lands on the CLI page — which documents
 * `setup`.
 */
const helpPage = (positional: string[], help: boolean, mcpHelp: boolean): Args['help'] => {
  if (positional[0] === HELP_COMMAND) return positional[1] === 'mcp' ? 'mcp' : 'cli';
  if (mcpHelp) return 'mcp';
  if (help) return positional[0] === 'mcp' ? 'mcp' : 'cli';
  return false;
};

/**
 * What `jira-fetch cache` was asked for.
 *
 * One function so the flags cannot be weighed differently in two places, and so "two of them at
 * once" has a single answer. They are mutually exclusive because each describes the whole run:
 * there is no sensible reading of "show it and also clear it".
 */
type CacheFlags = { refresh: boolean; show: boolean; clear: boolean };

/** Which of the three were passed, in a fixed order so an error names them predictably. */
const askedFor = (flags: CacheFlags): CacheAction[] =>
  (['refresh', 'show', 'clear'] as const).filter((name) => flags[name]);

/**
 * What `jira-fetch cache` was asked for.
 *
 * One function so the flags cannot be weighed differently in two places. It does not throw: the
 * refusals live with the other command guards, below the `--help` short-circuit, so
 * `jira-fetch --help` still prints help whatever else is on the line.
 */
const cacheAction = (flags: CacheFlags): CacheAction => askedFor(flags)[0] ?? 'choose';

export function parseCliArgs(argv: string[]): Args {
  const parsed = parseArgs(argv, {
    string: ['out', 'jql'],
    boolean: ['dry-run', 'verbose', 'help', 'mcp-help', 'version', 'refresh', 'show', 'clear'],
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

  if (positional[0] === HELP_COMMAND) {
    // Matched as an exact command for the same reason `COMMANDS` is: a typo should name itself
    // rather than quietly select the general help.
    if (positional.length > 2) {
      throw new UsageError('jira-fetch help takes one command at most');
    }
    const topic = positional[1];
    if (topic !== undefined && !Object.hasOwn(COMMANDS, topic)) {
      throw new UsageError(`no help for "${topic}"; run jira-fetch --help for the commands`);
    }
  }

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
    help: helpPage(positional, parsed.help, parsed['mcp-help']),
    version: parsed.version,
    cacheAction: cacheAction(parsed),
    cacheProjects: [],
  };

  if (args.help || args.version) return args;

  const asked = askedFor(parsed);
  if (command !== 'cache' && asked.length > 0) {
    // Refused rather than ignored, for the same reason an unknown option is: a flag that silently
    // does nothing is worse than one that says where it belongs.
    throw new UsageError(`--${asked[0]} has no meaning outside jira-fetch cache`);
  }
  if (asked.length > 1) {
    // Each describes the whole run, so there is no reading of "show it and also clear it".
    throw new UsageError(
      `--${asked[0]} and --${asked[1]} cannot be combined; each describes the whole run`,
    );
  }

  if (command === 'cache') {
    // The one subcommand that takes positional arguments, and they are project keys rather than
    // issue keys. Shape-checked here because each one reaches a filename and a REST path segment.
    for (const key of positional.slice(1)) {
      if (!PROJECT_KEY.test(key)) {
        throw new UsageError(
          `"${key}" is not a Jira project key (expected something like DN)`,
        );
      }
      if (!args.cacheProjects.includes(key)) args.cacheProjects.push(key);
    }
    if (args.jql) throw new UsageError('--jql has no meaning for cache');
    if (args.dryRun) throw new UsageError('--dry-run has no meaning for cache');
    return args;
  }

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
