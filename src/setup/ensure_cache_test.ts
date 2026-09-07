/** What the filter menu does before it offers anything.
 *
 * `MetadataClient` is the seam, so a counting fake answers the question a request-economy assertion
 * asks — "was this fetched at all" — without an HTTP server in the way.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { join } from '@std/path';
import type { MetadataClient } from '../cache/metadata.ts';
import { readManifest } from '../cache/store.ts';
import { ensureCache } from './ensure_cache.ts';
import type { EnsureCacheDeps, ProjectChoice } from './ensure_cache.ts';
import { loadMetadataView } from './metadata.ts';

const PROJECT = '/Users/kim/code/thing';
const SITE = 'https://site.atlassian.net';
const NOW = 1_757_000_000_000;

const page = <T>(items: T[]) => Promise.resolve({ items, truncated: false });

/** Every call counted, so "this was never fetched" is assertable. */
const countingClient = (overrides: Partial<MetadataClient> = {}) => {
  const calls: Record<string, number> = {};
  const count = <T>(name: string, answer: () => T) => (): T => {
    calls[name] = (calls[name] ?? 0) + 1;
    return answer();
  };
  const client: MetadataClient = {
    searchProjects: count('searchProjects', () =>
      page([
        { id: '1', key: 'DN', name: 'Datavault' },
        { id: '2', key: 'SUP', name: 'Support' },
      ])),
    getFields: count(
      'getFields',
      () => Promise.resolve([{ id: 'customfield_10050', name: 'Team', custom: true }]),
    ),
    getLabels: count('getLabels', () => page(['security', 'wontfix'])),
    getPriorities: count('getPriorities', () => page([{ id: '1', name: 'High' }])),
    getCreateMetaIssueTypes: count(
      'getCreateMetaIssueTypes',
      () => page([{ id: '10001', name: 'Bug' }]),
    ),
    getCreateMetaFields: count('getCreateMetaFields', () =>
      page([{
        key: 'customfield_10050',
        name: 'Team',
        allowedValues: [{ value: 'Platform' }],
        operations: [],
        required: false,
        schema: { type: 'array' },
      }])),
    getProjectStatuses: count(
      'getProjectStatuses',
      () => Promise.resolve([{ id: '3', name: 'Done' }]),
    ),
    getProjectComponents: count('getProjectComponents', () => page([{ id: '9', name: 'Infra' }])),
    getProjectVersions: count('getProjectVersions', () => page([{ id: '4', name: '1.0' }])),
    getAssignableUsers: count(
      'getAssignableUsers',
      // With an email, because a site that hides them raises the `emailsHidden` note and makes
      // the entry `partial` — correct, and not what these tests are about.
      () => page([{ accountId: 'a1', displayName: 'Kim Doe', emailAddress: 'kim@example.com' }]),
    ),
    getBoards: count('getBoards', () => page([{ id: 7, name: 'DN board' }])),
    getSprints: count('getSprints', () => page([{ id: 3, name: 'Sprint 3', state: 'active' }])),
    ...overrides,
  };
  return { client, calls };
};

/** Answers the picker with fixed keys, and records what it was offered. */
const picks = (keys: string[]) => {
  const offered: ProjectChoice[][] = [];
  return {
    offered,
    choose: (offer: ProjectChoice[]): Promise<string[]> => {
      offered.push(offer);
      return Promise.resolve(keys);
    },
  };
};

