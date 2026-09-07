/** The per-issue pipeline, shared by the CLI and the MCP server.
 *
 * It deliberately writes nothing to stdout. The CLI prints a path; the MCP server owns stdout for
 * the JSON-RPC stream and a single stray line there kills the session far from its cause. Removing
 * the sink from this module is what makes that structural rather than a convention — a caller gets
 * an `Outcome` and decides how to say it. */

import { join } from '@std/path';
import type { Config } from '../config/config.ts';
import { ConfigError } from '../config/errors.ts';
import type { FieldResolver } from '../filter/evaluate.ts';
import { preFetchDecision, ticketDecision } from '../filter/evaluate.ts';
import type { JiraClient } from '../jira/client.ts';
import type { JiraFieldMeta } from '../jira/types.ts';
import { assetDirName, buildManifest, downloadAssets } from '../assets/download.ts';
import { assembleDocument } from '../document/assemble.ts';
import type { IssueRef } from '../jira/types.ts';

/** What became of one issue key.
 *
 * `reason` names the rule that matched, and has exactly one consumer: the CLI's `--verbose` line.
 * The MCP layer never reads it — `rule.label` is `JSON.stringify(rule)`, so the string *is* the
 * serialised policy. There is deliberately no `stage` field either: a caller that cannot tell a
 * pre-fetch denial from a payload denial cannot leak the difference, and none needs to. */
export type Outcome =
  | {
    status: 'written';
    key: string;
    path: string;
    /** Attachments that actually landed on disk, not the number the issue listed. A caller that
     * reported the planned count would tell an agent to follow links to files that are not
     * there — the CLI's operator sees the failure on stderr, an agent never does. */
    assets: number;
    failedAssets: number;
    skippedComments: number;
  }
  | { status: 'dryRun'; key: string; path: string; assets: number }
  | { status: 'denied'; key: string; reason: string };

export type SessionOptions = {
  config: Config;
  client: JiraClient;
  /** Progress and filter decisions. Whatever this does, it must not be stdout in MCP mode. */
  log: (message: string) => void;
  dryRun?: boolean;
  /**
   * Where the field catalogue comes from. Defaults to the live client call, which is what seals
   * the suite: a test constructing a session gets live behaviour without having to know that a
   * cache exists, and only `src/main.ts` opts into the cached source.
   */
  fields?: FieldSource;
};

export type FetchSession = {
  /** Runs both filter stages and, if the issue survives them, writes its document and assets. */
  fetch(key: string): Promise<Outcome>;
  /** Issue keys matching a JQL query. Each still goes through `fetch`, filters and all. */
  keys(jql: string): AsyncGenerator<string>;
};

/**
 * Resolves configured field names ("Team") to the key they occupy in `issue.fields`
 * ("customfield_10101"). `GET /rest/api/3/field` is called at most once, and only when a `field`
 * predicate exists — a config without one never touches the endpoint.
 *
 * **A name that cannot be resolved to exactly one field is a configuration error, not a warning.**
 * It used to be treated as "absent", which reads reasonably until you notice what it does to the
 * two rule lists. An `exclude` rule on an unresolvable name matches nothing, so it **denies
 * nothing** — `exclude: [{field: {Teem: [...]}}]` is a deny rule that silently does not deny, and
 * `Team` and `Teams` can both exist on one site. An `include` rule on the same name matches
 * nothing either, so it denies *everything* and the user gets an empty run with no explanation.
 * Both are silent, and since this same block is what an agent's access is decided by, failing
 * open is the wrong direction to be wrong in. Fail loudly, at startup, before a single issue is
 * fetched.
 *
 * Ambiguity is an error for the same reason. Jira Cloud allows two custom fields to share a name,
 * and this site has four such pairs; picking whichever the API happened to list last would make
 * the meaning of a rule depend on the response order.
 */
/** The field catalogue, and a way to insist on a fresh one.
 *
 * Two methods rather than one because a *cached* catalogue can manufacture an error that is simply
 * wrong: a field renamed on the site since the last refresh reads as "does not exist". So the
 * resolver asks again, live, before it refuses — see `makeFieldResolver`. */
export type FieldSource = {
  get(): Promise<FieldCatalogEntry[]>;
  /** Bypasses any cache. Called only when `get()` produced a catalogue that fails to resolve. */
  refresh(): Promise<FieldCatalogEntry[]>;
};

/** Derived from the wire type so `client.getFields()` satisfies it with no adapter, and narrowed to
 * the three properties resolution reads. */
export type FieldCatalogEntry = Pick<JiraFieldMeta, 'id' | 'name'> & { key?: string };

