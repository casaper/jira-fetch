import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { join } from '@std/path';
import { ConfigError } from '../config/errors.ts';
import { applyDenyRules, configDirPattern, denyTargets } from './claude_settings.ts';

const withTemp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const readJson = async (path: string) => JSON.parse(await Deno.readTextFile(path));

Deno.test('a config directory under the home directory is written as a ~ pattern', () => {
  assertEquals(
    configDirPattern('/home/kim/.config/jira-fetch', '/home/kim'),
    '~/.config/jira-fetch/**',
  );
});

Deno.test('a directory outside the home directory is anchored at the filesystem root', () => {
  // `~` is the readable form and survives being copied to another machine, but it can only be
  // used when the directory really is under $HOME.
  assertEquals(configDirPattern('/opt/jira-fetch', '/home/kim'), '//opt/jira-fetch/**');
});

Deno.test('a sibling directory with a matching prefix is not mistaken for a child', () => {
  assertEquals(configDirPattern('/home/kimberly/cfg', '/home/kim'), '//home/kimberly/cfg/**');
});

Deno.test('the user file denies the config directory; the project file denies setup', () => {
  const [user, project] = denyTargets('/home/kim/.config/jira-fetch', '/home/kim', '/work/thing');
  assertEquals(user.path, '/home/kim/.claude/settings.json');
  assertEquals(user.rules, ['Read(~/.config/jira-fetch/**)', 'Edit(~/.config/jira-fetch/**)']);
  assertEquals(project.path, '/work/thing/.claude/settings.local.json');
  assertEquals(project.rules, ['Bash(jira-fetch setup:*)']);
});

Deno.test('the settings file and its directory are created when absent', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, '.claude', 'settings.json');
    const outcome = await applyDenyRules({ path, rules: ['Read(x)'], label: 'test' });
    assertEquals(outcome.added, ['Read(x)']);
    assertEquals((await readJson(path)).permissions.deny, ['Read(x)']);
  });
});

Deno.test('every unrelated key survives the merge', async () => {
  // The file belongs to the user; jira-fetch is a guest in it. This is the shape of a real one.
  await withTemp(async (dir) => {
    const path = join(dir, 'settings.local.json');
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        permissions: {
          allow: ['Bash(git:*)'],
          deny: ['Read(./.env*.local)'],
          ask: ['Bash(git reset:*)'],
        },
        hooks: {},
        enabledPlugins: { 'hookify@claude-plugins-official': true },
        plansDirectory: '.claude/plans',
      }),
    );

    await applyDenyRules({ path, rules: ['Bash(jira-fetch setup:*)'], label: 'test' });

    const after = await readJson(path);
    assertEquals(after.permissions.allow, ['Bash(git:*)']);
    assertEquals(after.permissions.ask, ['Bash(git reset:*)']);
    assertEquals(after.permissions.deny, ['Read(./.env*.local)', 'Bash(jira-fetch setup:*)']);
    assertEquals(after.enabledPlugins, { 'hookify@claude-plugins-official': true });
    assertEquals(after.plansDirectory, '.claude/plans');
  });
});

Deno.test('running it twice adds nothing the second time', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'settings.json');
    const target = { path, rules: ['Read(a)', 'Edit(a)'], label: 'test' };

    assertEquals((await applyDenyRules(target)).added, ['Read(a)', 'Edit(a)']);
    const first = await Deno.readTextFile(path);

    assertEquals((await applyDenyRules(target)).added, []);
    // Not merely deduplicated — the file is not rewritten at all when there is nothing to add.
    assertEquals(await Deno.readTextFile(path), first);
  });
});

Deno.test('a partly-applied file gains only the missing rule', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'settings.json');
    await Deno.writeTextFile(path, JSON.stringify({ permissions: { deny: ['Read(a)'] } }));
    assertEquals(
      (await applyDenyRules({ path, rules: ['Read(a)', 'Edit(a)'], label: 't' })).added,
      ['Edit(a)'],
    );
    assertEquals((await readJson(path)).permissions.deny, ['Read(a)', 'Edit(a)']);
  });
});

Deno.test('a permissions block with no deny list yet is filled in, not replaced', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'settings.json');
    await Deno.writeTextFile(path, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
    await applyDenyRules({ path, rules: ['Read(a)'], label: 't' });
    const after = await readJson(path);
    assertEquals(after.permissions.allow, ['Bash(ls:*)']);
    assertEquals(after.permissions.deny, ['Read(a)']);
  });
});

Deno.test('an empty file is treated as an empty object rather than a parse error', async () => {
  await withTemp(async (dir) => {
    const path = join(dir, 'settings.json');
    await Deno.writeTextFile(path, '\n');
    assertEquals((await applyDenyRules({ path, rules: ['Read(a)'], label: 't' })).added, [
      'Read(a)',
    ]);
  });
});

Deno.test('an unparseable settings file stops the run instead of being overwritten', async () => {
  // Rewriting it would destroy whatever the user wrote by hand, which is worse than refusing.
  await withTemp(async (dir) => {
    const path = join(dir, 'settings.json');
    await Deno.writeTextFile(path, '{ "permissions": { // a comment\n } }');
    const error = await assertRejects(
      () => applyDenyRules({ path, rules: ['Read(a)'], label: 't' }),
      ConfigError,
    );
    assertStringIncludes(error.message, 'add these rules by hand');
    assertStringIncludes(await Deno.readTextFile(path), '// a comment');
  });
});

Deno.test('an unknown home directory is refused rather than resolved against the cwd', () => {
  // `resolve('')` is the working directory. A deny rule anchored there would look plausible and
  // protect nothing, which is the worst failure this feature has.
  assertThrows(() => configDirPattern('/opt/jira-fetch', ''), ConfigError, 'no home directory');
});
