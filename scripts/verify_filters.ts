/** Verifies the filter engine against the real Jira site, not a fake one.
 *
 * `deno task verify:filters`. Deliberately **not** part of `deno test -A`: that suite is sealed —
 * no credentials, no network — and must stay that way. This is the complement to it. The sealed
 * suite proves what goes on the wire (`test/fake_jira.ts` records every request); only a real site
 * can prove that a rule written against real field names, real statuses and real components picks
 * out the tickets a person expects.
 *
 * Two properties make it a test rather than a snapshot:
 *
 *   - **Expectations are computed, not hardcoded.** Each ticket is fetched once, its real
 *     attributes are read off the payload, and a deliberately dumb oracle in this file decides
 *     which tickets a scenario should keep. Nothing is imported from `src/filter/`, so agreement
 *     between the two is evidence. Hardcoding the answers would only prove the site had not
 *     changed.
 *   - **The real pipeline runs.** Scenarios go through `createSession`, so both filter stages,
 *     the custom-field resolver and the document writer are the ones the CLI and the MCP server
 *     use.
 *
 * Documents land in `tmp/filters/<scenario>/` and are left there on purpose: the run doubles as a
 * way to look at what the tool actually produces for real tickets.
 */

import { join } from '@std/path';
import { loadDotenv, resolveConfig } from '../src/config/config.ts';
import { ConfigError } from '../src/config/errors.ts';
import { JiraClient } from '../src/jira/client.ts';
import { compileFilters } from '../src/filter/rules.ts';
import { People } from '../src/config/schema.ts';
import type { FiltersConfig } from '../src/config/schema.ts';
import { createSession } from '../src/fetch/session.ts';
import type { Config } from '../src/config/config.ts';
import type { JiraIssue } from '../src/jira/types.ts';

const REPO = new URL('..', import.meta.url).pathname;
const OUT_ROOT = join(REPO, 'tmp', 'filters');

/** The corpus, chosen for the attributes it spans rather than for being recent: several issue
 * types, a wide spread of statuses (including the ones a workflow only reaches at the end), single
 * and multiple components, tickets with labels and without, assigned and unassigned, and three
 * different projects so `project` — the only predicate decidable without fetching — has something
 * to bite on. Attachments and comments come along for free and are what makes the written
 * documents worth reading. */
const CORPUS = [
  'DN-1365', // Bug / Selected for Development / component Semantic-Model
  'DN-1364', // Task / In Progress / labels ai-gen-ticket, technical-excellence
  'DN-1351', // Bug / Cancelled / label ai-gen-ticket / component Business-Rules
  'DN-1346', // Bug / Backlog / labels ai-gen-ticket, tech-debt / unassigned
  'DN-1345', // Bug / TEST REVIEW / 4 attachments incl. video / component Data-Grid
  'DN-1344', // Bug / Technical Test / 4 attachments / 3 comments / component Staging
  'DN-1333', // Task / TEST REVIEW / four components / label regressiontest
  'DN-1352', // Story / Selected for Development / text attachment
  'DG-4242', // Task / In Progress / component grpc
  'DG-4244', // Improvement / Backlog / three labels / unassigned
  'DV-42', //  Task / To Do / label security
  'DV-44', //  Story / Done
];

/** What the oracle reads. Deliberately flat strings: the point is to compare against something
 * simpler than the thing under test. */
type Facts = {
  key: string;
  project: string;
  type: string | null;
  status: string | null;
  labels: string[];
  components: string[];
  reporter: string | null;
  assignee: string | null;
  summary: string;
  attachments: number;
  /** The `Team` custom field (customfield_10001), read as Jira sends it: an object with a `name`.
   * The only *custom* field in the table — everything else here is built in, and without it the
   * live run would never exercise name resolution against `GET /rest/api/3/field`. */
  team: string | null;
};

const factsOf = (issue: JiraIssue): Facts => ({
  key: issue.key,
  project: issue.key.slice(0, issue.key.lastIndexOf('-')),
  type: issue.fields.issuetype?.name ?? null,
  status: issue.fields.status?.name ?? null,
  labels: issue.fields.labels ?? [],
  components: (issue.fields.components ?? []).map((c) => c.name ?? '').filter((n) => n !== ''),
  reporter: issue.fields.reporter?.displayName ?? null,
  assignee: issue.fields.assignee?.displayName ?? null,
  summary: issue.fields.summary ?? '',
  attachments: (issue.fields.attachment ?? []).length,
  team: teamName(issue.fields.customfield_10001),
});

