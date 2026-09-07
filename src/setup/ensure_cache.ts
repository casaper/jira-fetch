/** Bringing the cache up to date before a menu offers what is in it.
 *
 * `jira-fetch filters` is only better than typing values from memory if there is something to pick
 * from, so it fills the cache itself rather than telling the reader to go and run another command.
 * That was the intent from the start; this module is where it happens.
 *
 * It prompts for nothing. The project selection arrives as a callback, so the whole sequence —
 * refresh the site, choose the projects, refresh those — is drivable from a test against the fake
 * Jira, which is the only place a request count can be asserted. `filter_tui.ts` supplies the
 * screen; this supplies the order.
 */

import { ProjectsEntry } from '../cache/schema.ts';
import type { CachedProject } from '../cache/schema.ts';
import { readEntry, readManifest, writeManifest } from '../cache/store.ts';
import type { EntryRef, PinnedEntry } from '../cache/store.ts';
import { refreshProject, refreshSite } from '../cache/metadata.ts';
import type { MetadataClient, ResourceOutcome } from '../cache/metadata.ts';
import { SCHEMA_VERSION } from '../cache/schema.ts';

/** A project the token can see, as a menu needs it. */
export type ProjectChoice = {
  key: string;
  name?: string;
};

export type EnsureCacheDeps = {
  client: MetadataClient;
  cacheDir: string;
  /** The canonicalised project root, pinned into every entry. */
  project: string;
  baseUrl: string;
  now: () => number;
  log: (message: string) => void;
  /**
   * Which Jira projects this cache covers.
   *
   * Called with what the site offers and what was chosen last. Returning the current selection
   * unchanged is how a caller declines to ask. An empty offer is not an error — a token that may
   * not list projects can still name one — so a caller may answer with keys that are not in it.
   */
  chooseProjects: (offer: ProjectChoice[], current: string[]) => Promise<string[]>;
  /** Refetch everything, past its TTL. */
  force?: boolean;
};

export type EnsureCacheResult = {
  /** What the cache now covers, and what was written to the manifest. */
  projectKeys: string[];
  outcomes: ResourceOutcome[];
  /**
   * Why nothing could be refreshed, when that is the case.
   *
   * A broken cache directory is the only thing that gets here: `src/cache/metadata.ts` turns every
   * Jira failure into a note instead of a throw. The menu carries on with whatever is already on
   * disk, because a cache that cannot be written is a reason to type values by hand and not a
   * reason to refuse to edit filters at all.
   */
  failure?: string;
};

/** The projects on disk, for the picker to offer. Read straight from the entry rather than through
 * `loadMetadataView`, which would read all fourteen files to answer one question. */
const cachedProjects = async (deps: EnsureCacheDeps): Promise<ProjectChoice[]> => {
  const ref: EntryRef = {
    cacheDir: deps.cacheDir,
    resource: 'projects',
    project: deps.project,
    baseUrl: deps.baseUrl,
  };
  const found = await readEntry<PinnedEntry<CachedProject[]>>(ProjectsEntry, ref, deps.now());
  return (found.hit?.data ?? []).map((project) => ({
    key: project.key,
    ...(project.name === undefined ? {} : { name: project.name }),
  }));
};

/**
 * Refresh what is stale, ask which projects, refresh those.
 *
 * The order is forced rather than chosen: the project picker offers the cached project list, so the
 * site-wide resources have to be read before there is anything to pick from — and on a first run
 * there are no project keys, so nothing project-scoped could be refreshed before the answer.
 *
 * Nothing is refetched while it is still inside its TTL. `ensure` in `src/cache/metadata.ts`
 * decides that, so a menu opened twice in a minute costs no requests the second time.
 */
export const ensureCache = async (deps: EnsureCacheDeps): Promise<EnsureCacheResult> => {
  const manifest = await readManifest(deps.cacheDir, {
    project: deps.project,
    baseUrl: deps.baseUrl,
  });
  const current = manifest.hit?.projects ?? [];
  const options = deps.force === undefined ? {} : { force: deps.force };

  try {
    const outcomes = await refreshSite(deps, options);

    const chosen = await deps.chooseProjects(await cachedProjects(deps), current);
    // Written even when it has not changed only if there was no manifest at all: `updatedAt` is
    // informational, and a needless write of a file two commands read is not worth it.
    const changed = chosen.length !== current.length ||
      chosen.some((key, index) => key !== current[index]);
    if (changed || manifest.hit === undefined) {
      await writeManifest(deps.cacheDir, {
        schemaVersion: SCHEMA_VERSION,
        project: deps.project,
        baseUrl: deps.baseUrl,
        projects: chosen,
        updatedAt: deps.now(),
      });
    }

    for (const key of chosen) {
      outcomes.push(...await refreshProject(deps, key, options));
    }
    return { projectKeys: chosen, outcomes };
  } catch (cause) {
    return {
      projectKeys: current,
      outcomes: [],
      failure: (cause as Error).message,
    };
  }
};
