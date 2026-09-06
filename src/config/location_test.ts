import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert';
import { join } from '@std/path';
import { ConfigError } from './errors.ts';
import { configPathFor, findProjectRoot, projectSlug, userConfigDir } from './location.ts';

Deno.test('the worked example from the specification', () => {
  assertEquals(
    projectSlug('/Users/username/coding_projects/jira_fetch Project Root'),
    'users_username_coding_projects_jira_fetch-project-root',
  );
});

Deno.test('the leading separator is dropped, the rest become underscores', () => {
  assertEquals(projectSlug('/a/b/c'), 'a_b_c');
});

Deno.test('underscores survive; every other non-alphanumeric run folds to one hyphen', () => {
  assertEquals(
    projectSlug('/keep_this/drop.these@chars/and  spaces'),
    'keep_this_drop-these-chars_and-spaces',
  );
});

Deno.test('hyphens do not accumulate at a segment edge', () => {
  assertEquals(projectSlug('/.hidden/trailing./-both-'), 'hidden_trailing_both');
});

Deno.test('repeated separators collapse rather than producing empty segments', () => {
  assertEquals(projectSlug('/a//b///c/'), 'a_b_c');
});

Deno.test('a Windows drive letter is a segment, not a segment with a colon', () => {
  assertEquals(projectSlug('C:\\Users\\kim\\code\\thing'), 'c_users_kim_code_thing');
});

Deno.test('a segment that folds away entirely is dropped, not left empty', () => {
  assertEquals(projectSlug('/a/!!!/b'), 'a_b');
});

Deno.test('the slug is not injective, which is why the file carries a project key', () => {
  // Documenting the hazard rather than pretending it away: `assertProjectMatches` in config.ts is
  // what actually catches this, and it refuses rather than warns.
  assertEquals(projectSlug('/a/b_c'), projectSlug('/a_b/c'));
});

Deno.test('an over-long root is truncated and disambiguated by a hash', () => {
  const long = '/' + Array.from({ length: 40 }, (_, i) => `segment-number-${i}`).join('/');
  const slug = projectSlug(long);
  assert(new TextEncoder().encode(slug).length <= 213, `slug was ${slug.length} chars`);
  // Two roots sharing a 200-byte prefix must still land on different files.
  assert(slug !== projectSlug(long + '/more'));
});

Deno.test('truncation never splits a multi-byte character', () => {
  const slug = projectSlug('/' + 'é'.repeat(400));
  assertFalseIncludes(slug, '\uFFFD');
});

const assertFalseIncludes = (haystack: string, needle: string): void => {
  assert(
    !haystack.includes(needle),
    `expected ${JSON.stringify(haystack)} not to contain ${needle}`,
  );
};

Deno.test('configPathFor names the one file, with a .yml extension', () => {
  assertEquals(
    configPathFor('/home/kim/code/thing', '/home/kim/.config/jira-fetch'),
    join('/home/kim/.config/jira-fetch', 'thing_slug_placeholder.yml').replace(
      'thing_slug_placeholder',
      'home_kim_code_thing',
    ),
  );
});

Deno.test('the config directory is $HOME/.config/jira-fetch on unix', () => {
  const env = (name: string) => (name === 'HOME' ? '/home/kim' : undefined);
  assertEquals(userConfigDir(env, 'linux'), '/home/kim/.config/jira-fetch');
  assertEquals(userConfigDir(env, 'darwin'), '/home/kim/.config/jira-fetch');
});

Deno.test('the config directory is %APPDATA%\\jira-fetch on windows', () => {
  const env = (name: string) => name === 'APPDATA' ? 'C:\\Users\\kim\\AppData\\Roaming' : undefined;
  assertStringIncludes(userConfigDir(env, 'windows'), 'jira-fetch');
  assertStringIncludes(userConfigDir(env, 'windows'), 'Roaming');
});

Deno.test('windows falls back to %USERPROFILE% when %APPDATA% is unset', () => {
  const env = (name: string) => (name === 'USERPROFILE' ? 'C:\\Users\\kim' : undefined);
  const dir = userConfigDir(env, 'windows');
  assertStringIncludes(dir, 'AppData');
  assertStringIncludes(dir, 'Roaming');
  assertStringIncludes(dir, 'jira-fetch');
});

Deno.test('no home directory is a config error, not a crash', () => {
  const empty = () => undefined;
  assertThrows(() => userConfigDir(empty, 'linux'), ConfigError, '$HOME is not set');
  assertThrows(() => userConfigDir(empty, 'windows'), ConfigError, '%APPDATA% is not set');
});

Deno.test('findProjectRoot walks up to the directory holding .git', async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, '.git'));
    const nested = join(root, 'src', 'deep');
    await Deno.mkdir(nested, { recursive: true });
    // Canonicalised: on macOS the temp dir is /var/... but Deno.cwd() reports /private/var/... .
    // The filename is derived from this, so the two spellings must not name different files.
    assertEquals(await findProjectRoot(nested), await Deno.realPath(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('a .git file counts: that is how a worktree and a submodule spell it', async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    assertEquals(await findProjectRoot(root), await Deno.realPath(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('outside a repository the error says so and names the directory', async () => {
  const root = await Deno.makeTempDir();
  try {
    const error = await assertRejects(() => findProjectRoot(root), ConfigError);
    assertStringIncludes(error.message, 'not inside a git repository');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
