import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import type { TicketRule } from '../config/schema.ts';
import { emptyRuleDraft, type RuleDraft } from './filter_draft.ts';
import type { FieldInfo, MetadataView, NamedValue, Resource } from './metadata_view.ts';
import {
  ABSENT,
  choiceValuesToMatchers,
  COMMON_FIELDS,
  fieldChoiceList,
  filtersToLines,
  findField,
  matchersToChoiceValues,
  nothingAvailable,
  predicateRows,
  resourceReport,
  ruleToText,
  testTitle,
  valueChoiceList,
} from './filter_render.ts';

const available = <T>(items: T[]): Resource<T> => ({ status: 'available', items });
const partial = <T>(items: T[], reason: string): Resource<T> => ({
  status: 'partial',
  reason,
  items,
});
const unavailable = <T>(reason: string): Resource<T> => ({
  status: 'unavailable',
  reason,
  items: [],
});

const named = (value: string, label?: string, hint?: string): NamedValue => ({
  value,
  label: label ?? value,
  ...(hint ? { hint } : {}),
});

const draftOf = (over: Partial<RuleDraft>): RuleDraft => ({ ...emptyRuleDraft(), ...over });

const view = (over: Partial<MetadataView> = {}): MetadataView => ({
  projects: available([named('DN')]),
  labels: available([named('security')]),
  issueTypes: available([named('Bug')]),
  statuses: available([named('Done')]),
  priorities: available([named('High')]),
  components: available([named('Infra')]),
  versions: available([named('1.0')]),
  sprints: available([named('Sprint 3')]),
  users: available([named('a1', 'Kim Doe')]),
  fields: available([{ id: 'customfield_1', name: 'Team' }]),
  ...over,
});

Deno.test('absent round trips, and no real value can be mistaken for it', () => {
  assertEquals(matchersToChoiceValues([null, 'x']), [ABSENT, 'v:x']);
  assertEquals(choiceValuesToMatchers([ABSENT, 'v:x']), [null, 'x']);
  // Every real value is prefixed, so even a Jira label literally called "absent" is distinct.
  assertEquals(choiceValuesToMatchers(matchersToChoiceValues(['absent', null])), ['absent', null]);
});

Deno.test('a picker always has something in it', () => {
  // A screen with no options is a broken screen, so even an unreadable resource offers the
  // absent entry and the note that says why the rest is missing.
  const list = valueChoiceList(unavailable('this token may not read them'), [], {
    absentLabel: '(absent)',
  });
  assert(list.items.length > 0);
  assertEquals(list.note, 'this token may not read them');
  assert(list.allowFreeText, 'a cache that could not be read must not become a cage');
});

Deno.test('a partial resource offers what it has and says it is short', () => {
  const list = valueChoiceList(partial([named('security')], '403 on one project'), [], {
    absentLabel: '(absent)',
  });
  assertEquals(list.note, '403 on one project');
  assert(list.items.some((item) => item.name === 'security'));
});

Deno.test('a complete resource carries no note', () => {
  assertEquals(
    valueChoiceList(available([named('security')]), [], { absentLabel: '(absent)' }).note,
    undefined,
  );
});

Deno.test('what is already in the rule is ticked', () => {
  const list = valueChoiceList(
    available([named('security'), named('wontfix')]),
    ['security', null],
    {
      absentLabel: '(absent)',
    },
  );
  const checked = list.items.filter((item) => item.checked).map((item) => item.value);
  assertEquals(new Set(checked), new Set([ABSENT, 'v:security']));
});

Deno.test('a value the cache has not heard of is kept, not silently dropped', () => {
  // A stale cache would otherwise delete part of a filter the moment somebody opened it.
  const list = valueChoiceList(available([named('security')]), ['retired-label'], {
    absentLabel: '(absent)',
  });
  const kept = list.items.find((item) => item.value === 'v:retired-label');
  assert(kept, 'the existing value disappeared');
  assert(kept.checked);
  assertStringIncludes(kept.name, 'not on this site');
});

