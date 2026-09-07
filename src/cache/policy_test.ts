import { assert, assertEquals, assertFalse, assertThrows } from '@std/assert';
import {
  isStale,
  MANIFEST_FILE,
  pinMismatch,
  type Resource,
  resourceFileName,
  RESOURCES,
} from './policy.ts';

const NOW = 1_757_000_000_000;

Deno.test('isStale is false up to and including the boundary', () => {
  const ttl = 60_000;
  assertFalse(isStale(NOW, ttl, NOW), 'just written');
  assertFalse(isStale(NOW - ttl + 1, ttl, NOW), 'a millisecond inside');
  assertFalse(isStale(NOW - ttl, ttl, NOW), 'exactly the boundary');
  assert(isStale(NOW - ttl - 1, ttl, NOW), 'a millisecond past');
  assert(isStale(NOW - ttl * 100, ttl, NOW), 'long past');
});

Deno.test('a stamp in the future is stale, not fresh', () => {
  // The clock moved. Trusting a future stamp would pin a stale entry as fresh for as long as the
  // skew lasts, which is the one way a TTL can fail open.
  assert(isStale(NOW + 1, 60_000, NOW));
  assert(isStale(NOW + 10 * 365 * 24 * 3_600_000, 60_000, NOW));
});

Deno.test('every resource has a usable policy', () => {
  // The Record type makes a missing entry a compile error; this catches a nonsense one.
  const resources = Object.keys(RESOURCES) as Resource[];
  assert(resources.length > 0);
  for (const resource of resources) {
    const policy = RESOURCES[resource];
    assert(policy.ttlMs > 0, `${resource} has a non-positive ttl`);
    assert(
      policy.scope === 'site' || policy.scope === 'project',
      `${resource} has an unknown scope`,
    );
  }
});

Deno.test('the field list is the shortest-lived resource of the ones read on the fetch path', () => {
  // Its TTL is what bounds the residual this cache accepts: a second field created with the same
  // display name makes a name newly ambiguous, and a stale catalogue resolves it happily.
  assert(RESOURCES.fields.ttlMs <= 6 * 3_600_000);
});

Deno.test('an empty result is a fact for some resources and a symptom for others', () => {
  // "The token can see no projects" is indistinguishable from "the token is wrong", so it is never
  // written as fresh-and-empty. A site with no labels is just a site with no labels.
  assertFalse(RESOURCES.projects.emptyIsOk);
  assertFalse(RESOURCES.fields.emptyIsOk);
  assertFalse(RESOURCES.users.emptyIsOk);
  assert(RESOURCES.labels.emptyIsOk);
  assert(RESOURCES.components.emptyIsOk);
  assert(RESOURCES.sprints.emptyIsOk);
});

Deno.test('a site-wide resource is one file; a project-scoped one is a file per key', () => {
  assertEquals(resourceFileName('fields'), 'fields.json');
  assertEquals(resourceFileName('labels'), 'labels.json');
  assertEquals(resourceFileName('users', 'DN'), 'DN-users.json');
  assertEquals(resourceFileName('sprints', 'SUP'), 'SUP-sprints.json');
  assert(resourceFileName('users', 'DN') !== resourceFileName('users', 'SUP'));
});

Deno.test('mismatching a resource with a project key is a programming error', () => {
  assertThrows(() => resourceFileName('fields', 'DN'), Error, 'site-wide');
  assertThrows(() => resourceFileName('users'), Error, 'needs a project key');
});

Deno.test('the manifest has a fixed name that no resource can collide with', () => {
  const resources = Object.keys(RESOURCES) as Resource[];
  for (const resource of resources) {
    const name = RESOURCES[resource].scope === 'site'
      ? resourceFileName(resource)
      : resourceFileName(resource, 'DN');
    assert(name !== MANIFEST_FILE, `${resource} collides with the manifest`);
  }
});

Deno.test('the pins reject another project and another site', () => {
  const expected = { project: '/Users/kim/code/thing', baseUrl: 'https://site.atlassian.net' };
  assertEquals(pinMismatch({ ...expected }, expected), undefined);
  assertEquals(
    pinMismatch({ ...expected, project: '/Users/kim/code/other' }, expected),
    'wrongProject',
  );
  // A repository repointed at a second Jira site must not read the first site's field ids as
  // fresh — the ids mean different fields there.
  assertEquals(
    pinMismatch({ ...expected, baseUrl: 'https://other.atlassian.net' }, expected),
    'wrongSite',
  );
});
