/** Entry point: resolve configuration, enumerate candidate issues, and write one Markdown
 * document per issue that survives the filters. */

import { type Args, HELP, parseCliArgs, UsageError, VERSION } from './cli/args.ts';
import { type Config, ConfigError, loadProjectConfig, resolveConfig } from './config/config.ts';
import { configPathFor, findProjectRoot, userConfigDir } from './config/location.ts';
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

/**
 * Everything ambient a run depends on, injectable so the suite can be hermetic.
 *
 * This matters more than it looks. The config file for a project is found by walking up for
 * `.git` and then deriving a filename in the user's config directory — so a test that let either
 * of those be computed would resolve the **real** configuration for this very repository, token
 * included. Nothing asserts the token, so the leak would not turn the suite red; it would just
 * quietly stop being hermetic.
 *
 * Any new entry point that calls `run` from a test must pass both `projectRoot` and `configDir`.
 */
export type RunDeps = {
  cwd?: string;
  /** When given, used **verbatim**: no walk for `.git` happens. */
  projectRoot?: string;
  /** When given, used **verbatim**: `$HOME` and `%APPDATA%` are never consulted. */
  configDir?: string;
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

  let config: Config;
  try {
    const projectRoot = deps.projectRoot ?? await findProjectRoot(cwd);
    const filePath = configPathFor(projectRoot, deps.configDir ?? userConfigDir());

    config = resolveConfig({
      flags: { out: args.out },
      file: await loadProjectConfig(filePath, projectRoot),
      filePath,
      cwd,
    });
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(`error: ${cause.message}`);
      return EXIT.usageError;
    }
    throw cause;
  }

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
    log(`config: ${config.configPath}`);
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

  log(`config: ${config.configPath}`);
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
