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

export function startFakeJira(): Promise<Fake> {
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
      return Response.json([{ id: 'customfield_10101', name: 'Team', custom: true }]);
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
