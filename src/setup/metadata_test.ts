import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import type { Resource } from '../cache/policy.ts';
import {
  ComponentsEntry,
  FieldOptionsEntry,
  FieldsEntry,
  LabelsEntry,
  ProjectsEntry,
  StatusesEntry,
  UsersEntry,
} from '../cache/schema.ts';
import type { CacheNote } from '../cache/schema.ts';
import { writeEntry } from '../cache/store.ts';
import { labelLookup, loadMetadataView } from './metadata.ts';

const PROJECT = '/Users/kim/code/thing';
const SITE = 'https://site.atlassian.net';
const NOW = 1_757_000_000_000;

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const base = await Deno.makeTempDir({ prefix: 'jira-fetch-view-' });
  try {
    await body(join(base, 'a9993e364706'));
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
};

/** Writes one entry the way `jira-fetch cache` would. */
const put = (
  dir: string,
  // deno-lint-ignore no-explicit-any -- one call per resource, each with its own payload
  schema: any,
  resource: Resource,
  projectKey: string | undefined,
  data: unknown,
  notes: CacheNote[] = [],
) =>
  writeEntry(
    schema,
    {
      cacheDir: dir,
      resource,
      ...(projectKey === undefined ? {} : { projectKey }),
      project: PROJECT,
      baseUrl: SITE,
    },
    NOW,
    { state: notes.length > 0 ? 'partial' : 'ok', notes, data },
  );

const load = (dir: string, projectKeys: string[], now = NOW) =>
  loadMetadataView({
    cacheDir: dir,
    project: PROJECT,
    baseUrl: SITE,
    projectKeys,
    now: () => now,
  });

Deno.test('an empty cache is unavailable everywhere, with a reason and no empty lists', async () => {
  await withDir(async (dir) => {
    const view = await load(dir, ['DN']);
    for (const [name, resource] of Object.entries(view)) {
      assertEquals(resource.status, 'unavailable', name);
      assert(resource.reason, `${name} has no reason`);
      // No reason may send the reader off to another command: the menu has already tried.
      assertStringIncludes(resource.reason, 'could not be');
    }
  });
});

Deno.test('a stale entry says it is out of date rather than that it is missing', async () => {
  await withDir(async (dir) => {
    await put(dir, LabelsEntry, 'labels', undefined, ['security']);
    // labels last 12 hours.
    const view = await load(dir, ['DN'], NOW + 13 * 3_600_000);
    assertEquals(view.labels.status, 'unavailable');
    assertStringIncludes(view.labels.reason ?? '', 'out of date');
  });
});

Deno.test('a site-wide resource is read once, whatever projects were chosen', async () => {
  await withDir(async (dir) => {
    await put(dir, LabelsEntry, 'labels', undefined, ['security', 'wontfix']);
    const view = await load(dir, ['DN', 'SUP']);
    assertEquals(view.labels.status, 'available');
    assertEquals(view.labels.items.map((item) => item.value), ['security', 'wontfix']);
  });
});

Deno.test('a project is labelled by key and name, and keyed by the key alone', async () => {
  await withDir(async (dir) => {
    await put(dir, ProjectsEntry, 'projects', undefined, [
      { id: '1', key: 'DN', name: 'Datavault' },
      { id: '2', key: 'SUP' },
    ]);
    const view = await load(dir, []);
    assertEquals(view.projects.items[0], { value: 'DN', label: 'DN — Datavault' });
    // A project with no name still offers its key rather than a blank line.
    assertEquals(view.projects.items[1], { value: 'SUP', label: 'SUP' });
  });
});

Deno.test('a per-project resource merges across projects without repeating itself', async () => {
  await withDir(async (dir) => {
    await put(dir, StatusesEntry, 'statuses', 'DN', [{ name: 'To Do' }, { name: 'Done' }]);
    await put(dir, StatusesEntry, 'statuses', 'SUP', [{ name: 'Done' }, { name: 'Waiting' }]);
    const view = await load(dir, ['DN', 'SUP']);
    assertEquals(view.statuses.status, 'available');
    assertEquals(view.statuses.items.map((item) => item.value), ['To Do', 'Done', 'Waiting']);
  });
});

Deno.test('one project failing makes the merged list partial, not complete', async () => {
  await withDir(async (dir) => {
    await put(dir, ComponentsEntry, 'components', 'DN', [{ name: 'Infra' }]);
    await put(dir, ComponentsEntry, 'components', 'SUP', [], [{ code: 'forbidden' }]);
    const view = await load(dir, ['DN', 'SUP']);
    // There is something to offer and something missing. Saying "available" would let a short
    // list read as the whole truth.
    assertEquals(view.components.status, 'partial');
    assertEquals(view.components.items.length, 1);
    assertStringIncludes(view.components.reason ?? '', 'may not read them');
  });
});

