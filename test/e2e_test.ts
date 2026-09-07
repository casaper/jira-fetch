/** End-to-end coverage against a fake Jira served on localhost: no credentials, no network.
 * This is what exercises the wiring in src/main.ts — argument parsing, config resolution, the
 * filter stages, asset download and the file layout — in one pass. */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from '@std/assert';
import { basename, join } from '@std/path';
import { EXIT, run } from '../src/main.ts';
import { configPathFor } from '../src/config/location.ts';
import type { FiltersConfig } from '../src/config/schema.ts';
import { stringify as stringifyYaml } from '@std/yaml';
import { type FakeOptions, startFakeJira } from './fake_jira.ts';

/** Config knobs a single run needs; an options object rather than positional booleans. */
interface RunOptions {
  filters?: FiltersConfig;
  allowJql?: boolean;
  /** Working directory for the run, when a test needs to control what is discovered around it. */
  cwd?: string;
}

interface Harness {
  origin: string;
  out: string;
  /** The stand-in project root. Runs resolve their config from it, exactly as a real one does. */
  projectRoot: string;
  /** The stand-in metadata cache. One per harness, so a cache hit in one test cannot answer a
   * request-count assertion in another. */
  cacheDir: string;
  requests: string[];
  runWith: (args: string[], options?: RunOptions) => Promise<number>;
  stdout: string[];
}

async function withJira(
  fn: (h: Harness) => Promise<void>,
  fakeOptions: FakeOptions = {},
): Promise<void> {
  const fake = await startFakeJira(fakeOptions);
  const out = await Deno.makeTempDir();
  const projectRoot = await Deno.makeTempDir();
  const configDir = await Deno.makeTempDir();
  const cacheDir = await Deno.makeTempDir();
  const originalLog = console.log;
  const stdout: string[] = [];
  console.log = (...args: unknown[]) => void stdout.push(args.join(' '));

  try {
    await fn({
      origin: fake.origin,
      out,
      projectRoot,
      cacheDir,
      requests: fake.requests,
      stdout,
      runWith: async (args, { filters, allowJql, cwd } = {}) => {
        // The config file carries the token, because after this refactor nothing else can: there
        // is no environment layer and no --token flag.
        await Deno.writeTextFile(
          configPathFor(projectRoot, configDir),
          stringifyYaml({
            project: projectRoot,
            baseUrl: fake.origin,
            email: 'kim@example.com',
            token: 't',
            ...(allowJql === undefined ? {} : { allowJql }),
            ...(filters ? { filters } : {}),
          }),
        );
        // Pinning all three seals the run. Without the first two, the walk for `.git` and the
        // derived path in $HOME would resolve this very repository's real configuration, token
        // included — and nothing asserts the token, so the leak would not turn the suite red.
        // Without `cacheDir` the suite reads and writes the developer's own metadata cache, and
        // because a cache hit is a request that does not happen, the request-count assertions
        // below would start depending on what ran before them.
        return await run([...args, '--out', out], { projectRoot, configDir, cacheDir, cwd });
      },
    });
  } finally {
    console.log = originalLog;
    await fake.stop();
    await Promise.all(
      // NotFound is tolerated: `cache --clear` removes its directory as the thing under test, and
      // teardown failing on that would report a passing test as an error.
      [out, projectRoot, configDir, cacheDir].map((dir) =>
        Deno.remove(dir, { recursive: true }).catch((cause) => {
          if (!(cause instanceof Deno.errors.NotFound)) throw cause;
        })
      ),
    );
  }
}

Deno.test('fetches an issue into a Markdown file with its assets alongside', async () => {
  await withJira(async ({ out, runWith }) => {
    assertEquals(await runWith(['DN-1243']), EXIT.ok);

    const markdown = await Deno.readTextFile(join(out, 'DN-1243.md'));
    assert(markdown.startsWith('---\n'));
    assertStringIncludes(markdown, 'id: DN-1243');
    // The heading carries the ticket link, which is what replaced the frontmatter's `url`.
    assertStringIncludes(markdown, '# [Spike: evaluate the export pipeline](');
    assertStringIncludes(markdown, '/browse/DN-1243)');
    // The media node names a media-service UUID, not the attachment id, so this line is what
    // proves the filename bridge works against a realistic payload.
    assertStringIncludes(markdown, '![screenshot 01.png](.DN-1243/screenshot_01.png)');

    // Both attachments land in the hidden per-issue directory, de-duplicated by name.
    const assets = (await Array.fromAsync(Deno.readDir(join(out, '.DN-1243')))).map((e) => e.name)
      .sort();
    assertEquals(assets, ['screenshot_01-20002.png', 'screenshot_01.png']);
  });
});

