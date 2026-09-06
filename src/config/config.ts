/** Configuration resolution.
 *
 * There is one config file per project and it is the **only** source of credentials and policy.
 * Its path is derived from the git repository the working directory belongs to (see
 * `location.ts`); it cannot be named on the command line, pointed elsewhere by an environment
 * variable, or shadowed by a file appearing in the project tree, because none of those inputs are
 * consulted. That is what makes `filters` an access boundary rather than a convention: an agent
 * that can write anywhere in the project still cannot reach the file that decides what it may
 * fetch.
 *
 * Nothing here reads ambient state. `resolveConfig` cannot reach `Deno.env`, and the config path
 * is passed in rather than computed, which is what lets the suite stay hermetic while a real
 * config for this very repository sits in the user's config directory.
 */

import { isAbsolute, resolve } from '@std/path';
import { parse as parseYaml } from '@std/yaml';
import { type CompiledFilters, compileFilters } from '../filter/rules.ts';
import { ConfigError } from './errors.ts';
import { type ConfigFile, parseConfigFile, People, type PeopleConfig } from './schema.ts';

export { ConfigError };
export type { ConfigFile };

/** The resolved configuration. Every key it shares with the config file is derived from the Zod
 * schema, so a rename there is a compile error here. `filters` is the compiled form (Sets and
 * RegExps, which no JSON Schema can express) and `configPath` is not configurable at all. */
export type Config =
  & Required<Pick<ConfigFile, 'baseUrl' | 'email' | 'token' | 'allowJql'>>
  & {
    /** The config file's `out`, resolved to an absolute path. */
    outDir: NonNullable<ConfigFile['out']>;
    filters: CompiledFilters;
    /** How much the document says about the people on a ticket. Always fully populated, even
     * when the file omits the block. */
    people: PeopleConfig;
    /** Where the config came from, for --verbose. */
    configPath: string;
  };

const parseConfigText = (text: string, path: string): ConfigFile => {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (cause) {
    throw new ConfigError(`${path} is not valid YAML: ${(cause as Error).message}`);
  }
  return parseConfigFile(data, path);
};

/**
 * Refuses a config file written for a different repository.
 *
 * `projectSlug` is not injective — `/a/b_c` and `/a_b/c` name the same file — so without this a
 * project could silently load another project's filters, which is the exact failure this whole
 * design exists to prevent. It is an error rather than a warning for the same reason
 * `makeFieldResolver` refuses an unresolvable field name: a policy that cannot be trusted is not
 * one to run under.
 *
 * The `realPath` fallback is for symlinked roots — on macOS `/var` is `/private/var`, so a file
 * written from one spelling would otherwise be rejected when reached by the other.
 */
const assertProjectMatches = async (
  declared: string,
  projectRoot: string,
  path: string,
): Promise<void> => {
  if (resolve(declared) === resolve(projectRoot)) return;
  const real = await Promise.all(
    [declared, projectRoot].map((p) => Deno.realPath(p).catch(() => resolve(p))),
  );
  if (real[0] === real[1]) return;
  throw new ConfigError(
    `${path} is not this project's configuration:\n` +
      `  it declares project: ${declared}\n` +
      `  but this repository is ${projectRoot}\n` +
      '  Two repository paths can share a config filename; run `jira-fetch setup` to write ' +
      'this one.',
  );
};

/** Reads the one config file for a project. The path is derived, never searched for. */
export const loadProjectConfig = async (
  path: string,
  projectRoot: string,
): Promise<ConfigFile> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      throw new ConfigError(
        `no configuration for this project:\n  expected ${path}\n` +
          '  Run `jira-fetch setup` to create it.',
      );
    }
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`);
  }
  const data = parseConfigText(text, path);
  await assertProjectMatches(data.project, projectRoot, path);
  return data;
};

export type ResolveOptions = {
  /** CLI overrides. Only keys that are placement rather than policy appear here: nothing that
   * decides which issues may be fetched can be set from argv, in either mode. */
  flags: Pick<ConfigFile, 'out'>;
  file: ConfigFile;
  filePath: string;
  cwd: string;
};

const normalizeBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(
      `base URL "${raw}" is not a valid URL (expected e.g. https://your-site.atlassian.net)`,
    );
  }
  // The API token travels in an Authorization header on every request, so plain http is only
  // tolerated against a loopback address — a local proxy, or the test suite's fake Jira.
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new ConfigError(
      `base URL must use https, got "${url.protocol}//" (http is allowed only for localhost)`,
    );
  }
  return trimmed;
};

export const resolveConfig = (opts: ResolveOptions): Config => {
  const { flags, file, filePath, cwd } = opts;

  const { baseUrl, email, token } = file;

  // Tested in one condition so the compiler narrows all three to `string` below; collecting the
  // messages first and throwing afterwards would leave it unable to see that.
  if (baseUrl === undefined || email === undefined || token === undefined) {
    const missing: string[] = [];
    if (baseUrl === undefined) missing.push('baseUrl');
    if (email === undefined) missing.push('email');
    if (token === undefined) missing.push('token');
    throw new ConfigError(
      `${filePath} is missing ${missing.join(', ')}\n` +
        '  Run `jira-fetch setup` to fill it in.',
    );
  }

  const out = flags.out || file.out || cwd;

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    email,
    token,
    outDir: isAbsolute(out) ? out : resolve(cwd, out),
    // Defaults to true; only an explicit `false` in the config file turns it off.
    allowJql: file.allowJql !== false,
    filters: compileFilters(file.filters),
    // Parsed rather than defaulted here, so the schema stays the only place the defaults are
    // written. `People.parse` is idempotent, which matters because a `ConfigFile` that never went
    // through `parseConfigFile` — a hand-built one in a test — carries no defaults despite the
    // inferred type promising them.
    people: People.parse(file.people ?? {}),
    configPath: filePath,
  };
};
