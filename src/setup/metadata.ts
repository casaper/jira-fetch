/** Reading the cache into the shape the filter menu offers.
 *
 * The cache stores one file per resource per project; a menu wants one list per kind, merged across
 * the projects that were chosen, each carrying how completely it could be read. That merge is here
 * rather than in the menu so it is testable — a menu is not.
 *
 * Nothing here fetches. `ensure_cache.ts` fills the cache and this reads it back, so a resource that
 * is missing or out of date by the time it gets here is one the refresh could not repair — which is
 * what the reasons below say.
 */

import { readEntry } from '../cache/store.ts';
import type { EntryRef, PinnedEntry } from '../cache/store.ts';
import type { Resource as CacheResource } from '../cache/policy.ts';
import {
  ComponentsEntry,
  FieldOptionsEntry,
  FieldsEntry,
  IssueTypesEntry,
  LabelsEntry,
  PrioritiesEntry,
  ProjectsEntry,
  SprintsEntry,
  StatusesEntry,
  UsersEntry,
  VersionsEntry,
} from '../cache/schema.ts';
import type { CacheNote } from '../cache/schema.ts';
import { describeNote } from '../cache/report.ts';
import type { FieldInfo, MetadataView, NamedValue, Resource } from './metadata_view.ts';
import type { NameLookup } from './filter_render.ts';

export type MetadataDeps = {
  cacheDir: string;
  /** The canonicalised project root. */
  project: string;
  baseUrl: string;
  /** Which Jira projects to merge. Empty means only the site-wide resources are available. */
  projectKeys: string[];
  now: () => number;
};

// Both reasons are read *after* a refresh has been attempted, so neither can suggest running
// something: whatever is missing here is missing because the site would not give it up.
const NOT_CACHED = 'not cached, and it could not be read from the site';
const OUT_OF_DATE = 'out of date, and it could not be refreshed';

/** An entry's state as the menu's three-way status. `partial` with nothing in it is `unavailable`:
 * there is a reason and no data, which is a different thing to show than a short list. */
const statusOf = (state: 'ok' | 'partial', count: number): Resource<never>['status'] => {
  if (state === 'ok') return 'available';
  return count === 0 ? 'unavailable' : 'partial';
};

const reasonOf = (notes: CacheNote[]): string | undefined =>
  notes.length === 0 ? undefined : notes.map(describeNote).join('; ');

