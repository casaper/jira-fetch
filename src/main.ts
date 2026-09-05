/** Entry point: resolve configuration, enumerate candidate issues, and write one Markdown
 * document per issue that survives the filters. */

import { join } from '@std/path';
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
import { preFetchDecision, ticketDecision } from './filter/evaluate.ts';
import type { FieldResolver } from './filter/evaluate.ts';
import { assetDirName, buildManifest, downloadAssets } from './assets/download.ts';
import { assembleDocument } from './document/assemble.ts';
import type { IssueRef } from './jira/types.ts';

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

/**
 * Resolves configured field names ("Team") to the `fields` key they occupy
 * ("customfield_10101"). `GET /rest/api/3/field` is called at most once, and only when a `field`
 * predicate exists — a config without one never touches the endpoint.
 */
async function makeFieldResolver(
  client: JiraClient,
  names: string[],
  log: (m: string) => void,
): Promise<FieldResolver> {
  if (names.length === 0) return () => undefined;

  log('  resolving custom field names...');
  const byName = new Map<string, string>();
  for (const field of await client.getFields()) {
    byName.set(field.name.toLowerCase(), field.id);
    byName.set(field.id.toLowerCase(), field.id);
    if (field.key) byName.set(field.key.toLowerCase(), field.id);
  }

  for (const name of names) {
    if (!byName.has(name.toLowerCase())) {
      log(`  warning: field "${name}" does not exist on this site; treating it as absent`);
    }
  }

  return (name: string) => byName.get(name.toLowerCase());
}

/** Candidate keys, from explicit arguments first and then from the JQL query. */
async function* candidateKeys(args: Args, client: JiraClient): AsyncGenerator<string> {
  for (const key of args.keys) yield key;
  if (args.jql) yield* client.searchIssueKeys(args.jql);
}

async function fetchOne(
  key: string,
  client: JiraClient,
  config: Config,
  args: Args,
  resolveField: FieldResolver,
  log: (m: string) => void,
  tally: Tally,
): Promise<void> {
  const pre = preFetchDecision(key, config.filters);
  if (pre.excluded) {
    tally.excluded++;
    log(`  ${key}: skipped before fetching — ${pre.reason}`);
    return;
  }

  const issue = await client.getIssue(key);

  // Stage 2 runs here, before comments are paginated and before a single byte of any attachment
  // is downloaded — that is where the cost and every disk write live.
  const decision = ticketDecision(issue, config.filters, resolveField);
  if (decision.excluded) {
    tally.excluded++;
    log(`  ${key}: skipped — ${decision.reason}`);
    return;
  }

  let siblings: IssueRef[] = [];
  const parentKey = issue.fields.parent?.key;
  if (parentKey) {
    siblings = (await client.getSubtasksOf(parentKey)).filter((s) => s.key !== issue.key);
  }

  const manifest = buildManifest(issue.fields.attachment, issue.key);
  const comments = await client.getComments(issue.key);
  log(
    `  ${key}: ${comments.length} comment(s), ${manifest.size} attachment(s)` +
      `${siblings.length > 0 ? `, ${siblings.length} sibling(s)` : ''}`,
  );

  const { markdown, skippedComments } = assembleDocument({
    issue,
    comments,
    siblings,
    assets: manifest,
    baseUrl: config.baseUrl,
    filters: config.filters,
  });
  if (skippedComments > 0) log(`  ${key}: ${skippedComments} comment(s) dropped by filter`);

  const documentPath = join(config.outDir, `${issue.key}.md`);

  if (args.dryRun) {
    console.log(
      `would write ${documentPath}${manifest.size > 0 ? ` + ${manifest.size} asset(s)` : ''}`,
    );
    // Counted so the exit code still distinguishes "would have written something" from
    // "everything was filtered"; the summary line says "would write" rather than "written".
    tally.written++;
    return;
  }

  await Deno.mkdir(config.outDir, { recursive: true });
  if (manifest.size > 0) {
    const result = await downloadAssets(
      client,
      manifest,
      join(config.outDir, assetDirName(issue.key)),
      log,
    );
    for (const failure of result.failures) {
      console.error(`  ${key}: attachment ${failure.filename} failed — ${failure.error}`);
    }
  }

  await Deno.writeTextFile(documentPath, markdown);
  console.log(documentPath);
  tally.written++;
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

  log(`config: ${config.configPath ?? '(none found)'}`);
  log(`site:   ${config.baseUrl}`);
  log(`output: ${config.outDir}${args.dryRun ? ' (dry run)' : ''}`);

  const client = new JiraClient({
    baseUrl: config.baseUrl,
    email: config.email,
    token: config.token,
  });

  const tally: Tally = { written: 0, excluded: 0, errors: 0 };

  try {
    const resolveField = await makeFieldResolver(client, config.filters.fieldNames, log);

    for await (const key of candidateKeys(args, client)) {
      try {
        await fetchOne(key, client, config, args, resolveField, log, tally);
      } catch (cause) {
        // One bad issue must not abort a batch.
        tally.errors++;
        console.error(`error: ${key}: ${(cause as Error).message}`);
      }
    }
  } catch (cause) {
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
