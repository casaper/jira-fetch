import { assertEquals, assertFalse, assertRejects, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { ConfigError } from '../config/errors.ts';
import { loadProjectConfig } from '../config/config.ts';
import {
  DIR_MODE,
  FILE_MODE,
  readConfigFileIfPresent,
  repairMode,
  writeConfigFile,
} from './config_file.ts';

const POSIX = Deno.build.os !== 'windows';

const withTemp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const mode = async (path: string) => ((await Deno.stat(path)).mode ?? 0) & 0o777;

Deno.test('what setup writes is what the loader reads back', async () => {
  // The round trip is the contract: setup validates through the same parseConfigFile the loader
  // uses, so it cannot produce a file the tool would then refuse.
  await withTemp(async (dir) => {
    const path = join(dir, 'nested', 'project.yml');
    await writeConfigFile(path, {
      project: dir,
      baseUrl: 'https://site.atlassian.net',
      email: 'kim@example.com',
      token: 'secret-token',
      allowJql: false,
      filters: { exclude: [{ project: ['SUP'] }] },
    });

    const read = await loadProjectConfig(path, dir);
    assertEquals(read.baseUrl, 'https://site.atlassian.net');
    assertFalse(read.allowJql);
    assertEquals(read.filters?.exclude?.[0], { project: ['SUP'] });
  });
});

Deno.test('the file carries the schema line so an editor can complete it', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'project.yml');
    await writeConfigFile(path, { project: dir });
    assertStringIncludes(await Deno.readTextFile(path), 'yaml-language-server: $schema=');
  });
});

Deno.test('a config setup would not be able to load is refused before anything is written', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'project.yml');
    // `baseUrl` is a plain string at the type level — z.url() only narrows at runtime — so this
    // is exactly the class of mistake the validation step exists to catch.
    await assertRejects(
      () => writeConfigFile(path, { project: dir, baseUrl: 'not a url' }),
      ConfigError,
    );
    assertEquals(await readConfigFileIfPresent(path), undefined);
  });
});

Deno.test({
  name: 'the directory is owner-only and the file is owner-read-write',
  ignore: !POSIX,
  fn: async () => {
    await withTemp(async (dir) => {
      const configDir = join(dir, 'jira-fetch');
      const path = join(configDir, 'project.yml');
      await writeConfigFile(path, { project: dir, token: 'secret' });
      assertEquals(await mode(configDir), DIR_MODE);
      // 0600 rather than the 0700 a directory needs: an execute bit on a YAML document would say
      // something untrue about it, and it is the same access either way.
      assertEquals(await mode(path), FILE_MODE);
    });
  },
});

Deno.test({
  name: 'a file left too readable by an earlier write is repaired, not just left alone',
  ignore: !POSIX,
  fn: async () => {
    await withTemp(async (dir) => {
      const path = join(dir, 'project.yml');
      await Deno.writeTextFile(path, 'project: /old\n');
      await Deno.chmod(path, 0o644);
      await writeConfigFile(path, { project: dir, token: 'secret' });
      assertEquals(await mode(path), FILE_MODE);
    });
  },
});

Deno.test({
  name: 'repairMode is silent about something that is not there',
  ignore: !POSIX,
  fn: async () => {
    await withTemp(async (dir) => {
      await repairMode(join(dir, 'absent'), FILE_MODE);
    });
  },
});

Deno.test('reading is undefined when there is nothing there', async () => {
  await withTemp(async (dir) => {
    assertEquals(await readConfigFileIfPresent(join(dir, 'absent.yml')), undefined);
  });
});

Deno.test('a file that exists but will not parse is an error, not a fresh start', async () => {
  // Starting over would silently discard whatever filters were in there.
  await withTemp(async (dir) => {
    const path = join(dir, 'project.yml');
    await Deno.writeTextFile(path, 'filters: [unclosed\n');
    await assertRejects(() => readConfigFileIfPresent(path), ConfigError);
  });
});

Deno.test('a long project path stays on one line', async () => {
  // Folded into a `>-` block it still round-trips, but this file is meant to be edited by hand.
  await withTemp(async (dir) => {
    const long = join(dir, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60));
    const path = join(dir, 'project.yml');
    await writeConfigFile(path, { project: long });
    assertStringIncludes(await Deno.readTextFile(path), `project: ${long}\n`);
    assertEquals((await readConfigFileIfPresent(path))?.project, long);
  });
});

Deno.test('the documented example is a valid configuration', async () => {
  // The README points readers at docs/config-example.yml instead of carrying inline examples, so
  // without this a drift between it and the Zod schema is a documentation bug with no detector.
  const path = new URL('../../docs/config-example.yml', import.meta.url).pathname;
  const config = await readConfigFileIfPresent(path);
  assertEquals(typeof config?.project, 'string');
  // Every credential a run needs, so someone working from it does not get told what is missing.
  for (const key of ['baseUrl', 'email', 'token'] as const) {
    assertEquals(typeof config?.[key], 'string', `${key} is missing from the example`);
  }
});
