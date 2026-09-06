/** The MCP server, driven over an in-memory transport with raw JSON-RPC on the far end.
 *
 * Raw frames rather than an MCP client library, for two reasons: the client package is a
 * dependency this project does not otherwise need, and the assertions below are about the exact
 * bytes a client would see — a library's parsing sitting in between would soften them.
 *
 * Most of these tests exist because the mode's whole purpose is what it refuses to do, and a
 * refusal that leaks is worse than no refusal: it tells an agent the issue exists.
 */

import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import { dirname, fromFileUrl, join } from '@std/path';
import { stringify as stringifyYaml } from '@std/yaml';
import { configPathFor, userConfigDir } from '../src/config/location.ts';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/mcp/server.ts';
import { createSession } from '../src/fetch/session.ts';
import type { Config } from '../src/config/config.ts';
import { compileFilters } from '../src/filter/rules.ts';
import { People } from '../src/config/schema.ts';
import type { FiltersConfig } from '../src/config/schema.ts';
import { JiraClient } from '../src/jira/client.ts';
import { startFakeJira } from './fake_jira.ts';

type Result = { content: Array<Record<string, unknown>>; isError?: boolean };

interface Tool {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, unknown> };
}

interface Client {
  call: (name: string, args: Record<string, unknown>) => Promise<Result>;
  tools: () => Promise<string[]>;
  listed: () => Promise<Tool[]>;
  /** The text block of the last result: every status line the agent is shown. */
  out: string;
}

interface Options {
  filters?: FiltersConfig;
  allowJql?: boolean;
  attachmentsFail?: boolean;
}

async function withMcp(
  options: Options,
  fn: (ctx: { client: Client; out: string; requests: string[] }) => Promise<void>,
): Promise<void> {
  const fake = await startFakeJira({ attachmentsFail: options.attachmentsFail });
  const outDir = await Deno.makeTempDir();

  const config: Config = {
    baseUrl: fake.origin,
    email: 'kim@example.com',
    token: 't',
    allowJql: options.allowJql ?? true,
    outDir,
    filters: compileFilters(options.filters),
    people: People.parse({}),
    configPath: '/config/jira-fetch/test.yml',
  };

  const session = await createSession({
    config,
    client: new JiraClient({ baseUrl: config.baseUrl, email: config.email, token: config.token }),
    log: () => {},
  });

  const [near, far] = InMemoryTransport.createLinkedPair();
  await createMcpServer(session, config).connect(far);

  const replies = new Map<number, Record<string, unknown>>();
  near.onmessage = (message: JSONRPCMessage) => {
    const frame = message as { id?: number };
    if (frame.id !== undefined) replies.set(frame.id, message as Record<string, unknown>);
  };
  await near.start();

  let nextId = 0;
  const request = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    await near.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    for (let tick = 0; tick < 200 && !replies.has(id); tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const reply = replies.get(id);
    assert(reply, `no reply to ${method}`);
    assertFalse('error' in reply, `${method} failed: ${JSON.stringify(reply)}`);
    return (reply as { result: Record<string, unknown> }).result;
  };

  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

  const client: Client = {
    out: '',
    listed: async () => (await request('tools/list', {})).tools as Tool[],
    tools: async () => (await client.listed()).map((tool) => tool.name),
    call: async (name, args) => {
      const result = await request('tools/call', { name, arguments: args }) as unknown as Result;
      const text = result.content.find((block) => block.type === 'text');
      client.out = (text?.text as string) ?? '';
      return result;
    },
  };

  try {
    await fn({ client, out: outDir, requests: fake.requests });
  } finally {
    await near.close();
    await fake.stop();
    await Deno.remove(outDir, { recursive: true });
  }
}

/** The exact phrasing an agent sees for anything it may not have. */
const UNAVAILABLE = 'not available (no such issue, or not permitted by this server configuration)';

Deno.test('the server offers two read tools and nothing that writes to Jira', async () => {
  await withMcp({}, async ({ client }) => {
    assertEquals((await client.tools()).sort(), ['fetch_issues', 'search_issues']);
  });
});

Deno.test('a permitted issue comes back as a link to a real file', async () => {
  await withMcp({}, async ({ client, out }) => {
    const result = await client.call('fetch_issues', { keys: ['DN-1243'] });

    assertFalse(result.isError);
    const link = result.content.find((block) => block.type === 'resource_link');
    assert(link, 'expected a resource_link for the document');
    assertEquals(link.name, 'DN-1243.md');
    assertEquals(link.mimeType, 'text/markdown');
    assertStringIncludes(link.uri as string, 'DN-1243.md');
    assertStringIncludes(client.out, 'DN-1243  written');

    // The link points at something that exists, and the content is in the file, not the reply.
    const markdown = await Deno.readTextFile(join(out, 'DN-1243.md'));
    assertStringIncludes(markdown, 'id: DN-1243');
    assertFalse(JSON.stringify(result).includes('Spike: evaluate the export pipeline'));
  });
});

