/** Filling the cache: which call feeds which resource, and what each failure means.
 *
 * The rule that shapes this module is that a resource nobody could read is recorded as such. Every
 * fetch is wrapped, every failure becomes a note, and a note makes the entry `partial` — so an
 * empty list is never mistaken for a small one. `src/cache/store.ts` enforces the other half: an
 * empty result for a resource where nothing is implausible is a symptom, not a fact.
 *
 * Nothing here throws for a Jira failure. A cache that could turn a working run red would cost more
 * than it saves. A failure to *write* does throw, because that is a broken cache directory rather
 * than a resource the token cannot see, and it will affect every resource equally.
 */

import type { z } from 'zod';
import { type JiraClient, JiraError } from '../jira/client.ts';
import type { FieldMetadata, JiraUser } from '../jira/types.ts';
import { type Resource, RESOURCES } from './policy.ts';
import {
  BoardsEntry,
  type CachedFieldOptions,
  type CachedPerson,
  type CacheNote,
  type CacheState,
  ComponentsEntry,
  FieldOptionsEntry,
  FieldsEntry,
  IssueTypesEntry,
  LabelsEntry,
  PrioritiesEntry,
  PROJECT_KEY,
  ProjectsEntry,
  SprintsEntry,
  StatusesEntry,
  UsersEntry,
  VersionsEntry,
} from './schema.ts';
import { type EntryRef, readEntry, writeEntry } from './store.ts';

/**
 * The part of `JiraClient` this module uses.
 *
 * Derived with `Pick` rather than restated, so renaming a client method is a compile error here —
 * and a test can supply a plain object instead of a real client without a cast.
 */
export type MetadataClient = Pick<
  JiraClient,
  | 'searchProjects'
  | 'getFields'
  | 'getLabels'
  | 'getPriorities'
  | 'getCreateMetaIssueTypes'
  | 'getCreateMetaFields'
  | 'getProjectStatuses'
  | 'getProjectComponents'
  | 'getProjectVersions'
  | 'getAssignableUsers'
  | 'getBoards'
  | 'getSprints'
>;

export type MetadataDeps = {
  client: MetadataClient;
  cacheDir: string;
  /** The canonicalised project root. */
  project: string;
  baseUrl: string;
  now: () => number;
  log: (message: string) => void;
};

/** What became of one resource. `refreshed: false` means the cached entry was still fresh and no
 * request was made. */
export type ResourceOutcome = {
  resource: Resource;
  projectKey?: string;
  state: CacheState;
  notes: CacheNote[];
  count: number;
  refreshed: boolean;
};

export type RefreshReport = {
  outcomes: ResourceOutcome[];
  projectKeys: string[];
};

export type RefreshOptions = {
  /** Refetch even where the cached entry is still inside its TTL. What `--refresh` sets, and the
   * way to retry a resource that was forbidden without waiting out its TTL. */
  force?: boolean;
};

/**
 * A Jira failure, as a note.
 *
 * `on400` is a parameter because 400 means something specific per endpoint and nothing in general:
 * a Kanban board answers 400 from its sprint endpoint because it has no sprints, which is a fact
 * about the board rather than an error.
 */
const classify = (cause: unknown, on400?: CacheNote['code']): CacheNote => {
  if (cause instanceof JiraError) {
    if (cause.status === 401 || cause.status === 403) return { code: 'forbidden' };
    if (cause.status === 404) return { code: 'notFound' };
    if (cause.status === 400 && on400) return { code: on400 };
  }
  // A 200 carrying HTML — a wrong host, or an SSO portal — reaches here as a parse failure. There
  // is no declared mime type to compare against, the way an attachment download has.
  if (cause instanceof SyntaxError) return { code: 'notJson' };
  return { code: 'networkError', detail: (cause as Error)?.message?.slice(0, 200) };
};

type Got<T> = { data: T[]; notes: CacheNote[]; failed?: undefined } | {
  data?: undefined;
  notes?: undefined;
  failed: CacheNote;
};

/** Runs one paginated call, turning truncation into a note and any failure into one. */
const got = async <T>(
  run: () => Promise<{ items: T[]; truncated: boolean }>,
  on400?: CacheNote['code'],
): Promise<Got<T>> => {
  try {
    const { items, truncated } = await run();
    return { data: items, notes: truncated ? [{ code: 'truncated' }] : [] };
  } catch (cause) {
    return { failed: classify(cause, on400) };
  }
};

