import { assert, assertEquals, assertFalse, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { DIR_MODE, FILE_MODE, POSIX } from '../util/modes.ts';
import { MANIFEST_FILE, resourceFileName } from './policy.ts';
import { FieldsEntry, LabelsEntry, ProjectsEntry, SCHEMA_VERSION } from './schema.ts';
import { clearCache, readEntry, readManifest, writeEntry, writeManifest } from './store.ts';

const PROJECT = '/Users/kim/code/thing';
const SITE = 'https://site.atlassian.net';
const NOW = 1_757_000_000_000;

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const base = await Deno.makeTempDir({ prefix: 'jira-fetch-cache-' });
  const dir = join(base, 'a9993e364706');
  try {
    await body(dir);
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
};

const fieldsRef = (cacheDir: string) => ({
  cacheDir,
  resource: 'fields' as const,
  project: PROJECT,
  baseUrl: SITE,
});

const FIELDS = [{ id: 'customfield_10050', name: 'Team' }];

const mode = async (path: string): Promise<number> => ((await Deno.stat(path)).mode ?? 0) & 0o777;

Deno.test('an entry written is an entry read back', async () => {
  await withDir(async (dir) => {
    await writeEntry(FieldsEntry, fieldsRef(dir), NOW, {
      state: 'ok',
      notes: [],
      data: FIELDS,
    });
    const read = await readEntry(FieldsEntry, fieldsRef(dir), NOW);
    assert(read.hit, 'expected a hit');
    assertEquals(read.hit.data, FIELDS);
    assertEquals(read.hit.state, 'ok');
    assertEquals(read.hit.fetchedAt, NOW);
  });
});

Deno.test({
  name: 'the directory and its entries are owner-only, from the moment they exist',
  ignore: !POSIX,
  fn: async () => {
    await withDir(async (dir) => {
      await writeEntry(FieldsEntry, fieldsRef(dir), NOW, { state: 'ok', notes: [], data: FIELDS });
      assertEquals(await mode(dir), DIR_MODE);
      assertEquals(await mode(join(dir, 'fields.json')), FILE_MODE);
    });
  },
});

Deno.test('a successful write leaves no temporary file behind', async () => {
  await withDir(async (dir) => {
    await writeEntry(FieldsEntry, fieldsRef(dir), NOW, { state: 'ok', notes: [], data: FIELDS });
    const names = [];
    for await (const item of Deno.readDir(dir)) names.push(item.name);
    assertEquals(names, ['fields.json']);
  });
});

Deno.test('every unusable entry is a miss, and none of them throws', async () => {
  await withDir(async (dir) => {
    const ref = fieldsRef(dir);
    const path = join(dir, resourceFileName('fields'));

    assertEquals((await readEntry(FieldsEntry, ref, NOW)).miss, 'absent');

    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, 'not json at all');
    assertEquals((await readEntry(FieldsEntry, ref, NOW)).miss, 'notJson');

    const good = {
      schemaVersion: SCHEMA_VERSION,
      project: PROJECT,
      baseUrl: SITE,
      resource: 'fields',
      fetchedAt: NOW,
      state: 'ok',
      notes: [],
      data: FIELDS,
    };

    await Deno.writeTextFile(path, JSON.stringify({ ...good, surprise: 1 }));
    assertEquals((await readEntry(FieldsEntry, ref, NOW)).miss, 'invalid');

    await Deno.writeTextFile(path, JSON.stringify({ ...good, schemaVersion: 99 }));
    assertEquals((await readEntry(FieldsEntry, ref, NOW)).miss, 'invalid');

    await Deno.writeTextFile(path, JSON.stringify({ ...good, project: '/somewhere/else' }));
    assertEquals((await readEntry(FieldsEntry, ref, NOW)).miss, 'wrongProject');

    await Deno.writeTextFile(path, JSON.stringify({ ...good, baseUrl: 'https://other.net' }));
    assertEquals((await readEntry(FieldsEntry, ref, NOW)).miss, 'wrongSite');

    // A file swapped for another resource's parses fine when the payload shapes agree, so the
    // resource is pinned inside the entry rather than trusted from the filename.
    await Deno.writeTextFile(path, JSON.stringify({ ...good, resource: 'labels' }));
    assertEquals((await readEntry(FieldsEntry, ref, NOW)).miss, 'invalid');

    await Deno.writeTextFile(path, JSON.stringify(good));
    const ttl = 6 * 3_600_000;
    assertEquals((await readEntry(FieldsEntry, ref, NOW + ttl + 1)).miss, 'stale');
    assert((await readEntry(FieldsEntry, ref, NOW + ttl)).hit, 'the boundary is still fresh');
  });
});