/** Merges one resource across the chosen projects, keeping the worst status any of them had. */
const merge = <T>(parts: Array<Resource<T>>, dedupe: (item: T) => string): Resource<T> => {
  if (parts.length === 0) return { status: 'unavailable', reason: NOT_CACHED, items: [] };

  const seen = new Set<string>();
  const items: T[] = [];
  for (const part of parts) {
    for (const item of part.items) {
      const key = dedupe(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  const reasons = [...new Set(parts.flatMap((part) => part.reason ? [part.reason] : []))];
  const worst = parts.some((part) => part.status === 'unavailable') && items.length === 0
    ? 'unavailable'
    : parts.every((part) => part.status === 'available')
    ? 'available'
    : 'partial';

  return {
    status: worst,
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    items,
  };
};

const byValue = (item: NamedValue): string => item.value;

export const loadMetadataView = async (deps: MetadataDeps): Promise<MetadataView> => {
  const ref = (resource: CacheResource, projectKey?: string): EntryRef => ({
    cacheDir: deps.cacheDir,
    resource,
    ...(projectKey === undefined ? {} : { projectKey }),
    project: deps.project,
    baseUrl: deps.baseUrl,
  });

  /** One entry, mapped. A miss is `unavailable` with a reason, never an empty list. */
  const read = async <T>(
    // deno-lint-ignore no-explicit-any -- one call site per resource, each with its own payload
    schema: any,
    resource: CacheResource,
    projectKey: string | undefined,
    map: (data: unknown) => T[],
  ): Promise<Resource<T>> => {
    const found = await readEntry<PinnedEntry<unknown>>(
      schema,
      ref(resource, projectKey),
      deps.now(),
    );
    if (!found.hit) {
      return {
        status: 'unavailable',
        reason: found.miss === 'stale' ? OUT_OF_DATE : NOT_CACHED,
        items: [],
      };
    }
    const items = map(found.hit.data);
    return {
      status: statusOf(found.hit.state, items.length),
      ...(reasonOf(found.hit.notes) ? { reason: reasonOf(found.hit.notes) } : {}),
      items,
    };
  };

  const namesOf = (data: unknown): NamedValue[] =>
    (data as Array<{ name: string }>).map((item) => ({ value: item.name, label: item.name }));

  const perProject = async <T>(
    // deno-lint-ignore no-explicit-any -- as above
    schema: any,
    resource: CacheResource,
    map: (data: unknown) => T[],
    dedupe: (item: T) => string,
  ): Promise<Resource<T>> =>
    merge(
      await Promise.all(
        deps.projectKeys.map((key) => read(schema, resource, key, map)),
      ),
      dedupe,
    );

  const [projects, labels, priorities, fieldList, fieldOptions] = await Promise.all([
    read(
      ProjectsEntry,
      'projects',
      undefined,
      (data) =>
        (data as Array<{ key: string; name?: string }>).map((item) => ({
          value: item.key,
          label: item.name ? `${item.key} — ${item.name}` : item.key,
        })),
    ),
    read(
      LabelsEntry,
      'labels',
      undefined,
      (data) => (data as string[]).map((label) => ({ value: label, label })),
    ),
    read(PrioritiesEntry, 'priorities', undefined, namesOf),
    read(
      FieldsEntry,
      'fields',
      undefined,
      (data) =>
        (data as Array<{ id: string; name: string }>).map((item) => ({
          id: item.id,
          name: item.name,
        })),
    ),
    perProject(
      FieldOptionsEntry,
      'fieldOptions',
      (data) => data as Array<{ fieldId: string; name: string; values: string[] }>,
      (item) => item.fieldId,
    ),
  ]);

  const [issueTypes, statuses, components, versions, sprints, users] = await Promise.all([
    perProject(IssueTypesEntry, 'issueTypes', namesOf, byValue),
    perProject(StatusesEntry, 'statuses', namesOf, byValue),
    perProject(ComponentsEntry, 'components', namesOf, byValue),
    perProject(VersionsEntry, 'versions', namesOf, byValue),
    perProject(
      SprintsEntry,
      'sprints',
      (data) =>
        (data as Array<{ name: string; state?: string }>).map((item) => ({
          value: item.name,
          label: item.name,
          ...(item.state ? { hint: item.state } : {}),
        })),
      byValue,
    ),
    perProject(
      UsersEntry,
      'users',
      (data) =>
        // The accountId is the value, because that is what a rule should carry; the name is a
        // label and the email a hint, both only so the entry can be recognised.
        (data as Array<{ accountId: string; displayName?: string; emailAddress?: string }>).map(
          (person) => ({
            value: person.accountId,
            label: person.displayName ?? person.accountId,
            ...(person.emailAddress ? { hint: person.emailAddress } : {}),
          }),
        ),
      byValue,
    ),
  ]);

  // The field list and the values each field accepts come from two resources, and the menu wants
  // them as one thing. A field with no cached values keeps `allowedValues` absent rather than
  // empty: "not known" and "none" are different, and a picker has to say which.
  const valuesById = new Map(fieldOptions.items.map((entry) => [entry.fieldId, entry.values]));
  const fields: Resource<FieldInfo> = {
    status: fieldList.status,
    ...(fieldList.reason ? { reason: fieldList.reason } : {}),
    items: fieldList.items.map((field) => {
      const values = valuesById.get(field.id);
      return {
        ...field,
        ...(values === undefined
          ? {}
          : { allowedValues: values.map((value) => ({ value, label: value })) }),
      };
    }),
  };

  return {
    projects,
    labels,
    issueTypes,
    statuses,
    priorities,
    components,
    versions,
    sprints,
    users,
    fields,
  };
};

/** Resolves an accountId to a display name using what was read, so a stored rule reads as people
 * rather than as ids. */
export const nameLookup = (view: MetadataView): NameLookup => {
  const byId = new Map(view.users.items.map((person) => [person.value, person.label]));
  return (accountId: string): string | undefined => byId.get(accountId);
};
