import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert';
import { decodeBase64 } from '@std/encoding/base64';
import { JiraClient, JiraError } from './client.ts';

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

function stub(responder: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const client = new JiraClient({
    baseUrl: 'https://example.atlassian.net/',
    email: 'kim@example.com',
    token: 'secret-token',
    maxRetries: 2,
    sleep: () => Promise.resolve(),
    fetch: async (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      return await responder(call, calls.length);
    },
  });
  return { client, calls };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

Deno.test('a trailing slash on the base URL does not double up in request paths', async () => {
  const { client, calls } = stub(() => json({ id: '1', key: 'DN-1', fields: {} }));
  await client.getIssue('DN-1');
  assertEquals(calls[0].url, 'https://example.atlassian.net/rest/api/3/issue/DN-1');
});

Deno.test('requests carry Basic auth built from the email and token', async () => {
  const { client, calls } = stub(() => json({ id: '1', key: 'DN-1', fields: {} }));
  await client.getIssue('DN-1');

  const header = calls[0].headers.get('authorization') ?? '';
  assert(header.startsWith('Basic '));
  assertEquals(
    new TextDecoder().decode(decodeBase64(header.slice(6))),
    'kim@example.com:secret-token',
  );
});

Deno.test('issue keys are URL-encoded', async () => {
  const { client, calls } = stub(() => json({ id: '1', key: 'A B-1', fields: {} }));
  await client.getIssue('A B-1');
  assertStringIncludes(calls[0].url, '/issue/A%20B-1');
});

Deno.test('a 429 is retried after the interval the server asks for', async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
      : json({ id: '1', key: 'DN-1', fields: {} })
  );

  const issue = await client.getIssue('DN-1');
  assertEquals(issue.key, 'DN-1');
  assertEquals(calls.length, 2);
});

Deno.test('a 500 is retried, and the last failure is reported', async () => {
  const { client, calls } = stub(() => new Response('boom', { status: 500 }));
  const error = await assertRejects(() => client.getIssue('DN-1'), JiraError);
  assertEquals(error.status, 500);
  assertEquals(calls.length, 3); // the initial attempt plus maxRetries
});

Deno.test('a 404 is not retried', async () => {
  const { client, calls } = stub(() =>
    json({ errorMessages: ['Issue does not exist'] }, { status: 404 })
  );
  const error = await assertRejects(() => client.getIssue('DN-9'), JiraError);
  assertEquals(calls.length, 1);
  assertStringIncludes(error.message, 'Issue does not exist');
});

Deno.test('an error message keeps the path but drops the query string', async () => {
  const { client } = stub(() => new Response('nope', { status: 403 }));
  const error = await assertRejects(() => client.getSubtasksOf('DN-1'), JiraError);
  assertStringIncludes(error.message, '/rest/api/3/issue/DN-1');
  assertFalse(error.message.includes('fields=subtasks'));
});

Deno.test('comments are paginated until the reported total is reached', async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1
      ? json({ total: 3, comments: [{ id: '1' }, { id: '2' }] })
      : json({ total: 3, comments: [{ id: '3' }] })
  );

  const comments = await client.getComments('DN-1');
  assertEquals(comments.map((c) => c.id), ['1', '2', '3']);
  assertStringIncludes(calls[0].url, 'startAt=0');
  assertStringIncludes(calls[1].url, 'startAt=2');
});

Deno.test('an empty comment page ends pagination even without a total', async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1 ? json({ comments: [{ id: '1' }] }) : json({ comments: [] })
  );
  assertEquals((await client.getComments('DN-1')).length, 1);
  assertEquals(calls.length, 2);
});

