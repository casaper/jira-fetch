/** Filter rules as prose, and metadata as choice lists.
 *
 * Pure, so every wording here is testable. Two decisions in it are correctness rather than
 * presentation, and both are marked below: how a field is recorded, and how a person is.
 */

import type { TicketRule, ValueMatcher } from '../config/schema.ts';
import type { FieldInfo, MetadataView, NamedValue, Resource } from './metadata_view.ts';
import type { PredicateKey, RuleDraft } from './filter_draft.ts';

/**
 * How `null` — "absent" — is spelled while it sits in a menu.
 *
 * Every *real* value is prefixed instead of the sentinel being made exotic, so a collision is
 * impossible by construction rather than merely unlikely: there is no Jira label, component or
 * account id that this function will hand back as `null`.
 */
export const ABSENT = 'absent';
const VALUE_PREFIX = 'v:';

export const matchersToChoiceValues = (matchers: ValueMatcher[]): string[] =>
  matchers.map((matcher) => matcher === null ? ABSENT : `${VALUE_PREFIX}${matcher}`);

export const choiceValuesToMatchers = (values: string[]): ValueMatcher[] =>
  values.map((value) => value === ABSENT ? null : value.slice(VALUE_PREFIX.length));

/** One entry of a choice list, as plain data for `prompts.ts` to hand to cliffy. */
export type Choice = {
  value: string;
  name: string;
  checked?: boolean;
};

export type ChoiceList = {
  items: Choice[];
  /** Set when the list cannot be trusted to be complete, so the menu can say so. */
  note?: string;
  /** Whether the menu should offer typing a value that is not listed. */
  allowFreeText: boolean;
};

const labelFor = (item: NamedValue): string =>
  item.hint ? `${item.label} · ${item.hint}` : item.label;

/**
 * The values a predicate can be given.
 *
 * Two things it must never do. It must never return an empty item list — a picker with nothing in
 * it is a broken screen — and it must never silently drop a value that is already in the rule
 * because the cache does not know about it. A stale cache would otherwise quietly delete part of a
 * filter the moment somebody opened it.
 */
export const valueChoiceList = (
  resource: Resource<NamedValue>,
  selected: ValueMatcher[],
  options: { absentLabel: string },
): ChoiceList => {
  const chosen = new Set(matchersToChoiceValues(selected));
  const items: Choice[] = [
    { value: ABSENT, name: options.absentLabel, checked: chosen.has(ABSENT) },
  ];

  const known = new Set<string>();
  for (const item of resource.items) {
    const value = `${VALUE_PREFIX}${item.value}`;
    known.add(value);
    items.push({ value, name: labelFor(item), checked: chosen.has(value) });
  }

  // Anything already in the rule that the cache has not heard of stays, and stays ticked.
  for (const value of chosen) {
    if (value === ABSENT || known.has(value)) continue;
    items.push({
      value,
      name: `${value.slice(VALUE_PREFIX.length)} (not on this site)`,
      checked: true,
    });
  }

  return {
    items,
    ...(resource.status === 'available' ? {} : { note: resource.reason ?? 'incomplete' }),
    // Always. A cache that could not be read must not become a cage.
    allowFreeText: true,
  };
};

/**
 * The fields a `field:` predicate can name.
 *
 * **A field is always recorded by its id, and only labelled with its display name.** Two reasons,
 * and the second is why this is the most valuable thing this module does.
 *
 * Jira Cloud lets two custom fields share a display name. `makeFieldResolver` refuses that
 * ambiguity before a single issue is fetched, so a menu offering the bare name twice would build a
 * configuration that dies on the next run.
 *
 * And the catalogue those names resolve against comes from the cache, which is outside the config
 * directory and therefore editable by anything that can write in the home directory. `buildResolver`
 * matches an exact id **before** any display name and treats an id the catalogue lacks as a problem,
 * so a rule naming the id fails closed: a tampered catalogue can force a refusal, but it cannot
 * quietly point the predicate at a different field. A rule naming `Team` has no such guarantee.
 *
 * The cost is a config that says `customfield_10050` where a reader would rather see `Team`, and it
 * is paid deliberately. Do not "improve" the readability back by recording the name — that is the
 * edit that undoes the property, the same way caching the resolved name-to-id map would.
 */
