/** `prompts.ts` itself cannot be tested — it is the module that talks to a terminal. What can be
 * tested is the rule it exists to enforce, which is the kind of structural claim that rots quietly:
 * one convenient import somewhere else and the library is spread across the tree again. */

import { assert, assertEquals } from '@std/assert';
import { fromFileUrl, join, relative, SEPARATOR } from '@std/path';

const SRC = fromFileUrl(new URL('../', import.meta.url));

/** A path relative to `src/`, always with forward slashes, so an assertion reads the same on every
 * host. Comparing raw paths here would fail on Windows for a reason these tests are not about. */
const named = (path: string): string => relative(SRC, path).replaceAll(SEPARATOR, '/');

/** Every `.ts` file under `src/`, so a new directory is covered without anyone remembering. */
const sources = async (): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const item of Deno.readDir(dir)) {
      const path = join(dir, item.name);
      if (item.isDirectory) await walk(path);
      else if (item.name.endsWith('.ts')) found.push(path);
    }
  };
  await walk(SRC);
  return found;
};

Deno.test('only prompts.ts imports the prompt library', async () => {
  const importers: string[] = [];
  for (const path of await sources()) {
    const text = await Deno.readTextFile(path);
    // An import, not a mention: `form.ts` says in prose that it has no cliffy import, and that
    // sentence should not fail this.
    if (/^\s*import[^;]*'@cliffy\//m.test(text)) importers.push(named(path));
  }
  assertEquals(importers, ['setup/prompts.ts']);
});

Deno.test('the pure setup modules reach no terminal and no console', async () => {
  // The split is what keeps the untestable surface small. A `console.log` in one of these would
  // mean output that no test can see and no caller can redirect — which under `jira-fetch mcp`
  // is a corrupted protocol stream.
  const pure = [
    'form.ts',
    'filter_draft.ts',
    'filter_render.ts',
    'metadata_view.ts',
    'verify.ts',
  ];
  for (const name of pure) {
    const text = await Deno.readTextFile(join(SRC, 'setup', name));
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!code.includes('console.'), `${name} writes to the console`);
    assert(!code.includes('Deno.stdin'), `${name} reads the terminal`);
    assert(!/from '\.\/prompts\.ts'/.test(code), `${name} imports the prompt layer`);
  }
});
