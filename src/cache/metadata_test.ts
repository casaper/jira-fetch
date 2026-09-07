import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { JiraError } from '../jira/client.ts';
import type { CacheNote } from './schema.ts';
import { FieldOptionsEntry, SprintsEntry, UsersEntry } from './schema.ts';
import { readEntry } from './store.ts';
import {
  type MetadataClient,
  type MetadataDeps,
  refreshAll,
  refreshProject,
  refreshSite,
  type ResourceOutcome,
  unavailable,
} from './metadata.ts';

const PROJECT = '/Users/kim/code/thing';
const SITE = 'https://site.atlassian.net';
const NOW = 1_757_000_000_000;

/** Named because `no-boolean-literal-for-arguments` is on, and because `page(x, TRUNCATED)` says
 * at the call site what `page(x, true)` does not. */
const TRUNCATED = true;

const page = <T>(items: T[], truncated = false) => Promise.resolve({ items, truncated });
const boom = (status: number) => () => Promise.reject(new JiraError('nope', status));

/** A client that answers everything plausibly. Each test overrides only what it is about. */
const okClient = (): MetadataClient => ({
  searchProjects: () => page([{ id: '1', key: 'DN', name: 'Datavault' }]),
  getFields: () => Promise.resolve([{ id: 'customfield_10050', name: 'Team', custom: true }]),
  getLabels: () => page(['security', 'wontfix']),
  getPriorities: () => page([{ id: '1', name: 'High' }]),
  getCreateMetaIssueTypes: () => page([{ id: '10001', name: 'Bug' }]),
  getCreateMetaFields: () =>
    page([
      {
        key: 'customfield_10050',
        name: 'Team',
        allowedValues: [{ value: 'Platform' }, { value: 'Data' }],
        operations: [],
        required: false,
        schema: { type: 'array' },
      },
    ]),
  getProjectStatuses: () => Promise.resolve([{ id: '3', name: 'Done' }]),
  getProjectComponents: () => page([{ id: '9', name: 'Infra' }]),
  getProjectVersions: () => page([{ id: '4', name: '1.0' }]),
  getAssignableUsers: () =>
    page([{ accountId: 'a1', displayName: 'Kim Doe', emailAddress: 'kim@example.com' }]),
  getBoards: () => page([{ id: 7, name: 'DN board' }]),
  getSprints: () => page([{ id: 3, name: 'Sprint 3', state: 'active' }]),
});

