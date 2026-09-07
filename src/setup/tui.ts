/** `jira-fetch setup`: credentials first, checked against the site, then everything else as a form.
 *
 * **The terminal check is the barrier.** An agent's shell has no controlling terminal, so refusing
 * to run without one keeps this command — the one that can write credentials and relax filters —
 * off the ordinary agent path at no cost in permissions. It is a barrier, not a boundary: anything
 * that can allocate a pty gets past it. That is worth stating plainly rather than dressing up.
 *
 * Nothing here spawns a process. `--allow-run` in the shipped binary would be carried by the MCP
 * server too, and "open the file in your editor" is not worth that; the path is printed instead.
 *
 * **Credentials are written the moment they check out, and everything else on Save.** Ctrl+C inside
 * a prompt calls `Deno.exit(130)` and nothing above it runs — see `prompts.ts` — so a form that
 * accumulated every answer and wrote once at the end would lose all of it silently. Two checkpoints
 * means an interrupt costs at most the stage in progress, never the token just typed.
 */

import { ConfigError } from '../config/errors.ts';
import type { ConfigFile, PersonField, PersonRole } from '../config/schema.ts';
import {
  People,
  PersonField as PersonFieldEnum,
  PersonRole as PersonRoleEnum,
} from '../config/schema.ts';
import { applyDenyRules, denyTargets } from './claude_settings.ts';
import { readConfigFileIfPresent, writeConfigFile } from './config_file.ts';
import { runFilterSetup } from './filter_tui.ts';
import {
  buildPeople,
  type FormAction,
  formExits,
  formRows,
  type FormState,
  hasCredentials,
  toConfigFile,
  validateBaseUrl,
  validateEmail,
  validateOut,
  validateToken,
} from './form.ts';
import {
  askSecret,
  askText,
  check,
  confirm,
  hasTerminal,
  type Item,
  pick,
  rule,
  say,
} from './prompts.ts';
import { describeFailure, verifyCredentials } from './verify.ts';

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/** Everything the menu needs to know about where it is running. Passed in rather than read here,
 * for the same reason the rest of the tool does it: so nothing resolves ambient state twice. */
export type SetupOptions = {
  configPath: string;
  configDir: string;
  /** Where this project's Jira metadata is cached. `setup` reads and writes nothing in it — it is
   * needed so the deny rules can name it, and so the filter menu can be handed it. */
  cacheDir: string;
  projectRoot: string;
  home: string;
  /** Injectable so the credential probe can be pointed elsewhere; nothing but a test would. */
  fetch?: typeof fetch;
};

const askSite = (current?: string): Promise<string> =>
  askText({
    message: 'Jira site',
    hint: 'the address of your Jira Cloud site, https:// included',
    default: current ?? 'https://your-site.atlassian.net',
    validate: validateBaseUrl,
  });

const askEmail = (current?: string): Promise<string> =>
  askText({
    message: 'Atlassian account email',
    hint: 'the account the API token belongs to',
    ...(current ? { default: current } : {}),
    validate: validateEmail,
  });

const askToken = async (): Promise<string> => {
  say();
  say(`  Create one at ${TOKEN_URL}`);
  say('  It is stored in this file and nowhere else — there is no environment variable, so');
  say('  it is not something a shell in your project inherits. Input is not echoed.');
  return await askSecret({ message: 'API token', validate: validateToken });
};

/**
 * The three answers, then proof that they work.
 *
 * Three, not two: a token cannot be checked without knowing which site to check it against.
 * Returns the state, or `undefined` when the user gave up.
 */
const collectCredentials = async (
  opts: SetupOptions,
  loaded: FormState,
): Promise<FormState | undefined> => {
  let state: FormState = { ...loaded };

  for (;;) {
    const baseUrl = await askSite(state.baseUrl);
    const email = await askEmail(state.email);
    const token = await askToken();
    state = { ...state, baseUrl, email, token };

    say();
    say(`Checking those against ${baseUrl}`);
    const result = await verifyCredentials({ baseUrl, email, token }, opts.fetch);

    if (result.ok) {
      const who = result.emailAddress ? ` (${result.emailAddress})` : '';
      say(`  signed in as ${result.displayName}${who}`);
      return state;
    }

    say();
    for (const line of describeFailure(result)) say(`  ${line}`);

    const next = await pick<'again' | 'anyway' | 'quit'>({
      message: 'That did not work — what now?',
      items: [
        { value: 'again', name: 'Go back over all three' },
        { value: 'anyway', name: 'Save these anyway and carry on' },
        { value: 'quit', name: 'Quit without saving' },
      ],
    });
    if (next === 'quit') return undefined;
    if (next === 'anyway') return state;
  }
};

const editPeople = async (state: FormState): Promise<FormState> => {
  say();
  say('How much the document says about people. None of it reaches the filters: hiding someone');
  say('never changes which tickets are fetched.');
  const current = state.people ?? People.parse({});

  // The option lists come from the Zod enums, so adding a role or a field in src/config/schema.ts
  // appears here with no edit.
  const roles = await check<PersonRole>({
    message: 'Who appears in the document',
    items: PersonRoleEnum.options.map((role) => ({
      value: role,
      name: role,
      checked: current.roles.includes(role),
    })),
  });
  const fields = await check<PersonField>({
    message: 'What is recorded about them',
    items: PersonFieldEnum.options.map((field) => ({
      value: field,
      name: field,
      checked: current.fields.includes(field),
    })),
    // Mirrors the schema's own .min(1), so the prompt cannot produce something it would refuse.
    min: 1,
  });
  const nameFormat = await pick<'full' | 'initials'>({
    message: 'How names are written',
    items: [
      { value: 'full', name: 'full — Kaspar Vollenweider' },
      { value: 'initials', name: 'initials — KV' },
    ],
    default: current.nameFormat,
  });

  return { ...state, people: buildPeople(roles, fields, nameFormat) };
};

