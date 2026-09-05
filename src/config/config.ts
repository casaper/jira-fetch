/** Configuration resolution: CLI flags -> environment -> `.env` files -> config file, applied
 * **per key**. A flag supplying one key must not discard the file's value for another.
 *
 * The environment is a *parameter* here, never read ambiently: `resolveConfig` cannot reach
 * `Deno.env`, and `loadDotenv` cannot decide for itself where to start looking. That is what lets
 * the test suite pin both and stay hermetic while a real `.env` sits in the tree.
 */

import { dirname, isAbsolute, join, resolve } from '@std/path';
import { parse as parseDotenv } from '@std/dotenv';
import { parse as parseYaml } from '@std/yaml';
import { type CompiledFilters, compileFilters } from '../filter/rules.ts';
import { ConfigError } from './errors.ts';
import { type ConfigFile, parseConfigFile } from './schema.ts';

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
    /** Where the config came from, for --verbose. */
    configPath?: string;
    /** Non-fatal advice for the user, printed by the caller. Returned rather than logged so this
     * module stays pure and the message is directly testable. */
    warnings: string[];
  };

/** Config file names, tried in this order **within each directory**. Closeness wins: a
 * `.jira-fetch.yml` in the working directory beats a `.jira-fetch.conf.yml` one level up. */
const FILE_NAMES = [
  '.jira-fetch.conf.yml',
  '.jira-fetch.conf.yaml',
  '.jira-fetch.conf.json',
  '.jira-fetch.yml',
  '.jira-fetch.yaml',
  '.jira-fetch.json',
  'jira-fetch.conf.yml',
  'jira-fetch.conf.yaml',
  'jira-fetch.conf.json',
];

/** Every directory from `startDir` up to the filesystem root, nearest first. Shared by config
 * discovery and `.env` discovery so the two closeness rules cannot drift apart. */
const ancestors = (startDir: string): string[] => {
  const out: string[] = [];
  let dir = resolve(startDir);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
};

/** The user's own config locations, tried after the upward walk finds nothing. The last group is
 * the pre-0.2 layout, kept so an existing setup keeps working. */
const homeCandidates = (home: string): string[] => [
  ...['jira-fetch.yml', 'jira-fetch.yaml', 'jira-fetch.json'].map((n) => join(home, '.config', n)),
  ...['jira-fetch.conf.yml', 'jira-fetch.conf.yaml', 'jira-fetch.conf.json']
    .map((n) => join(home, '.config', n)),
  ...['.jira-fetch.conf.yml', '.jira-fetch.conf.yaml', '.jira-fetch.conf.json']
    .map((n) => join(home, n)),
  ...['config.json', 'config.yaml', 'config.yml']
    .map((n) => join(home, '.config', 'jira-fetch', n)),
];

/**
 * Whether a config file is the user's own rather than a project's, decided **purely by location**.
 *
 * Nothing here consults git or `.gitignore`: the tool has no opinion on whether a given file is
 * tracked. It only distinguishes "in your home directory" from "in a project tree", which is the
 * only distinction the token warning needs.
 */
const isHomeConfig = (path: string, home?: string): boolean => {
  if (!home) return false;
  const dir = dirname(resolve(path));
  const root = resolve(home);
  return dir === root || dir === join(root, '.config') ||
    dir === join(root, '.config', 'jira-fetch');
};

const readIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return undefined;
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`);
  }
};

const parseConfigText = (text: string, path: string): ConfigFile => {
  let data: unknown;
  try {
    data = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (cause) {
    throw new ConfigError(
      `${path} is not valid ${path.endsWith('.json') ? 'JSON' : 'YAML'}: ${
        (cause as Error).message
      }`,
    );
  }
  return parseConfigFile(data, path);
};

/**
 * Walks up from `startDir` looking for a config file, then falls back to the user's own locations.
 *
 * **The nearest file found is the only one read** — configurations do not layer. That is what makes
 * a config committed to a project authoritative: finding it means the developer's own
 * `~/.config/jira-fetch.yaml` is never consulted, so the project's filters cannot be half-overridden
 * from a home directory.
 *
 * When the working directory sits under `$HOME` the upward walk has already probed
 * `$HOME/.jira-fetch.conf.*`, so a few of the home candidates below are redundant. That costs one
 * `NotFound` each and keeps the list readable as the documented set.
 */
export const discoverConfigFile = async (startDir: string, home?: string): Promise<
  { path: string; data: ConfigFile } | undefined
> => {
  const candidates = [
    ...ancestors(startDir).flatMap((dir) => FILE_NAMES.map((name) => join(dir, name))),
    ...(home ? homeCandidates(home) : []),
  ];

  for (const path of candidates) {
    const text = await readIfPresent(path);
    if (text !== undefined) return { path, data: parseConfigText(text, path) };
  }
  return undefined;
};

/**
 * Values from `.env` and `.env.local`, found by the same closeness rule as the config file.
 *
 * The nearest ancestor directory holding either file wins **outright**; levels do not merge, so a
 * parent's `.env` can never fill in gaps in a project's own. Within that one directory
 * `.env.local` shadows `.env`, which is the convention everywhere else.
 *
 * `@std/dotenv` does the parsing — quoting, escapes and multi-line values are the fiddly part and
 * not worth reimplementing — while the walk stays here, sharing `ancestors` with config discovery.
 * `parse` is a pure string -> record function, so this never mutates the process environment.
 */
export const loadDotenv = async (startDir: string): Promise<Record<string, string>> => {
  for (const dir of ancestors(startDir)) {
    const base = await readIfPresent(join(dir, '.env'));
    const local = await readIfPresent(join(dir, '.env.local'));
    if (base === undefined && local === undefined) continue;
    return { ...parseDotenv(base ?? ''), ...parseDotenv(local ?? '') };
  }
  return {};
};

export const loadConfigFile = async (path: string): Promise<ConfigFile> => {
  const text = await readIfPresent(path);
  if (text === undefined) throw new ConfigError(`config file not found: ${path}`);
  return parseConfigText(text, path);
};

export type ResolveOptions = {
  /** CLI overrides: the same keys as the file, all optional there and here. */
  flags: Pick<ConfigFile, 'baseUrl' | 'email' | 'token' | 'out'>;
  /** The process environment with any `.env` values already merged underneath it. */
  env: Record<string, string | undefined>;
  file?: ConfigFile;
  filePath?: string;
  cwd: string;
  /** Home directory, used only to tell a personal config from a project one. */
  home?: string;
};

/** Picks the first defined value across the sources, key by key. */
const pick = <T>(...candidates: Array<T | undefined>): T | undefined => {
  for (const c of candidates) {
    if (c !== undefined && c !== '') return c;
  }
  return undefined;
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
  const { flags, env, file, filePath, cwd, home } = opts;

  const baseUrl = pick(flags.baseUrl, env.JIRA_BASE_URL, file?.baseUrl);
  const email = pick(flags.email, env.JIRA_EMAIL, file?.email);
  const token = pick(flags.token, env.JIRA_API_TOKEN, file?.token);

  // Testing all three in one condition is what narrows them to `string` below; collecting the
  // messages first and throwing afterwards would leave the compiler unable to see it.
  if (baseUrl === undefined || email === undefined || token === undefined) {
    const missing: string[] = [];
    if (baseUrl === undefined) {
      missing.push('base URL (--base-url, JIRA_BASE_URL, .env, or baseUrl in the config file)');
    }
    if (email === undefined) {
      missing.push('email (--email, JIRA_EMAIL, .env, or email in the config file)');
    }
    if (token === undefined) {
      missing.push('API token (--token, JIRA_API_TOKEN, .env, or token in the config file)');
    }
    throw new ConfigError(`missing credentials:\n  - ${missing.join('\n  - ')}`);
  }

  const out = pick(flags.out, env.JIRA_FETCH_OUT, file?.out) ?? cwd;

  const warnings: string[] = [];
  // A config file is meant to be committed, so a token in one inside a project tree is a secret
  // heading for git. The condition is that the key *exists*, not that it won: a token on disk is
  // the problem, whether or not JIRA_API_TOKEN happens to override it today. A token in the user's
  // own home config is their business.
  if (file?.token !== undefined && filePath && !isHomeConfig(filePath, home)) {
    warnings.push(
      `${filePath} sets \`token\`; prefer JIRA_API_TOKEN, a .env file, or --token`,
    );
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    email,
    token,
    outDir: isAbsolute(out) ? out : resolve(cwd, out),
    // Defaults to true; only an explicit `false` in the config file turns it off.
    allowJql: file?.allowJql !== false,
    filters: compileFilters(file?.filters),
    configPath: filePath,
    warnings,
  };
};
