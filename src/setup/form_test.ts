import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { parseConfigFile, People } from '../config/schema.ts';
import {
  buildPeople,
  formExits,
  formRows,
  type FormState,
  hasCredentials,
  peopleSummary,
  toConfigFile,
  tokenSummary,
  validateBaseUrl,
  validateEmail,
  validateOut,
  validateToken,
} from './form.ts';

/** Named because `no-boolean-literal-for-arguments` is on, and because a validator returns
 * `true | string` — `assert(validate(x))` would pass on an error message, since a non-empty string
 * is truthy too. The comparison has to be exact. */
const VALID = true;

const rowFor = (state: FormState, action: string): string => {
  const row = formRows(state).find((candidate) => candidate.action === action);
  assert(row, `no row for ${action}`);
  return row.value;
};

Deno.test('the token row says how long it is and nothing else', () => {
  const token = 'ATATT3xFfGF0abcdefghijkl';
  const summary = tokenSummary(token);
  assertEquals(summary, `set (${token.length} characters)`);
  // No prefix, no mask, no substring: there is only ever one token in this file, so there is
  // nothing to tell apart and a hint would be a hint about a secret for no benefit.
  for (let i = 0; i + 3 <= token.length; i++) {
    assert(!summary.includes(token.slice(i, i + 3)), `leaked ${token.slice(i, i + 3)}`);
  }
  assertEquals(tokenSummary(undefined), 'not set');
  assertEquals(tokenSummary(''), 'not set');
});

Deno.test('an empty configuration reads as unset rather than as blank', () => {
  assertEquals(rowFor({}, 'baseUrl'), 'not set');
  assertEquals(rowFor({}, 'email'), 'not set');
  assertEquals(rowFor({}, 'token'), 'not set');
  // These two have real defaults, so saying "not set" would be wrong.
  assertEquals(rowFor({}, 'out'), 'the working directory');
  assertEquals(rowFor({}, 'allowJql'), 'allowed');
});

Deno.test('only an explicit false refuses JQL', () => {
  assertEquals(rowFor({ allowJql: true }, 'allowJql'), 'allowed');
  assertEquals(rowFor({ allowJql: false }, 'allowJql'), 'refused');
});

Deno.test('the people row says who, what and how', () => {
  assertEquals(
    peopleSummary(undefined),
    'reporter, assignee, commenter · name, email · full names',
  );
  assertEquals(
    peopleSummary(People.parse({ roles: [], fields: ['accountId'], nameFormat: 'initials' })),
    'nobody · accountId · initials',
  );
});

Deno.test('buildPeople takes its defaults from the schema, not from here', () => {
  const built = buildPeople(['reporter'], ['name'], 'full');
  assertEquals(built, { roles: ['reporter'], fields: ['name'], nameFormat: 'full' });
  // And the schema is what refuses an empty field list, so this cannot invent a laxer rule.
  assertEquals(People.parse({}).fields, ['name', 'email']);
});

Deno.test("a bad site address is refused in the loader's own words", () => {
  // Not a second wording of the rule: the same sentence the next run would print.
  const http = validateBaseUrl('http://jira.example.com');
  assert(http !== true);
  assertStringIncludes(http, 'must use https');

  const nonsense = validateBaseUrl('not a url');
  assert(nonsense !== true);

  assertEquals(validateBaseUrl('https://site.atlassian.net'), VALID);
});

Deno.test('plain http to loopback is accepted, because the suite depends on it', () => {
  assertEquals(validateBaseUrl('http://127.0.0.1:8080'), VALID);
  assertEquals(validateBaseUrl('http://localhost:8080'), VALID);
});

Deno.test('an email is checked against the schema that will check it again', () => {
  assertEquals(validateEmail('kim@example.com'), VALID);
  const bad = validateEmail('kim');
  assert(bad !== true);
  assertStringIncludes(bad, 'email');
});

Deno.test('an empty output folder means the working directory, which is a real answer', () => {
  assertEquals(validateOut(''), VALID);
  assertEquals(validateOut('  '), VALID);
  assertEquals(validateOut('docs/jira'), VALID);
});

Deno.test('a token is only checked for being there; the site decides the rest', () => {
  const empty = validateToken('   ');
  assert(empty !== true);
  assertEquals(validateToken('anything'), VALID);
});

Deno.test('credentials are complete only when all three are known', () => {
  assert(!hasCredentials({}));
  assert(!hasCredentials({ baseUrl: 'https://x', email: 'a@b.c' }));
  assert(hasCredentials({ baseUrl: 'https://x', email: 'a@b.c', token: 't' }));
});

Deno.test('the exit wording says what is already safe', () => {
  const [, , quit] = formExits({});
  assertEquals(quit.label, 'Quit without saving');
  const [, , quitAfter] = formExits({ baseUrl: 'https://x', email: 'a@b.c', token: 't' });
  // Credentials are written the moment they verify, so quitting later does not lose them.
  assertStringIncludes(quitAfter.label, 'the rest');
});

Deno.test('writing merges onto what was loaded rather than replacing it', () => {
  // The form does not offer a filters block, and building the file fresh would delete one.
  const loaded = {
    project: '/old/path',
    filters: { exclude: [{ project: ['SUP'] }] },
    $schema: 'https://example.invalid/schema.json',
  };
  const written = toConfigFile(loaded, {
    baseUrl: 'https://site.atlassian.net',
    email: 'kim@example.com',
    token: 't',
  }, '/new/path');
  assertEquals(written.filters, loaded.filters);
  assertEquals(written.$schema, loaded.$schema);
  // The project is always the repository in hand, never whatever the old file claimed.
  assertEquals(written.project, '/new/path');
});

Deno.test('everything the form can produce is a configuration the loader accepts', () => {
  // The guarantee config_file.ts already gives for the file as a whole, asserted for the states
  // this form can reach.
  const states: FormState[] = [
    { baseUrl: 'https://s.atlassian.net', email: 'k@e.com', token: 't' },
    { baseUrl: 'https://s.atlassian.net', email: 'k@e.com', token: 't', out: 'docs/jira' },
    { baseUrl: 'https://s.atlassian.net', email: 'k@e.com', token: 't', allowJql: false },
    {
      baseUrl: 'https://s.atlassian.net',
      email: 'k@e.com',
      token: 't',
      people: buildPeople([], ['accountId'], 'initials'),
    },
    {
      baseUrl: 'http://127.0.0.1:9999',
      email: 'k@e.com',
      token: 't',
      people: buildPeople(['reporter', 'assignee', 'commenter'], ['name', 'email'], 'full'),
    },
  ];
  for (const state of states) {
    const written = toConfigFile({}, state, '/work/thing');
    parseConfigFile(written, 'form');
  }
});
