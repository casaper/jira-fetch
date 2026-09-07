import { assert, assertEquals, assertFalse } from '@std/assert';
import {
  CachedPerson,
  CachedProject,
  CacheManifest,
  FieldsEntry,
  LabelsEntry,
  PROJECT_KEY,
  SCHEMA_VERSION,
  UsersEntry,
} from './schema.ts';

const wrap = (over: Record<string, unknown> = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  project: '/Users/kim/code/thing',
  baseUrl: 'https://site.atlassian.net',
  resource: 'fields',
  fetchedAt: 1_757_000_000_000,
  state: 'ok',
  notes: [],
  data: [{ id: 'customfield_10050', name: 'Team' }],
  ...over,
});

Deno.test('a complete entry validates', () => {
  assert(FieldsEntry.safeParse(wrap()).success);
});

Deno.test('a partial entry must record why', () => {
  // The whole point of the envelope. Without this, a resource nobody could read would be
  // indistinguishable from one that is genuinely as small as it looks.
  assertFalse(FieldsEntry.safeParse(wrap({ state: 'partial', notes: [] })).success);
  assert(
    FieldsEntry.safeParse(wrap({ state: 'partial', notes: [{ code: 'forbidden' }] })).success,
  );
});

Deno.test('an empty ok entry and an empty partial entry are different things', () => {
  // `ok` plus no data means the site really has no labels. `partial` plus no data means nobody
  // could find out. Two states plus notes says that; one boolean could not.
  assert(LabelsEntry.safeParse(wrap({ resource: 'labels', data: [] })).success);
  assert(
    LabelsEntry.safeParse(
      wrap({ resource: 'labels', data: [], state: 'partial', notes: [{ code: 'forbidden' }] }),
    ).success,
  );
});

Deno.test('a different schema version does not parse', () => {
  // Which makes it a miss, which refetches live. This is why there is no migration to write.
  assertFalse(FieldsEntry.safeParse(wrap({ schemaVersion: SCHEMA_VERSION + 1 })).success);
  assertFalse(FieldsEntry.safeParse(wrap({ schemaVersion: '1' })).success);
});

Deno.test('an unknown key does not parse', () => {
  // strictObject buys something here it does not buy in a config file: an unknown key means
  // another build wrote this, and treating that as a miss is exactly the wanted behaviour.
  assertFalse(FieldsEntry.safeParse(wrap({ ttl: 3600 })).success);
});

Deno.test('the pins are required', () => {
  assertFalse(FieldsEntry.safeParse(wrap({ project: '' })).success);
  assertFalse(FieldsEntry.safeParse(wrap({ baseUrl: '' })).success);
});

Deno.test('fetchedAt is a positive integer, not a date string', () => {
  assertFalse(FieldsEntry.safeParse(wrap({ fetchedAt: '2026-09-07T12:00:00Z' })).success);
  assertFalse(FieldsEntry.safeParse(wrap({ fetchedAt: 0 })).success);
  assertFalse(FieldsEntry.safeParse(wrap({ fetchedAt: 1.5 })).success);
});

Deno.test('an unknown note code does not parse', () => {
  assertFalse(FieldsEntry.safeParse(wrap({ state: 'partial', notes: [{ code: 'oops' }] })).success);
});

Deno.test('PROJECT_KEY accepts a Jira key and refuses anything that is not one', () => {
  for (const good of ['DN', 'SUP', 'A', 'SUP_2', 'ABCDEFGHIJ']) {
    assert(PROJECT_KEY.test(good), `should accept ${good}`);
  }
  // A key reaches a filename and a createmeta path segment, so these must never get through.
  for (const bad of ['', 'dn', 'DN-1', '../x', 'D N', 'DN/SUP', '1DN', 'A'.repeat(32)]) {
    assertFalse(PROJECT_KEY.test(bad), `should refuse ${JSON.stringify(bad)}`);
  }
});

Deno.test('a cached project carries a validated key', () => {
  assert(CachedProject.safeParse({ key: 'DN', name: 'Datavault' }).success);
  assertFalse(CachedProject.safeParse({ key: '../etc', name: 'nope' }).success);
});

Deno.test('a person is identified by accountId, and the rest is optional', () => {
  assert(CachedPerson.safeParse({ accountId: '5f1a2b' }).success);
  assertFalse(CachedPerson.safeParse({ displayName: 'Kim Doe' }).success);
  // A site that does not publish email addresses still yields a usable person.
  const parsed = CachedPerson.safeParse({ accountId: '5f1a2b', displayName: 'Kim Doe' });
  assert(parsed.success);
  assertEquals(parsed.data.emailAddress, undefined);
});

Deno.test('the users entry holds people, not names', () => {
  assertFalse(UsersEntry.safeParse(wrap({ resource: 'users', data: ['Kim Doe'] })).success);
  assert(
    UsersEntry.safeParse(wrap({ resource: 'users', data: [{ accountId: '5f1a2b' }] })).success,
  );
});

Deno.test('the manifest validates every project key it carries', () => {
  const base = {
    schemaVersion: SCHEMA_VERSION,
    project: '/Users/kim/code/thing',
    baseUrl: 'https://site.atlassian.net',
    updatedAt: 1_757_000_000_000,
  };
  assert(CacheManifest.safeParse({ ...base, projects: ['DN', 'SUP'] }).success);
  assert(CacheManifest.safeParse({ ...base, projects: [] }).success);
  assertFalse(CacheManifest.safeParse({ ...base, projects: ['DN', '../x'] }).success);
});
