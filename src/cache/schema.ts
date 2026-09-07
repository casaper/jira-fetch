/** The shape of everything the cache writes.
 *
 * Zod here for the same reason it is the source of truth for the config file: one description that
 * both types and runtime validation come from. Unlike the config schema, none of this is reachable
 * from `ConfigFile`, so `deno task schema` does not publish it — `scripts/gen_schema.ts` serialises
 * `ConfigFile` alone, and `schema/jira-fetch.schema.json` is unaffected by anything in this file.
 *
 * Every schema is a `strictObject`, which in a cache buys something it does not buy in a config
 * file: an unknown key means a different build wrote the entry, that fails validation, and a
 * validation failure is a **miss** that refetches live. Strictness is therefore free, and it is what
 * makes a future change to any of these shapes cost nothing.
 */

import { z } from 'zod';

/** Bumped when any shape below changes incompatibly. An entry carrying a different version is a
 * miss, so an old cache is refetched rather than misread — there is no migration to write. */
export const SCHEMA_VERSION = 1;

/**
 * A Jira project key, as it appears in an issue key.
 *
 * Shape-checked because it lands in two places that must not take arbitrary text: a filename, and
 * a path segment of `GET /rest/api/3/issue/createmeta/{key}/issuetypes`. That is the same hazard
 * `ISSUE_KEY` exists for on the way into `GET /rest/api/3/issue/{key}`.
 */
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,30}$/;

/**
 * Why an entry is not the whole truth.
 *
 * A code rather than prose, so the TUI can decide how to render it and a test can assert which
 * degradation happened rather than matching a sentence.
 */
export const CacheNote = z.strictObject({
  code: z.enum([
    /** 401 or 403: the token may not read this resource. */
    'forbidden',
    /** 404 on a project-scoped resource. The project stays chosen; it may come back. */
    'notFound',
    /** The request succeeded and returned nothing, for a resource where nothing is implausible. */
    'noneVisible',
    /** `MAX_PAGES` reached. What arrived is kept. */
    'truncated',
    /** The site does not publish email addresses, so people are name and accountId only. */
    'emailsHidden',
    /** No Agile board is visible for this project. */
    'noBoard',
    /** A Kanban board answers 400 from its sprint endpoint. Other boards still counted. */
    'boardWithoutSprints',
    /** The Agile API is absent, which is what a site without Jira Software looks like. */
    'agileUnavailable',
    /** What this resource is enumerated from was itself unavailable, so nothing was requested. */
    'dependencyMissing',
    /** Some of the things this resource is built from were forbidden; the rest are here. */
    'partiallyForbidden',
    /** HTTP 200 carrying something that is not JSON — a login page, or the wrong host. */
    'notJson',
    /** The request never completed, after retries. The previous entry is left alone. */
    'networkError',
  ]),
  detail: z.string().max(200).optional(),
});

/**
 * The envelope every cached resource shares.
 *
 * Module-private and generic on purpose: `no-slow-types` is on, and an exported generic factory
 * would trip it. Each concrete schema and its inferred type is exported instead, which is what
 * `src/config/schema.ts` does with `valueList`.
 *
 * `project` and `baseUrl` are the pins. Comparing them on read is what stops one repository reading
 * another's entry after a filename collision, and stops a config repointed at a second Jira site
 * reading the first site's field ids as fresh.
 */
const entry = <T extends z.ZodType>(data: T) =>
  z.strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** The canonicalised project root this entry belongs to. */
    project: z.string().min(1),
    /** The Jira site it was read from. */
    baseUrl: z.string().min(1),
    /** Which resource this is, so a file swapped for another fails validation rather than parsing. */
    resource: z.string().min(1),
    /** Epoch milliseconds. A number rather than an ISO string: staleness is arithmetic. */
    fetchedAt: z.number().int().positive(),
    state: z.enum(['ok', 'partial']),
    notes: z.array(CacheNote).max(50),
    data,
  })
    .refine(({ state, notes }) => state === 'ok' || notes.length > 0, {
      message: 'a partial entry must record why',
      path: ['notes'],
    });

export const CachedField = z.strictObject({
  id: z.string().min(1),
  key: z.string().optional(),
  name: z.string().min(1),
});

export const CachedProject = z.strictObject({
  id: z.string().optional(),
  key: z.string().regex(PROJECT_KEY),
  name: z.string().optional(),
});

export const CachedNamed = z.strictObject({
  id: z.string().optional(),
  name: z.string().min(1),
});

/** A person, recorded by `accountId` because that is what a filter rule should carry: display
 * names are neither unique nor stable, and `emailAddress` is absent on sites that do not publish
 * it. The name is here to label a menu entry, not to be matched on. */
export const CachedPerson = z.strictObject({
  accountId: z.string().min(1),
  displayName: z.string().optional(),
  emailAddress: z.string().optional(),
});

export const CachedSprint = z.strictObject({
  id: z.number().int(),
  name: z.string().min(1),
  state: z.string().optional(),
  boardId: z.number().int().optional(),
});

export const CachedBoard = z.strictObject({
  id: z.number().int(),
  name: z.string().min(1),
  type: z.string().optional(),
});

/** The values a field will accept, as far as this token can see them. Keyed by field id, with the
 * display name alongside so a menu can be built without a second lookup. */
export const CachedFieldOptions = z.strictObject({
  fieldId: z.string().min(1),
  name: z.string().min(1),
  values: z.array(z.string().min(1)),
});

export const FieldsEntry = entry(z.array(CachedField));
export const ProjectsEntry = entry(z.array(CachedProject));
export const LabelsEntry = entry(z.array(z.string().min(1)));
export const PrioritiesEntry = entry(z.array(CachedNamed));
export const IssueTypesEntry = entry(z.array(CachedNamed));
export const StatusesEntry = entry(z.array(CachedNamed));
export const ComponentsEntry = entry(z.array(CachedNamed));
export const VersionsEntry = entry(z.array(CachedNamed));
export const UsersEntry = entry(z.array(CachedPerson));
export const BoardsEntry = entry(z.array(CachedBoard));
export const SprintsEntry = entry(z.array(CachedSprint));
export const FieldOptionsEntry = entry(z.array(CachedFieldOptions));

/**
 * What the cache directory is for, and which projects the user chose.
 *
 * Owned by the `cache` command alone. Nothing on the fetch path reads or writes it, so a run that
 * only needs the field list cannot clobber a project selection.
 */
export const CacheManifest = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  project: z.string().min(1),
  baseUrl: z.string().min(1),
  projects: z.array(z.string().regex(PROJECT_KEY)).max(200),
  updatedAt: z.number().int().positive(),
});

export type CacheNote = z.infer<typeof CacheNote>;
export type CacheState = z.infer<typeof FieldsEntry>['state'];
export type CachedField = z.infer<typeof CachedField>;
export type CachedProject = z.infer<typeof CachedProject>;
export type CachedNamed = z.infer<typeof CachedNamed>;
export type CachedPerson = z.infer<typeof CachedPerson>;
export type CachedSprint = z.infer<typeof CachedSprint>;
export type CachedBoard = z.infer<typeof CachedBoard>;
export type CachedFieldOptions = z.infer<typeof CachedFieldOptions>;
export type FieldsEntry = z.infer<typeof FieldsEntry>;
export type ProjectsEntry = z.infer<typeof ProjectsEntry>;
export type CacheManifest = z.infer<typeof CacheManifest>;
