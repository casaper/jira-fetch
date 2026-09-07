/** The cache's blast radius, as an assertion rather than a paragraph.
 *
 * CLAUDE.md states it: only `src/cache/fields.ts` touches the cache on the fetch path, so the
 * surface an editable cache can act through is one file. That is what makes trusting the cache in
 * `fetch` and `mcp` an accepted cost rather than an open question — and nothing enforced it, so the
 * next person to cache "just one more thing" on the fetch path would have widened it silently.
 *
 * The same idiom as `src/setup/prompts_test.ts`: a structural claim, pinned by walking the tree,
 * because it is exactly the kind of rule that rots without anybody noticing.
 */

import { assert, assertEquals } from '@std/assert';
import { fromFileUrl, join, relative, SEPARATOR } from '@std/path';

const SRC = fromFileUrl(new URL('../', import.meta.url));

/** A path relative to `src/`, always forward-slashed, so an assertion reads the same on every
 * host — the Windows lesson from `configPathFor`. */
const named = (path: string): string => relative(SRC, path).replaceAll(SEPARATOR, '/');

/** Every non-test `.ts` under `src/`, outside `src/cache/` itself.
 *
 * Tests are excluded on purpose: one that reads an entry to assert what the cache did is not the
 * fetch path, and forbidding it would only push the assertions somewhere less honest. */
const sources = async (): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const item of Deno.readDir(dir)) {
      const path = join(dir, item.name);
      if (item.isDirectory) {
        if (item.name !== 'cache') await walk(path);
      } else if (item.name.endsWith('.ts') && !item.name.endsWith('_test.ts')) {
        found.push(path);
      }
    }
  };
  await walk(SRC);
  return found;
};

/** An `import` of a module under `cache/` — not a mention of the word, which several files make in
 * prose, and not a `deno.json` path. Multi-line import lists are one statement, so `[^;]` spanning
 * newlines is deliberate. */
const IMPORTS_CACHE = /^\s*import[^;]*['"](?:\.\.?\/)+cache\/[^'"]+['"]/m;

Deno.test('only main.ts and the menus reach into the cache', async () => {
  const importers: string[] = [];
  for (const path of await sources()) {
    if (IMPORTS_CACHE.test(await Deno.readTextFile(path))) importers.push(named(path));
  }
  importers.sort();

  // `src/setup/` is the menus, where reading the cache is the whole point and a person is present.
  // `main.ts` is composition. Nothing else — in particular nothing under `fetch/`, `mcp/`,
  // `filter/`, `jira/`, `document/` or `assets/`, which is what "the fetch path" means here.
  assertEquals(importers, [
    'main.ts',
    'setup/ensure_cache.ts',
    'setup/filter_tui.ts',
    'setup/metadata.ts',
  ]);
});

Deno.test('the fetch path gets the field list and nothing else from the cache', async () => {
  // `createSession` defaults its field source to the live client, and only `main.ts` swaps in the
  // cached one. So this list is the whole of what an entry can influence during a fetch: the paths,
  // the `cache` subcommand itself, and the field catalogue.
  const main = await Deno.readTextFile(join(SRC, 'main.ts'));
  const imported = [...main.matchAll(/from '\.\/cache\/([a-z_]+)\.ts'/g)].map((match) => match[1]);
  assertEquals(imported.sort(), ['command', 'fields', 'location']);

  // And the resolved name-to-id map is not among what is cached. `fields.ts` caching `{id, name}`
  // is what keeps `makeFieldResolver` rebuilding its maps — and so keeps the ambiguity check
  // firing — on every run. CLAUDE.md calls this out as the optimisation not to make.
  const fields = await Deno.readTextFile(join(SRC, 'cache', 'fields.ts'));
  assert(
    !/byName|byId|resolve\w*Map/.test(fields),
    'fields.ts looks like it caches a resolved field map; see CLAUDE.md',
  );
});
