import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert';
import { join } from '@std/path';
import { ConfigError, type ConfigFile, loadProjectConfig, resolveConfig } from './config.ts';
import { parseFilters } from './schema.ts';

const CWD = '/work/project';
const PATH = '/home/kim/.config/jira-fetch/work_project.yml';

/** The three credentials every config file must carry, since nothing else can supply them. */
const CREDENTIALS = {
  project: CWD,
  baseUrl: 'https://file.atlassian.net',
  email: 'file@example.com',
  token: 'file-token',
} satisfies ConfigFile;

const resolve = (file: Partial<ConfigFile> = {}, flags: Pick<ConfigFile, 'out'> = {}) =>
  resolveConfig({ flags, file: { ...CREDENTIALS, ...file }, filePath: PATH, cwd: CWD });

Deno.test('credentials come from the file, and the file is the only place they can come from', () => {
  const config = resolve();
  assertEquals(config.baseUrl, 'https://file.atlassian.net');
  assertEquals(config.email, 'file@example.com');
  assertEquals(config.token, 'file-token');
  assertEquals(config.configPath, PATH);
});

Deno.test('a file missing credentials names every one of them and points at setup', () => {
  const error = assertThrows(
    () => resolveConfig({ flags: {}, file: { project: CWD }, filePath: PATH, cwd: CWD }),
    ConfigError,
  );
  assertStringIncludes(error.message, 'baseUrl, email, token');
  assertStringIncludes(error.message, 'jira-fetch setup');
});

Deno.test('a trailing slash on the base URL is removed', () => {
  assertEquals(
    resolve({ baseUrl: 'https://site.atlassian.net/' }).baseUrl,
    'https://site.atlassian.net',
  );
});

Deno.test('a non-https base URL is rejected', () => {
  const error = assertThrows(() => resolve({ baseUrl: 'http://site.atlassian.net' }), ConfigError);
  assertStringIncludes(error.message, 'must use https');
});

Deno.test('plain http is allowed for loopback, which is what the fake Jira runs on', () => {
  assertEquals(resolve({ baseUrl: 'http://localhost:8080' }).baseUrl, 'http://localhost:8080');
});

Deno.test('a malformed base URL is rejected with the value quoted', () => {
  const error = assertThrows(() => resolve({ baseUrl: 'not a url' }), ConfigError);
  assertStringIncludes(error.message, '"not a url"');
});

Deno.test('the output directory defaults to the working directory', () => {
  assertEquals(resolve().outDir, CWD);
});

Deno.test('a relative out is resolved against the working directory', () => {
  assertEquals(resolve({ out: 'docs/jira' }).outDir, join(CWD, 'docs/jira'));
  assertEquals(resolve({}, { out: 'flag/dir' }).outDir, join(CWD, 'flag/dir'));
});

Deno.test('--out beats the file, which is the only key a flag can still override', () => {
  assertEquals(resolve({ out: 'from/file' }, { out: 'from/flag' }).outDir, join(CWD, 'from/flag'));
});

Deno.test('allowJql defaults to true and only an explicit false turns it off', () => {
  assert(resolve().allowJql);
  assert(resolve({ allowJql: true }).allowJql);
  assertFalse(resolve({ allowJql: false }).allowJql);
});

Deno.test('filters in the config file are compiled during resolution', () => {
  const config = resolve({ filters: { exclude: [{ project: ['SUP'] }] } });
  assertEquals(config.filters.exclude.length, 1);
  assert(config.filters.exclude[0].preFetch);
});

Deno.test('filters reaching resolution are already schema-validated', () => {
  // `parseConfigFile` is the only gate; by the time rules.ts sees a rule it only shapes it.
  const config = resolve({ filters: parseFilters({ include: [{ labels: ['Keep'] }] }) });
  assertEquals(config.filters.include.length, 1);
});

Deno.test('people defaults are filled in even when the config file omits the block', () => {
  assertEquals(resolve().people, {
    roles: ['reporter', 'assignee', 'commenter'],
    fields: ['name', 'email'],
    nameFormat: 'full',
  });
});

Deno.test('a people block in the config file is honoured', () => {
  const config = resolve({
    people: { roles: ['reporter'], fields: ['name'], nameFormat: 'initials' },
  });
  assertEquals(config.people, { roles: ['reporter'], fields: ['name'], nameFormat: 'initials' });
});

// --- loadProjectConfig: the derived path, and the guard on it ---------------------------------

const withTemp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const yaml = (root: string) =>
  `project: ${root}\nbaseUrl: https://site.atlassian.net\nemail: kim@example.com\ntoken: t\n`;

Deno.test('the config file is read as YAML from the path it is given', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'project.yml');
    await Deno.writeTextFile(path, yaml(dir));
    const file = await loadProjectConfig(path, dir);
    assertEquals(file.baseUrl, 'https://site.atlassian.net');
    assertEquals(file.project, dir);
  });
});

Deno.test('a config file for another repository is refused, naming both paths', async () => {
  // The slug is not injective — /a/b_c and /a_b/c name the same file — so without this guard a
  // project could silently run under another project's filters.
  await withTemp(async (dir) => {
    const path = join(dir, 'project.yml');
    await Deno.writeTextFile(path, yaml('/somewhere/else'));
    const error = await assertRejects(() => loadProjectConfig(path, dir), ConfigError);
    assertStringIncludes(error.message, '/somewhere/else');
    assertStringIncludes(error.message, dir);
    assertStringIncludes(error.message, 'jira-fetch setup');
  });
});

Deno.test('a symlinked project root still matches its own configuration', async () => {
  // /var is /private/var on macOS, so the two spellings must not read as different projects.
  await withTemp(async (dir) => {
    const real = await Deno.realPath(dir);
    const path = join(dir, 'project.yml');
    await Deno.writeTextFile(path, yaml(real));
    assertEquals((await loadProjectConfig(path, dir)).project, real);
  });
});

Deno.test('a missing config file names the exact path and suggests setup', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'absent.yml');
    const error = await assertRejects(() => loadProjectConfig(path, dir), ConfigError);
    assertStringIncludes(error.message, path);
    assertStringIncludes(error.message, 'jira-fetch setup');
  });
});

Deno.test('a malformed config file names the file and the problem', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'project.yml');
    await Deno.writeTextFile(path, 'filters: [unclosed\n');
    const error = await assertRejects(() => loadProjectConfig(path, dir), ConfigError);
    assertStringIncludes(error.message, path);
    assertStringIncludes(error.message, 'not valid YAML');
  });
});

Deno.test('a config file with no project key is refused by the schema', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'project.yml');
    await Deno.writeTextFile(path, 'baseUrl: https://site.atlassian.net\n');
    const error = await assertRejects(() => loadProjectConfig(path, dir), ConfigError);
    assertStringIncludes(error.message, 'project');
  });
});

Deno.test('JSON is no longer understood, even when the bytes would parse as YAML', async () => {
  // JSON happens to be a YAML subset, so this would silently work if the extension still routed
  // to a JSON parser. What must not work is a `.json` file being *found*: paths are derived with
  // a .yml suffix and nothing searches for anything else.
  await withTemp(async (dir) => {
    const path = join(dir, 'project.json');
    await Deno.writeTextFile(path, JSON.stringify({ project: dir, baseUrl: 'nonsense' }));
    const error = await assertRejects(() => loadProjectConfig(path, dir), ConfigError);
    assertStringIncludes(error.message, 'baseUrl');
  });
});
