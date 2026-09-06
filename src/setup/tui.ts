/** `jira-fetch setup`: an interactive menu for a project's configuration.
 *
 * **The terminal check is the barrier.** An agent's shell has no controlling terminal, so
 * refusing to run without one keeps this command — the one that can write credentials and relax
 * filters — off the ordinary agent path at no cost in permissions. It is a barrier, not a
 * boundary: anything that can allocate a pty gets past it. That is worth stating plainly rather
 * than dressing up.
 *
 * Built from `@std/cli`, which was already a dependency, so the whole of this needs no new
 * package and no permission beyond the four the binary is compiled with. Nothing here spawns a
 * process: `--allow-run` in the shipped binary would be carried by the MCP server too, and
 * "open the file in your editor" is not worth that. The path is printed instead.
 */

import { promptSecret } from '@std/cli/prompt-secret';
import { promptSelect } from '@std/cli/unstable-prompt-select';
import { ConfigError } from '../config/errors.ts';
import type { ConfigFile, TicketRule } from '../config/schema.ts';
import { applyDenyRules, denyTargets } from './claude_settings.ts';
import { readConfigFileIfPresent, writeConfigFile } from './config_file.ts';

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** Everything the menu needs to know about where it is running. Passed in rather than read here,
 * for the same reason the rest of the tool does it: so nothing resolves ambient state twice. */
export type SetupOptions = {
  configPath: string;
  configDir: string;
  projectRoot: string;
  home: string;
};

const say = (line = ''): void => console.log(line);

/** A free-text answer, with the current value offered as the default. Returns `undefined` when
 * the user submits nothing and there was nothing before. */
const ask = (question: string, current?: string): string | undefined => {
  const answer = prompt(`${question}${current === undefined ? '' : ` [${current}]`}`);
  if (answer === null) return current;
  const trimmed = answer.trim();
  return trimmed === '' ? current : trimmed;
};

const choose = <T extends string>(question: string, options: T[]): T | undefined =>
  promptSelect(question, options) as T | undefined;

/** A one-line summary of a key, so the menu shows what is set without showing the token. */
const summarize = (config: Partial<ConfigFile>): Record<string, string> => ({
  site: config.baseUrl ?? 'not set',
  email: config.email ?? 'not set',
  token: config.token ? `set (${config.token.length} characters)` : 'not set',
  out: config.out ?? 'the working directory',
  jql: config.allowJql === false ? 'refused' : 'allowed',
  filters: `${config.filters?.include?.length ?? 0} include, ` +
    `${config.filters?.exclude?.length ?? 0} exclude, ` +
    `${config.filters?.comments?.exclude?.length ?? 0} comment`,
  people: (config.people?.roles ?? ['reporter', 'assignee', 'commenter']).join(', ') || 'none',
});

const list = (question: string, current?: string[]): string[] | undefined => {
  const answer = ask(`${question} (comma-separated)`, current?.join(', '));
  if (answer === undefined) return undefined;
  const values = answer.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
  return values.length > 0 ? values : undefined;
};

/** Builds one filter rule. Every predicate in a rule must hold, so this collects as many as the
 * user wants to add and returns them as a single rule. */