const teamName = (raw: unknown): string | null =>
  typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string'
    ? (raw as { name: string }).name
    : null;

/** A rule as the oracle understands it: the same shape as `TicketRule`, read literally.
 *
 * `field` is limited to the built-in names the corpus exercises, and the oracle maps each to the
 * fact it means. That is the independence: `src/filter/` gets there through
 * `GET /rest/api/3/field` and `issue.fields[id]`, this gets there by knowing what "Status" means.
 * If the two ever disagree, one of them is wrong and the run says so. */
const FIELD_FACTS: Record<string, (f: Facts) => string[]> = {
  'status': (f) => (f.status === null ? [] : [f.status]),
  'issue type': (f) => (f.type === null ? [] : [f.type]),
  'components': (f) => f.components,
  'labels': (f) => f.labels,
  'team': (f) => (f.team === null ? [] : [f.team]),
};

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `null` in a value list means "absent", so an empty fact list matches only when null is listed. */
const literalMatch = (accepted: Array<string | null>, present: string[]): boolean =>
  present.length === 0
    ? accepted.includes(null)
    : present.some((value) => accepted.some((a) => a !== null && eq(a, value)));

const oracleRuleMatches = (rule: Record<string, unknown>, f: Facts): boolean => {
  for (const [predicate, raw] of Object.entries(rule)) {
    switch (predicate) {
      case 'project':
        if (!(raw as string[]).some((p) => eq(p, f.project))) return false;
        break;
      case 'labels':
      case 'tags':
        if (!literalMatch(raw as Array<string | null>, f.labels)) return false;
        break;
      case 'reporter':
        if (!literalMatch(raw as Array<string | null>, f.reporter ? [f.reporter] : [])) {
          return false;
        }
        break;
      case 'assignee':
        if (!literalMatch(raw as Array<string | null>, f.assignee ? [f.assignee] : [])) {
          return false;
        }
        break;
      case 'title': {
        const { matches, flags } = raw as { matches: string; flags?: string };
        if (!new RegExp(matches, flags ?? '').test(f.summary)) return false;
        break;
      }
      case 'field':
        for (const [name, values] of Object.entries(raw as Record<string, Array<string | null>>)) {
          const read = FIELD_FACTS[name.toLowerCase()];
          if (!read) throw new Error(`the oracle has no reading for field "${name}"`);
          if (!literalMatch(values, read(f))) return false;
        }
        break;
      default:
        throw new Error(`the oracle has no reading for predicate "${predicate}"`);
    }
  }
  return true;
};

/** Exclude beats include; an empty include list means "everything is included". Stated here in
 * four lines so the precedence the docs promise is checked against something other than the
 * implementation of it. */
const oracleKeeps = (filters: FiltersConfig, f: Facts): boolean => {
  const rules = (list: unknown) => (list ?? []) as Array<Record<string, unknown>>;
  if (rules(filters.exclude).some((r) => oracleRuleMatches(r, f))) return false;
  const include = rules(filters.include);
  return include.length === 0 || include.some((r) => oracleRuleMatches(r, f));
};

type Scenario = { name: string; filters: FiltersConfig };

