/** Turning a refresh into lines somebody can read.
 *
 * Pure: it returns strings and prints nothing, for the same reason `src/fetch/session.ts` has no
 * sink of its own — the caller decides where output goes, and under `jira-fetch mcp` stdout is the
 * protocol.
 *
 * The wording is the point. A resource that could not be read has to say so in a way that tells
 * the reader whether to act, so every note becomes a phrase rather than a code.
 */

import type { ResourceOutcome } from './metadata.ts';
import type { Resource } from './policy.ts';
import { RESOURCES } from './policy.ts';
import type { CacheNote } from './schema.ts';

/** What each resource is called in the report. Read by a person, so not the identifier. */
const LABELS: Record<Resource, string> = {
  projects: 'projects',
  fields: 'fields',
  labels: 'labels',
  priorities: 'priorities',
  issueTypes: 'issue types',
  fieldOptions: 'field values',
  statuses: 'statuses',
  components: 'components',
  versions: 'versions',
  users: 'people',
  boards: 'boards',
  sprints: 'sprints',
};

/** Why a resource is short, in words. */
export const describeNote = (note: CacheNote): string => {
  const detail = note.detail ? ` (${note.detail})` : '';
  switch (note.code) {
    case 'forbidden':
      return `this token may not read them${detail}`;
    case 'notFound':
      return `this site has no such project${detail}`;
    case 'noneVisible':
      return 'none are visible to this token, which may mean the credentials are wrong';
    case 'truncated':
      return 'there are more than could be read in one go';
    case 'emailsHidden':
      return 'this site does not publish email addresses, so people are listed by name';
    case 'noBoard':
      return 'no Agile board is visible to this account';
    case 'boardWithoutSprints':
      return `a board has no sprints${detail}`;
    case 'agileUnavailable':
      return 'this site has no Agile API, which is what a site without Jira Software looks like';
    case 'dependencyMissing':
      return 'there was nothing to enumerate them from';
    case 'partiallyForbidden':
      return `some are missing because this token may not read them${detail}`;
    case 'notJson':
      return 'the site answered with something that is not JSON — check the site address';
    case 'networkError':
      return `the request did not complete${detail}`;
  }
};

const name = (outcome: ResourceOutcome): string =>
  outcome.projectKey
    ? `${outcome.projectKey} ${LABELS[outcome.resource]}`
    : LABELS[outcome.resource];

/** A count, or a dash when there is nothing and a reason for it. */
const amount = (outcome: ResourceOutcome): string =>
  outcome.state === 'partial' && outcome.count === 0 ? '—' : String(outcome.count);

/**
 * One line per resource, aligned.
 *
 * Every `partial` resource carries its reason on the same line. A count with no explanation beside
 * it would let a short list read as a complete one, which is the failure this whole layer is built
 * to avoid.
 */
export const formatReport = (outcomes: ResourceOutcome[]): string[] => {
  if (outcomes.length === 0) return ['  nothing to read: no projects have been chosen'];
  const width = Math.max(...outcomes.map((outcome) => name(outcome).length));
  return outcomes.map((outcome) => {
    const reasons = outcome.notes.map(describeNote).join('; ');
    const line = `  ${name(outcome).padEnd(width)}  ${amount(outcome).padStart(5)}`;
    return reasons ? `${line}   ${reasons}` : line;
  });
};

/** A one-line summary, for the end of a refresh. */
export const summarise = (outcomes: ResourceOutcome[]): string => {
  const partial = outcomes.filter((outcome) => outcome.state === 'partial').length;
  const read = outcomes.filter((outcome) => outcome.refreshed).length;
  const parts = [`${outcomes.length} resources`, `${read} read`];
  if (partial > 0) parts.push(`${partial} incomplete`);
  return parts.join(', ');
};

/** What is on disk and how old it is, for `--show`. Reads nothing itself: the caller supplies the
 * entries so this stays pure and the command owns the I/O. */
export const formatShow = (
  entries: Array<{
    resource: Resource;
    projectKey?: string;
    fetchedAt?: number;
    state?: string;
    notes?: CacheNote[];
    count?: number;
  }>,
  now: number,
): string[] => {
  if (entries.length === 0) return ['  nothing cached yet'];
  const width = Math.max(
    ...entries.map((entry) =>
      (entry.projectKey ? `${entry.projectKey} ${LABELS[entry.resource]}` : LABELS[entry.resource])
        .length
    ),
  );
  return entries.map((entry) => {
    const label = entry.projectKey
      ? `${entry.projectKey} ${LABELS[entry.resource]}`
      : LABELS[entry.resource];
    if (entry.fetchedAt === undefined) return `  ${label.padEnd(width)}   not cached`;
    const age = ageOf(now - entry.fetchedAt);
    const stale = now - entry.fetchedAt > RESOURCES[entry.resource].ttlMs
      ? ' — due for a refresh'
      : '';
    // A partial entry shows a dash rather than its count, for the same reason the refresh report
    // does: `sprints 0` reads as "this project has no sprints" when what happened was that nobody
    // could find out. The reason follows, so the line answers the question it raises.
    const partial = entry.state === 'partial';
    const shown = partial && !entry.count ? '—' : String(entry.count ?? '');
    const count = entry.count === undefined && !partial ? '' : `${shown.padStart(5)}  `;
    const why = partial && entry.notes?.length
      ? ` — ${entry.notes.map(describeNote).join('; ')}`
      : '';
    return `  ${label.padEnd(width)}  ${count}${age} old${stale}${why}`;
  });
};

/** Coarse on purpose: the reader wants to know whether it is minutes or days, and a precise
 * duration invites reading meaning into the exact number. */
const ageOf = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};