Deno.test('search asks only for keys, and follows nextPageToken', async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1
      ? json({ issues: [{ key: 'DN-1' }, { key: 'DN-2' }], nextPageToken: 'tok' })
      : json({ issues: [{ key: 'DN-3' }], isLast: true })
  );

  const keys: string[] = [];
  for await (const key of client.searchIssueKeys('project = DN')) keys.push(key);

  assertEquals(keys, ['DN-1', 'DN-2', 'DN-3']);
  assertEquals(calls[0].method, 'POST');
  assertEquals(calls[0].url, 'https://example.atlassian.net/rest/api/3/search/jql');

  // Only the key is requested: every issue is then fetched through the single-key path, so
  // batch mode behaves exactly like running single fetches in a row.
  assertExists(calls[0].body);
  assertExists(calls[1].body);
  assertEquals(JSON.parse(calls[0].body).fields, ['key']);
  assertEquals(JSON.parse(calls[1].body).nextPageToken, 'tok');
});

Deno.test('search stops when the last page carries no token', async () => {
  const { client, calls } = stub(() => json({ issues: [{ key: 'DN-1' }] }));
  const keys: string[] = [];
  for await (const key of client.searchIssueKeys('project = DN')) keys.push(key);
  assertEquals(keys, ['DN-1']);
  assertEquals(calls.length, 1);
});

Deno.test("siblings come from the parent's subtasks, not from a search", async () => {
  const { client, calls } = stub(() =>
    json({
      id: '1',
      key: 'DN-1200',
      fields: { subtasks: [{ key: 'DN-1243' }, { key: 'DN-1244' }] },
    })
  );

  const subtasks = await client.getSubtasksOf('DN-1200');
  assertEquals(subtasks.map((s) => s.key), ['DN-1243', 'DN-1244']);
  assertStringIncludes(calls[0].url, '/rest/api/3/issue/DN-1200?fields=subtasks');
  assertEquals(calls[0].method, 'GET');
});

Deno.test('field metadata is fetched at most once per client', async () => {
  const { client, calls } = stub(() => json([{ id: 'customfield_10101', name: 'Team' }]));
  await client.getFields();
  await client.getFields();
  assertEquals(calls.length, 1);
});

Deno.test('pagination is bounded, so a server that never advances cannot hang the CLI', async () => {
  // This server ignores startAt and returns a full page forever.
  const { client, calls } = stub(() => json({ comments: [{ id: '1' }] }));
  const comments = await client.getComments('DN-1');
  assertEquals(comments.length, calls.length);
  assertEquals(calls.length, 1000);
});

Deno.test('a network failure is retried and then reported', async () => {
  const { client, calls } = stub(() => {
    throw new TypeError('connection refused');
  });
  const error = await assertRejects(() => client.getIssue('DN-1'), JiraError);
  assertEquals(calls.length, 3);
  assertStringIncludes(error.message, 'connection refused');
});

/** `startAt` as the endpoint saw it, so a test can assert the loop advanced. */
const startAtOf = (url: string): number => Number(new URL(url).searchParams.get('startAt'));

Deno.test('a paginated collection stops when the envelope says it is the last page', async () => {
  const { client, calls } = stub((call) =>
    json(
      startAtOf(call.url) === 0
        ? { values: [{ key: 'DN' }, { key: 'SUP' }], isLast: false }
        : { values: [{ key: 'OPS' }], isLast: true },
    )
  );
  const { items, truncated } = await client.searchProjects();
  assertEquals(items.map((p) => p.key), ['DN', 'SUP', 'OPS']);
  assertFalse(truncated);
  assertEquals(calls.length, 2);
  assertEquals(startAtOf(calls[1].url), 2);
});

Deno.test('a paginated collection stops when total is reached', async () => {
  const { client, calls } = stub((call) =>
    json({ values: startAtOf(call.url) === 0 ? [{ name: 'High' }, { name: 'Low' }] : [], total: 2 })
  );
  const { items } = await client.getPriorities();
  assertEquals(items.map((p) => p.name), ['High', 'Low']);
  assertEquals(calls.length, 1);
});

Deno.test('a bare-array endpoint stops on a short page', async () => {
  // The only signal these give: no isLast, no total, just fewer items than asked for.
  const { client, calls } = stub(() => json([{ accountId: 'a' }, { accountId: 'b' }]));
  const { items, truncated } = await client.getAssignableUsers('DN');
  assertEquals(items.length, 2);
  assertFalse(truncated);
  assertEquals(calls.length, 1);
});

