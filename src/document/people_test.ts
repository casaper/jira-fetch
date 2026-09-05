import { assertEquals } from '@std/assert';
import { People, type PeopleConfig } from '../config/schema.ts';
import { initials, personLabel, personRecord } from './people.ts';
import type { JiraUser } from '../jira/types.ts';

const people = (overrides: Partial<PeopleConfig> = {}): PeopleConfig =>
  People.parse({ ...People.parse({}), ...overrides });

const KIM: JiraUser = {
  accountId: '5b10a2844c20165700ede21g',
  emailAddress: 'kim@example.com',
  displayName: 'Kim Rivera',
};

Deno.test('initials take the first letter of every part of a name', () => {
  assertEquals(initials('Kaspar Vollenweider'), 'KV');
  assertEquals(initials('Automation for Jira'), 'AFJ');
  assertEquals(initials('Prince'), 'P');
  // Hyphens and underscores split too, so a double-barrelled surname keeps both letters.
  assertEquals(initials('Anne-Marie Dupont'), 'AMD');
  assertEquals(initials('service_account bot'), 'SAB');
  // Runs of whitespace and leading spaces do not produce empty initials.
  assertEquals(initials('  Kim   Rivera '), 'KR');
});

Deno.test('initials do not cut a name mid-codepoint', () => {
  // Outside the BMP: taking `name[0]` would yield half a surrogate pair.
  assertEquals(initials('𝒦aspar 𝒱ollenweider'), '𝒦𝒱');
  assertEquals(initials('Ólafur Þórðarson'), 'ÓÞ');
});

Deno.test('a name that is only separators yields nothing for the caller to write', () => {
  assertEquals(initials('   '), '');
  assertEquals(initials(''), '');
});

Deno.test('a person record carries the selected fields, in the configured order', () => {
  assertEquals(personRecord(KIM, people()), { name: 'Kim Rivera', email: 'kim@example.com' });
  assertEquals(personRecord(KIM, people({ fields: ['name'] })), { name: 'Kim Rivera' });
  assertEquals(
    Object.keys(personRecord(KIM, people({ fields: ['email', 'name'] })) ?? {}),
    ['email', 'name'],
  );
});

Deno.test('accountId is written as account_id, the frontmatter spelling', () => {
  assertEquals(personRecord(KIM, people({ fields: ['accountId'] })), {
    account_id: '5b10a2844c20165700ede21g',
  });
});

Deno.test('a person with none of the selected fields has no record at all', () => {
  const bot: JiraUser = { accountId: '712020:bot', displayName: 'Automation for Jira' };
  assertEquals(personRecord(bot, people({ fields: ['email'] })), null);
  assertEquals(personRecord(null, people()), null);
  assertEquals(personRecord(undefined, people()), null);
});

Deno.test('nameFormat shortens the name and nothing else', () => {
  assertEquals(personRecord(KIM, people({ nameFormat: 'initials' })), {
    name: 'KR',
    email: 'kim@example.com',
  });
});

Deno.test('a label is the first selected field the person actually has', () => {
  assertEquals(personLabel(KIM, people()), 'Kim Rivera');
  assertEquals(personLabel(KIM, people({ fields: ['email', 'name'] })), 'kim@example.com');
  assertEquals(personLabel(KIM, people({ nameFormat: 'initials' })), 'KR');
  assertEquals(personLabel(null, people()), undefined);
});

Deno.test('a label falls through to the next field when the name is missing', () => {
  const noName: JiraUser = { accountId: '712020:bot', emailAddress: 'bot@example.com' };
  // Initials is a *name* transform: the address is left whole, since abbreviating it would
  // destroy the one thing it is good for.
  assertEquals(personLabel(noName, people({ nameFormat: 'initials' })), 'bot@example.com');
});
