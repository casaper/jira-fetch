/** End-to-end coverage against a fake Jira served on localhost: no credentials, no network.
 * This is what exercises the wiring in src/main.ts — argument parsing, config resolution, the
 * filter stages, asset download and the file layout — in one pass. */

import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';
import { EXIT, run } from '../src/main.ts';
import { configPathFor } from '../src/config/location.ts';
import type { FiltersConfig } from '../src/config/schema.ts';
import { stringify as stringifyYaml } from '@std/yaml';
import { startFakeJira } from './fake_jira.ts';

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
  requests: string[];
  runWith: (args: string[], options?: RunOptions) => Promise<number>;
  stdout: string[];
}

async function withJira(fn: (h: Harness) => Promise<void>): Promise<void> {
  const fake = await startFakeJira();
  const out = await Deno.makeTempDir();
  const projectRoot = await Deno.makeTempDir();
  const configDir = await Deno.makeTempDir();
  const originalLog = console.log;
  const stdout: string[] = [];
  console.log = (...args: unknown[]) => void stdout.push(args.join(' '));

  try {
    await fn({
      origin: fake.origin,
      out,
      projectRoot,
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
        // Pinning both seals the run. Without them the walk for `.git` and the derived path in
        // $HOME would resolve this very repository's real configuration, token included — and
        // nothing asserts the token, so the leak would not turn the suite red.
        return await run([...args, '--out', out], { projectRoot, configDir, cwd });
      },
    });
  } finally {
    console.log = originalLog;
    await fake.stop();
    await Promise.all(
      [out, projectRoot, configDir].map((dir) => Deno.remove(dir, { recursive: true })),
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