const buildRule = (): TicketRule | undefined => {
  const rule: TicketRule = {};
  for (;;) {
    const chosen = choose('Add a condition to this rule (all of them must match)', [
      'project — the prefix of the issue key, e.g. DN',
      'labels — what the Jira UI calls tags',
      'field — any field by name: Status, Issue Type, Components, Team…',
      'title — a regular expression on the summary',
      'reporter — who raised it',
      'assignee — who it is assigned to',
      'done with this rule',
      'cancel this rule',
    ]);
    if (chosen === undefined || chosen.startsWith('cancel')) return undefined;
    if (chosen.startsWith('done')) {
      return Object.keys(rule).length > 0 ? rule : undefined;
    }

    if (chosen.startsWith('project')) {
      say('  The only condition decidable from the key alone, so a ticket it rules out is never');
      say('  requested from Jira at all.');
      rule.project = list('  Project prefixes', rule.project) ?? rule.project;
    } else if (chosen.startsWith('labels')) {
      rule.labels = list('  Labels', rule.labels as string[] | undefined) ?? rule.labels;
    } else if (chosen.startsWith('field')) {
      say('  A name is resolved against this Jira site. One that does not exist, or that two');
      say('  fields share, stops the run — a condition that quietly matches nothing is worse.');
      const name = ask('  Field name');
      const values = name === undefined ? undefined : list(`  Accepted values for ${name}`);
      if (name !== undefined && values !== undefined) {
        rule.field = { ...rule.field, [name]: values };
      }
    } else if (chosen.startsWith('title')) {
      const matches = ask('  Regular expression', rule.title?.matches);
      if (matches !== undefined) {
        const flags = ask('  Flags, e.g. i for case-insensitive', rule.title?.flags ?? '');
        rule.title = { matches, ...(flags ? { flags } : {}) };
      }
    } else if (chosen.startsWith('reporter')) {
      rule.reporter =
        list('  Names, emails or account ids', rule.reporter as string[] | undefined) ??
          rule.reporter;
    } else if (chosen.startsWith('assignee')) {
      rule.assignee =
        list('  Names, emails or account ids', rule.assignee as string[] | undefined) ??
          rule.assignee;
    }
  }
};

const editFilters = (config: Partial<ConfigFile>): void => {
  for (;;) {
    const filters = config.filters ?? {};
    const include = filters.include ?? [];
    const exclude = filters.exclude ?? [];
    say();
    say('Filters decide which tickets may be fetched — by the CLI and by an agent through the');
    say('MCP server alike. Exclude beats include; with no include rules, everything not excluded');
    say('is allowed.');
    say(`  include: ${include.length ? include.map((r) => JSON.stringify(r)).join('  ') : 'none'}`);
    say(`  exclude: ${exclude.length ? exclude.map((r) => JSON.stringify(r)).join('  ') : 'none'}`);

    const chosen = choose('Filters', [
      'add an include rule — a ticket must match one of these',
      'add an exclude rule — matching any of these drops the ticket',
      'remove the last include rule',
      'remove the last exclude rule',
      'exclude comments by author',
      'back',
    ]);
    if (chosen === undefined || chosen === 'back') return;

    if (chosen.startsWith('add an include')) {
      const rule = buildRule();
      if (rule) config.filters = { ...filters, include: [...include, rule] };
    } else if (chosen.startsWith('add an exclude')) {
      const rule = buildRule();
      if (rule) config.filters = { ...filters, exclude: [...exclude, rule] };
    } else if (chosen.startsWith('remove the last include')) {
      config.filters = { ...filters, include: include.slice(0, -1) };
    } else if (chosen.startsWith('remove the last exclude')) {
      config.filters = { ...filters, exclude: exclude.slice(0, -1) };
    } else if (chosen.startsWith('exclude comments')) {
      const authors = list('  Comment authors to leave out', undefined);
      if (authors) {
        config.filters = { ...filters, comments: { exclude: [{ author: authors }] } };
      }
    }
  }
};

const editPeople = (config: Partial<ConfigFile>): void => {
  say();
  say('How much the document says about people. None of it reaches the filters: hiding someone');
  say('never changes which tickets are fetched.');
  const roles = choose('Who appears in the document', [
    'reporter, assignee and commenters',
    'reporter and assignee only',
    'nobody',
  ]);
  if (roles === undefined) return;
  config.people = {
    roles: roles.startsWith('nobody')
      ? []
      : roles.startsWith('reporter and assignee')
      ? ['reporter', 'assignee']
      : ['reporter', 'assignee', 'commenter'],
    fields: config.people?.fields ?? ['name', 'email'],
    nameFormat: choose('How names are written', ['full', 'initials']) ?? 'full',
  };
};