Deno.test('a resource where nothing is implausible is never written fresh and empty', async () => {
  await withDir(async (dir) => {
    // "The token can see no projects" is indistinguishable from "the token is wrong", so an empty
    // ok is downgraded rather than trusted.
    const written = await writeEntry(
      ProjectsEntry,
      { cacheDir: dir, resource: 'projects', project: PROJECT, baseUrl: SITE },
      NOW,
      { state: 'ok', notes: [], data: [] },
    );
    assertEquals(written.state, 'partial');
    assertEquals(written.notes.map((n) => n.code), ['noneVisible']);
  });
});

Deno.test('a site with no labels is recorded as a site with no labels', async () => {
  await withDir(async (dir) => {
    const written = await writeEntry(
      LabelsEntry,
      { cacheDir: dir, resource: 'labels', project: PROJECT, baseUrl: SITE },
      NOW,
      { state: 'ok', notes: [], data: [] },
    );
    assertEquals(written.state, 'ok');
    assertEquals(written.notes, []);
  });
});

Deno.test('a partial entry keeps the data that did arrive', async () => {
  await withDir(async (dir) => {
    const written = await writeEntry(FieldsEntry, fieldsRef(dir), NOW, {
      state: 'partial',
      notes: [{ code: 'truncated' }],
      data: FIELDS,
    });
    assertEquals(written.state, 'partial');
    assertEquals(written.data, FIELDS);
  });
});

Deno.test('writing something the reader could not parse is refused', async () => {
  await withDir(async (dir) => {
    await assertRejects(
      () =>
        writeEntry(FieldsEntry, fieldsRef(dir), NOW, {
          state: 'ok',
          notes: [],
          data: [{ name: 'Team' }],
        }),
      Error,
      'refusing to cache an invalid fields entry',
    );
  });
});

Deno.test('the manifest round-trips and is pinned like an entry', async () => {
  await withDir(async (dir) => {
    await writeManifest(dir, {
      schemaVersion: SCHEMA_VERSION,
      project: PROJECT,
      baseUrl: SITE,
      projects: ['DN', 'SUP'],
      updatedAt: NOW,
    });
    const read = await readManifest(dir, { project: PROJECT, baseUrl: SITE });
    assert(read.hit);
    assertEquals(read.hit.projects, ['DN', 'SUP']);

    assertEquals(
      (await readManifest(dir, { project: '/elsewhere', baseUrl: SITE })).miss,
      'wrongProject',
    );
    assertEquals(
      (await readManifest(dir, { project: PROJECT, baseUrl: 'https://other.net' })).miss,
      'wrongSite',
    );
  });
});

Deno.test('the manifest does not age out', async () => {
  await withDir(async (dir) => {
    // It records a choice, not a reading of the site, so there is nothing for a TTL to protect.
    await writeManifest(dir, {
      schemaVersion: SCHEMA_VERSION,
      project: PROJECT,
      baseUrl: SITE,
      projects: ['DN'],
      updatedAt: NOW,
    });
    const read = await readManifest(dir, { project: PROJECT, baseUrl: SITE });
    assert(read.hit);
  });
});

Deno.test('clearing says whether there was anything to clear', async () => {
  await withDir(async (dir) => {
    assertFalse(await clearCache(dir), 'there was nothing to clear yet');
    await writeEntry(FieldsEntry, fieldsRef(dir), NOW, { state: 'ok', notes: [], data: FIELDS });
    assert(await clearCache(dir), 'the directory was there and is gone');
    assertEquals((await readEntry(FieldsEntry, fieldsRef(dir), NOW)).miss, 'absent');
  });
});

Deno.test('the manifest and the entries live side by side', async () => {
  await withDir(async (dir) => {
    await writeManifest(dir, {
      schemaVersion: SCHEMA_VERSION,
      project: PROJECT,
      baseUrl: SITE,
      projects: ['DN'],
      updatedAt: NOW,
    });
    await writeEntry(FieldsEntry, fieldsRef(dir), NOW, { state: 'ok', notes: [], data: FIELDS });
    const names = new Set<string>();
    for await (const item of Deno.readDir(dir)) names.add(item.name);
    assertEquals(names, new Set([MANIFEST_FILE, 'fields.json']));
  });
});