const stateFor = (notes: CacheNote[]): CacheState => notes.length > 0 ? 'partial' : 'ok';

/** The envelope fields `ensure` reads back, whatever the payload is. */
type AnyEntry = {
  project: string;
  baseUrl: string;
  fetchedAt: number;
  resource: string;
  state: CacheState;
  notes: CacheNote[];
  data: unknown;
};

/**
 * One resource: the cached entry if it is still fresh, otherwise a fetch and a write.
 *
 * This is where the TTL is honoured, so no caller decides for itself whether something is stale.
 */
const ensure = async <E extends AnyEntry>(
  schema: z.ZodType<E>,
  ref: EntryRef,
  deps: MetadataDeps,
  force: boolean,
  run: () => Promise<Got<unknown>>,
): Promise<ResourceOutcome> => {
  const now = deps.now();
  const label = ref.projectKey ? `${ref.projectKey} ${ref.resource}` : ref.resource;

  if (!force) {
    const cached = await readEntry(schema, ref, now);
    if (cached.hit) {
      return {
        resource: ref.resource,
        projectKey: ref.projectKey,
        state: cached.hit.state,
        notes: cached.hit.notes,
        count: Array.isArray(cached.hit.data) ? cached.hit.data.length : 0,
        refreshed: false,
      };
    }
    deps.log(`  ${label}: ${cached.miss}`);
  }

  // `run` wraps its own Jira calls, but a surprise from anywhere else in it must still land as a
  // note rather than as an exception: this module's contract is that reading the cache cannot fail.
  let result: Got<unknown>;
  try {
    result = await run();
  } catch (cause) {
    result = { failed: classify(cause) };
  }

  const data = result.failed ? [] : result.data;
  const notes = result.failed ? [result.failed] : result.notes;

  const written = await writeEntry(schema, ref, now, {
    state: stateFor(notes),
    notes,
    data,
  });

  return {
    resource: ref.resource,
    projectKey: ref.projectKey,
    state: written.state,
    notes: written.notes,
    count: data.length,
    refreshed: true,
  };
};

/**
 * A label for one of a field's accepted values.
 *
 * `allowedValues` is `unknown[]` in the specification and genuinely heterogeneous in practice — a
 * select option carries `value`, a component or version carries `name`, a user carries
 * `displayName`. Read defensively rather than cast: this is unvalidated wire data, and the first
 * string that looks like a label is the one a menu should show.
 *
 * Deliberately not `normalizeValues` from the filter engine: that lowercases, which is right for
 * matching and wrong for something a person reads and picks from.
 */
const optionLabel = (option: unknown): string | undefined => {
  if (typeof option === 'string') return option.length > 0 ? option : undefined;
  if (option === null || typeof option !== 'object') return undefined;
  const record = option as Record<string, unknown>;
  for (const key of ['value', 'name', 'displayName', 'key']) {
    const found = record[key];
    if (typeof found === 'string' && found.length > 0) return found;
  }
  return undefined;
};

/** Folds the per-issue-type field metadata into one list of fields and the values each accepts.
 * A field appears once, with the union of the values every issue type allows for it. */
const foldFieldOptions = (pages: FieldMetadata[][]): CachedFieldOptions[] => {
  const byField = new Map<string, { name: string; values: Set<string> }>();
  for (const fields of pages) {
    for (const field of fields) {
      if (!field.key || !field.name) continue;
      const values = (field.allowedValues ?? [])
        .map(optionLabel)
        .filter((label): label is string => label !== undefined);
      if (values.length === 0) continue;
      const existing = byField.get(field.key) ?? { name: field.name, values: new Set<string>() };
      for (const value of values) existing.values.add(value);
      byField.set(field.key, existing);
    }
  }
  return [...byField].map(([fieldId, { name, values }]) => ({
    fieldId,
    name,
    values: [...values],
  }));
};

/** People, keyed by accountId. A site that does not publish email addresses still yields usable
 * entries, and the caller records that the emails are missing rather than leaving it to be
 * discovered in a menu. */
