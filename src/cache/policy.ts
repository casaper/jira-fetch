/** Which resources the cache holds, how long each stays fresh, and what its file is called.
 *
 * Pure, and deliberately the only place any of it is written down. The endpoints themselves are in
 * `src/cache/metadata.ts`; this file is the policy those calls are driven by, so a TTL or a
 * filename cannot be decided differently in two places.
 */

import type { CacheManifest, FieldsEntry } from './schema.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Everything the cache can hold. Site-wide resources are read once per site; project-scoped ones
 * once per chosen project key. */
export type Resource =
  | 'projects'
  | 'fields'
  | 'labels'
  | 'priorities'
  | 'issueTypes'
  | 'fieldOptions'
  | 'statuses'
  | 'components'
  | 'versions'
  | 'users'
  | 'boards'
  | 'sprints';

export type ResourcePolicy = {
  scope: 'site' | 'project';
  ttlMs: number;
  /**
   * Whether an empty result is a fact or a symptom.
   *
   * `false` means a successful request that returned nothing is recorded as `partial` with a
   * `noneVisible` note, because "the token can see no projects" is indistinguishable from "the
   * token is wrong" and writing it as fresh-and-empty would be a cache that passes having verified
   * nothing. `true` means a site genuinely may have no labels, no components, no sprints.
   */
  emptyIsOk: boolean;
};

/**
 * The table. A `Record` over the union rather than a bare object, so adding a `Resource` without
 * giving it a policy is a compile error — the trick `CompiledTicketRule` uses to keep the filter
 * predicates and their compiled forms in step.
 */
export const RESOURCES: Record<Resource, ResourcePolicy> = {
  // Read on the fetch path, so its TTL is the one that bounds the residual this cache accepts: a
  // second field created with the same display name makes a name newly ambiguous, and a stale
  // catalogue resolves it happily where a live run would refuse. Six hours, not seven days.
  fields: { scope: 'site', ttlMs: 6 * HOUR, emptyIsOk: false },
  projects: { scope: 'site', ttlMs: DAY, emptyIsOk: false },
  labels: { scope: 'site', ttlMs: 12 * HOUR, emptyIsOk: true },
  priorities: { scope: 'site', ttlMs: 7 * DAY, emptyIsOk: false },
  issueTypes: { scope: 'project', ttlMs: DAY, emptyIsOk: false },
  fieldOptions: { scope: 'project', ttlMs: DAY, emptyIsOk: false },
  statuses: { scope: 'project', ttlMs: DAY, emptyIsOk: false },
  components: { scope: 'project', ttlMs: 12 * HOUR, emptyIsOk: true },
  versions: { scope: 'project', ttlMs: 12 * HOUR, emptyIsOk: true },
  users: { scope: 'project', ttlMs: 12 * HOUR, emptyIsOk: false },
  boards: { scope: 'project', ttlMs: DAY, emptyIsOk: false },
  // Sprints move constantly: an active sprint becomes closed and a new one opens without anything
  // else about the project changing.
  sprints: { scope: 'project', ttlMs: HOUR, emptyIsOk: true },
};

export const MANIFEST_FILE = 'manifest.json';

/**
 * The file an entry lives in. Flat — no subdirectories — so writing one is a single `mkdir` with
 * the mode applied at creation, and there is no intermediate directory to get the mode wrong on.
 *
 * A project-scoped resource without a key, or a site-wide one with one, is a programming error
 * rather than a bad input, so it throws here instead of producing a plausible filename.
 */
export const resourceFileName = (resource: Resource, projectKey?: string): string => {
  const { scope } = RESOURCES[resource];
  if (scope === 'site') {
    if (projectKey !== undefined) {
      throw new Error(`${resource} is site-wide and takes no project key`);
    }
    return `${resource}.json`;
  }
  if (projectKey === undefined) throw new Error(`${resource} needs a project key`);
  return `${projectKey}-${resource}.json`;
};

/**
 * Whether an entry has aged out.
 *
 * The `now < fetchedAt` arm is not defensiveness: a stamp in the future means the clock moved, and
 * trusting it would pin a stale entry as fresh for as long as the skew lasts. `now` is a parameter
 * rather than a `Date.now()` call so staleness is testable at, either side of, and before the
 * boundary.
 */
export const isStale = (fetchedAt: number, ttlMs: number, now: number): boolean =>
  now < fetchedAt || now - fetchedAt > ttlMs;

/** Why a read did not produce a usable entry. Every one of these refetches live, so none of them
 * is an error — which is the property that keeps the cache from ever turning a working run red. */
export type MissReason =
  | 'absent'
  | 'unreadable'
  | 'notJson'
  | 'invalid'
  | 'wrongProject'
  | 'wrongSite'
  | 'stale';

/** The pins. Checked on every read, for a filename collision and for a config repointed at a
 * second Jira site. */
export const pinMismatch = (
  pinned: Pick<FieldsEntry, 'project' | 'baseUrl'> | CacheManifest,
  expected: { project: string; baseUrl: string },
): MissReason | undefined => {
  if (pinned.project !== expected.project) return 'wrongProject';
  if (pinned.baseUrl !== expected.baseUrl) return 'wrongSite';
  return undefined;
};
