/** Creating and updating a project's config file: the part of `setup` that has nothing to do with
 * a terminal, and can therefore be tested. */

import { dirname } from '@std/path';
import { parse as parseYaml, stringify as stringifyYaml } from '@std/yaml';
import { ConfigError } from '../config/errors.ts';
import { type ConfigFile, parseConfigFile } from '../config/schema.ts';

/** Owner-only, on both counts. The directory needs `x` to be traversed at all; the file does not,
 * and an execute bit on a YAML document would say something untrue about it. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Windows has no POSIX modes, and `Deno.chmod` refuses there. It also needs none: everything
 * under %APPDATA% already inherits an ACL granting only that user, SYSTEM and Administrators. */
const POSIX = Deno.build.os !== 'windows';

const SCHEMA_URL =
  'https://raw.githubusercontent.com/casaper/jira-fetch/main/schema/jira-fetch.schema.json';

/** Applies the intended mode to something that already exists. Creating with `mode` covers the
 * new-file case; this covers a file or directory made before, or by hand. */
export const repairMode = async (path: string, mode: number): Promise<void> => {
  if (!POSIX) return;
  try {
    const info = await Deno.stat(path);
    if (((info.mode ?? mode) & 0o777) !== mode) await Deno.chmod(path, mode);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
};

/**
 * Writes a project's config file, owner-readable and no wider.
 *
 * Validated through the same `parseConfigFile` the loader uses, so `setup` cannot produce a file
 * the tool would then refuse — the Zod schema stays the one description of what a config is.
 *
 * The mode is passed at creation rather than applied afterwards: a `chmod` after the write leaves
 * a window in which a file holding an API token is readable by anyone on the machine.
 */
export const writeConfigFile = async (path: string, data: ConfigFile): Promise<void> => {
  parseConfigFile(data, path);

  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await repairMode(dir, DIR_MODE);

  // Unwrapped: a long project path would otherwise be folded into a `>-` block, which round-trips
  // correctly but is unpleasant to edit by hand, and this file is meant to be edited by hand.
  const body = stringifyYaml(data, { lineWidth: -1 });
  await Deno.writeTextFile(path, `# yaml-language-server: $schema=${SCHEMA_URL}\n\n${body}`, {
    mode: FILE_MODE,
  });
  await repairMode(path, FILE_MODE);
};

/** The current contents, or `undefined` when there is nothing there yet. A file that exists but
 * does not parse is an error: silently starting from scratch would discard someone's filters. */
export const readConfigFileIfPresent = async (
  path: string,
): Promise<ConfigFile | undefined> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return undefined;
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`);
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw new ConfigError(`${path} is not valid YAML: ${(cause as Error).message}`);
  }
  return parseConfigFile(data, path);
};