const toPeople = (users: JiraUser[]): { people: CachedPerson[]; emailsHidden: boolean } => {
  const people = users
    .filter((user): user is JiraUser & { accountId: string } =>
      typeof user.accountId === 'string' && user.accountId.length > 0
    )
    .map((user) => ({
      accountId: user.accountId,
      displayName: user.displayName,
      emailAddress: user.emailAddress,
    }));
  const withEmail = people.filter((person) => person.emailAddress !== undefined);
  return { people, emailsHidden: people.length > 0 && withEmail.length === 0 };
};

const siteRef = (deps: MetadataDeps, resource: Resource): EntryRef => ({
  cacheDir: deps.cacheDir,
  resource,
  project: deps.project,
  baseUrl: deps.baseUrl,
});

const projectRef = (deps: MetadataDeps, resource: Resource, projectKey: string): EntryRef => ({
  cacheDir: deps.cacheDir,
  resource,
  projectKey,
  project: deps.project,
  baseUrl: deps.baseUrl,
});

/** The site-wide resources: read once, whatever projects were chosen. */
export const refreshSite = async (
  deps: MetadataDeps,
  { force = false }: RefreshOptions = {},
): Promise<ResourceOutcome[]> => [
  await ensure(ProjectsEntry, siteRef(deps, 'projects'), deps, force, async () => {
    const result = await got(() => deps.client.searchProjects());
    if (result.failed) return result;
    // Keys that are not Jira keys are dropped rather than interpolated into a filename and a
    // createmeta path segment. Nothing on a real site produces one, so this costs nothing — but
    // dropping it here is what makes it a non-event instead of a write the schema refuses.
    const projects = result.data
      .filter((project): project is typeof project & { key: string } =>
        typeof project.key === 'string' && PROJECT_KEY.test(project.key)
      )
      .map((project) => ({ id: project.id, key: project.key, name: project.name }));
    return { data: projects, notes: result.notes };
  }),
  await ensure(FieldsEntry, siteRef(deps, 'fields'), deps, force, async () => {
    try {
      const fields = await deps.client.getFields();
      return {
        data: fields.map((field) => ({ id: field.id, key: field.key, name: field.name })),
        notes: [],
      };
    } catch (cause) {
      return { failed: classify(cause) };
    }
  }),
  await ensure(
    LabelsEntry,
    siteRef(deps, 'labels'),
    deps,
    force,
    () => got(() => deps.client.getLabels()),
  ),
  await ensure(PrioritiesEntry, siteRef(deps, 'priorities'), deps, force, async () => {
    const result = await got(() => deps.client.getPriorities());
    if (result.failed) return result;
    return { data: named(result.data), notes: result.notes };
  }),
];

/** Drops anything without a name: it could not be offered as a choice, and an id alone in a menu
 * is worse than one fewer option. */
const named = (
  items: Array<{ id?: string; name?: string }>,
): Array<{ id?: string; name: string }> =>
  items
    .filter((item): item is { id?: string; name: string } => typeof item.name === 'string')
    .map((item) => ({ id: item.id, name: item.name }));