const withDeps = async (
  client: Partial<MetadataClient>,
  body: (deps: MetadataDeps) => Promise<void>,
): Promise<void> => {
  const base = await Deno.makeTempDir({ prefix: 'jira-fetch-meta-' });
  try {
    await body({
      client: { ...okClient(), ...client } as MetadataClient,
      cacheDir: join(base, 'a9993e364706'),
      project: PROJECT,
      baseUrl: SITE,
      now: () => NOW,
      log: () => {},
    });
  } finally {
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
};

const find = (
  outcomes: ResourceOutcome[],
  resource: string,
): ResourceOutcome => {
  const found = outcomes.find((outcome) => outcome.resource === resource);
  assert(found, `no outcome for ${resource}`);
  return found;
};

const codes = (outcome: ResourceOutcome): CacheNote['code'][] =>
  outcome.notes.map((note) => note.code);

Deno.test('a healthy site caches every resource as ok', async () => {
  await withDeps({}, async (deps) => {
    const report = await refreshAll(deps, ['DN']);
    for (const outcome of report.outcomes) {
      assertEquals(outcome.state, 'ok', `${outcome.resource}: ${codes(outcome).join(',')}`);
      assert(outcome.refreshed);
    }
    assertEquals(unavailable(report), []);
  });
});

Deno.test('a fresh entry is not refetched, and a forced refresh is', async () => {
  await withDeps({}, async (deps) => {
    let calls = 0;
    const counting = {
      ...okClient(),
      getLabels: () => {
        calls++;
        return page(['security']);
      },
    } as MetadataClient;

    await refreshSite({ ...deps, client: counting });
    assertEquals(calls, 1);

    // Same clock, so the entry is still inside its TTL.
    const second = await refreshSite({ ...deps, client: counting });
    assertEquals(calls, 1);
    assert(!find(second, 'labels').refreshed);

    await refreshSite({ ...deps, client: counting }, { force: true });
    assertEquals(calls, 2, 'a forced refresh ignores the TTL');
  });
});

Deno.test('403 is recorded as forbidden, with nothing pretending to be data', async () => {
  await withDeps({ getLabels: boom(403) }, async (deps) => {
    const labels = find(await refreshSite(deps), 'labels');
    assertEquals(labels.state, 'partial');
    assertEquals(codes(labels), ['forbidden']);
    assertEquals(labels.count, 0);
  });
});

Deno.test('401 is forbidden too — the token, not the resource', async () => {
  await withDeps({ getLabels: boom(401) }, async (deps) => {
    assertEquals(codes(find(await refreshSite(deps), 'labels')), ['forbidden']);
  });
});

Deno.test('404 on a project resource is notFound and keeps the project', async () => {
  await withDeps({ getProjectComponents: boom(404) }, async (deps) => {
    const components = find(await refreshProject(deps, 'DN'), 'components');
    assertEquals(components.state, 'partial');
    assertEquals(codes(components), ['notFound']);
  });
});

Deno.test('a truncated collection keeps what arrived and says it is short', async () => {
  await withDeps({ getLabels: () => page(['a', 'b'], TRUNCATED) }, async (deps) => {
    const labels = find(await refreshSite(deps), 'labels');
    assertEquals(codes(labels), ['truncated']);
    assertEquals(labels.count, 2);
    assertEquals(labels.state, 'partial');
  });
});

Deno.test('an empty result is a fact for labels and a symptom for projects', async () => {
  await withDeps({ getLabels: () => page([]) }, async (deps) => {
    assertEquals(find(await refreshSite(deps), 'labels').state, 'ok');
  });
  await withDeps({ searchProjects: () => page([]) }, async (deps) => {
    const projects = find(await refreshSite(deps), 'projects');
    assertEquals(projects.state, 'partial');
    assertEquals(codes(projects), ['noneVisible']);
  });
});

Deno.test('HTML with a 200 is recorded as notJson', async () => {
  // A wrong host or an SSO portal. It reaches here as a parse failure.
  const notJson = () => Promise.reject(new SyntaxError('Unexpected token < in JSON'));
  await withDeps({ getLabels: notJson }, async (deps) => {
    assertEquals(codes(find(await refreshSite(deps), 'labels')), ['notJson']);
  });
});

Deno.test('a transport failure is networkError and carries the reason', async () => {
  await withDeps({
    getLabels: () => Promise.reject(new Error('connection reset')),
  }, async (deps) => {
    const labels = find(await refreshSite(deps), 'labels');
    assertEquals(codes(labels), ['networkError']);
    assertEquals(labels.notes[0].detail, 'connection reset');
  });
});

Deno.test('field values are unioned across the issue types that allow them', async () => {
  await withDeps({
    getCreateMetaIssueTypes: () => page([{ id: '1', name: 'Bug' }, { id: '2', name: 'Task' }]),
    getCreateMetaFields: (_project: string, issueTypeId: string) =>
      page([{
        key: 'customfield_10050',
        name: 'Team',
        allowedValues: issueTypeId === '1' ? [{ value: 'Platform' }] : [{ value: 'Data' }],
        operations: [],
        required: false,
        schema: { type: 'array' },
      }]),
  }, async (deps) => {
    await refreshProject(deps, 'DN');
    const entry = await readEntry(FieldOptionsEntry, {
      cacheDir: deps.cacheDir,
      resource: 'fieldOptions',
      projectKey: 'DN',
      project: PROJECT,
      baseUrl: SITE,
    }, NOW);
    assert(entry.hit);
    assertEquals(entry.hit.data.length, 1);
    assertEquals(entry.hit.data[0].fieldId, 'customfield_10050');
    assertEquals(new Set(entry.hit.data[0].values), new Set(['Platform', 'Data']));
  });
});

Deno.test('field values without Create Issues are forbidden, not silently empty', async () => {
  await withDeps({ getCreateMetaFields: boom(403) }, async (deps) => {
    const options = find(await refreshProject(deps, 'DN'), 'fieldOptions');
    assertEquals(options.state, 'partial');
    assertEquals(codes(options), ['forbidden']);
  });
});

Deno.test('some issue types refusing still yields the union of the rest', async () => {
  await withDeps({
    getCreateMetaIssueTypes: () => page([{ id: '1', name: 'Bug' }, { id: '2', name: 'Task' }]),
    getCreateMetaFields: (_project: string, issueTypeId: string) =>
      issueTypeId === '2' ? Promise.reject(new JiraError('no', 403)) : page([{
        key: 'customfield_10050',
        name: 'Team',
        allowedValues: [{ value: 'Platform' }],
        operations: [],
        required: false,
        schema: { type: 'array' },
      }]),
  }, async (deps) => {
    const options = find(await refreshProject(deps, 'DN'), 'fieldOptions');
    assertEquals(codes(options), ['partiallyForbidden']);
    assertEquals(options.count, 1);
  });
});

Deno.test('field values cannot be enumerated without issue types', async () => {
  await withDeps({ getCreateMetaIssueTypes: boom(403) }, async (deps) => {
    const outcomes = await refreshProject(deps, 'DN');
    assertEquals(codes(find(outcomes, 'issueTypes')), ['forbidden']);
    // Nothing was requested: saying so beats issuing calls that cannot succeed.
    assertEquals(codes(find(outcomes, 'fieldOptions')), ['dependencyMissing']);
  });
});

Deno.test('a site without Jira Software has no Agile API, and sprints say why', async () => {
  await withDeps({ getBoards: boom(404) }, async (deps) => {
    const outcomes = await refreshProject(deps, 'DN');
    assertEquals(codes(find(outcomes, 'boards')), ['agileUnavailable']);
    assertEquals(codes(find(outcomes, 'sprints')), ['dependencyMissing']);
  });
});

Deno.test('a project with no board is not a project with no sprints', async () => {
  await withDeps({ getBoards: () => page([]) }, async (deps) => {
    const outcomes = await refreshProject(deps, 'DN');
    assertEquals(codes(find(outcomes, 'boards')), ['noBoard']);
    assertEquals(codes(find(outcomes, 'sprints')), ['dependencyMissing']);
  });
});

Deno.test('a Kanban board is skipped and the other boards still count', async () => {
  await withDeps({
    getBoards: () => page([{ id: 7, name: 'Scrum' }, { id: 8, name: 'Kanban' }]),
    getSprints: (boardId: number) =>
      boardId === 8
        ? Promise.reject(new JiraError('no sprints', 400))
        : page([{ id: 3, name: 'Sprint 3' }]),
  }, async (deps) => {
    const sprints = find(await refreshProject(deps, 'DN'), 'sprints');
    assertEquals(codes(sprints), ['boardWithoutSprints']);
    assertEquals(sprints.notes[0].detail, 'board 8');
    assertEquals(sprints.count, 1, 'the scrum board still contributed');
    const entry = await readEntry(SprintsEntry, {
      cacheDir: deps.cacheDir,
      resource: 'sprints',
      projectKey: 'DN',
      project: PROJECT,
      baseUrl: SITE,
    }, NOW);
    assert(entry.hit);
    assertEquals(entry.hit.data[0].boardId, 7);
  });
});

Deno.test('a site that hides email addresses still yields usable people', async () => {
  await withDeps({
    getAssignableUsers: () => page([{ accountId: 'a1', displayName: 'Kim Doe' }]),
  }, async (deps) => {
    const users = find(await refreshProject(deps, 'DN'), 'users');
    assertEquals(codes(users), ['emailsHidden']);
    assertEquals(users.count, 1);
    const entry = await readEntry(UsersEntry, {
      cacheDir: deps.cacheDir,
      resource: 'users',
      projectKey: 'DN',
      project: PROJECT,
      baseUrl: SITE,
    }, NOW);
    assert(entry.hit);
    // The accountId is what a rule should carry; the name is only a label.
    assertEquals(entry.hit.data[0].accountId, 'a1');
    assertEquals(entry.hit.data[0].emailAddress, undefined);
  });
});

Deno.test('a user without an accountId is dropped rather than half-recorded', async () => {
  await withDeps({
    getAssignableUsers: () => page([{ displayName: 'Ghost' }, { accountId: 'a1' }]),
  }, async (deps) => {
    assertEquals(find(await refreshProject(deps, 'DN'), 'users').count, 1);
  });
});

Deno.test('a project key that is not a Jira key never reaches a filename', async () => {
  await withDeps({
    searchProjects: () => page([{ id: '1', key: '../etc', name: 'nope' }, { id: '2', key: 'DN' }]),
  }, async (deps) => {
    const projects = find(await refreshSite(deps), 'projects');
    assertEquals(projects.count, 1);
  });
});

Deno.test('unavailable names the resources with nothing usable in them', async () => {
  await withDeps({ getLabels: boom(403), getBoards: boom(404) }, async (deps) => {
    const report = await refreshAll(deps, ['DN']);
    const names = unavailable(report).map((outcome) => outcome.resource);
    assert(names.includes('labels'));
    assert(names.includes('boards'));
    assert(!names.includes('fields'), 'fields read fine');
  });
});