Deno.test('every field is recorded by id and shown by name', () => {
  // Two reasons, and both are in the docstring: two custom fields may share a display name, and a
  // name is resolved through the cache while an id is matched before it. A rule naming the id fails
  // closed — a tampered catalogue can force a refusal but cannot redirect the predicate.
  const fields: FieldInfo[] = [
    { id: 'customfield_10078', name: 'Category' },
    { id: 'customfield_10045', name: 'Category' },
    { id: 'customfield_10101', name: 'Team' },
  ];
  const list = fieldChoiceList(available(fields), []);

  // An unambiguous field reads as its name and records its id.
  const team = list.items.find((item) => item.name === 'Team');
  assert(team);
  assertEquals(team.value, 'customfield_10101');

  // A duplicated name keeps the id in the label too, or the two would be indistinguishable.
  const categories = list.items.filter((item) => item.name.startsWith('Category'));
  assertEquals(categories.length, 2);
  assertEquals(
    categories.map((choice) => choice.value).sort(),
    ['customfield_10045', 'customfield_10078'],
  );
  for (const choice of categories) assertStringIncludes(choice.name, 'customfield_');
});

Deno.test('findField resolves either spelling, and refuses an ambiguous name', () => {
  // Mirrors buildResolver: an id wins, a name resolves only when one field carries it, and both
  // are case-insensitive. Resolving more loosely here would record what the run then refuses.
  const fields = available<FieldInfo>([
    { id: 'customfield_10078', name: 'Category' },
    { id: 'customfield_10045', name: 'Category' },
    { id: 'customfield_10101', name: 'Team' },
    { id: 'status', name: 'Status' },
  ]);

  assertEquals(findField(fields, 'customfield_10101')?.id, 'customfield_10101');
  assertEquals(findField(fields, 'Team')?.id, 'customfield_10101');
  assertEquals(findField(fields, 'team')?.id, 'customfield_10101');
  assertEquals(findField(fields, 'CUSTOMFIELD_10101')?.id, 'customfield_10101');
  assertEquals(findField(fields, 'status')?.name, 'Status');
  // Ambiguous by name, so nothing — but each id still resolves on its own.
  assertEquals(findField(fields, 'Category'), undefined);
  assertEquals(findField(fields, 'customfield_10045')?.name, 'Category');
  assertEquals(findField(fields, 'Nothing'), undefined);
});

Deno.test('a rule naming a field id still reads as the field name', () => {
  // The readability is traded away in the file, deliberately. Giving it away on the screen as well
  // would be paying for it twice.
  const labels = (id: string) => id === 'customfield_10050' ? 'Team' : undefined;
  const text = ruleToText({ field: { customfield_10050: ['Platform'] } }, labels);
  assertStringIncludes(text, 'Team: Platform');

  const rows = predicateRows(draftOf({ field: [{ name: 'customfield_10050', values: ['x'] }] }));
  // With no lookup it falls back to the raw id rather than showing nothing.
  assertStringIncludes(rows.find((row) => row.key === 'field')?.value ?? '', 'customfield_10050');
});

Deno.test('the common fields come first, whatever order the site listed them', () => {
  const fields: FieldInfo[] = [
    { id: 'customfield_1', name: 'Zebra' },
    { id: 'status', name: 'Status' },
    { id: 'customfield_2', name: 'Aardvark' },
  ];
  const list = fieldChoiceList(available(fields), COMMON_FIELDS);
  assertEquals(list.items[0].name, 'Status');
});

Deno.test('a rule reads as a sentence, with absence spelled out', () => {
  const rule: TicketRule = {
    project: ['DN'],
    labels: ['security', null],
    field: { Team: ['Platform'] },
    title: { matches: '^spike:', flags: 'i' },
    reporter: [null],
  };
  const text = ruleToText(rule);
  assertStringIncludes(text, 'project DN');
  assertStringIncludes(text, 'labels security, (absent)');
  assertStringIncludes(text, 'Team: Platform');
  assertStringIncludes(text, 'title matches /^spike:/i');
  assertStringIncludes(text, 'reporter (absent)');
});

Deno.test('a tags rule renders as the labels it is', () => {
  assertStringIncludes(ruleToText({ tags: ['security'] }), 'labels security');
});