Deno.test('siblings come from the parent and exclude the issue itself', async () => {
  await withJira(async ({ out, runWith }) => {
    await runWith(['DN-1243']);
    const markdown = await Deno.readTextFile(join(out, 'DN-1243.md'));
    assertStringIncludes(markdown, 'siblings:\n  - DN-1250');
    assertFalse(markdown.includes('- DN-1243\n'));
  });
});

Deno.test('a pre-fetch filter means the issue is never requested at all', async () => {
  await withJira(async ({ out, runWith, requests }) => {
    const code = await runWith(['SUP-9'], { filters: { exclude: [{ project: ['SUP'] }] } });

    assertEquals(code, EXIT.allFiltered);
    assertEquals(requests.filter((r) => r.includes('SUP-9')), []);
    assertEquals((await Array.fromAsync(Deno.readDir(out))).map((e) => e.name), []);
  });
});

Deno.test('a post-fetch filter stops before comments and attachments are fetched', async () => {
  await withJira(async ({ out, runWith, requests }) => {
    const code = await runWith(['DN-1243'], { filters: { exclude: [{ labels: ['wontfix'] }] } });

    assertEquals(code, EXIT.allFiltered);
    assert(requests.includes('GET /rest/api/3/issue/DN-1243'));
    // The issue itself had to be fetched to evaluate the label, but nothing beyond it.
    assertFalse(requests.some((r) => r.includes('/comment')));
    assertFalse(requests.some((r) => r.startsWith('GET /attachment/')));
    assertEquals((await Array.fromAsync(Deno.readDir(out))).map((e) => e.name), []);
  });
});

Deno.test('a custom field filter resolves the field name once', async () => {
  await withJira(async ({ runWith, requests }) => {
    const code = await runWith(['DN-1243'], {
      filters: { exclude: [{ field: { Team: ['Platform'] } }] },
    });

    assertEquals(code, EXIT.allFiltered);
    assertEquals(requests.filter((r) => r === 'GET /rest/api/3/field').length, 1);
  });
});

Deno.test('the field endpoint is untouched when no filter needs it', async () => {
  await withJira(async ({ runWith, requests }) => {
    await runWith(['DN-1243'], { filters: { exclude: [{ labels: ['nope'] }] } });
    assertFalse(requests.some((r) => r.includes('/field')));
  });
});

Deno.test('--jql enumerates keys and filters prune the results', async () => {
  await withJira(async ({ out, runWith }) => {
    const code = await runWith(['--jql', 'project in (DN, SUP)'], {
      filters: { exclude: [{ project: ['SUP'] }] },
    });

    assertEquals(code, EXIT.ok);
    const written = (await Array.fromAsync(Deno.readDir(out))).map((e) => e.name).sort();
    assertEquals(written, ['.DN-1243', 'DN-1243.md']);
  });
});

Deno.test('--jql is refused when the config forbids it', async () => {
  await withJira(async ({ runWith, requests }) => {
    assertEquals(await runWith(['--jql', 'project = DN'], { allowJql: false }), EXIT.usageError);
    assertEquals(requests, []);
  });
});

Deno.test('--dry-run reports what it would write without touching the disk', async () => {
  await withJira(async ({ out, runWith, stdout }) => {
    assertEquals(await runWith(['DN-1243', '--dry-run']), EXIT.ok);
    assertEquals((await Array.fromAsync(Deno.readDir(out))).map((e) => e.name), []);
    assertStringIncludes(stdout.join('\n'), 'would write');
  });
});

Deno.test('re-fetching overwrites the existing document', async () => {
  await withJira(async ({ out, runWith }) => {
    await runWith(['DN-1243']);
    await Deno.writeTextFile(join(out, 'DN-1243.md'), 'stale');
    await runWith(['DN-1243']);
    assertStringIncludes(await Deno.readTextFile(join(out, 'DN-1243.md')), 'id: DN-1243');
  });
});

