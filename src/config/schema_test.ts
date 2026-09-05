import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { ConfigError } from './errors.ts';
import { parseConfigFile, parseFilters } from './schema.ts';

function rejects(data: unknown, ...includes: string[]) {
  const error = assertThrows(() => parseFilters(data), ConfigError);
  for (const needle of includes) assertStringIncludes(error.message, needle);
  return error;
}

Deno.test('a valid filters block round-trips', () => {
  const filters = parseFilters({
    include: [{ project: ['DN'] }],
    exclude: [
      { labels: ['wontfix'] },
      { field: { Team: ['Platform'] } },
      { title: { matches: '^spike:', flags: 'i' } },
      { reporter: [null, 'bot@example.com'] },
    ],
    comments: { exclude: [{ author: [null] }] },
  });
  assertEquals(filters.exclude?.length, 4);
});

Deno.test('an empty rule is rejected, because it would match every ticket', () => {
  rejects({ exclude: [{}] }, 'at least one predicate');
});

Deno.test('an unknown predicate is rejected and named', () => {
  rejects({ exclude: [{ compnent: ['api'] }] }, 'compnent');
});

Deno.test('an empty value list is rejected, because it could never match', () => {
  rejects({ exclude: [{ labels: [] }] }, 'at least one value');
});

Deno.test('project cannot be null: every issue key has a prefix', () => {
  rejects({ exclude: [{ project: [null] }] }, 'exclude[0].project[0]');
});

Deno.test('an invalid regex is reported against its rule path', () => {
  rejects({ exclude: [{ title: { matches: '([' } }] }, 'title.matches', 'regular expression');
});

Deno.test('invalid regex flags are rejected', () => {
  rejects({ exclude: [{ title: { matches: 'x', flags: 'q' } }] }, 'flags');
});

Deno.test("only 'author' is accepted on a comment rule", () => {
  rejects({ comments: { exclude: [{ labels: ['x'] }] } }, 'author');
});

Deno.test('errors name the file they came from and every problem at once', () => {
  const error = assertThrows(
    () => parseConfigFile({ filters: { exclude: [{}, { labels: [] }] } }, '.jira-fetch.json'),
    ConfigError,
  );
  assertStringIncludes(error.message, '.jira-fetch.json is not a valid configuration');
  assert(error.message.split('\n').length >= 3);
});

Deno.test('an unknown top-level key is rejected rather than silently ignored', () => {
  const error = assertThrows(
    () => parseConfigFile({ basUrl: 'https://x.atlassian.net' }, 'cfg'),
    ConfigError,
  );
  assertStringIncludes(error.message, 'basUrl');
});

Deno.test('$schema is allowed, so editors can bind the file to the schema', () => {
  const config = parseConfigFile(
    { $schema: './schema/jira-fetch.schema.json', email: 'a@b.co' },
    'cfg',
  );
  assertEquals(config.email, 'a@b.co');
});

Deno.test('baseUrl and email are validated as a URL and an address', () => {
  assertThrows(() => parseConfigFile({ baseUrl: 'not a url' }, 'cfg'), ConfigError);
  assertThrows(() => parseConfigFile({ email: 'not an email' }, 'cfg'), ConfigError);
});

Deno.test('an empty config file is valid: everything may come from flags or the environment', () => {
  assertEquals(parseConfigFile({}, 'cfg'), {});
});

Deno.test('the people block fills in its defaults', () => {
  const config = parseConfigFile({ people: {} }, 'cfg');
  assertEquals(config.people, {
    roles: ['reporter', 'assignee', 'commenter'],
    fields: ['name', 'email'],
    nameFormat: 'full',
  });
});

Deno.test('an empty roles list is how a user says "no people at all"', () => {
  const config = parseConfigFile({ people: { roles: [] } }, 'cfg');
  assertEquals(config.people?.roles, []);
  // The field selection is untouched by that: the two axes are independent.
  assertEquals(config.people?.fields, ['name', 'email']);
});

Deno.test('an empty field selection is refused: a person needs at least one property', () => {
  const error = assertThrows(
    () => parseConfigFile({ people: { fields: [] } }, 'cfg'),
    ConfigError,
  );
  assertStringIncludes(error.message, 'people.fields');
  assertStringIncludes(error.message, 'at least one field');
});

Deno.test('an unknown role, field or name format is refused', () => {
  for (
    const people of [
      { roles: ['watcher'] },
      { fields: ['account_id'] },
      { nameFormat: 'short' },
      { nameFormat: 'full', extra: true },
    ]
  ) {
    assertThrows(() => parseConfigFile({ people }, 'cfg'), ConfigError);
  }
});
