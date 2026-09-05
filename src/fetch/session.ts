/** The per-issue pipeline, shared by the CLI and the MCP server.
 *
 * It deliberately writes nothing to stdout. The CLI prints a path; the MCP server owns stdout for
 * the JSON-RPC stream and a single stray line there kills the session far from its cause. Removing
 * the sink from this module is what makes that structural rather than a convention — a caller gets
 * an `Outcome` and decides how to say it. */

import { join } from '@std/path';
import type { Config } from '../config/config.ts';
import type { FieldResolver } from '../filter/evaluate.ts';
import { preFetchDecision, ticketDecision } from '../filter/evaluate.ts';
import type { JiraClient } from '../jira/client.ts';
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
  | { status: 'written'; key: string; path: string; assets: number; skippedComments: number }
  | { status: 'dryRun'; key: string; path: string; assets: number }
  | { status: 'denied'; key: string; reason: string };

export type SessionOptions = {
  config: Config;
  client: JiraClient;
  /** Progress and filter decisions. Whatever this does, it must not be stdout in MCP mode. */
  log: (message: string) => void;
  dryRun?: boolean;
};

export type FetchSession = {
  /** Runs both filter stages and, if the issue survives them, writes its document and assets. */
  fetch(key: string): Promise<Outcome>;
  /** Issue keys matching a JQL query. Each still goes through `fetch`, filters and all. */
  keys(jql: string): AsyncGenerator<string>;
};

/**
 * Resolves configured field names ("Team") to the `fields` key they occupy
 * ("customfield_10101"). `GET /rest/api/3/field` is called at most once, and only when a `field`
 * predicate exists — a config without one never touches the endpoint.
 */
const makeFieldResolver = async (
  client: JiraClient,
  names: string[],
  log: (m: string) => void,
): Promise<FieldResolver> => {
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
};

/** Resolves custom-field names once, then hands back a session over that resolution. */
export const createSession = async (opts: SessionOptions): Promise<FetchSession> => {
  const { config, client, log } = opts;
  const resolveField = await makeFieldResolver(client, config.filters.fieldNames, log);

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
    if (manifest.size > 0) {
      const result = await downloadAssets(
        client,
        manifest,
        join(config.outDir, assetDirName(issue.key)),
        log,
      );
      // stderr, so this is safe in both modes.
      for (const failure of result.failures) {
        console.error(`  ${key}: attachment ${failure.filename} failed — ${failure.error}`);
      }
    }

    await Deno.writeTextFile(path, markdown);
    return { status: 'written', key: issue.key, path, assets: manifest.size, skippedComments };
  };

  return { fetch, keys: (jql: string) => client.searchIssueKeys(jql) };
};