/** Builds the resolution maps and reports which of `names` they cannot answer.
 *
 * Separated from the throwing half so the whole thing can be run twice against two catalogues.
 */
const buildResolver = (
  entries: FieldCatalogEntry[],
  names: string[],
): { resolve: FieldResolver; problems: string[] } => {
  // Ids and keys are unique, names are not, so they cannot share one map: a name resolving to two
  // fields has to stay visible as two rather than collapsing to the last one written.
  const byId = new Map<string, string>();
  const byName = new Map<string, Set<string>>();
  for (const field of entries) {
    byId.set(field.id.toLowerCase(), field.id);
    if (field.key) byId.set(field.key.toLowerCase(), field.id);
    const existing = byName.get(field.name.toLowerCase()) ?? new Set<string>();
    existing.add(field.id);
    byName.set(field.name.toLowerCase(), existing);
  }

  const resolve = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    // An exact id or key wins over a display name, so a raw `customfield_10078` is always an
    // unambiguous way to say what you mean — which is what the ambiguity error tells you to use.
    const byExactId = byId.get(lower);
    if (byExactId) return byExactId;
    const candidates = byName.get(lower);
    return candidates?.size === 1 ? [...candidates][0] : undefined;
  };

  const problems: string[] = [];
  for (const name of names) {
    if (resolve(name) !== undefined) continue;
    const candidates = byName.get(name.toLowerCase());
    problems.push(
      candidates && candidates.size > 1
        ? `field "${name}" is ambiguous on this site — ${candidates.size} fields share that name ` +
          `(${[...candidates].join(', ')}); use the id of the one you mean`
        : `field "${name}" does not exist on this site`,
    );
  }
  return { resolve, problems };
};

const makeFieldResolver = async (
  source: FieldSource,
  names: string[],
  log: (m: string) => void,
): Promise<FieldResolver> => {
  if (names.length === 0) return () => undefined;

  log('  resolving custom field names...');
  let { resolve, problems } = buildResolver(await source.get(), names);

  if (problems.length > 0) {
    // The catalogue may have come from a cache, and a field renamed since it was written reads as
    // one that does not exist. One request, on the error path only, so the error a run dies on is a
    // live fact — which is what earns the right to refuse rather than warn.
    log('  a configured field name did not resolve; checking the live field list...');
    ({ resolve, problems } = buildResolver(await source.refresh(), names));
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `filters name fields this Jira site does not resolve:\n${
        problems.map((p) => `  - ${p}`).join('\n')
      }`,
    );
  }

  return resolve;
};

/** Resolves custom-field names once, then hands back a session over that resolution. */
export const createSession = async (opts: SessionOptions): Promise<FetchSession> => {
  const { config, client, log } = opts;
  const fields: FieldSource = opts.fields ??
    { get: () => client.getFields(), refresh: () => client.getFields() };
  const resolveField = await makeFieldResolver(fields, config.filters.fieldNames, log);

  const fetch = async (key: string): Promise<Outcome> => {
    const pre = preFetchDecision(key, config.filters);
    if (pre.excluded) {
      log(`  ${key}: skipped before fetching — ${pre.reason}`);
      return { status: 'denied', key, reason: pre.reason ?? '' };
    }

    const issue = await client.getIssue(key);

    // Stage 2 runs here, before comments are paginated and before a single byte of any attachment
    // is downloaded — that is where the cost and every disk write live.
    const decision = ticketDecision(issue, config.filters, resolveField);
    if (decision.excluded) {
      log(`  ${key}: skipped — ${decision.reason}`);
      return { status: 'denied', key, reason: decision.reason ?? '' };
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
      people: config.people,
    });
    if (skippedComments > 0) log(`  ${key}: ${skippedComments} comment(s) dropped by filter`);

    const path = join(config.outDir, `${issue.key}.md`);

    if (opts.dryRun) return { status: 'dryRun', key: issue.key, path, assets: manifest.size };

    await Deno.mkdir(config.outDir, { recursive: true });
    let downloaded = 0;
    let failedAssets = 0;
    if (manifest.size > 0) {
      const result = await downloadAssets(
        client,
        manifest,
        join(config.outDir, assetDirName(issue.key)),
        log,
      );
      downloaded = result.downloaded;
      failedAssets = result.failures.length;
      // stderr, so this is safe in both modes.
      for (const failure of result.failures) {
        console.error(`  ${key}: attachment ${failure.filename} failed — ${failure.error}`);
      }
    }

    await Deno.writeTextFile(path, markdown);
    return {
      status: 'written',
      key: issue.key,
      path,
      assets: downloaded,
      failedAssets,
      skippedComments,
    };
  };

  return { fetch, keys: (jql: string) => client.searchIssueKeys(jql) };
};