Deno.test('one failing issue does not abort the rest of a batch', async () => {
  await withJira(async ({ out, runWith }) => {
    // DN-9999 is not served, so it 404s while DN-1243 still succeeds.
    const code = await runWith(['DN-9999', 'DN-1243']);
    assertEquals(code, EXIT.ok);
    assert((await Array.fromAsync(Deno.readDir(out))).some((e) => e.name === 'DN-1243.md'));
  });
});

Deno.test('a run with nothing but failures exits 1', async () => {
  await withJira(async ({ runWith }) => {
    assertEquals(await runWith(['DN-9999']), EXIT.runtimeError);
  });
});

Deno.test('usage errors exit 2 before any request is made', async () => {
  await withJira(async ({ runWith, requests }) => {
    assertEquals(await runWith(['not-a-key']), EXIT.usageError);
    assertEquals(requests, []);
  });
});

Deno.test('nothing planted in the working directory can redirect or relax a run', async () => {
  // The reason the whole config layout changed. An agent that can write in the project used to
  // have two routes: a `.env` supplying its own credentials, and a `.jira-fetch.yml` nearer than
  // the real one, which discovery would prefer and whose empty `filters` would allow everything.
  // Neither file is a source any more — the path is derived from the repository root alone.
  await withJira(async ({ requests, runWith }) => {
    const cwd = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(cwd, '.env'),
        'JIRA_BASE_URL=https://evil.example.com\nJIRA_API_TOKEN=stolen\n',
      );
      await Deno.writeTextFile(
        join(cwd, '.env.local'),
        'JIRA_BASE_URL=https://evil.example.com\n',
      );
      for (const name of ['.jira-fetch.yml', '.jira-fetch.conf.yml', 'jira-fetch.conf.yml']) {
        await Deno.writeTextFile(
          join(cwd, name),
          'project: /anywhere\nbaseUrl: https://evil.example.com\nemail: e@x.com\ntoken: stolen\n' +
            'filters: {}\n',
        );
      }

      // SUP-9 is excluded by the real config; if any planted file had been read, its empty
      // filters would have let it through.
      assertEquals(
        await runWith(['DN-1243', 'SUP-9'], { cwd, filters: { exclude: [{ project: ['SUP'] }] } }),
        EXIT.ok,
      );
      assert(requests.includes('GET /rest/api/3/issue/DN-1243'));
      assertFalse(requests.some((r) => r.includes('SUP-9')));
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });
});

Deno.test('an include rule the key cannot satisfy means the issue is never requested', async () => {
  await withJira(async ({ out, runWith, requests }) => {
    // The rule needs the payload for `labels`, but its `project` predicate already rules SUP-9
    // out — and every predicate in a rule must hold, so nothing in the payload could rescue it.
    const code = await runWith(['SUP-9'], {
      filters: { include: [{ project: ['DN'], labels: ['backend'] }] },
    });

    assertEquals(code, EXIT.allFiltered);
    // The proof this test exists for: --dry-run can show that nothing was written, but only the
    // request log can show that nothing was read. Under the MCP server this is the difference
    // between denying a ticket and reading it with the user's credentials before denying it.
    assertEquals(requests.filter((r) => r.includes('SUP-9')), []);
    assertEquals((await Array.fromAsync(Deno.readDir(out))).map((e) => e.name), []);
  });
});

Deno.test('a filter naming an unknown field fails as a config error, before any issue', async () => {
  await withJira(async ({ runWith, requests }) => {
    const code = await runWith(['DN-1243'], {
      filters: { exclude: [{ field: { Teem: ['Platform'] } }] },
    });

    // Exit 2, not 1: the fix is in the config file. It used to be a warning, and the run went on
    // with an exclude rule that excluded nothing.
    assertEquals(code, EXIT.usageError);
    assertFalse(requests.some((r) => r.includes('DN-1243')));
  });
});

