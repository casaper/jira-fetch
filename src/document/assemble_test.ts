import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from '@std/assert';
import { parse as parseYaml } from '@std/yaml';
import { assembleDocument } from './assemble.ts';
import { buildManifest } from '../assets/download.ts';
import { compileFilters } from '../filter/rules.ts';
import { type FiltersConfig, People, type PeopleConfig } from '../config/schema.ts';
import { commentsFixture, issueFixture } from '../../test/fixtures.ts';

const FETCHED_AT = new Date('2026-09-05T15:00:00.000Z');

/** The shipped defaults, parsed rather than restated, so these tests fail if the schema's
 * defaults change rather than quietly testing a stale copy of them. */
const DEFAULT_PEOPLE = People.parse({});

const people = (overrides: Partial<PeopleConfig> = {}): PeopleConfig =>
  People.parse({ ...DEFAULT_PEOPLE, ...overrides });

function assemble(filters?: FiltersConfig, peopleConfig: PeopleConfig = DEFAULT_PEOPLE) {
  const issue = issueFixture();
  return assembleDocument({
    issue,
    comments: commentsFixture(),
    siblings: [{ key: 'DN-1245' }, { key: 'DN-1246' }],
    assets: buildManifest(issue.fields.attachment, issue.key),
    baseUrl: 'https://example.atlassian.net',
    filters: compileFilters(filters),
    people: peopleConfig,
    fetchedAt: FETCHED_AT,
  });
}

function frontmatterOf(markdown: string): Record<string, unknown> {
  const end = markdown.indexOf('\n---', 4);
  return parseYaml(markdown.slice(4, end)) as Record<string, unknown>;
}

Deno.test('the document opens with a YAML frontmatter block', () => {
  const { markdown } = assemble();
  assert(markdown.startsWith('---\n'));
  assertStringIncludes(markdown, '\n---\n\n# [Spike: evaluate the export pipeline]');
});

Deno.test('the title heading links to the ticket', () => {
  const { markdown } = assemble();
  assertStringIncludes(
    markdown,
    '# [Spike: evaluate the export pipeline](https://example.atlassian.net/browse/DN-1243)',
  );
});

Deno.test('a title containing Markdown syntax is escaped in the link label', () => {
  const issue = issueFixture();
  issue.fields.summary = 'Fix [SUP-1] and _the_ exporter';
  const { markdown } = assembleDocument({
    issue,
    comments: [],
    siblings: [],
    assets: new Map(),
    baseUrl: 'https://example.atlassian.net',
    filters: compileFilters(undefined),
    people: DEFAULT_PEOPLE,
  });
  assertStringIncludes(
    markdown,
    '# [Fix \\[SUP-1\\] and \\_the\\_ exporter](https://example.atlassian.net/browse/DN-1243)',
  );
});

Deno.test("frontmatter carries the ticket's machine-readable metadata", () => {
  const data = frontmatterOf(assemble().markdown);

  assertEquals(data.id, 'DN-1243');
  assertEquals(data.title, 'Spike: evaluate the export pipeline');
  assertEquals(data.type, 'Task');
  assertEquals(data.status, 'In Progress');
  assertEquals(data.priority, 'Medium');
  assertEquals(data.created_at, '2026-08-01T09:12:00.000+0200');
  assertEquals(data.updated_at, '2026-08-14T16:40:11.000+0200');
  // Spelled like Jira's own timestamps — local time with a numeric offset, not UTC with a `Z` —
  // so every date in the block reads the same way. Asserted by shape and instant rather than by
  // a literal, since the offset is whatever the machine running the tests is in.
  const fetchedAt = data.fetched_at as string;
  assertMatch(fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/);
  assertEquals(new Date(fetchedAt).getTime(), FETCHED_AT.getTime());
  assertEquals(data.labels, ['backend', 'wontfix']);
  assertEquals(data.components, ['api', 'exporter']);
  assertEquals(data.fix_versions, ['2026.9']);
});

Deno.test('the keys that duplicate the ticket id or the link are gone', () => {
  const data = frontmatterOf(assemble().markdown);
  for (const key of ['internal_id', 'url', 'creator', 'author', 'project', 'project_name']) {
    assertFalse(key in data, `${key} should no longer be written`);
  }
});

Deno.test('absent values are omitted rather than spelled out', () => {
  const issue = issueFixture();
  issue.fields.components = [];
  issue.fields.attachment = [];
  const { markdown } = assembleDocument({
    issue,
    comments: [],
    siblings: [],
    assets: new Map(),
    baseUrl: 'https://example.atlassian.net',
    filters: compileFilters(undefined),
    people: DEFAULT_PEOPLE,
  });
  const data = frontmatterOf(markdown);

  // Null in the payload: an unresolved ticket, an anonymous portal reporter.
  assertFalse('resolution' in data);
  assertFalse('reporter' in data);
  // Empty collections.
  assertFalse('components' in data);
  assertFalse('siblings' in data);
  assertFalse('assets' in data);
  // Empty is not falsy: a ticket with no comments still says so.
  assertEquals(data.comment_count, 0);
});