const offerDenyRules = async (opts: SetupOptions): Promise<void> => {
  say();
  say('Claude Code can be told to keep away from the configuration directory. This stops the');
  say('well-behaved path — it is not a sandbox, and an agent with a shell can still read the');
  say("file. The only hard boundary is what your API token may see on Atlassian's side.");
  if (!await confirm({ message: 'Write those deny rules?', default: true })) return;

  const targets = denyTargets({
    configDir: opts.configDir,
    cacheDir: opts.cacheDir,
    home: opts.home,
    projectRoot: opts.projectRoot,
  });
  for (const target of targets) {
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
      for (const denyRule of target.rules) say(`    ${denyRule}`);
    }
  }
};

/** Writes the state, reporting what happened. `false` means the file was refused. */
const save = async (opts: SetupOptions, state: FormState): Promise<boolean> => {
  const loaded = await readConfigFileIfPresent(opts.configPath) ?? {};
  const next = toConfigFile(loaded as Record<string, unknown>, state, opts.projectRoot);
  try {
    await writeConfigFile(opts.configPath, next as ConfigFile);
    say();
    say(`Saved ${opts.configPath}`);
    return true;
  } catch (cause) {
    say(`Not saved: ${(cause as Error).message}`);
    return false;
  }
};

/** Runs the menu. Returns the process exit code. */
export const runSetup = async (opts: SetupOptions): Promise<number> => {
  if (!hasTerminal()) {
    throw new ConfigError(
      'jira-fetch setup needs a terminal.\n' +
        `  To see the file it would write: jira-fetch config-file\n  ${opts.configPath}`,
    );
  }

  const existing = await readConfigFileIfPresent(opts.configPath);
  say();
  say(`Configuring ${opts.projectRoot}`);
  say(`  ${opts.configPath}`);
  say();
  say('Your credentials are saved as soon as they check out. Everything after that is saved when');
  say('you choose Save. Ctrl+C leaves immediately.');

  let state: FormState = {
    ...(existing?.baseUrl ? { baseUrl: existing.baseUrl } : {}),
    ...(existing?.email ? { email: existing.email } : {}),
    ...(existing?.token ? { token: existing.token } : {}),
    ...(existing?.out ? { out: existing.out } : {}),
    ...(existing?.allowJql === undefined ? {} : { allowJql: existing.allowJql }),
    ...(existing?.people ? { people: existing.people } : {}),
  };

  // Credentials first, and nothing else until they work: every screen after this is about a site
  // that has already answered.
  const credentials = await collectCredentials(opts, state);
  if (credentials === undefined) {
    say('Nothing was written.');
    return 0;
  }
  state = credentials;
  if (!await save(opts, state)) return 2;

  for (;;) {
    const rows = formRows(state);
    const width = Math.max(...rows.map((row) => row.label.length));
    const items: Array<Item<FormAction>> = rows.map((row) => ({
      value: row.action,
      name: `${row.label.padEnd(width)}  ${row.value}`,
    }));
    items.push(rule());
    for (const exit of formExits(state)) items.push({ value: exit.action, name: exit.label });

    const chosen = await pick<FormAction>({
      message: 'jira-fetch for this project',
      items,
      default: 'out',
    });

    switch (chosen) {
      case 'baseUrl':
      case 'email':
      case 'token': {
        // Any of the three changing means all three are unproven again.
        const rechecked = await collectCredentials(opts, state);
        if (rechecked) {
          state = rechecked;
          await save(opts, state);
        }
        break;
      }
      case 'out': {
        const answer = await askText({
          message: 'Output folder',
          hint: 'where documents are written, relative to wherever you run jira-fetch',
          ...(state.out ? { default: state.out } : {}),
          validate: validateOut,
        });
        state = { ...state, out: answer.trim() === '' ? undefined : answer.trim() };
        break;
      }
      case 'allowJql':
        state = {
          ...state,
          allowJql: await pick<boolean>({
            message: 'JQL queries',
            items: [
              { value: true, name: 'allowed' },
              {
                value: false,
                name: 'refused — also removes the search_issues tool from the MCP server ' +
                  'entirely, rather than having it refuse when called',
              },
            ],
            default: state.allowJql !== false,
          }),
        };
        break;
      case 'people':
        state = await editPeople(state);
        break;
      case 'save':
        if (!await save(opts, state)) break;
        await offerDenyRules(opts);
        say();
        say('To edit it by hand:');
        say('  $EDITOR "$(jira-fetch config-file)"');
        return 0;
      case 'saveAndFilters':
        if (!await save(opts, state)) break;
        await offerDenyRules(opts);
        // Re-read rather than passing the object across, so the chained path runs the same code as
        // a standalone `jira-fetch filters` — and the write is proved to round trip on the spot.
        return await runFilterSetup({
          configPath: opts.configPath,
          projectRoot: opts.projectRoot,
          cacheDir: opts.cacheDir,
        });
      case 'quit':
        say(
          hasCredentials(state)
            ? 'Nothing more was written. Your credentials are already saved.'
            : 'Nothing was written.',
        );
        return 0;
    }
  }
};
