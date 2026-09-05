/** Entry point: resolve configuration, enumerate candidate issues, and write one Markdown
 * document per issue that survives the filters. */

import { type Args, HELP, parseCliArgs, UsageError, VERSION } from './cli/args.ts';
import {
  type Config,
  ConfigError,
  discoverConfigFile,
  loadConfigFile,
  loadDotenv,
  resolveConfig,
} from './config/config.ts';
import { JiraClient, JiraError } from './jira/client.ts';
import { createSession, type FetchSession, type Outcome } from './fetch/session.ts';
import { serveMcp } from './mcp/server.ts';

export const EXIT = {
  ok: 0,
  runtimeError: 1,
  usageError: 2,
  allFiltered: 3,
} as const;

interface Tally {
  written: number;
  excluded: number;
  errors: number;
}

function makeLogger(verbose: boolean) {
  return (message: string) => {
    if (verbose) console.error(message);
  };
}

/** Candidate keys, from explicit arguments first and then from the JQL query. */
async function* candidateKeys(args: Args, session: FetchSession): AsyncGenerator<string> {
  for (const key of args.keys) yield key;
  if (args.jql) yield* session.keys(args.jql);
}

/** The CLI's half of an `Outcome`: what it prints, and how it counts. */
function report(outcome: Outcome, tally: Tally): void {
  switch (outcome.status) {
    case 'written':
      console.log(outcome.path);
      tally.written++;
      return;
    case 'dryRun':
      console.log(
        `would write ${outcome.path}` +
          `${outcome.assets > 0 ? ` + ${outcome.assets} asset(s)` : ''}`,
      );
      // Counted so the exit code still distinguishes "would have written something" from
      // "everything was filtered"; the line says "would write" rather than "written".
      tally.written++;
      return;
    case 'denied':
      // The session already logged the reason under --verbose, where it belongs.
      tally.excluded++;
      return;
  }
}

/** The environment variables this tool reads. Listed once so `.env` values and the real
 * environment are merged over exactly the same key set. */
const ENV_KEYS = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_FETCH_OUT'] as const;

/** Only the keys that are actually set: spreading an `undefined` over a `.env` value would erase
 * it, which would silently invert the documented precedence. */
const readProcessEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = Deno.env.get(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/**
 * Everything ambient a run depends on, injectable so the suite can be hermetic.
 *
 * This matters more than it looks: `.env` files are a credential source now, so a test that let
 * the process environment through would pick up whatever `.env` happens to sit above the checkout.
 */
export type RunDeps = {
  /** When given, used **verbatim**: no `.env` file is read and `Deno.env` is not consulted. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Only used to locate the user's own config, and to tell it from a project's. */
  home?: string;
};

export const run = async (argv: string[], deps: RunDeps = {}): Promise<number> => {
  let args: Args;
  try {
    args = parseCliArgs(argv);
  } catch (cause) {
    if (cause instanceof UsageError) {
      console.error(`error: ${cause.message}\n`);
      console.error(HELP);
      return EXIT.usageError;
    }
    throw cause;
  }

  if (args.help) {
    console.log(HELP);
    return EXIT.ok;
  }
  if (args.version) {
    console.log(VERSION);
    return EXIT.ok;
  }

  const log = makeLogger(args.verbose);
  const cwd = deps.cwd ?? Deno.cwd();
  // An explicit `env` means "this run is sealed": no .env, and no home directory either, or a
  // stray ~/.config/jira-fetch.yaml would still leak in through discovery.
  const home = deps.home ?? (deps.env ? undefined : Deno.env.get('HOME') ?? undefined);
  const env = deps.env ?? { ...await loadDotenv(cwd), ...readProcessEnv() };

  let config: Config;
  try {
    const found = args.config
      ? { path: args.config, data: await loadConfigFile(args.config) }
      : await discoverConfigFile(cwd, home);

    config = resolveConfig({
      flags: { baseUrl: args.baseUrl, email: args.email, token: args.token, out: args.out },
      env,
      file: found?.data,
      filePath: found?.path,
      cwd,
      home,
    });
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(`error: ${cause.message}`);
      return EXIT.usageError;
    }
    throw cause;
  }

  for (const warning of config.warnings) console.error(`warning: ${warning}`);

  if (args.jql && !config.allowJql) {
    console.error('error: --jql is disabled by this configuration (allowJql: false)');
    return EXIT.usageError;
  }

  const clientOptions = {
    baseUrl: config.baseUrl,
    email: config.email,
    token: config.token,
  };

  if (args.mode === 'mcp') {
    // The protocol owns stdout from here: one stray line corrupts the JSON-RPC stream and the
    // session dies far from its cause. `src/fetch/session.ts` is what actually prevents that — it
    // writes nothing there — and this throws rather than redirecting to stderr, because a redirect
    // would launder a leak into something `test/mcp_test.ts`'s purity check cannot see.
    console.log = () => {
      throw new Error('stdout belongs to the MCP protocol; write to stderr instead');
    };
    log(`config: ${config.configPath ?? '(none found)'}`);
    log(`site:   ${config.baseUrl}`);
    log(`output: ${config.outDir}`);

    const client = new JiraClient(clientOptions);
    try {
      await serveMcp(await createSession({ config, client, log }), config);
    } catch (cause) {
      // A policy that does not resolve is not a server that should start: it would offer an agent
      // whatever the broken rule failed to deny.
      if (cause instanceof ConfigError) {
        console.error(`error: ${cause.message}`);
        return EXIT.usageError;
      }
      console.error(`error: ${(cause as Error).message}`);
      return EXIT.runtimeError;
    }
    return EXIT.ok;
  }

  log(`config: ${config.configPath ?? '(none found)'}`);
  log(`site:   ${config.baseUrl}`);
  log(`output: ${config.outDir}${args.dryRun ? ' (dry run)' : ''}`);

  const client = new JiraClient(clientOptions);

  const tally: Tally = { written: 0, excluded: 0, errors: 0 };

  try {
    const session = await createSession({ config, client, log, dryRun: args.dryRun });

    for await (const key of candidateKeys(args, session)) {
      try {
        report(await session.fetch(key), tally);
      } catch (cause) {
        // One bad issue must not abort a batch.
        tally.errors++;
        console.error(`error: ${key}: ${(cause as Error).message}`);
      }
    }
  } catch (cause) {
    // A filter naming a field this site does not have is a config error, not a runtime one — the
    // fix is in the file, and the exit code should say so.
    if (cause instanceof ConfigError) {
      console.error(`error: ${cause.message}`);
      return EXIT.usageError;
    }
    // A failure enumerating candidates (bad JQL, auth, network) is fatal for the whole run.
    console.error(`error: ${(cause as Error).message}`);
    if (cause instanceof JiraError || cause instanceof Error) return EXIT.runtimeError;
    throw cause;
  }

  if (args.verbose || tally.excluded > 0 || tally.errors > 0) {
    console.error(
      `done: ${tally.written} ${args.dryRun ? 'would be written' : 'written'}, ` +
        `${tally.excluded} filtered, ${tally.errors} failed`,
    );
  }

  if (tally.written > 0) return EXIT.ok;
  if (tally.errors > 0) return EXIT.runtimeError;
  if (tally.excluded > 0) return EXIT.allFiltered;
  return EXIT.ok;
};

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
