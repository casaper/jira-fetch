import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { describeFailure, verifyCredentials, type VerifyResult } from './verify.ts';

const CREDENTIALS = {
  baseUrl: 'https://site.atlassian.net',
  email: 'kim@example.com',
  token: 'secret',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A stub fetch that counts calls, so "no retries at an interactive prompt" is observable. */
const stub = (responder: () => Response | Promise<Response>) => {
  let calls = 0;
  const impl: typeof fetch = () => {
    calls++;
    return Promise.resolve(responder());
  };
  return { impl, calls: () => calls };
};

const failed = (result: VerifyResult): Extract<VerifyResult, { ok: false }> => {
  assert(!result.ok, 'expected a failure');
  return result;
};

Deno.test('valid credentials come back as who you are, not as a tick', () => {
  const { impl } = stub(() =>
    json({ accountId: '5f1a2b', displayName: 'Kim Doe', emailAddress: 'kim@example.com' })
  );
  return verifyCredentials(CREDENTIALS, impl).then((result) => {
    assert(result.ok);
    assertEquals(result.accountId, '5f1a2b');
    assertEquals(result.displayName, 'Kim Doe');
    assertEquals(result.emailAddress, 'kim@example.com');
  });
});

Deno.test('a site that hides email addresses still verifies', async () => {
  const { impl } = stub(() => json({ accountId: '5f1a2b', displayName: 'Kim Doe' }));
  const result = await verifyCredentials(CREDENTIALS, impl);
  assert(result.ok);
  assertEquals(result.emailAddress, undefined);
});

Deno.test('an account with no display name falls back to its id rather than to nothing', async () => {
  const { impl } = stub(() => json({ accountId: '5f1a2b' }));
  const result = await verifyCredentials(CREDENTIALS, impl);
  assert(result.ok);
  assertEquals(result.displayName, '5f1a2b');
});

Deno.test('HTML with a 200 is the failure this check exists for', async () => {
  // A marketing page, an SSO portal or a corporate proxy. `response.ok` is true, so the status
  // code proves nothing and the content type has to decide.
  const { impl } = stub(() =>
    new Response('<html><body>Sign in</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  );
  const result = failed(await verifyCredentials(CREDENTIALS, impl));
  assertEquals(result.kind, 'notJira');
  assertStringIncludes(result.message, 'Check the site address');
});

Deno.test('JSON without an account is not a Jira site either', async () => {
  const { impl } = stub(() => json({ hello: 'world' }));
  assertEquals(failed(await verifyCredentials(CREDENTIALS, impl)).kind, 'notJira');
});

Deno.test('each status points at a different thing to fix', async () => {
  const cases: Array<[number, string, string]> = [
    [401, 'unauthorized', 'email and token did not match'],
    [403, 'forbidden', 'not allowed to use the API'],
    [404, 'notFound', 'REST v2'],
    [500, 'server', 'returned an error'],
  ];
  for (const [status, kind, needle] of cases) {
    const { impl } = stub(() => json({ errorMessages: ['no'] }, status));
    const result = failed(await verifyCredentials(CREDENTIALS, impl));
    assertEquals(result.kind, kind, `status ${status}`);
    assertStringIncludes(result.message, needle);
  }
});

Deno.test('a prompt does not wait out a retry backoff', async () => {
  // 503 is retryable, and the default three attempts with backoff would freeze an interactive
  // prompt for about fifteen seconds. A person can press "try again" faster than that.
  const { impl, calls } = stub(() => json({ errorMessages: ['busy'] }, 503));
  assertEquals(failed(await verifyCredentials(CREDENTIALS, impl)).kind, 'server');
  assertEquals(calls(), 1);
});

Deno.test('a transport failure is the network, not the keys', async () => {
  const impl: typeof fetch = () => Promise.reject(new TypeError('connection refused'));
  const result = failed(await verifyCredentials(CREDENTIALS, impl));
  assertEquals(result.kind, 'network');
  assertStringIncludes(result.message, 'connection refused');
});

Deno.test("a bad site address is refused before any request, in the loader's own words", async () => {
  const { impl, calls } = stub(() => json({ accountId: 'x' }));
  const result = failed(
    await verifyCredentials({ ...CREDENTIALS, baseUrl: 'http://jira.example.com' }, impl),
  );
  assertEquals(result.kind, 'badUrl');
  // The same sentence the next run would have printed, rather than a second wording of the rule.
  assertStringIncludes(result.message, 'must use https');
  assertEquals(calls(), 0, 'nothing should have been sent');

  const nonsense = failed(await verifyCredentials({ ...CREDENTIALS, baseUrl: 'not a url' }, impl));
  assertEquals(nonsense.kind, 'badUrl');
});

Deno.test('plain http to loopback is allowed, because the whole suite rests on it', async () => {
  const { impl } = stub(() => json({ accountId: '5f1a2b', displayName: 'Kim Doe' }));
  const result = await verifyCredentials(
    { ...CREDENTIALS, baseUrl: 'http://127.0.0.1:8080' },
    impl,
  );
  assert(result.ok, 'loopback http must verify');
});

Deno.test('a trailing slash on the site address is not a different site', async () => {
  let seen = '';
  const impl: typeof fetch = (input) => {
    seen = String(input);
    return Promise.resolve(json({ accountId: 'x' }));
  };
  await verifyCredentials({ ...CREDENTIALS, baseUrl: 'https://site.atlassian.net/' }, impl);
  assertEquals(seen, 'https://site.atlassian.net/rest/api/3/myself');
});

Deno.test('only an unreachable site suggests saving anyway', () => {
  // Verification is a convenience, not the boundary, so an offline machine must still be able to
  // finish. A wrong token is not the same situation and gets no such nudge.
  for (const kind of ['network', 'server'] as const) {
    const lines = describeFailure({ ok: false, kind, message: 'x' });
    assert(lines.some((line) => line.includes('anyway')), kind);
  }
  for (const kind of ['unauthorized', 'forbidden', 'notFound', 'notJira', 'badUrl'] as const) {
    const lines = describeFailure({ ok: false, kind, message: 'x' });
    assert(!lines.some((line) => line.includes('anyway')), kind);
  }
});
