/** Writing Claude Code permission rules that keep an agent out of the configuration directory.
 *
 * **This is a speed bump, not a boundary, and the README says so in those words.** Deny rules stop
 * the well-behaved path — `Read` covers Grep, Glob and the file reads Claude Code recognises in
 * Bash — but they do not reach a script that opens the file itself, and an agent with a shell can
 * edit the settings files too. What they buy is that circumventing the policy has to be
 * deliberate and visible rather than incidental. The only hard boundary is what the API token is
 * permitted to see on Atlassian's side.
 *
 * The rules are split by what each protects, which is why there are two files rather than one:
 *
 * - The config directory is denied at **user** scope, in `~/.claude/settings.json`. One write
 *   covers every project, the rule lives outside every repository, and a deny at any scope beats
 *   an allow at any other — so a project cannot grant back what this takes away.
 * - `jira-fetch setup` is denied in the **project**, so a teammate cloning the repository sees
 *   that the command is meant for a human at a terminal.
 */

import { dirname, join, resolve, SEPARATOR } from '@std/path';
import { ConfigError } from '../config/errors.ts';

/** One settings file and the rules this tool wants denied in it. */
export type RuleTarget = {
  path: string;
  rules: string[];
  /** What the file is, for the line `setup` prints. */
  label: string;
};

/**
 * The path pattern naming the configuration directory.
 *
 * `~/` is preferred over an absolute path because it is what a reader recognises and it survives
 * the file being copied to another machine. Claude Code expands it; it does **not** expand `$HOME`
 * or `%APPDATA%`, so those are never emitted. Patterns are gitignore-style and always use forward
 * slashes, including on Windows.
 */
export const configDirPattern = (configDir: string, home: string): string => {
  const dir = resolve(configDir);
  const root = resolve(home);
  const slashes = (path: string) => path.replaceAll(SEPARATOR, '/');
  if (dir === root || dir.startsWith(root + SEPARATOR)) {
    return `~/${slashes(dir.slice(root.length + 1))}/**`;
  }
  // A double slash anchors a pattern at the filesystem root. %APPDATA% lives under %USERPROFILE%,
  // so on Windows this branch is only reached by a deliberately relocated directory.
  return `//${slashes(dir).replace(/^\/+/, '')}/**`;
};

/** The two files and what each should deny. */
export const denyTargets = (
  configDir: string,
  home: string,
  projectRoot: string,
): RuleTarget[] => {
  const pattern = configDirPattern(configDir, home);
  return [
    {
      path: join(home, '.claude', 'settings.json'),
      label: 'your Claude Code settings (all projects)',
      // Read and Edit are the only two path-scoped tool names Claude Code honours; Read also
      // covers Grep, Glob and recognised Bash reads such as cat, sed and `< file` redirections.
      rules: [`Read(${pattern})`, `Edit(${pattern})`],
    },
    {
      path: join(projectRoot, '.claude', 'settings.local.json'),
      label: "this project's Claude Code settings",
      rules: ['Bash(jira-fetch setup:*)'],
    },
  ];
};

/** What `applyDenyRules` did to one file, so the caller can report it rather than guess. */
export type RuleOutcome = {
  path: string;
  label: string;
  /** Rules this call actually added. Empty means every rule was already there. */
  added: string[];
};

const readSettings = async (path: string): Promise<Record<string, unknown>> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return {};
    throw new ConfigError(`cannot read ${path}: ${(cause as Error).message}`);
  }
  if (text.trim() === '') return {};
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('expected a JSON object');
    }
    return data as Record<string, unknown>;
  } catch (cause) {
    // Rewriting a file we could not parse would destroy settings someone wrote by hand, so this
    // stops and names the rules instead of guessing.
    throw new ConfigError(
      `${path} is not valid JSON (${(cause as Error).message}); add these rules by hand`,
    );
  }
};

/**
 * Adds `rules` to a settings file's `permissions.deny`, preserving everything else in it.
 *
 * Idempotent: a rule already present is left alone, so running `setup` twice cannot produce a
 * second copy. Every other key — `allow`, `ask`, `hooks`, `enabledPlugins` — is carried through
 * untouched, because this file belongs to the user and jira-fetch is a guest in it.
 */
export const applyDenyRules = async (target: RuleTarget): Promise<RuleOutcome> => {
  const settings = await readSettings(target.path);

  const permissions = typeof settings.permissions === 'object' && settings.permissions !== null &&
      !Array.isArray(settings.permissions)
    ? { ...settings.permissions as Record<string, unknown> }
    : {};
  const existing = Array.isArray(permissions.deny) ? permissions.deny as unknown[] : [];

  const added = target.rules.filter((rule) => !existing.includes(rule));
  if (added.length === 0) return { path: target.path, label: target.label, added };

  permissions.deny = [...existing, ...added];

  await Deno.mkdir(dirname(target.path), { recursive: true });
  await Deno.writeTextFile(
    target.path,
    `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`,
  );
  return { path: target.path, label: target.label, added };
};
