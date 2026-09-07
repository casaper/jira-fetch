import { assert, assertEquals, assertFalse } from '@std/assert';
import { parseFilters } from '../config/schema.ts';
import type { FiltersConfig, TicketRule, ValueMatcher } from '../config/schema.ts';
import { compileFilters } from '../filter/rules.ts';
import { commentExcluded, ticketDecision } from '../filter/evaluate.ts';
import type { JiraComment, JiraIssue } from '../jira/types.ts';
import {
  clearPredicate,
  draftIsEmpty,
  draftToFilters,
  draftToRule,
  emptyRuleDraft,
  filtersToDraft,
  type PredicateKey,
  removeField,
  type RuleDraft,
  ruleToDraft,
  setFieldValues,
} from './filter_draft.ts';

const draftOf = (over: Partial<RuleDraft>): RuleDraft => ({ ...emptyRuleDraft(), ...over });

Deno.test('every predicate survives a round trip through the loader', () => {
  const rules: TicketRule[] = [
    { project: ['DN'] },
    { labels: ['security'] },
    { labels: ['security', null] },
    { field: { Team: ['Platform'] } },
    { field: { Team: ['Platform', null], Status: ['Done'] } },
    { title: { matches: '^spike:' } },
    { title: { matches: '^spike:', flags: 'i' } },
    { reporter: ['kim@example.com'] },
    { reporter: [null] },
    { assignee: ['5f1a2b', null] },
    {
      project: ['DN', 'SUP'],
      labels: ['security'],
      field: { Team: ['Platform'] },
      title: { matches: 'x', flags: 'im' },
      reporter: [null],
      assignee: ['kim@example.com'],
    },
  ];
  for (const rule of rules) {
    const back = draftToRule(ruleToDraft(rule));
    assertEquals(back, rule, JSON.stringify(rule));
    // And through the gate the loader itself uses.
    parseFilters({ include: [back] }, 'draft');
  }
});

Deno.test('a whole filters block round trips', () => {
  const filters: FiltersConfig = {
    include: [{ project: ['DN'] }],
    exclude: [{ labels: ['wontfix'] }, { field: { Team: ['Platform'] } }],
    comments: { exclude: [{ author: ['Automation for Jira', null] }] },
  };
  const back = draftToFilters(filtersToDraft(filters));
  assertEquals(back, filters);
  parseFilters(back, 'draft');
});

Deno.test('nothing chosen produces no rule at all', () => {
  assertEquals(draftToRule(emptyRuleDraft()), undefined);
  assert(draftIsEmpty(emptyRuleDraft()));
});

Deno.test('an empty predicate can never reach the config, in any combination', () => {
  // The test that matters most here. `{ field: {} }` *passes* parseConfigFile — the rule
  // refinement only counts keys — and compileTicketRule then yields `field: []`, over which
  // `.every()` is vacuously true. In an include list that is a rule matching every ticket. So
  // round-tripping through the schema does not establish that a draft means what was chosen.
  const empties: Array<Partial<RuleDraft>> = [
    { project: [] },
    { labels: [] },
    { field: [] },
    { field: [{ name: 'Team', values: [] }] },
    { field: [{ name: '', values: ['Platform'] }] },
    { field: [{ name: 'Team', values: [] }, { name: 'Status', values: [] }] },
    { title: { matches: '', flags: '' } },
    { title: { matches: '', flags: 'i' } },
    { reporter: [] },
    { assignee: [] },
  ];

  for (const partial of empties) {
    const rule = draftToRule(draftOf(partial));
    if (rule === undefined) continue;
    for (const [key, value] of Object.entries(rule)) {
      assert(
        !Array.isArray(value) || value.length > 0,
        `${JSON.stringify(partial)} produced an empty ${key}`,
      );
      if (key === 'field') {
        const field = value as Record<string, ValueMatcher[]>;
        assert(Object.keys(field).length > 0, `${JSON.stringify(partial)} produced an empty field`);
        for (const [name, values] of Object.entries(field)) {
          assert(name !== '', 'a field with no name');
          assert(values.length > 0, `field ${name} has no values`);
        }
      }
    }
  }

  // And the two mixed cases: something real beside something empty keeps only the real one.
  assertEquals(
    draftToRule(draftOf({ project: ['DN'], labels: [], field: [{ name: 'Team', values: [] }] })),
    { project: ['DN'] },
  );
});

Deno.test('a tags rule survives being edited, rather than being deleted', () => {
  // compileTicketRule reads `labels ?? tags`, so a hand-written tags: rule is live policy. A
  // draft that only read labels would render it empty and drop it on save — silent loosening.
  const draft = ruleToDraft({ tags: ['security'] });
  assertEquals(draft.labels, ['security']);
  const back = draftToRule(draft);
  assertEquals(back, { labels: ['security'] });

  // The canonical spelling changes, and the meaning does not.
  const before = compileFilters({ include: [{ tags: ['security'] }] });
  const after = compileFilters({ include: [back as TicketRule] });
  assertEquals(after.include[0].labels, before.include[0].labels);
});

