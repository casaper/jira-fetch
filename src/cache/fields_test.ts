import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import type { JiraFieldMeta } from '../jira/types.ts';
import { cachedFieldSource } from './fields.ts';
import { FieldsEntry } from './schema.ts';
import { readEntry, writeEntry } from './store.ts';

const PROJECT = '/Users/kim/code/thing';
const SITE = 'https://site.atlassian.net';
const NOW = 1_757_000_000_000;
const TTL = 6 * 3_600_000;

const field = (id: string, name: string): JiraFieldMeta => ({
  id,
  name,
  custom: true,
  navigable: true,
  orderable: true,
  searchable: true,
  clauseNames: [name],
});

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const base = await Deno.makeTempDir({ prefix: 'jira-fetch-fields-' });
  try {
    await body(join(base, 'a9993e364706'));
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
};

const sourceFor = (dir: string, fields: JiraFieldMeta[], now = () => NOW) => {
  let calls = 0;
  const logged: string[] = [];
  const source = cachedFieldSource({
    client: {
      getFields: () => {
        calls++;
        return Promise.resolve(fields);
      },
    },
    cacheDir: dir,
    project: PROJECT,
    baseUrl: SITE,
    now,
    log: (message) => logged.push(message),
  });
  return { source, calls: () => calls, logged };
};

const ref = (dir: string) => ({
  cacheDir: dir,
  resource: 'fields' as const,
  project: PROJECT,
  baseUrl: SITE,
});

Deno.test('a miss fetches live and remembers the answer', async () => {
  await withDir(async (dir) => {
    const { source, calls } = sourceFor(dir, [field('customfield_1', 'Team')]);
    assertEquals((await source.get()).map((f) => f.name), ['Team']);
    assertEquals(calls(), 1);

    const stored = await readEntry(FieldsEntry, ref(dir), NOW);
    assert(stored.hit);
    // `key` is absent rather than undefined: JSON drops it on the way to disk, which is fine
    // because resolution only reads it when a field actually has one.
    assertEquals(stored.hit.data, [{ id: 'customfield_1', name: 'Team' }]);
  });
});

Deno.test('a fresh entry is served without a request', async () => {
  await withDir(async (dir) => {
    const first = sourceFor(dir, [field('customfield_1', 'Team')]);
    await first.source.get();

    const second = sourceFor(dir, [field('customfield_1', 'Team')]);
    assertEquals((await second.source.get()).map((f) => f.name), ['Team']);
    assertEquals(second.calls(), 0);
  });
});

Deno.test('a stale entry is refetched', async () => {
  await withDir(async (dir) => {
    const written = sourceFor(dir, [field('customfield_1', 'Squad')]);
    await written.source.get();

    const later = sourceFor(dir, [field('customfield_1', 'Team')], () => NOW + TTL + 1);
    assertEquals((await later.source.get()).map((f) => f.name), ['Team']);
    assertEquals(later.calls(), 1);
  });
});

Deno.test('refresh always goes live, whatever the cache holds', async () => {
  await withDir(async (dir) => {
    const written = sourceFor(dir, [field('customfield_1', 'Squad')]);
    await written.source.get();

    const fresh = sourceFor(dir, [field('customfield_1', 'Team')]);
    assertEquals((await fresh.source.refresh()).map((f) => f.name), ['Team']);
    assertEquals(fresh.calls(), 1);
    // And the live answer replaces what was there.
    const stored = await readEntry(FieldsEntry, ref(dir), NOW);
    assert(stored.hit);
    assertEquals(stored.hit.data[0].name, 'Team');
  });
});

Deno.test('only the three properties resolution reads are stored', async () => {
  await withDir(async (dir) => {
    const { source } = sourceFor(dir, [field('customfield_1', 'Team')]);
    await source.get();
    const raw = JSON.parse(await Deno.readTextFile(join(dir, 'fields.json')));
    assertEquals(Object.keys(raw.data[0]).sort(), ['id', 'name']);
    // Nothing about a field's configuration reaches disk.
    assertEquals(raw.data[0].clauseNames, undefined);
    assertEquals(raw.data[0].searchable, undefined);
  });
});

Deno.test('two fields sharing a name are both kept, so the ambiguity stays visible', async () => {
  // The reason the raw catalogue is cached and not a resolved map: rebuilding the maps on every
  // run is what keeps makeFieldResolver able to refuse an ambiguous name.
  await withDir(async (dir) => {
    const { source } = sourceFor(dir, [
      field('customfield_1', 'Category'),
      field('customfield_2', 'Category'),
    ]);
    const entries = await source.get();
    assertEquals(entries.length, 2);
    assertEquals(new Set(entries.map((f) => f.id)), new Set(['customfield_1', 'customfield_2']));
  });
});

Deno.test('an unwritable cache is slower, not broken', async () => {
  await withDir(async (dir) => {
    // A file where the directory should be: mkdir fails, so the write fails, and the fetch must
    // still return the live answer.
    await Deno.mkdir(join(dir, '..'), { recursive: true }).catch(() => {});
    await Deno.writeTextFile(dir, 'not a directory');

    const { source, logged } = sourceFor(dir, [field('customfield_1', 'Team')]);
    assertEquals((await source.get()).map((f) => f.name), ['Team']);
    assert(
      logged.some((line) => line.includes('could not cache the field list')),
      `expected a note about the failed write, got: ${logged.join(' | ')}`,
    );
  });
});

Deno.test('an entry pinned to another site is not served', async () => {
  await withDir(async (dir) => {
    await writeEntry(
      FieldsEntry,
      {
        cacheDir: dir,
        resource: 'fields',
        project: PROJECT,
        baseUrl: 'https://other.atlassian.net',
      },
      NOW,
      { state: 'ok', notes: [], data: [{ id: 'customfield_9', name: 'Elsewhere' }] },
    );

    const { source, calls } = sourceFor(dir, [field('customfield_1', 'Team')]);
    assertEquals((await source.get()).map((f) => f.name), ['Team']);
    assertEquals(calls(), 1, "the other site's ids must not be reused");
  });
});
