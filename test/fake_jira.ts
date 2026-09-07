/** A fake Jira Cloud on localhost, shared by the CLI e2e tests and the MCP server tests.
 *
 * It lives in its own module because two entry points now drive it, and a second copy would drift
 * from this one the first time a fixture changed. No credentials, no network. */

const ISSUE = JSON.parse(
  Deno.readTextFileSync(new URL('./fixtures/issue.json', import.meta.url)),
);
const COMMENTS = JSON.parse(
  Deno.readTextFileSync(new URL('./fixtures/comments.json', import.meta.url)),
);

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export interface Fake {
  origin: string;
  requests: string[];
  stop: () => Promise<void>;
}

/** Knobs a test needs the *server* to have, as against the run driving it. */
export interface FakeOptions {
  /** Attachment requests fail, so a caller can see how a partial fetch is reported. */
  attachmentsFail?: boolean;
  /** Path fragments that answer 403, so a caller can see a resource the token may not read. */
  forbid?: string[];
  /** The Agile family answers 404, which is what a site without Jira Software looks like. */
  noAgile?: boolean;
  /** People come back without email addresses, as they do on a site that does not publish them. */
  hideEmails?: boolean;
}

export function startFakeJira(options: FakeOptions = {}): Promise<Fake> {
  const requests: string[] = [];
  const controller = new AbortController();

  const server = Deno.serve({
    port: 0,
    hostname: '127.0.0.1',
    signal: controller.signal,
    onListen: () => {},
  }, (request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);

    // --- project metadata, which `jira-fetch cache` reads -------------------------------------
    // Placed before the issue handlers because `/rest/api/3/issue/createmeta/...` shares their
    // prefix, and the dispatcher above matches on `startsWith`.

    if ((options.forbid ?? []).some((fragment) => url.pathname.includes(fragment))) {
      return Response.json({ errorMessages: ['not permitted'] }, { status: 403 });
    }
    if (options.noAgile && url.pathname.startsWith('/rest/agile/')) {
      return new Response('not found', { status: 404 });
    }

    if (url.pathname === '/rest/api/3/project/search') {
      return Response.json({
        values: [
          { id: '10000', key: 'DN', name: 'Datavault' },
          { id: '10001', key: 'SUP', name: 'Support' },
        ],
        isLast: true,
      });
    }
    if (url.pathname === '/rest/api/3/label') {
      return Response.json({ values: ['security', 'wontfix'], isLast: true, total: 2 });
    }
    if (url.pathname === '/rest/api/3/priority/search') {
      return Response.json({
        values: [{ id: '1', name: 'High' }, { id: '3', name: 'Low' }],
        isLast: true,
      });
    }
    // SUP refuses createmeta by default, so the partial path is exercised without a knob: a token
    // that can browse a project but not create issues in it is the ordinary case.
    if (url.pathname.startsWith('/rest/api/3/issue/createmeta/SUP/')) {
      return Response.json({ errorMessages: ['no permission'] }, { status: 403 });
    }
    if (/^\/rest\/api\/3\/issue\/createmeta\/[A-Z]+\/issuetypes$/.test(url.pathname)) {
      return Response.json({ issueTypes: [{ id: '10001', name: 'Bug' }], total: 1 });
    }
    if (/^\/rest\/api\/3\/issue\/createmeta\/[A-Z]+\/issuetypes\/\d+$/.test(url.pathname)) {
      return Response.json({
        fields: [
          {
            key: 'customfield_10101',
            name: 'Team',
            allowedValues: [{ value: 'Platform' }, { value: 'Data' }],
            operations: [],
            required: false,
            schema: { type: 'array' },
          },
        ],
        total: 1,
      });
    }
    if (/^\/rest\/api\/3\/project\/[A-Z]+\/statuses$/.test(url.pathname)) {
      return Response.json([
        { id: '10001', statuses: [{ id: '1', name: 'To Do' }, { id: '3', name: 'Done' }] },
        // The same status under a second issue type, which is why the cache de-duplicates.
        { id: '10002', statuses: [{ id: '3', name: 'Done' }] },
      ]);
    }
    if (/^\/rest\/api\/3\/project\/[A-Z]+\/components$/.test(url.pathname)) {
      return Response.json([{ id: '9', name: 'Infra' }]);
    }
    if (/^\/rest\/api\/3\/project\/[A-Z]+\/version$/.test(url.pathname)) {
      return Response.json({ values: [{ id: '4', name: '1.0' }], isLast: true });
    }
    if (url.pathname === '/rest/api/3/user/assignable/search') {
      return Response.json([
        {
          accountId: '5f1a2b',
          displayName: 'Kim Doe',
          ...(options.hideEmails ? {} : { emailAddress: 'kim@example.com' }),
        },
      ]);
    }
    if (url.pathname === '/rest/agile/1.0/board') {
      return Response.json({ values: [{ id: 7, name: 'DN board', type: 'scrum' }], isLast: true });
    }
    if (/^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/.test(url.pathname)) {
      return Response.json({
        values: [{ id: 3, name: 'Sprint 3', state: 'active' }],
        isLast: true,
      });
    }

    if (url.pathname.startsWith('/rest/api/3/issue/DN-1200')) {
      return Response.json({
        id: '10200',
        key: 'DN-1200',
        fields: {
          subtasks: [
            { key: 'DN-1243' },
            { key: 'DN-1250', fields: { summary: 'Sibling' } },
          ],
        },
      });
    }
    if (url.pathname === '/rest/api/3/issue/DN-1243/comment') {
      return Response.json(COMMENTS);
    }
    if (url.pathname === '/rest/api/3/issue/DN-1243') {
      // The fixture's attachment URLs point at example.atlassian.net; rewrite them at serve
      // time so the downloader talks to this server.
      const issue = structuredClone(ISSUE);
      for (const a of issue.fields.attachment) {
        a.content = `${url.origin}/attachment/${a.id}`;
      }
      return Response.json(issue);
    }
    if (url.pathname === '/rest/api/3/issue/SUP-9') {
      return Response.json({ id: '1', key: 'SUP-9', fields: { summary: 'Support' } });
    }
    if (url.pathname.startsWith('/attachment/')) {
      if (options.attachmentsFail) return new Response('gone', { status: 404 });
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }
    if (url.pathname === '/rest/api/3/search/jql') {
      // `wide` is how a test asks for more hits than a limit allows; the default pair is what the
      // CLI tests expect, so the two cases stay independent. The query is in the POST body — the
      // search endpoint is token-paged and takes JSON, not query parameters.
      return request.json().then((body: { jql?: string }) =>
        Response.json(
          (body.jql ?? '').includes('wide')
            ? {
              issues: [{ key: 'DN-1243' }, { key: 'SUP-9' }, { key: 'DN-1250' }],
              isLast: true,
            }
            : { issues: [{ key: 'DN-1243' }, { key: 'SUP-9' }], isLast: true },
        )
      );
    }
    if (url.pathname === '/rest/api/3/field') {
      return Response.json([
        { id: 'customfield_10101', name: 'Team', custom: true },
        { id: 'status', name: 'Status', custom: false },
        // Two fields sharing a name is not hypothetical: Jira Cloud allows it, and the site this
        // was developed against has four such pairs.
        { id: 'customfield_10078', name: 'Category', custom: true },
        { id: 'customfield_10045', name: 'Category', custom: true },
      ]);
    }
    return new Response('not found', { status: 404 });
  });

  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return Promise.resolve({
    origin,
    requests,
    stop: async () => {
      controller.abort();
      await server.finished;
    },
  });
}