export const fieldChoiceList = (
  fields: Resource<FieldInfo>,
  common: string[],
): ChoiceList => {
  const byName = new Map<string, number>();
  for (const field of fields.items) {
    byName.set(field.name.toLowerCase(), (byName.get(field.name.toLowerCase()) ?? 0) + 1);
  }

  const choiceFor = (field: FieldInfo): Choice => {
    // The id suffix stays for a duplicated name, or two entries would carry identical labels.
    const ambiguous = (byName.get(field.name.toLowerCase()) ?? 0) > 1;
    return { value: field.id, name: ambiguous ? `${field.name} (${field.id})` : field.name };
  };

  const lower = new Set(common.map((name) => name.toLowerCase()));
  const first = fields.items.filter((field) => lower.has(field.name.toLowerCase()));
  const rest = fields.items.filter((field) => !lower.has(field.name.toLowerCase()));

  return {
    items: [...first, ...rest].map(choiceFor),
    ...(fields.status === 'available' ? {} : { note: fields.reason ?? 'incomplete' }),
    allowFreeText: true,
  };
};

/**
 * A field named by either spelling, resolved to the one entry it means.
 *
 * Mirrors `buildResolver` in `src/fetch/session.ts`, deliberately: an exact id wins, a display name
 * resolves only when exactly one field carries it, and both comparisons are case-insensitive. A menu
 * that resolved more loosely than the run does would record a predicate the run then refuses.
 *
 * Needed because a draft may hold either spelling — a hand-written config says `Team`, this menu
 * records `customfield_10050`, and both are the same predicate.
 */
export const findField = (
  fields: Resource<FieldInfo>,
  spelling: string,
): FieldInfo | undefined => {
  const wanted = spelling.toLowerCase();
  const byId = fields.items.find((field) => field.id.toLowerCase() === wanted);
  if (byId) return byId;
  const named = fields.items.filter((field) => field.name.toLowerCase() === wanted);
  return named.length === 1 ? named[0] : undefined;
};

/** The fields worth putting at the top of a long list. Built-ins, because `GET /field` lists those
 * too and there are deliberately no separate `type` or `status` predicates. */
export const COMMON_FIELDS = [
  'Status',
  'Issue Type',
  'Components',
  'Priority',
  'Fix Version/s',
  'Sprint',
  'Labels',
];

/**
 * Resolves an opaque id — an accountId, a field id — back to a display label for the screen.
 *
 * One lookup for both rather than one per kind, and that is safe rather than lazy: it is display
 * only, an accountId and a field id cannot collide, and every caller falls back to the raw string.
 * What is recorded in the file is unaffected.
 */
export type LabelLookup = (id: string) => string | undefined;

const showValue = (value: ValueMatcher, labels?: LabelLookup): string => {
  if (value === null) return '(absent)';
  return labels?.(value) ?? value;
};

const showList = (values: ValueMatcher[], labels?: LabelLookup): string =>
  values.map((value) => showValue(value, labels)).join(', ');

/**
 * One rule, as a sentence.
 *
 * For a menu only. `compileTicketRule`'s `label` stays `JSON.stringify(rule)` and must not be
 * changed to use this: under the MCP server that string *is* the serialised policy in
 * `Outcome.reason`, and two audiences want two renderings.
 */
export const ruleToText = (rule: TicketRule, labels?: LabelLookup): string => {
  const parts: string[] = [];
  if (rule.project) parts.push(`project ${rule.project.join(', ')}`);
  const labelValues = rule.labels ?? rule.tags;
  if (labelValues) parts.push(`labels ${showList(labelValues)}`);
  for (const [name, values] of Object.entries(rule.field ?? {})) {
    // Through the lookup, because this menu records field ids: a screen showing
    // `customfield_10050` would give away the readability the file deliberately traded, for nothing.
    parts.push(`${labels?.(name) ?? name}: ${showList(values)}`);
  }
  if (rule.title) {
    parts.push(`title matches /${rule.title.matches}/${rule.title.flags ?? ''}`);
  }
  if (rule.reporter) parts.push(`reporter ${showList(rule.reporter, labels)}`);
  if (rule.assignee) parts.push(`assignee ${showList(rule.assignee, labels)}`);
  return parts.length === 0 ? 'nothing yet' : parts.join(' · ');
};