Deno.test('a denied issue names neither the rule that denied it nor anything about it', async () => {
  await withMcp({ filters: { exclude: [{ labels: ['wontfix'] }] } }, async ({ client, out }) => {
    const result = await client.call('fetch_issues', { keys: ['DN-1243'] });
    const wire = JSON.stringify(result);

    assertStringIncludes(client.out, `DN-1243  ${UNAVAILABLE}`);
    // Not the matched value, not the serialised rule, not the summary the payload carried.
    assertFalse(wire.includes('wontfix'));
    assertFalse(wire.includes('exclude'));
    assertFalse(wire.includes('Spike: evaluate the export pipeline'));
    // And no file — a marker document would say the same thing while overwriting a real one.
    assertEquals(await Array.fromAsync(Deno.readDir(out)), []);
  });
});

Deno.test('a denied issue and one that does not exist are reported identically', async () => {
  await withMcp({ filters: { exclude: [{ project: ['SUP'] }] } }, async ({ client }) => {
    await client.call('fetch_issues', { keys: ['SUP-9'] });
    const denied = client.out;

    await client.call('fetch_issues', { keys: ['DN-4040'] });
    const missing = client.out;

    // Same shape, differing only in the key: a client cannot map the deny-list by probing.
    assertEquals(denied.replace('SUP-9', 'KEY'), missing.replace('DN-4040', 'KEY'));
  });
});

Deno.test('a call that produced nothing is an error; a mixed call is not', async () => {
  await withMcp({ filters: { exclude: [{ project: ['SUP'] }] } }, async ({ client }) => {
    const nothing = await client.call('fetch_issues', { keys: ['SUP-9'] });
    assert(nothing.isError, 'a call that wrote nothing should be a tool error');

    const mixed = await client.call('fetch_issues', { keys: ['DN-1243', 'SUP-9'] });
    assertFalse(mixed.isError, 'a call that wrote something is an ordinary result');
    assertStringIncludes(client.out, 'DN-1243  written');
    assertStringIncludes(client.out, `SUP-9  ${UNAVAILABLE}`);
  });
});

Deno.test('a pre-fetch denial inside a JQL result never requests the issue', async () => {
  await withMcp({ filters: { exclude: [{ project: ['SUP'] }] } }, async ({ client, requests }) => {
    await client.call('search_issues', { jql: 'project in (DN, SUP)' });

    assertStringIncludes(client.out, 'DN-1243  written');
    assertStringIncludes(client.out, `SUP-9  ${UNAVAILABLE}`);
    // The query matched it and the config still kept it off the wire entirely.
    assertEquals(requests.filter((r) => r.includes('SUP-9')), []);
  });
});

Deno.test('a search says whether it was cut short or ran out', async () => {
  await withMcp({}, async ({ client }) => {
    // Three matches for `wide`.
    await client.call('search_issues', { jql: 'wide', limit: 2 });
    assertStringIncludes(client.out, 'limit reached; more may match');

    await client.call('search_issues', { jql: 'wide', limit: 50 });
    assertStringIncludes(client.out, 'query exhausted');

    // The boundary, and the reason this is tracked rather than inferred from a count: a query
    // with exactly `limit` matches ran out, and saying "more may match" here would be a lie in
    // the one line an agent uses to decide whether to look further.
    await client.call('search_issues', { jql: 'wide', limit: 3 });
    assertStringIncludes(client.out, 'query exhausted');
  });
});

Deno.test('an attachment that failed to download is said out loud', async () => {
  await withMcp({ attachmentsFail: true }, async ({ client }) => {
    await client.call('fetch_issues', { keys: ['DN-1243'] });

    // The document still exists and is worth having; what must not happen is the agent being
    // told about attachments that are not there and following relative links into nothing.
    assertStringIncludes(client.out, 'DN-1243  written');
    assertStringIncludes(client.out, '2 attachment(s) failed to download');
    assertFalse(client.out.includes('+2 attachment(s)'));
  });
});

Deno.test('allowJql: false removes the search tool rather than refusing it', async () => {
  await withMcp({ allowJql: false }, async ({ client }) => {
    assertEquals(await client.tools(), ['fetch_issues']);
  });
});

Deno.test('no tool offers a path parameter', async () => {
  await withMcp({}, async ({ client }) => {
    // Asserted on the published schemas, not on behaviour: the point is that the parameter does
    // not exist to be passed, so the agent picks which issues it wants and never where bytes go.
    for (const tool of await client.listed()) {
      const parameters = Object.keys(tool.inputSchema.properties ?? {});
      assertFalse(
        parameters.some((name) => /path|dir|out|file/i.test(name)),
        `${tool.name} should take no path parameter, got ${parameters.join(', ')}`,
      );
    }
  });
});

