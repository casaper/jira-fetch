/** The field catalogue, served from the cache.
 *
 * The only module on the fetch path that touches the cache, and deliberately the only one: the
 * field catalogue is the sole thing `fetch` and `mcp` read from here, so the surface where a
 * writable file participates in a run is one file.
 *
 * What is cached is the **raw catalogue**, never a resolved name-to-id map.
 * `makeFieldResolver` rebuilds its own maps from this list on every run, which keeps the ambiguity
 * check live: two entries sharing a display name still raise a `ConfigError` rather than one of
 * them being picked silently. An edit to a cache entry can therefore add or remove fields, but it
 * cannot quietly redirect a `field:` predicate at a different field.
 */

import type { FieldCatalogEntry, FieldSource } from '../fetch/session.ts';
import type { JiraClient } from '../jira/client.ts';
import { FieldsEntry } from './schema.ts';
import { type EntryRef, readEntry, writeEntry } from './store.ts';

export type CachedFieldsDeps = {
  client: Pick<JiraClient, 'getFields'>;
  cacheDir: string;
  /** The canonicalised project root. */
  project: string;
  baseUrl: string;
  now: () => number;
  log: (message: string) => void;
};

/** Only what resolution reads. Not `clauseNames`, `schema` or `scope`: a smaller entry, and
 * nothing about a field's *configuration* reaches disk. */
const narrow = (
  fields: Array<{ id: string; key?: string; name: string }>,
): FieldCatalogEntry[] => fields.map(({ id, key, name }) => ({ id, key, name }));

export const cachedFieldSource = (deps: CachedFieldsDeps): FieldSource => {
  const ref: EntryRef = {
    cacheDir: deps.cacheDir,
    resource: 'fields',
    project: deps.project,
    baseUrl: deps.baseUrl,
  };

  /** Writing is best effort. A read-only home directory, a full disk or a directory somebody
   * chmod'ed is a reason to be slower, not a reason to fail a fetch. */
  const remember = async (entries: FieldCatalogEntry[]): Promise<void> => {
    try {
      await writeEntry(FieldsEntry, ref, deps.now(), { state: 'ok', notes: [], data: entries });
    } catch (cause) {
      deps.log(`  could not cache the field list: ${(cause as Error).message}`);
    }
  };

  const live = async (): Promise<FieldCatalogEntry[]> => {
    const entries = narrow(await deps.client.getFields());
    await remember(entries);
    return entries;
  };

  return {
    get: async () => {
      const cached = await readEntry(FieldsEntry, ref, deps.now());
      if (cached.hit) return cached.hit.data;
      deps.log(`  field list: ${cached.miss}`);
      return await live();
    },
    refresh: live,
  };
};