const SCENARIOS: Scenario[] = [
  { name: 'no-filters', filters: {} },

  // --- deny only ---
  { name: 'deny-project', filters: { exclude: [{ project: ['DV', 'DG'] }] } },
  {
    name: 'deny-status',
    filters: { exclude: [{ field: { Status: ['Cancelled', 'Done', 'Backlog'] } }] },
  },
  { name: 'deny-type', filters: { exclude: [{ field: { 'Issue Type': ['Bug'] } }] } },
  { name: 'deny-label', filters: { exclude: [{ labels: ['ai-gen-ticket'] }] } },
  {
    name: 'deny-component',
    filters: { exclude: [{ field: { Components: ['Staging', 'grpc'] } }] },
  },
  { name: 'deny-unassigned', filters: { exclude: [{ assignee: [null] }] } },
  {
    // The custom-field path: "Team" has to be resolved through GET /rest/api/3/field to
    // customfield_10001, and its value is an object Jira answers with, not a string.
    name: 'deny-custom-field-team',
    filters: { exclude: [{ field: { Team: ['Backend'] } }] },
  },
  {
    // Matches DN-1333 ("Auto. Regressiontest: ...") and DG-4242 ("gRPC Server - ..."), so the
    // scenario is not vacuous — a regex matching nothing passes trivially and proves only that
    // the run happened. The `i` flag is load-bearing for the second: the summary says "gRPC".
    name: 'deny-title-regex',
    filters: { exclude: [{ title: { matches: '^(auto\\.|grpc)', flags: 'i' } }] },
  },
  {
    // The same two tickets, written in the casing the summaries actually use and with no flag.
    // Dropping the same pair is what shows the `i` above is doing the work rather than the engine
    // lower-casing summaries behind the scenes — a scenario that kept everything could not tell
    // that apart from title predicates being broken outright.
    name: 'deny-title-case-sensitive',
    filters: { exclude: [{ title: { matches: '^(Auto\\.|gRPC)' } }] },
  },

  // --- allow only ---
  { name: 'allow-project', filters: { include: [{ project: ['DN'] }] } },
  { name: 'allow-type', filters: { include: [{ field: { 'Issue Type': ['Bug', 'Story'] } }] } },
  { name: 'allow-label', filters: { include: [{ labels: ['ai-gen-ticket', 'security'] }] } },
  {
    name: 'allow-team',
    filters: { include: [{ field: { Team: ['Frontend'] } }] },
  },
  {
    // Most of the corpus has no Team at all, so `null` — "absent" — is the only way to select
    // them. That the two partition the corpus is the property worth having.
    name: 'allow-team-absent',
    filters: { include: [{ field: { Team: [null] } }] },
  },
  {
    name: 'allow-two-rules-or',
    filters: { include: [{ project: ['DV'] }, { labels: ['tech-debt'] }] },
  },
  {
    name: 'allow-one-rule-and',
    // Both predicates in one rule: a DN ticket that also carries the label. Narrower than the OR
    // above by construction, which is the property being checked.
    filters: { include: [{ project: ['DN'], labels: ['ai-gen-ticket'] }] },
  },

  // --- allow and deny together ---
  {
    name: 'both-exclude-beats-include',
    // DN-1351 satisfies the include rule and the exclude rule. Exclude must win.
    filters: {
      include: [{ project: ['DN'] }],
      exclude: [{ field: { Status: ['Cancelled'] } }],
    },
  },
  {
    name: 'both-project-in-status-out',
    filters: {
      include: [{ project: ['DN', 'DG'] }],
      exclude: [{ field: { Status: ['Backlog', 'Cancelled', 'Done'] } }],
    },
  },
  {
    name: 'both-narrow-allow-wide-deny',
    filters: {
      include: [{ field: { 'Issue Type': ['Bug'] } }],
      exclude: [{ labels: ['ai-gen-ticket'] }, { project: ['DG', 'DV'] }],
    },
  },
  {
    name: 'both-everything-denied',
    // The include list can never be satisfied once the exclude list covers it: a real config
    // mistake, and the exit code is how a user finds out.
    filters: {
      include: [{ project: ['DV'] }],
      exclude: [{ project: ['DV'] }],
    },
  },
];

/** Scenarios whose point is that the run *fails*. Expectations are about the error, so they are
 * kept apart from the table above rather than given a fake key set. */
const REJECTED: Array<{ name: string; filters: FiltersConfig; expect: string[] }> = [
  {
    name: 'reject-unknown-field',
    // Fails open before this was fixed: the rule matched nothing, so it denied nothing.
    filters: { exclude: [{ field: { Teem: ['Platform'] } }] },
    expect: ['Teem', 'does not exist'],
  },
  {
    name: 'reject-ambiguous-field',
    // "Category" is two different custom fields on this site. Resolving it to whichever the API
    // listed last would make the rule mean different things on different days.
    filters: { exclude: [{ field: { Category: ['anything'] } }] },
    expect: ['ambiguous'],
  },
];

const slug = (name: string) => name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

const configFor = (base: Config, filters: FiltersConfig, outDir: string): Config => ({
  ...base,
  outDir,
  filters: compileFilters(filters),
  people: People.parse({}),
});