Deno.test('a bare-array endpoint keeps paging while pages come back full', async () => {
  const { client, calls } = stub((call) =>
    json(
      startAtOf(call.url) < 50
        ? Array.from({ length: 50 }, (_, i) => ({ accountId: `a${i}` }))
        : [],
    )
  );
  const { items } = await client.getAssignableUsers('DN');
  assertEquals(items.length, 50);
  assertEquals(calls.length, 2);
});

Deno.test('a server that never advances is truncated, not a hang', async () => {
  // The reason every loop here is bounded. What arrived is still worth caching, so the bound is
  // reported rather than thrown, and the caller records the resource as partial.
  const { client, calls } = stub(() =>
    json({ values: Array.from({ length: 50 }, (_, i) => ({ name: `p${i}` })), isLast: false })
  );
  const { items, truncated } = await client.getPriorities();
  assert(truncated, 'expected the page bound to be reported');
  assertEquals(calls.length, 1000);
  assertEquals(items.length, 50_000);
});

Deno.test('createmeta collections are read under their own keys', async () => {
  // These two do not spell the collection `values`, and guessing wrong would look like a working
  // call that found nothing.
  const types = stub(() => json({ issueTypes: [{ id: '10001', name: 'Bug' }], total: 1 }));
  assertEquals((await types.client.getCreateMetaIssueTypes('DN')).items[0].name, 'Bug');

  const fields = stub(() =>
    json({ fields: [{ key: 'customfield_1', name: 'Team', allowedValues: [] }], total: 1 })
  );
  assertEquals((await fields.client.getCreateMetaFields('DN', '10001')).items[0].name, 'Team');
});

Deno.test('statuses arrive grouped by issue type and are flattened', async () => {
  const { client } = stub(() =>
    json([
      { id: '10001', statuses: [{ id: '1', name: 'To Do' }, { id: '3', name: 'Done' }] },
      { id: '10002', statuses: [{ id: '3', name: 'Done' }] },
    ])
  );
  assertEquals((await client.getProjectStatuses('DN')).map((s) => s.name), [
    'To Do',
    'Done',
    'Done',
  ]);
});

Deno.test('versions come from the paginated singular endpoint', async () => {
  // /version pages; /versions returns the lot and ignores startAt, which reads as a working call
  // that silently drops everything past the first page.
  const { client, calls } = stub(() => json({ values: [{ name: '1.0' }], isLast: true }));
  await client.getProjectVersions('DN');
  assertStringIncludes(calls[0].url, '/rest/api/3/project/DN/version?');
  assertFalse(calls[0].url.includes('/versions'));
});

Deno.test('boards and sprints go to the Agile API, not the platform one', async () => {
  const boards = stub(() => json({ values: [{ id: 7, name: 'DN board' }], isLast: true }));
  await boards.client.getBoards('DN');
  assertStringIncludes(boards.calls[0].url, '/rest/agile/1.0/board?projectKeyOrId=DN');

  const sprints = stub(() => json({ values: [{ id: 3, name: 'Sprint 3' }], isLast: true }));
  await sprints.client.getSprints(7);
  assertStringIncludes(sprints.calls[0].url, '/rest/agile/1.0/board/7/sprint?');
});

Deno.test('a metadata endpoint that is forbidden surfaces its status', async () => {
  // The client classifies nothing: 403 stays a JiraError with .status, and src/cache/ decides what
  // that means for the resource.
  const { client } = stub(() => new Response('{"errorMessages":["no"]}', { status: 403 }));
  const error = await assertRejects(() => client.getLabels(), JiraError);
  assertEquals(error.status, 403);
});

Deno.test('a metadata endpoint answering HTML with a 200 fails to parse', async () => {
  // A wrong host, or an SSO portal. There is no declared mime type to compare against here the way
  // an attachment has, so this surfaces as a parse failure the cache records as notJson.
  const { client } = stub(() =>
    new Response('<html><body>Sign in</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  );
  await assertRejects(() => client.getLabels());
});