Deno.test('flattening the comment rules drops exactly the same comments', () => {
  const comment = (author: string | null): JiraComment =>
    ({ author: author === null ? null : { displayName: author } }) as JiraComment;

  const separate = compileFilters({
    comments: { exclude: [{ author: ['Bot One'] }, { author: ['Bot Two'] }] },
  });
  const flattened = compileFilters({
    comments: { exclude: [{ author: ['Bot One', 'Bot Two'] }] },
  });

  for (const author of ['Bot One', 'Bot Two', 'Kim Doe', null]) {
    assertEquals(
      commentExcluded(comment(author), separate).excluded,
      commentExcluded(comment(author), flattened).excluded,
      `disagreed about ${author}`,
    );
  }
});

Deno.test('duplicate comment authors are recorded once, in the order chosen', () => {
  const filters = draftToFilters({
    include: [],
    exclude: [],
    commentAuthors: ['Bot', null, 'Bot', null, 'Other'],
  });
  assertEquals(filters?.comments?.exclude, [{ author: ['Bot', null, 'Other'] }]);
});

Deno.test('no filters at all is undefined, not an empty block', () => {
  // An empty `filters:` key would read as "filters have been configured" when they have not.
  assertEquals(draftToFilters({ include: [], exclude: [], commentAuthors: [] }), undefined);
  // A rule that turned out empty does not resurrect the block either.
  assertEquals(
    draftToFilters({ include: [emptyRuleDraft()], exclude: [], commentAuthors: [] }),
    undefined,
  );
});

Deno.test('clearing a predicate leaves the rest of the rule alone', () => {
  const full = draftOf({
    project: ['DN'],
    labels: ['x'],
    field: [{ name: 'Team', values: ['Platform'] }],
    title: { matches: 'a', flags: 'i' },
    reporter: ['k'],
    assignee: ['j'],
  });
  const keys: PredicateKey[] = ['project', 'labels', 'field', 'title', 'reporter', 'assignee'];
  for (const key of keys) {
    const cleared = draftToRule(clearPredicate(full, key));
    assert(cleared, `clearing ${key} emptied the whole rule`);
    assertFalse(key in cleared, `${key} survived being cleared`);
    // Five predicates left, every time.
    assertEquals(Object.keys(cleared).length, 5, `clearing ${key} lost more than it should`);
  }
});

Deno.test('a field is replaced rather than added twice', () => {
  let draft = setFieldValues(emptyRuleDraft(), 'Team', ['Platform']);
  draft = setFieldValues(draft, 'Team', ['Data']);
  assertEquals(draft.field, [{ name: 'Team', values: ['Data'] }]);
  draft = setFieldValues(draft, 'Status', ['Done']);
  assertEquals(draft.field.length, 2);
  assertEquals(removeField(draft, 'Team').field, [{ name: 'Status', values: ['Done'] }]);
});

Deno.test('a field re-picked under its other spelling replaces the entry, not adds one', () => {
  // The regression the id change could have introduced. A config written by hand says `Team`; the
  // menu records `customfield_10101`. Matching on the string alone appends, and the saved rule then
  // carries two conditions on one field, ANDed — which is not what anybody chose.
  const same = (spelling: string) =>
    spelling === 'customfield_10101' || spelling.toLowerCase() === 'team';

  let draft = ruleToDraft({ field: { Team: ['Platform'] } });
  assertEquals(draft.field, [{ name: 'Team', values: ['Platform'] }]);

  draft = setFieldValues(draft, 'customfield_10101', ['Data'], same);
  assertEquals(draft.field, [{ name: 'customfield_10101', values: ['Data'] }]);
  assertEquals(Object.keys(draftToRule(draft)?.field ?? {}), ['customfield_10101']);

  // And it goes in place, so the order predicates were added in survives.
  let ordered = ruleToDraft({ field: { Team: ['Platform'], status: ['Done'] } });
  ordered = setFieldValues(ordered, 'customfield_10101', ['Data'], same);
  assertEquals(ordered.field.map((entry) => entry.name), ['customfield_10101', 'status']);

  assertEquals(removeField(ordered, 'customfield_10101', same).field, [{
    name: 'status',
    values: ['Done'],
  }]);
});

Deno.test('what the menu builds decides tickets the way the menu said it would', () => {
  // The only test here that runs from a choice all the way to a filter decision.
  const issue = {
    key: 'DN-1243',
    fields: {
      summary: 'spike: try something',
      labels: ['security'],
      reporter: { displayName: 'Kim Doe' },
    },
  } as unknown as JiraIssue;

  const excludeSpikes = draftToFilters({
    include: [],
    exclude: [draftOf({ title: { matches: '^spike:', flags: 'i' } })],
    commentAuthors: [],
  });
  assert(ticketDecision(issue, compileFilters(excludeSpikes)).excluded);

  const excludeOtherLabel = draftToFilters({
    include: [],
    exclude: [draftOf({ labels: ['wontfix'] })],
    commentAuthors: [],
  });
  assertFalse(ticketDecision(issue, compileFilters(excludeOtherLabel)).excluded);

  // An include list a ticket does not match drops it.
  const onlySup = draftToFilters({
    include: [draftOf({ project: ['SUP'] })],
    exclude: [],
    commentAuthors: [],
  });
  assert(ticketDecision(issue, compileFilters(onlySup)).excluded);
});
