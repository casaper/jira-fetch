/** Reading and writing cache entries.
 *
 * The one rule worth stating up front: **nothing here throws for a bad entry.** An absent,
 * unreadable, corrupt, mispinned or stale file is a `MissReason`, and every miss refetches live. A
 * cache that could turn a working run red would be a liability rather than a saving, and this
 * module is where that property is kept.
 */

import { join } from '@std/path';
import type { z } from 'zod';
import { DIR_MODE, FILE_MODE, repairMode } from '../util/modes.ts';
import {
  isStale,
  MANIFEST_FILE,
  type MissReason,
  pinMismatch,
  type Resource,
  resourceFileName,
  RESOURCES,
} from './policy.ts';
import {
  AnyEntryEnvelope,
  type CacheManifest,
  CacheManifest as ManifestSchema,
  type CacheNote,
  type CacheState,
  SCHEMA_VERSION,
} from './schema.ts';

/** The fields every entry carries, whatever its payload. */
type Pinned = { project: string; baseUrl: string; fetchedAt: number; resource: string };

export type ReadResult<E> = { hit: E; miss?: undefined } | { hit?: undefined; miss: MissReason };

/** Where an entry lives, and what it must be pinned to. */
export type EntryRef = {
  cacheDir: string;
  resource: Resource;
  /** Required for a project-scoped resource, refused for a site-wide one. */
  projectKey?: string;
  /** The canonicalised project root. */
  project: string;
  baseUrl: string;
};

const readJson = async (path: string): Promise<{ data: unknown } | { miss: MissReason }> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    return { miss: cause instanceof Deno.errors.NotFound ? 'absent' : 'unreadable' };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { miss: 'notJson' };
  }
};

/**
 * One entry, if there is a usable one.
 *
 * The order of the checks is the order they get cheaper to be wrong about: parse, then version and
 * shape via the schema, then the pins, then age. A caller only ever needs to know that it missed,
 * but the reason is returned because it is what the report prints and what a test asserts.
 */
export const readEntry = async <E extends Pinned>(
  schema: z.ZodType<E>,
  ref: EntryRef,
  now: number,
): Promise<ReadResult<E>> => {
  const path = join(ref.cacheDir, resourceFileName(ref.resource, ref.projectKey));
  const read = await readJson(path);
  if ('miss' in read) return { miss: read.miss };

  const parsed = schema.safeParse(read.data);
  if (!parsed.success) return { miss: 'invalid' };
  const entry = parsed.data;

  // A file swapped for another parses fine when two resources share a payload shape, so the
  // resource is pinned too rather than trusted from the filename.
  if (entry.resource !== ref.resource) return { miss: 'invalid' };

  const mismatch = pinMismatch(entry, { project: ref.project, baseUrl: ref.baseUrl });
  if (mismatch) return { miss: mismatch };

  if (isStale(entry.fetchedAt, RESOURCES[ref.resource].ttlMs, now)) return { miss: 'stale' };
  return { hit: entry };
};

/** Creates the cache directory with the mode applied at creation, and repairs one that already
 * existed. A chmod after the write would leave a window in which a file holding a project's whole
 * user list — names and, where the site publishes them, email addresses — is world-readable. */
const ensureDir = async (cacheDir: string): Promise<void> => {
  await Deno.mkdir(cacheDir, { recursive: true, mode: DIR_MODE });
  await repairMode(cacheDir, DIR_MODE);
};

/** Writes `json` to `name` inside `cacheDir` without ever leaving a half-written file in place:
 * a crash mid-write loses the new entry rather than corrupting the old one. */
const writeAtomic = async (cacheDir: string, name: string, json: string): Promise<void> => {
  await ensureDir(cacheDir);
  const tmp = join(cacheDir, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(tmp, `${json}\n`, { mode: FILE_MODE });
    await repairMode(tmp, FILE_MODE);
    await Deno.rename(tmp, join(cacheDir, name));
  } catch (cause) {
    await Deno.remove(tmp).catch(() => {});
    throw cause;
  }
};

export type WriteEntry = {
  state: CacheState;
  notes: CacheNote[];
  data: unknown;
};

/**
 * Writes one entry, refusing to record a resource as fresh and empty.
 *
 * That downgrade lives here rather than in each fetcher because it is the property the whole
 * design rests on: for a resource where nothing is implausible, a successful request that returned
 * nothing is indistinguishable from a broken token, and writing it as `ok` would be a cache that
 * passes having verified nothing. So it becomes `partial` with a `noneVisible` note, and the report
 * says so.
 *
 * Validated against the same schema `readEntry` uses, so this cannot write something unreadable.
 */
export const writeEntry = async <E extends Pinned>(
  schema: z.ZodType<E>,
  ref: EntryRef,
  now: number,
  { state, notes, data }: WriteEntry,
): Promise<E> => {
  const empty = Array.isArray(data) && data.length === 0;
  const downgrade = empty && state === 'ok' && !RESOURCES[ref.resource].emptyIsOk;

  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    project: ref.project,
    baseUrl: ref.baseUrl,
    resource: ref.resource,
    fetchedAt: now,
    state: downgrade ? 'partial' : state,
    notes: downgrade ? [...notes, { code: 'noneVisible' as const }] : notes,
    data,
  };

  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`refusing to cache an invalid ${ref.resource} entry: ${parsed.error.message}`);
  }

  await writeAtomic(
    ref.cacheDir,
    resourceFileName(ref.resource, ref.projectKey),
    JSON.stringify(parsed.data, null, 2),
  );
  return parsed.data;
};

/** The manifest, if it is this project's and this site's. Owned by the `cache` command alone:
 * nothing on the fetch path reads or writes it, so a run that only needs the field list cannot
 * clobber a project selection. */
export const readManifest = async (
  cacheDir: string,
  expected: { project: string; baseUrl: string },
): Promise<ReadResult<CacheManifest>> => {
  const read = await readJson(join(cacheDir, MANIFEST_FILE));
  if ('miss' in read) return { miss: read.miss };
  const parsed = ManifestSchema.safeParse(read.data);
  if (!parsed.success) return { miss: 'invalid' };
  const mismatch = pinMismatch(parsed.data, expected);
  return mismatch ? { miss: mismatch } : { hit: parsed.data };
};

export const writeManifest = async (
  cacheDir: string,
  manifest: CacheManifest,
): Promise<void> => {
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`refusing to write an invalid manifest: ${parsed.error.message}`);
  }
  await writeAtomic(cacheDir, MANIFEST_FILE, JSON.stringify(parsed.data, null, 2));
};

/**
 * What is in one file, without interpreting its payload — for reporting rather than for use.
 *
 * Deliberately does not check the TTL: `--show` wants to say how old something is, and treating a
 * stale entry as absent would hide exactly what the reader asked about.
 */
export const peekEntry = async (
  cacheDir: string,
  resource: Resource,
  projectKey?: string,
): Promise<AnyEntryEnvelope | undefined> => {
  const read = await readJson(join(cacheDir, resourceFileName(resource, projectKey)));
  if ('miss' in read) return undefined;
  const parsed = AnyEntryEnvelope.safeParse(read.data);
  return parsed.success ? parsed.data : undefined;
};

/** Removes a project's cache directory. Absent is success: the point is that it is gone. */
export const clearCache = async (cacheDir: string): Promise<boolean> => {
  try {
    await Deno.remove(cacheDir, { recursive: true });
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
};
