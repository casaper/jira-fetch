/** What the filter menu sees of the metadata cache.
 *
 * Types only, and deliberately not the cache's own shapes. The pure modules that build choice lists
 * and render rules depend on this, and one small adapter in `filter_tui.ts` maps the cache onto it —
 * so those modules are testable from plain fixtures, and a change to how the cache stores something
 * moves one untestable function rather than four tested ones.
 *
 * Every resource carries how completely it could be read. A menu that showed a `partial` list as
 * though it were the whole truth would be the same failure the cache layer works to avoid: a short
 * list reading as a complete one.
 */

export type ResourceStatus = 'available' | 'partial' | 'unavailable';

export type Resource<T> = {
  status: ResourceStatus;
  /** Why it is not the whole truth. Present whenever the status is not `available`. */
  reason?: string;
  items: T[];
};

/** Something choosable: `value` is what a filter rule records, `label` is what a person reads. */
export type NamedValue = {
  value: string;
  label: string;
  /** Extra detail shown beside the label — an email address, a sprint's state. */
  hint?: string;
};

/** A field, and the values it will accept where those could be read. */
export type FieldInfo = {
  id: string;
  name: string;
  /** Absent means the values are not known, which is different from an empty list. */
  allowedValues?: NamedValue[];
};

/** Everything the filter menu can offer, for the projects that were cached. */
export type MetadataView = {
  projects: Resource<NamedValue>;
  labels: Resource<NamedValue>;
  issueTypes: Resource<NamedValue>;
  statuses: Resource<NamedValue>;
  priorities: Resource<NamedValue>;
  components: Resource<NamedValue>;
  versions: Resource<NamedValue>;
  sprints: Resource<NamedValue>;
  /** Keyed by accountId, labelled by display name — see `filter_render.ts` for why. */
  users: Resource<NamedValue>;
  fields: Resource<FieldInfo>;
};

export const emptyResource = <T>(reason: string): Resource<T> => ({
  status: 'unavailable',
  reason,
  items: [],
});