Deno.test('a resource nobody could read anywhere is unavailable', async () => {
  await withDir(async (dir) => {
    await put(dir, ComponentsEntry, 'components', 'DN', [], [{ code: 'forbidden' }]);
    const view = await load(dir, ['DN']);
    assertEquals(view.components.status, 'unavailable');
    assertEquals(view.components.items, []);
  });
});

Deno.test('a note becomes words, not a code', async () => {
  await withDir(async (dir) => {
    await put(dir, UsersEntry, 'users', 'DN', [{ accountId: 'a1', displayName: 'Kim Doe' }], [{
      code: 'emailsHidden',
    }]);
    const view = await load(dir, ['DN']);
    assertStringIncludes(view.users.reason ?? '', 'does not publish email addresses');
    assert(!(view.users.reason ?? '').includes('emailsHidden'));
  });
});

Deno.test('a person is keyed by account id and labelled by name', async () => {
  await withDir(async (dir) => {
    await put(dir, UsersEntry, 'users', 'DN', [
      { accountId: '5f1a2b', displayName: 'Kim Doe', emailAddress: 'kim@example.com' },
      { accountId: '7c3d4e', displayName: 'Jo Bloggs' },
    ]);
    const view = await load(dir, ['DN']);
    assertEquals(view.users.items[0], {
      value: '5f1a2b',
      label: 'Kim Doe',
      hint: 'kim@example.com',
    });
    // No email on a site that hides them; the entry is still usable.
    assertEquals(view.users.items[1], { value: '7c3d4e', label: 'Jo Bloggs' });

    const labels = labelLookup(view);
    assertEquals(labels('5f1a2b'), 'Kim Doe');
    assertEquals(labels('unknown'), undefined);
  });
});

Deno.test('the label lookup covers field ids as well as people', async () => {
  // Both kinds, one map. A rule records an accountId for a person and an id for a field — neither
  // is readable, and a review screen showing `customfield_10050` would pay for that twice.
  await withDir(async (dir) => {
    await put(dir, FieldsEntry, 'fields', undefined, [
      { id: 'customfield_10050', name: 'Team' },
    ]);
    await put(dir, UsersEntry, 'users', 'DN', [
      { accountId: '5f1a2b', displayName: 'Kim Doe' },
    ]);
    const labels = labelLookup(await load(dir, ['DN']));

    assertEquals(labels('customfield_10050'), 'Team');
    assertEquals(labels('5f1a2b'), 'Kim Doe');
    assertEquals(labels('customfield_99999'), undefined);
  });
});

Deno.test('a field carries its values where they were cached, and nothing where not', async () => {
  await withDir(async (dir) => {
    await put(dir, FieldsEntry, 'fields', undefined, [
      { id: 'customfield_1', name: 'Team' },
      { id: 'customfield_2', name: 'Squad' },
    ]);
    await put(dir, FieldOptionsEntry, 'fieldOptions', 'DN', [
      { fieldId: 'customfield_1', name: 'Team', values: ['Platform', 'Data'] },
    ]);
    const view = await load(dir, ['DN']);

    const team = view.fields.items.find((field) => field.name === 'Team');
    assert(team);
    assertEquals(team.allowedValues?.map((value) => value.value), ['Platform', 'Data']);

    // "Not known" and "none" are different, and a picker has to be able to say which.
    const squad = view.fields.items.find((field) => field.name === 'Squad');
    assert(squad);
    assertEquals(squad.allowedValues, undefined);
  });
});

Deno.test('an entry pinned to another site is not read', async () => {
  await withDir(async (dir) => {
    await writeEntry(
      LabelsEntry,
      {
        cacheDir: dir,
        resource: 'labels',
        project: PROJECT,
        baseUrl: 'https://other.atlassian.net',
      },
      NOW,
      { state: 'ok', notes: [], data: ['elsewhere'] },
    );
    const view = await load(dir, ['DN']);
    assertEquals(view.labels.items, []);
    assertEquals(view.labels.status, 'unavailable');
  });
});

Deno.test('no projects chosen still offers the site-wide resources', async () => {
  await withDir(async (dir) => {
    await put(dir, LabelsEntry, 'labels', undefined, ['security']);
    const view = await load(dir, []);
    assertEquals(view.labels.status, 'available');
    // And says plainly that the per-project ones need a project.
    assertEquals(view.statuses.status, 'unavailable');
  });
});
