import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from '@std/assert';
import { join } from '@std/path';
import {
  ConfigError,
  type ConfigFile,
  discoverConfigFile,
  loadDotenv,
  resolveConfig,
} from './config.ts';

const CWD = '/work/project';

function resolve(
  flags: Record<string, string | undefined> = {},
  env: Record<string, string | undefined> = {},
  file: ConfigFile | undefined = undefined,
) {
  return resolveConfig({ flags, env, file, cwd: CWD });
}

const ENV = {
  JIRA_BASE_URL: 'https://env.atlassian.net',
  JIRA_EMAIL: 'env@example.com',
  JIRA_API_TOKEN: 'env-token',
};

/** The same three credentials as `ENV`, but as config-file keys. */
const ENV_FILE: ConfigFile = {
  baseUrl: 'https://file.atlassian.net',
  email: 'file@example.com',
};

Deno.test('flags beat environment, which beats the config file', () => {
  const config = resolve(
    { baseUrl: 'https://flag.atlassian.net' },
    ENV,
    { baseUrl: 'https://file.atlassian.net', email: 'file@example.com', token: 'file-token' },
  );
  assertEquals(config.baseUrl, 'https://flag.atlassian.net');
  assertEquals(config.email, 'env@example.com');
  assertEquals(config.token, 'env-token');
});

Deno.test("precedence is per key: a flag for one key keeps the file's other values", () => {
  const config = resolve(
    { baseUrl: 'https://flag.atlassian.net' },
    {},
    { baseUrl: 'https://file.atlassian.net', email: 'file@example.com', token: 'file-token' },
  );
  assertEquals(config.baseUrl, 'https://flag.atlassian.net');
  assertEquals(config.email, 'file@example.com');
  assertEquals(config.token, 'file-token');
});

Deno.test('missing credentials are reported together, naming all three sources', () => {
  const error = assertThrows(() => resolve({}, {}, {}), ConfigError);
  assertStringIncludes(error.message, '--base-url');
  assertStringIncludes(error.message, 'JIRA_EMAIL');
  assertStringIncludes(error.message, 'token in the config file');
});

Deno.test('a trailing slash on the base URL is removed', () => {
  assertEquals(
    resolve({}, { ...ENV, JIRA_BASE_URL: 'https://x.atlassian.net//' }).baseUrl,
    'https://x.atlassian.net',
  );
});

Deno.test('a non-https base URL is rejected', () => {
  assertThrows(
    () => resolve({}, { ...ENV, JIRA_BASE_URL: 'http://x.atlassian.net' }),
    ConfigError,
    'must use https',
  );
});

Deno.test('a malformed base URL is rejected with the value quoted', () => {
  assertThrows(
    () => resolve({}, { ...ENV, JIRA_BASE_URL: 'not a url' }),
    ConfigError,
    'is not a valid URL',
  );
});

Deno.test('the output directory defaults to the working directory', () => {
  assertEquals(resolve({}, ENV).outDir, CWD);
});

Deno.test('a relative --out is resolved against the working directory', () => {
  assertEquals(resolve({ out: 'tmp' }, ENV).outDir, join(CWD, 'tmp'));
  assertEquals(resolve({ out: '/abs/out' }, ENV).outDir, '/abs/out');
});

Deno.test('allowJql defaults to true and only an explicit false turns it off', () => {
  assert(resolve({}, ENV).allowJql);
  assert(resolve({}, ENV, { allowJql: true }).allowJql);
  assertFalse(resolve({}, ENV, { allowJql: false }).allowJql);
});

Deno.test('filters in the config file are compiled during resolution', () => {
  const config = resolve({}, ENV, { filters: { exclude: [{ project: ['SUP'] }] } });
  assertEquals(config.filters.exclude.length, 1);
  assert(config.filters.exclude[0].preFetch);
});

Deno.test('filters reaching resolution are already schema-validated', () => {
  // parseConfigFile rejects a malformed filter before resolveConfig ever sees it; see
  // src/config/schema_test.ts. Resolution therefore only compiles.
  const config = resolve({}, ENV, { filters: { comments: { exclude: [{ author: [null] }] } } });
  assertEquals(config.filters.commentExclude.length, 1);
});

