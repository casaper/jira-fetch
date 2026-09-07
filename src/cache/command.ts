/** `jira-fetch cache`: the four things it can be asked to do.
 *
 * Thin on purpose — the policy is in `policy.ts`, the degradation in `metadata.ts`, the wording in
 * `report.ts`. What is left here is deciding which projects a run covers and turning the outcome
 * into an exit code.
 */

import type { CacheAction } from '../cli/args.ts';
import { type MetadataClient, type MetadataDeps, refreshAll } from './metadata.ts';
import { allResourceRefs } from './policy.ts';
import { formatReport, formatShow, summarise } from './report.ts';
import { SCHEMA_VERSION } from './schema.ts';
import { clearCache, peekEntry, readManifest, writeManifest } from './store.ts';

export type CacheCommandDeps = {
  action: CacheAction;
  /** Project keys named on the command line. Empty means "whichever were chosen last". */
  projects: string[];
  cacheDir: string;
  /** The canonicalised project root. */
  project: string;
  baseUrl: string;
  client: MetadataClient;
  now: () => number;
  /** stdout. */
  out: (line: string) => void;
  /** stderr — where the report goes, so stdout stays pipeable. */
  note: (line: string) => void;
};

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

/**
 * Which projects this run covers.
 *
 * Named on the line wins, so `jira-fetch cache DN SUP` both chooses and reads. Otherwise the
 * manifest's selection is reused. With neither, there is nothing to do and saying so beats reading
 * every project the token can see — a large site would be hundreds of requests nobody asked for.
 */
const chooseProjects = async (deps: CacheCommandDeps): Promise<string[] | undefined> => {
  if (deps.projects.length > 0) return deps.projects;
  const manifest = await readManifest(deps.cacheDir, {
    project: deps.project,
    baseUrl: deps.baseUrl,
  });
  return manifest.hit?.projects;
};

const show = async (deps: CacheCommandDeps): Promise<number> => {
  deps.out(deps.cacheDir);
  const manifest = await readManifest(deps.cacheDir, {
    project: deps.project,
    baseUrl: deps.baseUrl,
  });
  const projects = manifest.hit?.projects ?? [];
  deps.note(
    projects.length > 0
      ? `\nprojects: ${projects.join(', ')}`
      : '\nno projects chosen yet — run jira-fetch cache <PROJECT-KEY>...',
  );

  const entries = [];
  for (const ref of allResourceRefs(projects)) {
    const found = await peekEntry(deps.cacheDir, ref.resource, ref.projectKey);
    entries.push({
      resource: ref.resource,
      projectKey: ref.projectKey,
      fetchedAt: found?.fetchedAt,
      state: found?.state,
      notes: found?.notes,
      count: Array.isArray(found?.data) ? found.data.length : undefined,
    });
  }
  for (const line of formatShow(entries, deps.now())) deps.note(line);
  return EXIT_OK;
};

const clear = async (deps: CacheCommandDeps): Promise<number> => {
  const removed = await clearCache(deps.cacheDir);
  deps.note(removed ? `removed ${deps.cacheDir}` : `nothing cached at ${deps.cacheDir}`);
  return EXIT_OK;
};

const refresh = async (deps: CacheCommandDeps): Promise<number> => {
  const projects = await chooseProjects(deps);
  if (projects === undefined || projects.length === 0) {
    deps.note(
      'no projects chosen yet. Name the ones you filter on, for example:\n' +
        '  jira-fetch cache DN SUP\n' +
        'Run jira-fetch cache --show to see what is cached.',
    );
    return EXIT_USAGE;
  }

  const metadata: MetadataDeps = {
    client: deps.client,
    cacheDir: deps.cacheDir,
    project: deps.project,
    baseUrl: deps.baseUrl,
    now: deps.now,
    log: deps.note,
  };

  deps.note(`reading ${deps.baseUrl}`);
  const report = await refreshAll(metadata, projects, { force: deps.action === 'refresh' });

  // Written after the read, so a refresh that could not reach the site does not leave a selection
  // behind that nothing was ever read for.
  await writeManifest(deps.cacheDir, {
    schemaVersion: SCHEMA_VERSION,
    project: deps.project,
    baseUrl: deps.baseUrl,
    projects,
    updatedAt: deps.now(),
  });

  for (const line of formatReport(report.outcomes)) deps.note(line);
  deps.note(summarise(report.outcomes));
  deps.out(deps.cacheDir);

  // Every resource failing is a broken site or a wrong credential rather than a set of permissions
  // this token happens not to have, so it is worth a non-zero exit. Anything less is a partial
  // cache, which is the normal case and still useful.
  const usable = report.outcomes.filter((outcome) => outcome.state === 'ok').length;
  return usable === 0 ? EXIT_RUNTIME : EXIT_OK;
};

export const runCache = (deps: CacheCommandDeps): Promise<number> => {
  switch (deps.action) {
    case 'show':
      return show(deps);
    case 'clear':
      return clear(deps);
    case 'choose':
    case 'refresh':
      return refresh(deps);
  }
};