const offerDenyRules = async (opts: SetupOptions): Promise<void> => {
  say();
  say('Claude Code can be told to keep away from the configuration directory. This stops the');
  say('well-behaved path — it is not a sandbox, and an agent with a shell can still read the');
  say("file. The only hard boundary is what your API token may see on Atlassian's side.");
  const answer = choose('Write those deny rules?', ['yes', 'no']);
  if (answer !== 'yes') return;

  for (const target of denyTargets(opts.configDir, opts.home, opts.projectRoot)) {
    try {
      const outcome = await applyDenyRules(target);
      say(
        outcome.added.length === 0
          ? `  already set in ${outcome.path}`
          : `  added ${outcome.added.length} rule(s) to ${outcome.path}`,
      );
    } catch (cause) {
      // One unwritable settings file must not lose the config that was just saved.
      say(`  could not update ${target.path}: ${(cause as Error).message}`);
      for (const rule of target.rules) say(`    ${rule}`);
    }
  }
};

/** Runs the menu. Returns the process exit code. */
export const runSetup = async (opts: SetupOptions): Promise<number> => {
  if (!Deno.stdin.isTerminal()) {
    throw new ConfigError(
      'jira-fetch setup needs a terminal.\n' +
        `  To see the file it would write: jira-fetch config-file\n` +
        `  ${opts.configPath}`,
    );
  }

  const existing = await readConfigFileIfPresent(opts.configPath);
  const config: Partial<ConfigFile> = { ...existing, project: opts.projectRoot };

  say();
  say(`Configuring ${opts.projectRoot}`);
  say(`  ${opts.configPath}`);

  for (;;) {
    const s = summarize(config);
    say();
    const chosen = choose('What would you like to change?', [
      `Jira site      ${s.site}`,
      `Account email  ${s.email}`,
      `API token      ${s.token}`,
      `Output folder  ${s.out}`,
      `JQL queries    ${s.jql}`,
      `Filters        ${s.filters}`,
      `People         ${s.people}`,
      'Save and exit',
      'Exit without saving',
    ]);

    if (chosen === undefined || chosen === 'Exit without saving') {
      say('Nothing was written.');
      return 0;
    }

    if (chosen.startsWith('Jira site')) {
      say('  The address of your Jira Cloud site, https:// included.');
      config.baseUrl = ask('  Jira site', config.baseUrl);
    } else if (chosen.startsWith('Account email')) {
      say('  The Atlassian account the API token belongs to.');
      config.email = ask('  Account email', config.email);
    } else if (chosen.startsWith('API token')) {
      say(`  Create one at ${TOKEN_URL}`);
      say('  It is stored in this file and nowhere else — there is no environment variable, so');
      say('  it is not something a shell in your project inherits. Input is not echoed.');
      const token = promptSecret('  API token: ');
      if (token !== null && token.trim() !== '') config.token = token.trim();
    } else if (chosen.startsWith('Output folder')) {
      say('  Where documents are written, relative to wherever you run the tool.');
      config.out = ask('  Output folder', config.out);
    } else if (chosen.startsWith('JQL queries')) {
      say('  Refusing them also removes the search_issues tool from the MCP server entirely,');
      say('  rather than having it refuse when called.');
      config.allowJql = choose('JQL queries', ['allowed', 'refused']) !== 'refused';
    } else if (chosen.startsWith('Filters')) {
      editFilters(config);
    } else if (chosen.startsWith('People')) {
      editPeople(config);
    } else if (chosen === 'Save and exit') {
      try {
        await writeConfigFile(opts.configPath, config as ConfigFile);
      } catch (cause) {
        say(`Not saved: ${(cause as Error).message}`);
        continue;
      }
      say();
      say(`Saved ${opts.configPath}`);
      await offerDenyRules(opts);
      say();
      say('To edit it by hand:');
      say('  $EDITOR "$(jira-fetch config-file)"');
      return 0;
    }
  }
};