Deno.test('config-file prints the derived path and writes nothing', async () => {
  const projectRoot = await Deno.makeTempDir();
  const configDir = await Deno.makeTempDir();
  const cacheDir = await Deno.makeTempDir();
  const stdout: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => void stdout.push(args.join(' '));
  try {
    // Exit 0 with the file absent is the point: `$EDITOR "$(jira-fetch config-file)"` has to work
    // the first time, before there is anything to edit.
    assertEquals(await run(['config-file'], { projectRoot, configDir, cacheDir }), EXIT.ok);
    assertEquals(stdout.length, 1);
    assertEquals(stdout[0], configPathFor(projectRoot, configDir));
    assertEquals(await Array.fromAsync(Deno.readDir(configDir)), []);
  } finally {
    console.log = originalLog;
    await Promise.all(
      [projectRoot, configDir, cacheDir].map((dir) => Deno.remove(dir, { recursive: true })),
    );
  }
});

Deno.test('config-file needs no valid configuration, only a repository', async () => {
  await withJira(async ({ projectRoot, runWith, stdout }) => {
    // A run that would otherwise fail — the config it prints may be missing or broken — still
    // answers the one question this subcommand exists for.
    assertEquals(await runWith(['config-file']), EXIT.ok);
    assert(stdout.some((line) => line.includes(basename(projectRoot))));
  });
});

Deno.test('config-file refuses arguments that name work it will not do', async () => {
  // All three pinned even though these runs return before any of them is read. The rule is about
  // entry points, not about the current dispatch order: a later reorder would unseal them silently.
  const deps = { projectRoot: '/tmp/x', configDir: '/tmp/y', cacheDir: '/tmp/z' };
  assertEquals(await run(['config-file', 'DN-1'], deps), EXIT.usageError);
  assertEquals(await run(['config-file', '--jql', 'x'], deps), EXIT.usageError);
  assertEquals(await run(['config-file', '--dry-run'], deps), EXIT.usageError);
});

