/** Builds the YAML frontmatter block: everything about the ticket that is worth having in a
 * machine-readable form.
 *
 * The rule that shapes it is that a key is present only when it carries something. There is no
 * `resolution: null`, no `components: []` — absent is spelled one way, by absence. See `prune`. */

import { stringify as stringifyYaml } from '@std/yaml';
import type { PeopleConfig } from '../config/schema.ts';
import type { AssetManifest, IssueRef, JiraIssue } from '../jira/types.ts';
import { personRecord } from './people.ts';

/** A pointer to another issue: enough to identify it and decide whether it matters, and no more.
 *
 * Deliberately no `title`. A related ticket's summary is a copy of text that lives in that
 * ticket — it goes stale the moment someone renames it, and the key is what you fetch to get the
 * current one. Type and status stay because they are what a reader triages on. */
function ref(r: IssueRef | null | undefined) {
  if (!r?.key) return null;
  return {
    key: r.key,
    type: r.fields?.issuetype?.name ?? null,
    status: r.fields?.status?.name ?? null,
  };
}

/** Jira's own timestamp spelling: local time with a numeric offset, `2026-09-05T22:55:38.299+0200`.
 *
 * `toISOString()` would be correct but a *different* format — UTC with a `Z` — sitting next to
 * `created_at` and `updated_at`, which come from Jira verbatim. One block, one shape. */
const localTimestamp = (d: Date): string => {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  // getTimezoneOffset counts minutes *behind* UTC, so its sign is the opposite of the one written.
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
};

function names(list: Array<{ name?: string }> | undefined): string[] {
  return (list ?? []).map((v) => v.name).filter((n): n is string => typeof n === 'string');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

/** Drops what carries no information: `null`, `undefined`, `[]` and `{}`, recursively.
 *
 * Deliberately *not* "falsy". `comment_count: 0` and a `false` are facts, and an empty string is
 * left alone rather than guessed at — this removes absence, not content.
 *
 * Children are pruned before their parents, so `{ parent: { status: null } }` collapses all the
 * way rather than leaving an empty object behind. Object *properties* are dropped; array
 * *elements* are pruned in place but never removed, since dropping one would shift every index
 * after it. The consequence is that nested records go ragged — `parent` may be just `{ key }`,
 * and one `assets` entry may carry `size` where another does not. That is the same rule applied
 * consistently rather than stopped at the top level. */
const prune = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(prune);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = prune(child);
    if (!isEmpty(pruned)) out[key] = pruned;
  }
  return out;
};

export interface FrontmatterInput {
  issue: JiraIssue;
  baseUrl: string;
  /** Other children of the same parent, excluding this issue. */
  siblings: IssueRef[];
  assets: AssetManifest;
  commentCount: number;
  people: PeopleConfig;
  fetchedAt?: Date;
}

export function buildFrontmatter(input: FrontmatterInput): Record<string, unknown> {
  const { issue, siblings, assets, commentCount, people } = input;
  const f = issue.fields;
  const person = (u: Parameters<typeof personRecord>[0], role: PeopleConfig['roles'][number]) =>
    people.roles.includes(role) ? personRecord(u, people) : null;

  return prune({
    id: issue.key,
    title: f.summary ?? null,
    type: f.issuetype?.name ?? null,
    status: f.status?.name ?? null,
    priority: f.priority?.name ?? null,
    resolution: f.resolution?.name ?? null,
    reporter: person(f.reporter, 'reporter'),
    assignee: person(f.assignee, 'assignee'),
    created_at: f.created ?? null,
    updated_at: f.updated ?? null,
    fetched_at: localTimestamp(input.fetchedAt ?? new Date()),
    labels: f.labels ?? [],
    components: names(f.components),
    fix_versions: names(f.fixVersions),
    parent: ref(f.parent),
    siblings: siblings.map((s) => s.key),
    subtasks: (f.subtasks ?? []).map(ref).filter((s) => s !== null),
    comment_count: commentCount,
    assets: [...assets.values()].map((a) => ({
      filename: a.filename,
      path: a.relativePath,
      mime_type: a.mimeType ?? null,
      size: a.size ?? null,
    })),
  }) as Record<string, unknown>;
}

export function renderFrontmatter(data: Record<string, unknown>): string {
  // lineWidth: -1 disables folding. A width of 0 would fold *every* string into a block scalar,
  // turning `id: DN-1243` into an unreadable `id: >-` block.
  const yaml = stringifyYaml(data, { lineWidth: -1, skipInvalid: true }).trimEnd();
  return `---\n${yaml}\n---`;
}
