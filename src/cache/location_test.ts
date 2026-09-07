import { assert, assertEquals, assertThrows } from '@std/assert';
import { join } from '@std/path';
import { ConfigError } from '../config/errors.ts';
import type { EnvReader } from '../config/location.ts';
import { cacheDirFor, cacheKey, userCacheDir } from './location.ts';

/** An environment with exactly the variables named, so a test can pin a home directory without
 * touching the process it runs in. */
const envOf = (vars: Record<string, string>): EnvReader => (name) => vars[name];

Deno.test('userCacheDir answers for the os it was asked about, not the host', () => {
  // The regression this pins: joining with the *host's* separator made the linux answer
  // `\home\kim\...` on Windows — a path for no operating system at all.
  assertEquals(
    userCacheDir(envOf({ HOME: '/home/kim' }), 'linux'),
    '/home/kim/.cache/jira-fetch',
  );
  assertEquals(
    userCacheDir(envOf({ APPDATA: 'C:\\Users\\Kim\\AppData\\Roaming' }), 'windows'),
    'C:\\Users\\Kim\\AppData\\Roaming\\jira-fetch\\cache',
  );
  assertEquals(
    userCacheDir(envOf({ HOME: '/Users/kim' }), 'darwin'),
    '/Users/kim/.cache/jira-fetch',
  );
});

Deno.test('userCacheDir falls back to %USERPROFILE% on Windows', () => {
  assertEquals(
    userCacheDir(envOf({ USERPROFILE: 'C:\\Users\\Kim' }), 'windows'),
    'C:\\Users\\Kim\\AppData\\Roaming\\jira-fetch\\cache',
  );
});

Deno.test('userCacheDir refuses rather than guessing when the home is unknown', () => {
  assertThrows(() => userCacheDir(envOf({}), 'linux'), ConfigError, '$HOME is not set');
  assertThrows(() => userCacheDir(envOf({}), 'windows'), ConfigError, '%APPDATA% is not set');
});

Deno.test('XDG_CACHE_HOME is not a way to move the cache', () => {
  // Same reasoning as userConfigDir ignoring XDG_CONFIG_HOME: another variable read is another
  // way for the answer to depend on the environment.
  assertEquals(
    userCacheDir(envOf({ HOME: '/home/kim', XDG_CACHE_HOME: '/somewhere/else' }), 'linux'),
    '/home/kim/.cache/jira-fetch',
  );
});

Deno.test('cacheKey is the leading hex of SHA-1', async () => {
  // SHA-1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
  assertEquals(await cacheKey('abc'), 'a9993e364706');
});

Deno.test('cacheKey is 12 lower-case hex characters, whatever the input', async () => {
  for (const input of ['/', '/Users/kim/code/thing', 'C:\\code\\thing', '/a'.repeat(400), 'ü']) {
    const key = await cacheKey(input);
    assertEquals(key.length, 12);
    assert(/^[0-9a-f]{12}$/.test(key), `not hex: ${key}`);
  }
});

Deno.test('cacheKey does not resolve its argument', async () => {
  // A pure string transform, like projectSlug: the same literal keys the same way on every host,
  // and two spellings of one directory are two keys. Canonicalising is the caller's job, which is
  // why the contract is "pass what findProjectRoot returned".
  const viaSymlink = await cacheKey('/var/folders/x/repo');
  const canonical = await cacheKey('/private/var/folders/x/repo');
  assert(viaSymlink !== canonical);
});

Deno.test('cacheKey distinguishes paths that projectSlug would collide', async () => {
  // projectSlug is not injective — /a/b_c and /a_b/c both slug to a_b_c. The digest separates
  // them, though the manifest's project key is still what actually guards a mix-up.
  assert(await cacheKey('/a/b_c') !== await cacheKey('/a_b/c'));
});

Deno.test('cacheDirFor puts the key inside the cache directory it was given', async () => {
  // Built with `join` rather than written out, because this one *does* use the host's separator:
  // its directory argument came from `userCacheDir`, which already answered in the host's shape.
  // A POSIX literal on the right-hand side would fail on Windows for a reason the test is not
  // about — the same trap `configPathFor`'s test avoids the same way.
  assertEquals(
    await cacheDirFor('abc', join('home', 'kim', '.cache', 'jira-fetch')),
    join('home', 'kim', '.cache', 'jira-fetch', 'a9993e364706'),
  );
});

Deno.test('two project roots never share a cache directory', async () => {
  const dir = join('home', 'kim', '.cache', 'jira-fetch');
  assert(
    await cacheDirFor('/a/thing', dir) !== await cacheDirFor('/b/thing', dir),
  );
});
