/** The session is the pipeline both entry points share, so what it returns is the contract
 * between them. These tests pin the `Outcome` shapes rather than the file contents, which
 * `src/document/` and the e2e suite already cover. */

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { createSession } from './session.ts';
import type { Config } from '../config/config.ts';
import { compileFilters } from '../filter/rules.ts';
import { People } from '../config/schema.ts';
import { JiraClient } from '../jira/client.ts';
import { ConfigError } from '../config/errors.ts';
import { type Fake, startFakeJira } from '../../test/fake_jira.ts';
import type { FiltersConfig } from '../config/schema.ts';

const configFor = (fake: Fake, out: string, filters?: FiltersConfig): Config => ({
  baseUrl: fake.origin,
  email: 'kim@example.com',
  token: 't',
  allowJql: true,
  outDir: out,
  filters: compileFilters(filters),
  people: People.parse({}),
  configPath: '/config/jira-fetch/test.yml',
});

async function withSession(
  filters: FiltersConfig | undefined,
  fn: (ctx: {
    session: Awaited<ReturnType<typeof createSession>>;
    out: string;
    requests: string[];
    logged: string[];
  }) => Promise<void>,
): Promise<void> {
  const fake = await startFakeJira();
  const out = await Deno.makeTempDir();
  const logged: string[] = [];
  try {
    const config = configFor(fake, out, filters);
    const session = await createSession({
      config,
      client: new JiraClient({ baseUrl: config.baseUrl, email: config.email, token: config.token }),
      log: (m) => logged.push(m),
    });
    await fn({ session, out, requests: fake.requests, logged });
  } finally {
    await fake.stop();
    await Deno.remove(out, { recursive: true });
  }
}

Deno.test('a surviving issue is written and reported with its path', async () => {
  await withSession(undefined, async ({ session, out }) => {
    const outcome = await session.fetch('DN-1243');

    assertEquals(outcome.status, 'written');
    assert(outcome.status === 'written');
    assertEquals(outcome.key, 'DN-1243');
    assertEquals(outcome.path, join(out, 'DN-1243.md'));
    assertEquals(outcome.assets, 2);
    assertStringIncludes(await Deno.readTextFile(outcome.path), 'id: DN-1243');
  });
});

Deno.test('a key denied on its project prefix is never requested from Jira', async () => {
  await withSession({ exclude: [{ project: ['SUP'] }] }, async ({ session, requests, out }) => {
    const outcome = await session.fetch('SUP-9');

    assertEquals(outcome.status, 'denied');
    assertEquals(requests.filter((r) => r.includes('SUP-9')), []);
    // Nothing is written for a denied key — not even a marker.
    assertEquals(await Array.fromAsync(Deno.readDir(out)), []);
  });
});

Deno.test('a key denied on its payload is dropped before comments or attachments', async () => {
  await withSession({ exclude: [{ labels: ['wontfix'] }] }, async ({ session, requests, out }) => {
    const outcome = await session.fetch('DN-1243');

    assertEquals(outcome.status, 'denied');
    // The issue itself had to be fetched to read the label, but nothing beyond it.
    assert(requests.includes('GET /rest/api/3/issue/DN-1243'));
    assert(!requests.some((r) => r.includes('/comment')));
    assert(!requests.some((r) => r.startsWith('GET /attachment/')));
    assertEquals(await Array.fromAsync(Deno.readDir(out)), []);
  });
});

Deno.test('a denied outcome still carries the reason the CLI prints under --verbose', async () => {
  await withSession({ exclude: [{ project: ['SUP'] }] }, async ({ session, logged }) => {
    const outcome = await session.fetch('SUP-9');

    assert(outcome.status === 'denied');
    // The string names the matched rule — which is why the MCP layer must never read it.
    assertStringIncludes(outcome.reason, 'matched exclude rule');
    assertStringIncludes(logged.join('\n'), 'SUP-9: skipped before fetching');
  });
});

Deno.test('a dry run reports the path it would take and writes nothing', async () => {
  const fake = await startFakeJira();
  const out = await Deno.makeTempDir();
  try {
    const config = configFor(fake, out);
    const session = await createSession({
      config,
      client: new JiraClient({ baseUrl: config.baseUrl, email: config.email, token: config.token }),
      log: () => {},
      dryRun: true,
    });
    const outcome = await session.fetch('DN-1243');

    assertEquals(outcome.status, 'dryRun');
    assert(outcome.status === 'dryRun');
    assertEquals(outcome.path, join(out, 'DN-1243.md'));
    assertEquals(await Array.fromAsync(Deno.readDir(out)), []);
  } finally {
    await fake.stop();
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('the session writes nothing to stdout, whatever the outcome', async () => {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => void captured.push(args.join(' '));
  try {
    await withSession({ exclude: [{ project: ['SUP'] }] }, async ({ session }) => {
      await session.fetch('DN-1243');
      await session.fetch('SUP-9');
    });
  } finally {
    console.log = original;
  }
  // This is the property the MCP server depends on: stdout is the JSON-RPC stream there.
  assertEquals(captured, []);
});

Deno.test('a filter naming a field the site does not have is refused, not ignored', async () => {
  const fake = await startFakeJira();
  const out = await Deno.makeTempDir();
  try {
    const config = configFor(fake, out, { exclude: [{ field: { Teem: ['anything'] } }] });
    const error = await assertRejects(
      () =>
        createSession({
          config,
          client: new JiraClient({
            baseUrl: config.baseUrl,
            email: config.email,
            token: config.token,
          }),
          log: () => {},
        }),
      ConfigError,
    );
    // Named, so the fix is obvious. The alternative — treating it as absent — makes an exclude
    // rule deny nothing at all, silently.
    assertStringIncludes(error.message, 'Teem');
    assertStringIncludes(error.message, 'does not exist');
  } finally {
    await fake.stop();
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('a field name two fields share is refused as ambiguous, naming both', async () => {
  const fake = await startFakeJira();
  const out = await Deno.makeTempDir();
  try {
    const config = configFor(fake, out, { exclude: [{ field: { Category: ['x'] } }] });
    const error = await assertRejects(
      () =>
        createSession({
          config,
          client: new JiraClient({
            baseUrl: config.baseUrl,
            email: config.email,
            token: config.token,
          }),
          log: () => {},
        }),
      ConfigError,
    );
    assertStringIncludes(error.message, 'ambiguous');
    // Both ids, so the message says how to disambiguate rather than only that you must.
    assertStringIncludes(error.message, 'customfield_10078');
    assertStringIncludes(error.message, 'customfield_10045');
  } finally {
    await fake.stop();
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test('a raw field id resolves even when its display name is ambiguous', async () => {
  await withSession({ exclude: [{ field: { customfield_10078: ['x'] } }] }, async ({ session }) => {
    // The escape hatch the ambiguity error points at has to actually work.
    assertEquals((await session.fetch('DN-1243')).status, 'written');
  });
});