const withCacheDir = async (body: (cacheDir: string) => Promise<void>): Promise<void> => {
  const base = await Deno.makeTempDir({ prefix: 'jira-fetch-ensure-' });
  try {
    await body(join(base, 'a9993e364706'));
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
};

const deps = (
  cacheDir: string,
  client: MetadataClient,
  choose: EnsureCacheDeps['chooseProjects'],
  now = NOW,
): EnsureCacheDeps => ({
  client,
  cacheDir,
  project: PROJECT,
  baseUrl: SITE,
  now: () => now,
  log: () => {},
  chooseProjects: choose,
});

Deno.test('an empty cache is filled rather than reported as empty', async () => {
  // The defect this covers: the menu used to read the cache and render whatever was there, so a
  // first run offered nothing and sent the reader off to another command.
  await withCacheDir(async (cacheDir) => {
    const { client, calls } = countingClient();
    const picker = picks(['DN']);
    const result = await ensureCache(deps(cacheDir, client, picker.choose));

    assertEquals(result.failure, undefined);
    assertEquals(result.projectKeys, ['DN']);
    assertEquals(calls.searchProjects, 1);
    assertEquals(calls.getFields, 1);
    assertEquals(calls.getProjectComponents, 1);
    assert(result.outcomes.length > 0);
    assert(
      result.outcomes.every((outcome) => outcome.state === 'ok'),
      result.outcomes.filter((o) => o.state !== 'ok').map((o) => o.resource).join(','),
    );
  });
});

Deno.test('a cache still inside its TTL costs no requests at all', async () => {
  // The other half of the same feature: opening the menu twice in a minute must not refetch a
  // site. `ensure` decides that per resource; this is the assertion that it is reached.
  await withCacheDir(async (cacheDir) => {
    const { client, calls } = countingClient();
    const picker = picks(['DN']);
    await ensureCache(deps(cacheDir, client, picker.choose));
    const first = { ...calls };

    const second = await ensureCache(deps(cacheDir, client, picker.choose));

    assertEquals(calls, first);
    assert(
      second.outcomes.every((outcome) => !outcome.refreshed),
      'nothing should have been refreshed the second time',
    );
  });
});

Deno.test('force refetches what is still fresh', async () => {
  await withCacheDir(async (cacheDir) => {
    const { client, calls } = countingClient();
    const picker = picks(['DN']);
    await ensureCache(deps(cacheDir, client, picker.choose));

    await ensureCache({ ...deps(cacheDir, client, picker.choose), force: true });

    assertEquals(calls.getFields, 2);
  });
});

Deno.test('the picker is offered the projects that were just cached', async () => {
  // Ordering, and it is the whole reason the site refresh runs first: on a first run there is
  // nothing to offer until `/project/search` has been read.
  await withCacheDir(async (cacheDir) => {
    const { client } = countingClient();
    const picker = picks(['SUP']);
    await ensureCache(deps(cacheDir, client, picker.choose));

    assertEquals(picker.offered.length, 1);
    assertEquals(picker.offered[0], [
      { key: 'DN', name: 'Datavault' },
      { key: 'SUP', name: 'Support' },
    ]);
  });
});

Deno.test('the chosen projects reach the manifest, and the view reads them back', async () => {
  await withCacheDir(async (cacheDir) => {
    const { client } = countingClient();
    await ensureCache(deps(cacheDir, client, picks(['SUP']).choose));

    const manifest = await readManifest(cacheDir, { project: PROJECT, baseUrl: SITE });
    assertEquals(manifest.hit?.projects, ['SUP']);

    // Across the module boundary, because the manifest is the only thing that tells the next run
    // which projects it covers.
    const view = await loadMetadataView({
      cacheDir,
      project: PROJECT,
      baseUrl: SITE,
      projectKeys: manifest.hit?.projects ?? [],
      now: () => NOW,
    });
    assertEquals(view.components.items.map((item) => item.label), ['Infra']);
  });
});

Deno.test('a re-pick replaces the selection rather than adding to it', async () => {
  await withCacheDir(async (cacheDir) => {
    const { client } = countingClient();
    await ensureCache(deps(cacheDir, client, picks(['DN']).choose));
    await ensureCache(deps(cacheDir, client, picks(['SUP']).choose));

    const manifest = await readManifest(cacheDir, { project: PROJECT, baseUrl: SITE });
    assertEquals(manifest.hit?.projects, ['SUP']);
  });
});

Deno.test('a token that cannot list projects still gets to name them', async () => {
  // `/project/search` needs Browse Projects. A token without it can still read a project it is
  // told the key of, so an empty offer must not become an empty menu.
  await withCacheDir(async (cacheDir) => {
    const { client, calls } = countingClient({
      searchProjects: () => Promise.reject(new Error('nope')),
    });
    const picker = picks(['DN']);
    const result = await ensureCache(deps(cacheDir, client, picker.choose));

    assertEquals(picker.offered[0], []);
    assertEquals(result.projectKeys, ['DN']);
    assertEquals(calls.getProjectComponents, 1);
  });
});

Deno.test('a cache directory that cannot be written is a failure, not a throw', async () => {
  // Nothing in src/cache/ throws for a Jira failure, but a write does. The menu still has to open:
  // an unwritable home directory is a reason to type values by hand, not a reason to refuse.
  const base = await Deno.makeTempDir({ prefix: 'jira-fetch-ensure-' });
  try {
    const blocker = join(base, 'blocker');
    await Deno.writeTextFile(blocker, 'not a directory');
    const { client } = countingClient();
    const result = await ensureCache(deps(join(blocker, 'cache'), client, picks(['DN']).choose));

    assert(result.failure !== undefined, 'a write failure should be reported');
    assertEquals(result.outcomes, []);
    assertFalse(result.projectKeys.length > 0);
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});
