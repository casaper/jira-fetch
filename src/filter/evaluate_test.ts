import { assert, assertEquals, assertFalse } from '@std/assert';
import { compileFilters } from './rules.ts';
import {
  commentExcluded,
  normalizeValues,
  preFetchDecision,
  projectPrefix,
  ticketDecision,
} from './evaluate.ts';
import type { JiraIssue } from '../jira/types.ts';
import { commentsFixture, issueFixture } from '../../test/fixtures.ts';

Deno.test('projectPrefix reads the key, not the project field', () => {
  assertEquals(projectPrefix('DN-1243'), 'DN');
  assertEquals(projectPrefix('dn-1243'), 'DN');
  // Some sites allow hyphens inside the project key; the number is always last.
  assertEquals(projectPrefix('SUP-DESK-42'), 'SUP-DESK');
});

Deno.test('normalizeValues flattens every shape a Jira field value takes', () => {
  assertEquals(normalizeValues('Platform'), ['platform']);
  assertEquals(normalizeValues({ value: 'Platform' }), ['platform']);
  assertEquals(normalizeValues([{ name: 'api' }, { name: 'exporter' }]), ['api', 'exporter']);
  assertEquals(normalizeValues(null), []);
  assertEquals(normalizeValues(undefined), []);
  assertEquals(normalizeValues([]), []);
});

Deno.test('pre-fetch stage excludes by project prefix without the payload', () => {
  const filters = compileFilters({ exclude: [{ project: ['SUP'] }] });

  const decision = preFetchDecision('SUP-9', filters);
  assert(decision.excluded);
  assert(decision.reason?.includes('SUP'));

  assertFalse(preFetchDecision('DN-1243', filters).excluded);
});

Deno.test('pre-fetch stage defers a rule it cannot decide from the key alone', () => {
  // The rule needs the payload, so nothing may be decided before fetching.
  const filters = compileFilters({ exclude: [{ project: ['DN'], labels: ['wontfix'] }] });
  assertFalse(preFetchDecision('DN-1243', filters).excluded);
});

Deno.test('pre-fetch stage applies include rules only when all of them are pre-fetch', () => {
  const onlyPreFetch = compileFilters({ include: [{ project: ['DN'] }] });
  assert(preFetchDecision('SUP-9', onlyPreFetch).excluded);
  assertFalse(preFetchDecision('DN-1243', onlyPreFetch).excluded);

  // One include rule needs the payload, so the key alone can no longer rule anything out.
  const mixed = compileFilters({ include: [{ project: ['DN'] }, { labels: ['keep'] }] });
  assertFalse(preFetchDecision('SUP-9', mixed).excluded);
});

Deno.test('excludes anonymous reporter', () => {
  const issue = issueFixture(); // reporter is null, as for a portal submission
  const filters = compileFilters({ exclude: [{ reporter: [null] }] });
  assert(ticketDecision(issue, filters).excluded);
});

Deno.test('a named-user rule does not match an absent user', () => {
  const issue = issueFixture();
  const filters = compileFilters({ exclude: [{ reporter: ['someone@example.com'] }] });
  assertFalse(ticketDecision(issue, filters).excluded);
});

Deno.test('user predicates match on email, display name or account id', () => {
  const issue = issueFixture();
  for (const value of ['kim@example.com', 'Kim Rivera', '5b10a2844c20165700ede21g']) {
    const filters = compileFilters({ exclude: [{ assignee: [value] }] });
    assert(ticketDecision(issue, filters).excluded, `expected ${value} to match`);
  }
});

Deno.test("labels and its 'tags' alias behave identically", () => {
  const issue = issueFixture();
  assert(ticketDecision(issue, compileFilters({ exclude: [{ labels: ['wontfix'] }] })).excluded);
  assert(ticketDecision(issue, compileFilters({ exclude: [{ tags: ['wontfix'] }] })).excluded);
  assertFalse(ticketDecision(issue, compileFilters({ exclude: [{ tags: ['other'] }] })).excluded);
});

Deno.test('title predicate applies its regex flags', () => {
  const issue = issueFixture(); // summary starts with "Spike: "
  const sensitive = compileFilters({ exclude: [{ title: { matches: '^spike:' } }] });
  assertFalse(ticketDecision(issue, sensitive).excluded);

  const insensitive = compileFilters({ exclude: [{ title: { matches: '^spike:', flags: 'i' } }] });
  assert(ticketDecision(issue, insensitive).excluded);
});

Deno.test('field predicate resolves a custom field name to its customfield id', () => {
  const issue = issueFixture();
  const filters = compileFilters({ exclude: [{ field: { Team: ['Platform'] } }] });
  const resolve = (name: string) => name === 'Team' ? 'customfield_10101' : undefined;

  assert(ticketDecision(issue, filters, resolve).excluded);
  // Without the resolver the field reads as absent rather than throwing, so a config shared
  // across sites does not hard-fail where the field is missing.
  assertFalse(ticketDecision(issue, filters).excluded);
});

Deno.test("predicates within one rule are AND'd", () => {
  const issue = issueFixture();
  const both = compileFilters({ exclude: [{ project: ['DN'], labels: ['wontfix'] }] });
  assert(ticketDecision(issue, both).excluded);

  const oneWrong = compileFilters({ exclude: [{ project: ['SUP'], labels: ['wontfix'] }] });
  assertFalse(ticketDecision(issue, oneWrong).excluded);
});

Deno.test("rules within a list are OR'd", () => {
  const issue = issueFixture();
  const filters = compileFilters({ exclude: [{ project: ['SUP'] }, { labels: ['wontfix'] }] });
  assert(ticketDecision(issue, filters).excluded);
});

Deno.test('a ticket matching no include rule is dropped', () => {
  const issue = issueFixture();
  assert(ticketDecision(issue, compileFilters({ include: [{ project: ['SUP'] }] })).excluded);
  assertFalse(ticketDecision(issue, compileFilters({ include: [{ project: ['DN'] }] })).excluded);
});

Deno.test('exclude beats include', () => {
  const issue = issueFixture();
  const filters = compileFilters({
    include: [{ project: ['DN'] }],
    exclude: [{ labels: ['wontfix'] }],
  });
  assert(ticketDecision(issue, filters).excluded);
});

Deno.test('no filters keeps everything', () => {
  const issue = issueFixture();
  assertFalse(ticketDecision(issue, compileFilters(undefined)).excluded);
  assertFalse(preFetchDecision(issue.key, compileFilters({})).excluded);
});

Deno.test('comment filter drops comments, never the ticket', () => {
  const issue = issueFixture();
  const comments = commentsFixture();
  const filters = compileFilters({ comments: { exclude: [{ author: [null] }] } });

  assertFalse(ticketDecision(issue, filters).excluded);
  assertEquals(comments.filter((c) => commentExcluded(c, filters).excluded).length, 1);
});

Deno.test('comment filter matches a named bot author', () => {
  const comments = commentsFixture();
  const filters = compileFilters({
    comments: { exclude: [{ author: ['Automation for Jira'] }] },
  });
  const kept = comments.filter((c) => !commentExcluded(c, filters).excluded);
  assertEquals(kept.length, 2);
});

Deno.test('an issue without the optional fields does not throw', () => {
  const bare = { id: '1', key: 'X-1', fields: {} } as JiraIssue;
  const filters = compileFilters({
    exclude: [{ labels: ['a'] }, { assignee: ['b'] }, { title: { matches: 'c' } }],
  });
  assertFalse(ticketDecision(bare, filters).excluded);
});