Deno.test('an account id is shown as a name where one is known', () => {
  const names = (id: string) => (id === 'a1' ? 'Kim Doe' : undefined);
  assertStringIncludes(ruleToText({ reporter: ['a1'] }, names), 'Kim Doe');
  // And falls back to the id, which is still better than nothing.
  assertStringIncludes(ruleToText({ reporter: ['a2'] }, names), 'a2');
});

Deno.test('an empty rule says so rather than rendering as blank', () => {
  assertEquals(ruleToText({}), 'nothing yet');
});

Deno.test('the rule editor lists every predicate, set or not', () => {
  const rows = predicateRows(draftOf({ project: ['DN'] }));
  assertEquals(rows.length, 6);
  assertEquals(rows.find((row) => row.key === 'project')?.value, 'DN');
  assertEquals(rows.find((row) => row.key === 'labels')?.value, 'not set');
  assertEquals(rows.find((row) => row.key === 'title')?.value, 'not set');
});

Deno.test('a half-typed title reads as unset', () => {
  assertEquals(
    predicateRows(draftOf({ title: { matches: '', flags: 'i' } })).find((r) => r.key === 'title')
      ?.value,
    'not set',
  );
});

Deno.test('no filters says what that means rather than saying nothing', () => {
  const lines = filtersToLines(undefined);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], 'every ticket your token can see');
});

Deno.test('the review screen groups include, exclude and comments', () => {
  const lines = filtersToLines({
    include: [{ project: ['DN'] }],
    exclude: [{ labels: ['wontfix'] }],
    comments: { exclude: [{ author: ['Bot'] }] },
  }).join('\n');
  assertStringIncludes(lines, 'include');
  assertStringIncludes(lines, 'exclude');
  assertStringIncludes(lines, 'comments left out');
  assertStringIncludes(lines, 'Bot');
});

Deno.test('a title pattern can be tried before it is saved', () => {
  assert(testTitle({ matches: '^spike:' }, 'spike: try it'));
  assertFalse(testTitle({ matches: '^spike:' }, 'Spike: try it'));
  assert(testTitle({ matches: '^spike:', flags: 'i' }, 'Spike: try it'));
  // An invalid pattern is false rather than a throw; the schema refuses it separately.
  assertFalse(testTitle({ matches: '[' }, 'anything'));
});

Deno.test('the report says what is missing as clearly as what is there', () => {
  const lines = resourceReport(view({
    sprints: unavailable('no Agile board is visible to this account'),
    users: partial([named('a1', 'Kim Doe')], 'this site does not publish email addresses'),
  })).join('\n');
  assertStringIncludes(lines, 'no Agile board is visible');
  assertStringIncludes(lines, 'does not publish email addresses');
  // Nothing readable is a dash, not a zero.
  assert(/sprints\s+—/.test(lines), lines);
});

Deno.test('a healthy report is counts and nothing else', () => {
  for (const line of resourceReport(view())) {
    assertFalse(line.includes('—'), line);
  }
});

Deno.test('nothing readable at all is detected, so the menu can offer typing instead', () => {
  assertFalse(nothingAvailable(view()));
  assert(nothingAvailable({
    projects: unavailable('401'),
    labels: unavailable('401'),
    issueTypes: unavailable('401'),
    statuses: unavailable('401'),
    priorities: unavailable('401'),
    components: unavailable('401'),
    versions: unavailable('401'),
    sprints: unavailable('401'),
    users: unavailable('401'),
    fields: unavailable('401'),
  }));
});

Deno.test('a person is offered by account id and labelled by name', () => {
  // normalizeValues matches on displayName, emailAddress or accountId — but names are neither
  // unique nor stable, so the id is what a rule records and the name is only what is read.
  const list = valueChoiceList(
    available([named('5f1a2b', 'Kim Doe', 'kim@example.com')]),
    [],
    { absentLabel: '(unassigned)' },
  );
  const person = list.items.find((item) => item.value === 'v:5f1a2b');
  assert(person, 'the person should be keyed by account id');
  assertStringIncludes(person.name, 'Kim Doe');
  assertStringIncludes(person.name, 'kim@example.com');
});
