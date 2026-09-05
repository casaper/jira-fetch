/** Configuration resolution: CLI flags -> environment -> config file, applied **per key**.
 * A flag supplying one key must not discard the file's value for another. */

import { dirname, isAbsolute, join, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { type CompiledFilters, compileFilters } from "../filter/rules.ts";
import { ConfigError } from "./errors.ts";
import { type ConfigFile, parseConfigFile } from "./schema.ts";

export { ConfigError };
export type { ConfigFile };

export interface CredentialOverrides {
  baseUrl?: string;
  email?: string;
  token?: string;
}

export interface Config {
  baseUrl: string;
  email: string;
  token: string;
  outDir: string;
  allowJql: boolean;
  filters: CompiledFilters;
  /** Where the config came from, for --verbose. */
  configPath?: string;
}

const FILE_NAMES = [".jira-fetch.json", ".jira-fetch.yaml", ".jira-fetch.yml"];

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return undefined;
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`);
  }
}

function parseConfigText(text: string, path: string): ConfigFile {
  let data: unknown;
  try {
    data = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (cause) {
    throw new ConfigError(
      `${path} is not valid ${path.endsWith(".json") ? "JSON" : "YAML"}: ${
        (cause as Error).message
      }`,
    );
  }
  return parseConfigFile(data, path);
}

/** Walks up from `startDir` looking for a config file, then falls back to the user config dir. */
export async function discoverConfigFile(startDir: string, home?: string): Promise<
  { path: string; data: ConfigFile } | undefined
> {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of FILE_NAMES) {
      const path = join(dir, name);
      const text = await readIfPresent(path);
      if (text !== undefined) return { path, data: parseConfigText(text, path) };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (home) {
    for (const name of ["config.json", "config.yaml", "config.yml"]) {
      const path = join(home, ".config", "jira-fetch", name);
      const text = await readIfPresent(path);
      if (text !== undefined) return { path, data: parseConfigText(text, path) };
    }
  }
  return undefined;
}

export async function loadConfigFile(path: string): Promise<ConfigFile> {
  const text = await readIfPresent(path);
  if (text === undefined) throw new ConfigError(`config file not found: ${path}`);
  return parseConfigText(text, path);
}

export interface ResolveOptions {
  flags: CredentialOverrides & { out?: string };
  env: Record<string, string | undefined>;
  file?: ConfigFile;
  filePath?: string;
  cwd: string;
}

/** Picks the first defined value across the three sources, key by key. */
function pick<T>(...candidates: Array<T | undefined>): T | undefined {
  for (const c of candidates) {
    if (c !== undefined && c !== "") return c;
  }
  return undefined;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
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
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new ConfigError(
      `base URL must use https, got "${url.protocol}//" (http is allowed only for localhost)`,
    );
  }
  return trimmed;
}

export function resolveConfig(opts: ResolveOptions): Config {
  const { flags, env, file, filePath, cwd } = opts;

  const baseUrl = pick(flags.baseUrl, env.JIRA_BASE_URL, file?.baseUrl);
  const email = pick(flags.email, env.JIRA_EMAIL, file?.email);
  const token = pick(flags.token, env.JIRA_API_TOKEN, file?.token);

  const missing: string[] = [];
  if (!baseUrl) missing.push("base URL (--base-url, JIRA_BASE_URL, or baseUrl in the config file)");
  if (!email) missing.push("email (--email, JIRA_EMAIL, or email in the config file)");
  if (!token) missing.push("API token (--token, JIRA_API_TOKEN, or token in the config file)");
  if (missing.length > 0) {
    throw new ConfigError(`missing credentials:\n  - ${missing.join("\n  - ")}`);
  }

  const out = pick(flags.out, env.JIRA_FETCH_OUT, file?.out) ?? cwd;

  return {
    baseUrl: normalizeBaseUrl(baseUrl!),
    email: email!,
    token: token!,
    outDir: isAbsolute(out) ? out : resolve(cwd, out),
    // Defaults to true; only an explicit `false` in the config file turns it off.
    allowJql: file?.allowJql !== false,
    filters: compileFilters(file?.filters),
    configPath: filePath,
  };
}