Deno.test('every byte the server writes to stdout is a JSON-RPC frame', async () => {
  // A subprocess, because that is the only place a stray `console.log` anywhere in the pipeline
  // can actually be seen. In-process the test harness owns `console`, so a leak would be
  // invisible exactly where it matters most: stdout is the protocol.
  const fake = await startFakeJira();
  const outDir = await Deno.makeTempDir();
  // The subprocess resolves its own config the way a real run does: walk up for `.git`, then
  // derive a filename under $HOME. Pinning HOME is what keeps it off this repository's real one.
  const home = await Deno.makeTempDir();
  await Deno.mkdir(join(outDir, '.git'));
  // realPath because `findProjectRoot` canonicalises, and on macOS the temp dir is a symlink.
  const projectRoot = await Deno.realPath(outDir);
  // Derived with the same function the server will use, rather than restated as
  // `<home>/.config/jira-fetch`: Windows puts it under %APPDATA% instead, and a test that
  // hardcodes the unix layout writes the config somewhere the server never looks.
  const fakeEnv = (name: string) => (name === 'HOME' || name === 'APPDATA' ? home : undefined);
  const configPath = configPathFor(projectRoot, userConfigDir(fakeEnv));
  await Deno.mkdir(dirname(configPath), { recursive: true });
  await Deno.writeTextFile(
    configPath,
    stringifyYaml({
      project: projectRoot,
      baseUrl: fake.origin,
      email: 'kim@example.com',
      token: 't',
    }),
  );

  const frames = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'fetch_issues', arguments: { keys: ['DN-1243', 'DN-4040'] } },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'search_issues', arguments: { jql: 'wide' } },
    },
  ];

  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      // The same narrowed set the shipped binary is compiled with (PERMISSIONS in
      // scripts/build_all.ts). Running the real server under it here is what proves nothing in
      // the pipeline — @std/*, the MCP package, zod — reads a variable outside this list; a
      // NotCapable would only ever surface at runtime.
      '--allow-net',
      '--allow-env=HOME,APPDATA,USERPROFILE',
      '--allow-read',
      '--allow-write',
      // fromFileUrl, not .pathname: on Windows that is "/D:/...", which deno resolves from the
      // wrong place and then cannot find deno.json, so every import fails.
      fromFileUrl(import.meta.resolve('../src/main.ts')),
      'mcp',
      '--out',
      outDir,
      '--verbose',
    ],
    // A pinned HOME and a cwd inside the fake project are the whole seal: there is no --config to
    // pass and no JIRA_* variable to set, so without these the subprocess would resolve this
    // repository's own configuration, real token included.
    // APPDATA as well as HOME: it is what locates the directory on Windows, and pinning only
    // HOME there would send the server to the real one. SYSTEMROOT is not about configuration at
    // all — Winsock cannot initialise without it, so on Windows a cleared environment makes every
    // fetch fail before it reaches a socket. None of the three is a way to reach a config file.
    env: Deno.build.os === 'windows'
      ? { HOME: home, APPDATA: home, SYSTEMROOT: Deno.env.get('SYSTEMROOT') ?? '' }
      : { HOME: home },
    clearEnv: true,
    cwd: outDir,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  const writer = command.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n'),
  );

  // stdin stays open until every reply is in. Closing it early is not merely impatient: the
  // server treats end-of-stdin as "the client is gone" and stops, so the two tool calls — which
  // do real work against the fake Jira — would never be answered. A real client holds the pipe.
  const lines: string[] = [];
  let pending = '';
  const stderrRead = new Response(command.stderr).text();
  for await (const chunk of command.stdout.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const line of parts) if (line.trim() !== '') lines.push(line);
    if (lines.length >= 4) break;
  }
  await writer.close();

  const err = await stderrRead;
  const status = await command.status;

  assertEquals(status.code, 0, `server exited ${status.code}\n${err}`);
  assertEquals(lines.length, 4, `expected four replies, got ${lines.length}:\n${lines.join('\n')}`);

  for (const line of lines) {
    const frame = JSON.parse(line) as { jsonrpc?: string };
    assertEquals(frame.jsonrpc, '2.0', `not a JSON-RPC frame: ${line}`);
  }
  // The last two are the tool calls, so the whole pipeline ran — filters, downloads and all —
  // with nothing of it landing on stdout.
  assertStringIncludes(lines[2], 'DN-1243');
  assertStringIncludes(lines[3], 'resource_link');

  // --verbose was on, so progress lines exist — and every one of them went to stderr.
  assertStringIncludes(err, 'site:');

  await fake.stop();
  await Deno.remove(outDir, { recursive: true });
});

Deno.test('a key that is not an issue key is refused before any request', async () => {
  await withMcp({}, async ({ client, requests }) => {
    const before = requests.length;
    const result = await client.call('fetch_issues', { keys: ['../../field'] });

    assert(result.isError, 'a malformed key should not be attempted');
    // Nothing reached Jira: an unvalidated key is interpolated into the issue endpoint's path.
    assertEquals(requests.length, before);
  });
});