Deno.test('outside a git repository the error says so rather than naming a missing file', async () => {
  const outside = await Deno.makeTempDir();
  try {
    assertEquals(
      await run(['config-file'], { cwd: outside, configDir: outside, cacheDir: outside }),
      EXIT.usageError,
    );
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test('setup refuses without a terminal, and says where the file would be', async () => {
  // The barrier that keeps this command — the one that writes credentials and can relax filters —
  // off the ordinary agent path: a Bash tool has no controlling terminal. Not a boundary; anything
  // that can allocate a pty gets past it.
  const projectRoot = await Deno.makeTempDir();
  const configDir = await Deno.makeTempDir();
  const cacheDir = await Deno.makeTempDir();
  try {
    assertEquals(await run(['setup'], { projectRoot, configDir, cacheDir }), EXIT.usageError);
    assertEquals(await Array.fromAsync(Deno.readDir(configDir)), []);
  } finally {
    await Promise.all(
      [projectRoot, configDir, cacheDir].map((dir) => Deno.remove(dir, { recursive: true })),
    );
  }
});

Deno.test('setup refuses arguments that name work it will not do', async () => {
  const deps = { projectRoot: '/tmp/x', configDir: '/tmp/y', cacheDir: '/tmp/z' };
  assertEquals(await run(['setup', 'DN-1'], deps), EXIT.usageError);
  assertEquals(await run(['setup', '--jql', 'x'], deps), EXIT.usageError);
});

// --- jira-fetch cache ------------------------------------------------------------------------

/** Which resources a cache directory has entries for. */
const cachedFiles = async (dir: string): Promise<string[]> => {
  const names: string[] = [];
  for await (const item of Deno.readDir(dir)) names.push(item.name);
  return names.sort();
};

Deno.test('cache names its projects and reads what they contain', async () => {
  await withJira(async ({ runWith, cacheDir, requests }) => {
    assertEquals(await runWith(['cache', 'DN']), EXIT.ok);

    const files = await cachedFiles(cacheDir);
    assert(files.includes('manifest.json'), files.join(', '));
    assert(files.includes('fields.json'));
    assert(files.includes('DN-issueTypes.json'));
    assert(files.includes('DN-sprints.json'));
    // Site-wide resources are read once, not once per project.
    assertEquals(requests.filter((r) => r.endsWith('/rest/api/3/label')).length, 1);
  });
});

Deno.test('cache reuses the projects it was given last time', async () => {
  await withJira(async ({ runWith, cacheDir }) => {
    await runWith(['cache', 'DN', 'SUP']);
    // No keys this time: the manifest is what remembers them, so nothing has to be retyped.
    assertEquals(await runWith(['cache']), EXIT.ok);
    const files = await cachedFiles(cacheDir);
    assert(files.includes('DN-components.json'));
    assert(files.includes('SUP-components.json'));
  });
});

Deno.test('cache with nothing chosen says what to do rather than reading everything', async () => {
  await withJira(async ({ runWith, requests }) => {
    // Reading every project a token can see would be hundreds of requests nobody asked for.
    assertEquals(await runWith(['cache']), EXIT.usageError);
    assertFalse(requests.some((r) => r.includes('/rest/api/3/label')));
  });
});

Deno.test('cache --show reads nothing and reports what is there', async () => {
  await withJira(async ({ runWith, requests, stdout, cacheDir }) => {
    await runWith(['cache', 'DN']);
    const before = requests.length;
    assertEquals(await runWith(['cache', '--show']), EXIT.ok);
    assertEquals(requests.length, before, '--show must not touch the site');
    // stdout carries the directory alone, so it can be used in a shell substitution.
    assert(stdout.includes(cacheDir), stdout.join(' | '));
  });
});

Deno.test('cache --clear removes the directory and says so', async () => {
  await withJira(async ({ runWith, cacheDir }) => {
    await runWith(['cache', 'DN']);
    assert((await cachedFiles(cacheDir)).length > 0);
    assertEquals(await runWith(['cache', '--clear']), EXIT.ok);
    await assertRejects(() => Deno.stat(cacheDir), Deno.errors.NotFound);
  });
});

Deno.test('a resource this token cannot read is cached as unreadable, not as empty', async () => {
  await withJira(async ({ runWith, cacheDir }) => {
    assertEquals(await runWith(['cache', 'DN']), EXIT.ok);
    const labels = JSON.parse(await Deno.readTextFile(join(cacheDir, 'labels.json')));
    assertEquals(labels.state, 'partial');
    assertEquals(labels.notes[0].code, 'forbidden');
    assertEquals(labels.data, []);
  }, { forbid: ['/rest/api/3/label'] });
});

Deno.test('a project without Create Issues still caches everything else', async () => {
  await withJira(async ({ runWith, cacheDir }) => {
    // The fake refuses createmeta for SUP, which is the ordinary case for a token that can browse
    // a project but not create in it.
    assertEquals(await runWith(['cache', 'SUP']), EXIT.ok);
    const options = JSON.parse(await Deno.readTextFile(join(cacheDir, 'SUP-fieldOptions.json')));
    assertEquals(options.state, 'partial');
    const components = JSON.parse(await Deno.readTextFile(join(cacheDir, 'SUP-components.json')));
    assertEquals(components.state, 'ok');
  });
});

Deno.test('a site without Jira Software caches sprints as unavailable', async () => {
  await withJira(async ({ runWith, cacheDir }) => {
    assertEquals(await runWith(['cache', 'DN']), EXIT.ok);
    const boards = JSON.parse(await Deno.readTextFile(join(cacheDir, 'DN-boards.json')));
    assertEquals(boards.notes[0].code, 'agileUnavailable');
    const sprints = JSON.parse(await Deno.readTextFile(join(cacheDir, 'DN-sprints.json')));
    assertEquals(sprints.notes[0].code, 'dependencyMissing');
  }, { noAgile: true });
});

Deno.test('a site that hides email addresses says so rather than looking empty', async () => {
  await withJira(async ({ runWith, cacheDir }) => {
    await runWith(['cache', 'DN']);
    const users = JSON.parse(await Deno.readTextFile(join(cacheDir, 'DN-users.json')));
    assertEquals(users.notes[0].code, 'emailsHidden');
    assertEquals(users.data.length, 1);
    assertEquals(users.data[0].accountId, '5f1a2b');
  }, { hideEmails: true });
});

Deno.test('the field list is read once across two runs, not once per run', async () => {
  await withJira(async ({ runWith, requests }) => {
    const filters = { include: [{ field: { Team: ['Platform'] } }] };
    await runWith(['DN-1243'], { filters });
    await runWith(['DN-1243'], { filters });
    // This is the assertion that catches the cached field source being quietly disconnected — and
    // the one that would silently pass on a leftover entry if `cacheDir` were not pinned.
    assertEquals(requests.filter((r) => r.endsWith('/rest/api/3/field')).length, 1);
  });
});