/** Everything scoped to one project. */
export const refreshProject = async (
  deps: MetadataDeps,
  projectKey: string,
  { force = false }: RefreshOptions = {},
): Promise<ResourceOutcome[]> => {
  const ref = (resource: Resource) => projectRef(deps, resource, projectKey);
  const outcomes: ResourceOutcome[] = [];

  const issueTypes = await ensure(IssueTypesEntry, ref('issueTypes'), deps, force, async () => {
    const result = await got(() => deps.client.getCreateMetaIssueTypes(projectKey));
    if (result.failed) return result;
    return { data: named(result.data), notes: result.notes };
  });
  outcomes.push(issueTypes);

  outcomes.push(
    await ensure(FieldOptionsEntry, ref('fieldOptions'), deps, force, async () => {
      // Enumerated from the issue types, so there is nothing to ask for when those are missing.
      // Saying that plainly beats issuing requests that cannot succeed.
      const typeEntry = await readEntry(IssueTypesEntry, ref('issueTypes'), deps.now());
      const types = typeEntry.hit?.data ?? [];
      if (types.length === 0) return { failed: { code: 'dependencyMissing' } };

      const pages: FieldMetadata[][] = [];
      const notes: CacheNote[] = [];
      let refused = 0;
      for (const type of types) {
        if (!type.id) continue;
        const page = await got(() =>
          deps.client.getCreateMetaFields(projectKey, type.id as string)
        );
        if (page.failed) {
          refused++;
          continue;
        }
        pages.push(page.data);
        notes.push(...page.notes);
      }
      // Some issue types refused and some read: the union is still worth having, and saying it is
      // incomplete is more useful than dropping it.
      if (refused > 0) {
        notes.push({
          code: refused === types.length ? 'forbidden' : 'partiallyForbidden',
          detail: `${refused} of ${types.length} issue types`,
        });
      }
      return { data: foldFieldOptions(pages), notes };
    }),
  );

  outcomes.push(
    await ensure(StatusesEntry, ref('statuses'), deps, force, async () => {
      try {
        const statuses = await deps.client.getProjectStatuses(projectKey);
        // The same status belongs to several issue types, so the flattened list repeats.
        const unique = new Map(named(statuses).map((status) => [status.name, status]));
        return { data: [...unique.values()], notes: [] };
      } catch (cause) {
        return { failed: classify(cause) };
      }
    }),
  );

  outcomes.push(
    await ensure(ComponentsEntry, ref('components'), deps, force, async () => {
      const result = await got(() => deps.client.getProjectComponents(projectKey));
      if (result.failed) return result;
      return { data: named(result.data), notes: result.notes };
    }),
  );

  outcomes.push(
    await ensure(VersionsEntry, ref('versions'), deps, force, async () => {
      const result = await got(() => deps.client.getProjectVersions(projectKey));
      if (result.failed) return result;
      return { data: named(result.data), notes: result.notes };
    }),
  );

  outcomes.push(
    await ensure(UsersEntry, ref('users'), deps, force, async () => {
      const result = await got(() => deps.client.getAssignableUsers(projectKey));
      if (result.failed) return result;
      const { people, emailsHidden } = toPeople(result.data);
      const notes = [...result.notes];
      if (emailsHidden) notes.push({ code: 'emailsHidden' });
      return { data: people, notes };
    }),
  );

  const boards = await ensure(BoardsEntry, ref('boards'), deps, force, async () => {
    const result = await got(() => deps.client.getBoards(projectKey));
    // A 404 from the only Agile entry point is what a site without Jira Software looks like. It is
    // not distinguishable from a missing project here, and naming the licence is the more useful
    // of the two guesses because the project key came from this same site's project list.
    if (result.failed?.code === 'notFound') return { failed: { code: 'agileUnavailable' } };
    if (result.failed) return result;
    if (result.data.length === 0) return { data: [], notes: [{ code: 'noBoard' as const }] };
    return {
      data: result.data.map((board) => ({ id: board.id, name: board.name, type: board.type })),
      notes: result.notes,
    };
  });
  outcomes.push(boards);

  outcomes.push(
    await ensure(SprintsEntry, ref('sprints'), deps, force, async () => {
      const boardEntry = await readEntry(BoardsEntry, ref('boards'), deps.now());
      const found = boardEntry.hit?.data ?? [];
      if (found.length === 0) return { failed: { code: 'dependencyMissing' } };

      const sprints = [];
      const notes: CacheNote[] = [];
      for (const board of found) {
        const page = await got(() => deps.client.getSprints(board.id), 'boardWithoutSprints');
        if (page.failed) {
          // A Kanban board has no sprints and says so with a 400. The other boards still count.
          notes.push({ ...page.failed, detail: `board ${board.id}` });
          continue;
        }
        for (const sprint of page.data) {
          sprints.push({
            id: sprint.id,
            name: sprint.name,
            state: sprint.state,
            boardId: board.id,
          });
        }
        notes.push(...page.notes);
      }
      return { data: sprints, notes };
    }),
  );

  return outcomes;
};

/** Everything, for the projects given. */
export const refreshAll = async (
  deps: MetadataDeps,
  projectKeys: string[],
  options: RefreshOptions = {},
): Promise<RefreshReport> => {
  const outcomes = await refreshSite(deps, options);
  for (const key of projectKeys) {
    outcomes.push(...await refreshProject(deps, key, options));
  }
  return { outcomes, projectKeys };
};

/** Which resources a report has nothing usable for. Kept here so the command and the TUI agree on
 * what "unavailable" means: partial with nothing in it. */
export const unavailable = (report: RefreshReport): ResourceOutcome[] =>
  report.outcomes.filter((outcome) => outcome.state === 'partial' && outcome.count === 0);

/** Every resource the cache knows about, for a caller that wants to report on all of them. */
export const allResources = Object.keys(RESOURCES) as Resource[];