Deno.test('discoverConfigFile walks upward from the working directory', async () => {
  const root = await Deno.makeTempDir();
  try {
    const nested = join(root, 'a', 'b');
    await Deno.mkdir(nested, { recursive: true });
    await Deno.writeTextFile(
      join(root, '.jira-fetch.json'),
      JSON.stringify({ email: 'found@example.com' }),
    );

    const found = await discoverConfigFile(nested);
    assertEquals(found?.data.email, 'found@example.com');
    assertEquals(found?.path, join(root, '.jira-fetch.json'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('the nearest config file wins over one further up', async () => {
  const root = await Deno.makeTempDir();
  try {
    const nested = join(root, 'a');
    await Deno.mkdir(nested);
    await Deno.writeTextFile(join(root, '.jira-fetch.json'), JSON.stringify({ out: 'far' }));
    await Deno.writeTextFile(join(nested, '.jira-fetch.json'), JSON.stringify({ out: 'near' }));

    assertEquals((await discoverConfigFile(nested))?.data.out, 'near');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('YAML config files are accepted alongside JSON', async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(root, '.jira-fetch.yaml'),
      'email: yaml@example.com\nallowJql: false\n',
    );
    const found = await discoverConfigFile(root);
    assertEquals(found?.data.email, 'yaml@example.com');
    assertFalse(found?.data.allowJql);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('a malformed config file names the file and the problem', async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root, '.jira-fetch.json'), '{ not json');
    await assertRejectsConfigError(() => discoverConfigFile(root), 'is not valid JSON');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('discoverConfigFile returns undefined when there is nothing to find', async () => {
  const root = await Deno.makeTempDir();
  try {
    assertEquals(await discoverConfigFile(root), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function assertRejectsConfigError(fn: () => Promise<unknown>, includes: string) {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof ConfigError);
    assertStringIncludes((error as Error).message, includes);
    return;
  }
  throw new Error('expected a ConfigError');
}

/** Runs `fn` against a fresh temp directory and removes it afterwards. */
const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test('closeness beats the name order: a plain name nearby wins over a .conf further up', async () => {
  await withTempDir(async (root) => {
    const nested = join(root, 'a');
    await Deno.mkdir(nested);
    // `.jira-fetch.conf.yml` is first in the name list, but it is one directory further away.
    await Deno.writeTextFile(join(root, '.jira-fetch.conf.yml'), 'out: far\n');
    await Deno.writeTextFile(join(nested, '.jira-fetch.yml'), 'out: near\n');

    assertEquals((await discoverConfigFile(nested))?.data.out, 'near');
  });
});

Deno.test('within one directory the name order decides', async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(join(root, '.jira-fetch.json'), JSON.stringify({ out: 'plain' }));
    await Deno.writeTextFile(join(root, '.jira-fetch.conf.yml'), 'out: conf\n');

    assertEquals((await discoverConfigFile(root))?.data.out, 'conf');
  });
});

Deno.test('every documented config file name is discovered', async () => {
  const names = [
    '.jira-fetch.conf.yml',
    '.jira-fetch.conf.yaml',
    '.jira-fetch.conf.json',
    '.jira-fetch.yml',
    '.jira-fetch.yaml',
    '.jira-fetch.json',
    'jira-fetch.conf.yml',
    'jira-fetch.conf.yaml',
    'jira-fetch.conf.json',
  ];
  for (const name of names) {
    await withTempDir(async (root) => {
      // Both dialects have to survive the round trip; `.json` names take the JSON branch of
      // parseConfigText and everything else takes the YAML one.
      const body = name.endsWith('.json') ? JSON.stringify({ out: name }) : `out: ${name}\n`;
      await Deno.writeTextFile(join(root, name), body);

      const found = await discoverConfigFile(root);
      assertEquals(found?.path, join(root, name), name);
      assertEquals(found?.data.out, name, name);
    });
  }
});

Deno.test('home locations are searched when the walk finds nothing', async () => {
  const cases: Array<[string[], string]> = [
    [['.config', 'jira-fetch.yml'], 'config-dir'],
    [['.config', 'jira-fetch.conf.yaml'], 'config-dir-conf'],
    [['.jira-fetch.conf.json'], 'home-dot'],
    [['.config', 'jira-fetch', 'config.json'], 'legacy'],
  ];
  for (const [segments, value] of cases) {
    await withTempDir(async (home) => {
      await withTempDir(async (cwd) => {
        const path = join(home, ...segments);
        await Deno.mkdir(join(path, '..'), { recursive: true });
        const body = path.endsWith('.json') ? JSON.stringify({ out: value }) : `out: ${value}\n`;
        await Deno.writeTextFile(path, body);

        const found = await discoverConfigFile(cwd, home);
        assertEquals(found?.path, path, value);
        assertEquals(found?.data.out, value, value);
      });
    });
  }
});

Deno.test('the legacy ~/.config/jira-fetch/config.json is the last resort, not the first', async () => {
  await withTempDir(async (home) => {
    await withTempDir(async (cwd) => {
      await Deno.mkdir(join(home, '.config', 'jira-fetch'), { recursive: true });
      await Deno.writeTextFile(join(home, '.config', 'jira-fetch.yml'), 'out: current\n');
      await Deno.writeTextFile(
        join(home, '.config', 'jira-fetch', 'config.json'),
        JSON.stringify({ out: 'legacy' }),
      );

      assertEquals((await discoverConfigFile(cwd, home))?.data.out, 'current');
    });
  });
});

Deno.test('loadDotenv reads .env, with .env.local shadowing it key by key', async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(
      join(root, '.env'),
      'JIRA_EMAIL=base@example.com\nJIRA_API_TOKEN=t1\n',
    );
    await Deno.writeTextFile(join(root, '.env.local'), 'JIRA_API_TOKEN=t2\n');

    const env = await loadDotenv(root);
    assertEquals(env.JIRA_EMAIL, 'base@example.com');
    assertEquals(env.JIRA_API_TOKEN, 't2');
  });
});

Deno.test('loadDotenv finds .env.local on its own, with no .env beside it', async () => {
  await withTempDir(async (root) => {
    const nested = join(root, 'a');
    await Deno.mkdir(nested);
    await Deno.writeTextFile(join(root, '.env.local'), 'JIRA_API_TOKEN=only-local\n');

    assertEquals((await loadDotenv(nested)).JIRA_API_TOKEN, 'only-local');
  });
});

Deno.test('the nearest .env wins outright — an ancestor does not fill in its gaps', async () => {
  await withTempDir(async (root) => {
    const nested = join(root, 'a');
    await Deno.mkdir(nested);
    await Deno.writeTextFile(
      join(root, '.env'),
      'JIRA_API_TOKEN=far\nJIRA_BASE_URL=https://far.atlassian.net\n',
    );
    await Deno.writeTextFile(join(nested, '.env'), 'JIRA_API_TOKEN=near\n');

    const env = await loadDotenv(nested);
    assertEquals(env.JIRA_API_TOKEN, 'near');
    // Levels do not merge: the parent's base URL must not leak into the project's environment.
    assertEquals(env.JIRA_BASE_URL, undefined);
  });
});

Deno.test('loadDotenv is empty, not an error, when there is no .env anywhere', async () => {
  await withTempDir(async (root) => {
    assertEquals(await loadDotenv(root), {});
  });
});

Deno.test('a config file carrying only filters is valid; credentials come from elsewhere', () => {
  const config = resolveConfig({
    flags: {},
    env: ENV,
    file: { filters: { exclude: [{ project: ['SUP'] }] } },
    filePath: '/work/project/.jira-fetch.yaml',
    cwd: CWD,
    home: '/home/kim',
  });
  assertEquals(config.token, 'env-token');
  assertEquals(config.filters.exclude.length, 1);
  // Nothing to warn about: the secret is not on disk.
  assertEquals(config.warnings, []);
});

Deno.test('a token in a project config warns, even when the environment overrides it', () => {
  const config = resolveConfig({
    flags: {},
    env: ENV,
    file: { token: 'file-token' },
    filePath: '/work/project/.jira-fetch.yaml',
    cwd: CWD,
    home: '/home/kim',
  });
  assertEquals(config.token, 'env-token');
  assertEquals(config.warnings.length, 1);
  assertStringIncludes(config.warnings[0], '/work/project/.jira-fetch.yaml');
  assertStringIncludes(config.warnings[0], 'JIRA_API_TOKEN');
});

Deno.test("a token in the user's own config is their business — no warning", () => {
  const home = '/home/kim';
  const personal = [
    join(home, '.config', 'jira-fetch.yaml'),
    join(home, '.config', 'jira-fetch.conf.yml'),
    join(home, '.jira-fetch.conf.json'),
    join(home, '.config', 'jira-fetch', 'config.json'),
  ];
  for (const filePath of personal) {
    const config = resolveConfig({
      flags: {},
      env: {},
      file: { ...ENV_FILE, token: 'file-token' },
      filePath,
      cwd: CWD,
      home,
    });
    assertEquals(config.warnings, [], filePath);
  }

  // One directory below $HOME is a project again, not a personal config.
  const inProject = resolveConfig({
    flags: {},
    env: {},
    file: { ...ENV_FILE, token: 'file-token' },
    filePath: join(home, 'code', 'thing', '.jira-fetch.yaml'),
    cwd: CWD,
    home,
  });
  assertEquals(inProject.warnings.length, 1);
});

Deno.test('without a known home directory nothing is treated as personal', () => {
  const config = resolveConfig({
    flags: {},
    env: {},
    file: { ...ENV_FILE, token: 'file-token' },
    filePath: '/home/kim/.config/jira-fetch.yaml',
    cwd: CWD,
  });
  assertEquals(config.warnings.length, 1);
});