/** The rows of the rule editor: every predicate, set or not. */
export const predicateRows = (
  draft: RuleDraft,
  labels?: LabelLookup,
): Array<{ key: PredicateKey; label: string; value: string }> => {
  const unset = 'not set';
  return [
    {
      key: 'project',
      label: 'project',
      value: draft.project.length > 0 ? draft.project.join(', ') : unset,
    },
    {
      key: 'labels',
      label: 'labels',
      value: draft.labels.length > 0 ? showList(draft.labels) : unset,
    },
    {
      key: 'field',
      label: 'fields',
      value: draft.field.length > 0
        ? draft.field
          .map((entry) => `${labels?.(entry.name) ?? entry.name}: ${showList(entry.values)}`)
          .join(' · ')
        : unset,
    },
    {
      key: 'title',
      label: 'title',
      value: draft.title && draft.title.matches !== ''
        ? `/${draft.title.matches}/${draft.title.flags}`
        : unset,
    },
    {
      key: 'reporter',
      label: 'reporter',
      value: draft.reporter.length > 0 ? showList(draft.reporter, labels) : unset,
    },
    {
      key: 'assignee',
      label: 'assignee',
      value: draft.assignee.length > 0 ? showList(draft.assignee, labels) : unset,
    },
  ];
};

/** The whole filters block, for the review screen. */
export const filtersToLines = (
  filters: {
    include?: TicketRule[];
    exclude?: TicketRule[];
    comments?: {
      exclude?: Array<{ author: ValueMatcher[] }>;
    };
  } | undefined,
  labels?: LabelLookup,
): string[] => {
  const lines: string[] = [];
  const section = (title: string, rules: TicketRule[]) => {
    if (rules.length === 0) return;
    lines.push(`  ${title}`);
    for (const rule of rules) lines.push(`    ${ruleToText(rule, labels)}`);
  };
  section('include — a ticket must match one of these', filters?.include ?? []);
  section('exclude — matching any of these drops the ticket', filters?.exclude ?? []);
  const authors = (filters?.comments?.exclude ?? []).flatMap((rule) => rule.author);
  if (authors.length > 0) {
    lines.push('  comments left out, by author');
    lines.push(`    ${showList(authors, labels)}`);
  }
  return lines.length === 0
    ? ['  no filters: every ticket your token can see is fetchable']
    : lines;
};

/** Tries a title pattern against a sample, so a regular expression can be checked before it is
 * saved. An invalid pattern is `false` rather than a throw — the schema refuses it separately. */
export const testTitle = (
  predicate: { matches: string; flags?: string },
  sample: string,
): boolean => {
  try {
    return new RegExp(predicate.matches, predicate.flags).test(sample);
  } catch {
    return false;
  }
};

/** Every resource, paired with what to call it. One list, so the report and the
 * "could anything be read at all" check cannot disagree about what counts. */
const resourcesOf = (view: MetadataView): Array<[string, Resource<unknown>]> => [
  ['projects', view.projects],
  ['labels', view.labels],
  ['issue types', view.issueTypes],
  ['statuses', view.statuses],
  ['priorities', view.priorities],
  ['components', view.components],
  ['versions', view.versions],
  ['sprints', view.sprints],
  ['people', view.users],
  ['fields', view.fields],
];

/** One line per resource, for the screen that reports what could be read. */
export const resourceReport = (view: MetadataView): string[] => {
  const rows = resourcesOf(view);
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, resource]) => {
    const count = resource.status === 'unavailable' ? '\u2014' : String(resource.items.length);
    const why = resource.status === 'available' ? '' : `   ${resource.reason ?? 'incomplete'}`;
    return `  ${label.padEnd(width)}  ${count.padStart(4)}${why}`;
  });
};

/**
 * Whether nothing at all could be read.
 *
 * The menu offers typing values by hand when this is true, rather than presenting a screen of
 * empty pickers. A 401 on the whole site looks exactly like this.
 */
export const nothingAvailable = (view: MetadataView): boolean =>
  resourcesOf(view).every(([, resource]) => resource.items.length === 0);