Deno.test('pruning reaches inside nested records', () => {
  const issue = issueFixture();
  issue.fields.parent = { key: 'DN-1200' };
  const attachment = issue.fields.attachment?.[0];
  assert(attachment);
  delete attachment.size;
  const { markdown } = assembleDocument({
    issue,
    comments: [],
    siblings: [],
    assets: buildManifest([attachment], issue.key),
    baseUrl: 'https://example.atlassian.net',
    filters: compileFilters(undefined),
    people: DEFAULT_PEOPLE,
  });
  const data = frontmatterOf(markdown);

  // A parent with no summary, type or status collapses to the one thing it does have.
  assertEquals(data.parent, { key: 'DN-1200' });
  // Entries in a list go ragged rather than carrying empty placeholders.
  assertEquals(data.assets, [{
    filename: 'screenshot_01.png',
    path: '.DN-1243/screenshot_01.png',
    mime_type: 'image/png',
  }]);
});

Deno.test('people carry the configured fields, and nobody else', () => {
  const data = frontmatterOf(assemble().markdown);
  // Defaults are name + email; the opaque account_id is available but not written.
  assertEquals(data.assignee, { name: 'Kim Rivera', email: 'kim@example.com' });
  // An anonymous reporter has no record at all, so the key is absent.
  assertFalse('reporter' in data);
});

Deno.test('the field selection picks what is recorded, in the order given', () => {
  const data = frontmatterOf(
    assemble(undefined, people({ fields: ['accountId', 'name'] })).markdown,
  );
  assertEquals(data.assignee, {
    account_id: '5b10a2844c20165700ede21g',
    name: 'Kim Rivera',
  });
});

Deno.test('a role left out of the config disappears from the document', () => {
  const { markdown } = assemble(undefined, people({ roles: [] }));
  const data = frontmatterOf(markdown);
  assertFalse('assignee' in data);
  assertFalse('reporter' in data);
  // The comment heading falls back to its date alone.
  assertStringIncludes(markdown, '### 2026-08-05T11:00:00.000+0200');
  assertFalse(markdown.includes('Kim Rivera —'));
});

Deno.test('initials shorten a name everywhere it appears', () => {
  const { markdown } = assemble(undefined, people({ nameFormat: 'initials' }));
  assertEquals(frontmatterOf(markdown).assignee, { name: 'KR', email: 'kim@example.com' });
  assertStringIncludes(markdown, '### KR — 2026-08-05T11:00:00.000+0200');
});

Deno.test('parent, siblings and subtasks are recorded', () => {
  const data = frontmatterOf(assemble().markdown);
  assertEquals((data.parent as Record<string, unknown>).key, 'DN-1200');
  assertEquals(data.siblings, ['DN-1245', 'DN-1246']);
  assertEquals(data.subtasks, [{ key: 'DN-1244', type: 'Sub-task', status: 'To Do' }]);
});

Deno.test('a reference to another issue carries no copy of its title', () => {
  const data = frontmatterOf(assemble().markdown);
  assertEquals(data.parent, { key: 'DN-1200', type: 'Epic', status: 'In Progress' });
  // The fixture's parent and subtask both have a summary; neither is written.
  assertFalse(JSON.stringify(data.parent).includes('Export epic'));
  assertFalse(JSON.stringify(data.subtasks).includes('Write the exporter'));
});

Deno.test('assets are listed with the relative path used in the body', () => {
  const data = frontmatterOf(assemble().markdown);
  const assets = data.assets as Array<Record<string, unknown>>;
  assertEquals(assets.length, 2);
  assertEquals(assets[0].path, '.DN-1243/screenshot_01.png');
  assertEquals(assets[1].path, '.DN-1243/screenshot_01-20002.png');
});

Deno.test('comments follow the description, each behind a horizontal rule', () => {
  const { markdown } = assemble();
  const body = markdown.slice(markdown.indexOf('\n---\n', 4) + 5);
  assertEquals(body.split('\n---\n').length - 1, 3);
  assertStringIncludes(markdown, '### Kim Rivera — 2026-08-05T11:00:00.000+0200');
});

Deno.test('an anonymous comment is headed by its date, not by a placeholder name', () => {
  const { markdown } = assemble();
  assertStringIncludes(markdown, '### 2026-08-06T09:30:00.000+0200');
  assertFalse(markdown.includes('Anonymous'));
});

Deno.test("a comment's media resolves through the same manifest as the description", () => {
  const { markdown } = assemble();
  // Both attachments are called "screenshot 01.png", so the two media UUIDs are matched in
  // document order: the description takes the first, this comment the second. Nothing in ADF can
  // distinguish them better than that.
  assertStringIncludes(markdown, '![screenshot 01.png](.DN-1243/screenshot_01.png)');
  assertStringIncludes(markdown, '![screenshot 01.png](.DN-1243/screenshot_01-20002.png)');
});

Deno.test('filtered comments are dropped and counted', () => {
  const result = assemble({ comments: { exclude: [{ author: [null] }] } });
  assertEquals(result.skippedComments, 1);
  assertFalse(result.markdown.includes('Reported from the portal'));
  assertEquals(frontmatterOf(result.markdown).comment_count, 2);
});

Deno.test('an issue with no description says so rather than leaving a gap', () => {
  const issue = issueFixture();
  issue.fields.description = null;
  const { markdown } = assembleDocument({
    issue,
    comments: [],
    siblings: [],
    assets: new Map(),
    baseUrl: 'https://example.atlassian.net',
    filters: compileFilters(undefined),
    people: DEFAULT_PEOPLE,
  });
  assertStringIncludes(markdown, '*No description.*');
  assert(markdown.endsWith('\n'));
});
