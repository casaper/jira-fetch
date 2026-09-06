/** Where a project's configuration lives — derived, never discovered and never named.
 *
 * The path is a pure function of the project root, and the project root is the git repository the
 * working directory sits in. Nothing here can be pointed somewhere else: there is no flag, no
 * environment variable and no search order, which is the whole point. An agent that can write
 * anywhere in a project still cannot make this function return a file it authored.
 *
 * The functions below are pure and synchronous apart from `findProjectRoot`, which has to touch the
 * filesystem. Keeping them that way is what lets the slug rules be tested exhaustively.
 */

import { dirname, join, resolve } from '@std/path';
import { ConfigError } from './errors.ts';

/** Every directory from `startDir` up to the filesystem root, nearest first. */
export const ancestors = (startDir: string): string[] => {
  const out: string[] = [];
  let dir = resolve(startDir);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
};

/** Reads one environment variable. A parameter rather than an ambient `Deno.env` call, so a test
 * can pin the home directory without touching the process it runs in. */
export type EnvReader = (name: string) => string | undefined;

const readEnv: EnvReader = (name) => Deno.env.get(name);

/**
 * The user's jira-fetch configuration directory.
 *
 * `%APPDATA%` is also the answer to "what is the Windows equivalent of `chmod 700`": everything
 * under `C:\Users\<user>\AppData` already inherits an ACL granting only that user, `SYSTEM` and
 * `Administrators`. So Windows has the property natively and needs no `icacls` — which matters,
 * because shelling out would mean `--allow-run` baked into every binary including the MCP server.
 *
 * `%LOCALAPPDATA%` would avoid roaming-profile sync, which is arguably better for a file holding a
 * token; `%APPDATA%` is what almost every CLI uses, and consistency wins here.
 */
export const userConfigDir = (
  env: EnvReader = readEnv,
  os: typeof Deno.build.os = Deno.build.os,
): string => {
  if (os === 'windows') {
    const appData = env('APPDATA');
    if (appData) return join(appData, 'jira-fetch');
    const profile = env('USERPROFILE');
    if (profile) return join(profile, 'AppData', 'Roaming', 'jira-fetch');
    throw new ConfigError('cannot locate the configuration directory: %APPDATA% is not set');
  }
  const home = env('HOME');
  if (home) return join(home, '.config', 'jira-fetch');
  throw new ConfigError('cannot locate the configuration directory: $HOME is not set');
};

/**
 * The git repository `startDir` belongs to.
 *
 * Deliberately a walk for a `.git` entry rather than `git rev-parse --show-toplevel`: running git
 * needs `--allow-run`, and `deno compile` bakes permissions in at build time with no per-subcommand
 * grant, so the MCP server binary would carry the ability to spawn processes. The walk agrees with
 * `rev-parse` in every ordinary case — `.git` is matched as a **file** too, which is how worktrees
 * and submodules spell it.
 *
 * It also ignores `GIT_DIR` and `GIT_WORK_TREE`. That is a feature: they are environment overrides
 * of exactly the thing this module exists to make underivable.
 */
export const findProjectRoot = async (startDir: string): Promise<string> => {
  for (const dir of ancestors(startDir)) {
    try {
      await Deno.lstat(join(dir, '.git'));
      return dir;
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) continue;
      throw new ConfigError(`cannot read ${join(dir, '.git')}: ${(cause as Error).message}`);
    }
  }
  throw new ConfigError(
    `not inside a git repository: ${resolve(startDir)}\n` +
      '  jira-fetch keeps one config file per project, named after the repository root.',
  );
};

/** Filenames cap at 255 bytes on every filesystem this ships to. Leave room for `.yml` and the
 * disambiguating suffix below. */
const MAX_SLUG_BYTES = 200;

/** FNV-1a, 64-bit, rendered as 12 hex characters.
 *
 * Not a cryptographic hash and it does not need to be: this only disambiguates two project roots
 * long enough to be truncated to the same 200 bytes. The real collision guard is the `project` key
 * inside the file, which is compared against the actual root and refuses a mismatch outright. */
const shortHash = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0').slice(0, 12);
};

/**
 * The config filename stem for a project root.
 *
 * `/` (and Windows `\`) become `_`, with the leading one dropped; everything within a path segment
 * is lower-cased and folded to `-`, except `_`, which survives. So
 * `/Users/username/coding_projects/jira_fetch Project Root` becomes
 * `users_username_coding_projects_jira_fetch-project-root`.
 *
 * **This is not injective**, and cannot be made so while staying readable: `/a/b_c` and `/a_b/c`
 * both land on `a_b_c`. The `project` key in the file is what catches that — see
 * `assertProjectMatches` in `config.ts`.
 *
 * A pure string transform: it does **not** resolve its argument, so a Windows path slugs the same
 * way on every host. `findProjectRoot` already returns an absolute path, and that is the contract.
 */
export const projectSlug = (projectRoot: string): string => {
  const slug = projectRoot
    // A Windows drive is a path segment, not a segment with a colon in it: `C:\a` -> `c_a`.
    .replace(/^([A-Za-z]):[\\/]/, '$1/')
    .split(/[\\/]/)
    // Dropping empties is what "the first one is omitted" means, and it also collapses `//`.
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    .filter((segment) => segment.length > 0)
    .join('_');

  const encoder = new TextEncoder();
  if (encoder.encode(slug).length <= MAX_SLUG_BYTES) return slug;
  // Truncate on a byte boundary, then re-decode: slicing bytes can split a multi-byte character,
  // and `TextDecoder` would leave a replacement character in the filename.
  const truncated = new TextDecoder().decode(encoder.encode(slug).slice(0, MAX_SLUG_BYTES))
    .replace(/\uFFFD+$/, '');
  return `${truncated}-${shortHash(projectRoot)}`;
};

/** The absolute path of a project's config file. The only place this name is constructed. */
export const configPathFor = (projectRoot: string, dir: string): string =>
  join(dir, `${projectSlug(projectRoot)}.yml`);