const run = async (): Promise<number> => {
  const cwd = REPO;
  const env = {
    ...await loadDotenv(cwd),
    ...Object.fromEntries(
      ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].map((k) => [k, Deno.env.get(k)])
        .filter(([, v]) => v !== undefined),
    ),
  };

  let base: Config;
  try {
    // No config file: the scenarios below are the filters under test, and a discovered
    // `.jira-fetch.yml` would silently change every expectation in this file.
    base = resolveConfig({ flags: {}, env, cwd });
  } catch (cause) {
    if (cause instanceof ConfigError) {
      console.error(`skipped: no Jira credentials available (${cause.message})`);
      console.error(
        '  set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN, or put them in .env.local',
      );
      return 0;
    }
    throw cause;
  }

  const client = new JiraClient({
    baseUrl: base.baseUrl,
    email: base.email,
    token: base.token,
  });

  console.log(`site: ${base.baseUrl}`);
  console.log(`corpus: ${CORPUS.length} issues\n`);

  const facts: Facts[] = [];
  for (const key of CORPUS) {
    facts.push(factsOf(await client.getIssue(key)));
  }

  console.log('the corpus, as the site actually has it:');
  for (const f of facts) {
    console.log(
      `  ${f.key.padEnd(9)} ${(f.type ?? '-').padEnd(12)} ${(f.status ?? '-').padEnd(24)}` +
        ` team=${f.team ?? '-'}`.padEnd(16) +
        ` labels=${f.labels.join(',') || '-'}`.padEnd(46) +
        ` components=${f.components.join(',') || '-'}`.padEnd(42) +
        ` assignee=${f.assignee ?? 'NONE'}`,
    );
  }
  console.log();

  await Deno.mkdir(OUT_ROOT, { recursive: true });

  let failures = 0;
  for (const scenario of SCENARIOS) {
    const expected = facts.filter((f) => oracleKeeps(scenario.filters, f)).map((f) => f.key);
    const outDir = join(OUT_ROOT, slug(scenario.name));
    await Deno.mkdir(outDir, { recursive: true });

    const session = await createSession({
      config: configFor(base, scenario.filters, outDir),
      client,
      log: () => {},
    });

    const actual: string[] = [];
    for (const key of CORPUS) {
      const outcome = await session.fetch(key);
      if (outcome.status === 'written') actual.push(outcome.key);
    }

    const ok = expected.join(',') === actual.join(',');
    if (!ok) failures++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'}  ${scenario.name.padEnd(28)} kept ${actual.length}/${CORPUS.length}`,
    );
    if (!ok) {
      console.log(`        oracle expected: ${expected.join(' ') || '(none)'}`);
      console.log(`        the engine kept: ${actual.join(' ') || '(none)'}`);
      const missing = expected.filter((k) => !actual.includes(k));
      const extra = actual.filter((k) => !expected.includes(k));
      if (missing.length > 0) console.log(`        wrongly dropped: ${missing.join(' ')}`);
      if (extra.length > 0) console.log(`        wrongly kept:    ${extra.join(' ')}`);
    }
  }

  // Rules that cannot be resolved against this site must stop the run rather than quietly
  // denying nothing, so these assert on the failure itself.
  for (const scenario of REJECTED) {
    let message: string | undefined;
    try {
      await createSession({
        config: configFor(base, scenario.filters, join(OUT_ROOT, slug(scenario.name))),
        client,
        log: () => {},
      });
    } catch (cause) {
      if (!(cause instanceof ConfigError)) throw cause;
      message = cause.message;
    }
    const ok = message !== undefined && scenario.expect.every((part) => message.includes(part));
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${scenario.name.padEnd(28)} rejected at startup`);
    if (!ok) {
      console.log(
        message === undefined
          ? '        expected a ConfigError; the run was allowed to proceed'
          : `        message did not mention ${scenario.expect.join(', ')}: ${message}`,
      );
    }
  }

  console.log(`\ndocuments written under ${OUT_ROOT}`);
  console.log(
    failures === 0
      ? `all ${SCENARIOS.length + REJECTED.length} scenarios behaved as specified`
      : `${failures} of ${SCENARIOS.length + REJECTED.length} scenarios did not`,
  );
  return failures === 0 ? 0 : 1;
};

if (import.meta.main) {
  Deno.exit(await run());
}
