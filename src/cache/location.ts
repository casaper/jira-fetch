/** Where a project's cached Jira metadata lives — derived from the project root, like the config
 * file and for the same reason.
 *
 * These functions are pure: `cacheKey` hashes the string it is handed and does not resolve it, so
 * a Windows path keys identically on every host and the rules are testable without a Windows
 * runner. The contract is the one `configPathFor` already has — the caller passes an absolute,
 * canonicalised project root, which is what `findProjectRoot` returns. That matters here because
 * `/var` is a symlink to `/private/var` on macOS, and hashing the two spellings would give one
 * repository two cache directories.
 */

import { join } from '@std/path';
import { join as joinPosix } from '@std/path/posix';
import { join as joinWindows } from '@std/path/windows';
import { ConfigError } from '../config/errors.ts';
import { type EnvReader, readEnv } from '../config/location.ts';

/**
 * The user's jira-fetch cache directory.
 *
 * `%APPDATA%` rather than `%LOCALAPPDATA%`, which is the Windows location a cache belongs in:
 * `LOCALAPPDATA` is not in the `--allow-env` set baked into the shipped binaries, and widening that
 * set would move `deno.json`, `scripts/build_all.ts` and `test/mcp_test.ts` in lockstep to save a
 * directory of regenerable JSON from roaming-profile sync. `%APPDATA%` also carries the ACL that
 * stands in for `chmod 700` on Windows, which this directory wants.
 *
 * `$XDG_CACHE_HOME` is deliberately not read, matching `userConfigDir` ignoring `$XDG_CONFIG_HOME`:
 * another variable is another way for the answer to depend on the environment.
 *
 * It joins with the separator of the `os` it was **asked about**, not the one it is running on.
 */
export const userCacheDir = (
  env: EnvReader = readEnv,
  os: typeof Deno.build.os = Deno.build.os,
): string => {
  if (os === 'windows') {
    const appData = env('APPDATA');
    if (appData) return joinWindows(appData, 'jira-fetch', 'cache');
    const profile = env('USERPROFILE');
    if (profile) return joinWindows(profile, 'AppData', 'Roaming', 'jira-fetch', 'cache');
    throw new ConfigError('cannot locate the cache directory: %APPDATA% is not set');
  }
  const home = env('HOME');
  if (home) return joinPosix(home, '.cache', 'jira-fetch');
  throw new ConfigError('cannot locate the cache directory: $HOME is not set');
};

/** How many hex characters of the digest name the directory. Twelve is plenty to separate the
 * repositories one machine holds, and the `project` key inside the manifest is the real guard —
 * it is compared against the repository in hand and refuses a mismatch outright. */
const KEY_LENGTH = 12;

/** The cache directory name for a project root: the leading hex of its SHA-1.
 *
 * Opaque where the config filename is readable, which is the right trade for a directory nobody
 * edits by hand: it cannot collide with a path separator and needs no length cap. `crypto.subtle`
 * is Web Crypto, so this costs no dependency and no permission — and it is why this function is
 * async where `configPathFor` is not.
 */
export const cacheKey = async (projectRoot: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(projectRoot));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, KEY_LENGTH);
};

/**
 * The absolute path of a project's cache directory. The only place this name is constructed.
 *
 * Joins with the **host's** separator, unlike `userCacheDir` above — and that is right rather than
 * an oversight: `dir` has already been answered in the host's shape, so this is the same contract
 * `configPathFor` has. It is `cacheKey` that is host-independent, not this.
 */
export const cacheDirFor = async (projectRoot: string, dir: string): Promise<string> =>
  join(dir, await cacheKey(projectRoot));
