/** The shape of the setup form, and the rules its fields are checked against.
 *
 * Pure: no prompt, no console, no `@cliffy` import. What a person sees is a list of rows with the
 * current value beside each one, and turning a configuration into that list — and a typed answer
 * back into a configuration — is all decided here so it can be tested. `tui.ts` only draws it.
 *
 * The validators derive from the Zod schema rather than restating it, so a bad answer is refused
 * in the same words the loader would have used on the next run, and renaming a key in
 * `src/config/schema.ts` is a compile error here.
 */

import { normalizeBaseUrl } from '../config/config.ts';
import { ConfigError } from '../config/errors.ts';
import {
  ConfigFile,
  People,
  type PeopleConfig,
  type PersonField,
  type PersonRole,
} from '../config/schema.ts';
import type { ConfigFile as ConfigFileData } from '../config/schema.ts';

/** Every row of the form, plus the three ways out of it. A string-literal union rather than a
 * display string, so the menu cannot dispatch on prose. */
export type FormAction =
  | 'baseUrl'
  | 'email'
  | 'token'
  | 'out'
  | 'allowJql'
  | 'people'
  | 'saveAndFilters'
  | 'save'
  | 'quit';

export type FormRow = {
  action: FormAction;
  label: string;
  /** The current setting, as a person would read it. */
  value: string;
};

/**
 * What is known about the configuration while the form is open.
 *
 * Derived from the schema's own type rather than restated, so renaming a key in
 * `src/config/schema.ts` is a compile error here. `project` is deliberately not among them: it is
 * the repository, and changing it would make the file belong to a different one.
 */
export type FormState = Partial<
  Pick<ConfigFileData, 'baseUrl' | 'email' | 'token' | 'out' | 'allowJql' | 'people'>
>;

const NOT_SET = 'not set';

/**
 * How the token is described.
 *
 * Its length and nothing else. A masked prefix would be a hint about a secret for no benefit —
 * there is only ever one token in this file, so there is nothing to tell apart.
 */
export const tokenSummary = (token?: string): string =>
  token === undefined || token === '' ? NOT_SET : `set (${[...token].length} characters)`;

/** The people block in one line. Reads the same order the schema declares. */
export const peopleSummary = (people?: PeopleConfig): string => {
  const resolved = people ?? People.parse({});
  const who = resolved.roles.length === 0 ? 'nobody' : resolved.roles.join(', ');
  const what = resolved.fields.join(', ');
  const how = resolved.nameFormat === 'initials' ? 'initials' : 'full names';
  return `${who} · ${what} · ${how}`;
};

/** Assembles a people block through the schema, so its defaults are the schema's defaults. */
export const buildPeople = (
  roles: PersonRole[],
  fields: PersonField[],
  nameFormat: PeopleConfig['nameFormat'],
): PeopleConfig => People.parse({ roles, fields, nameFormat });

/** Whether enough is known to write a file the loader would accept and use. */
export const hasCredentials = (state: FormState): boolean =>
  Boolean(state.baseUrl) && Boolean(state.email) && Boolean(state.token);

/**
 * The rows, recomputed on every pass so an edit shows immediately.
 *
 * `saveAndFilters` comes first of the three exits because it is the one a new configuration wants:
 * credentials alone fetch everything the token can see, and choosing what not to fetch is the
 * point of the tool.
 */
export const formRows = (state: FormState): FormRow[] => [
  { action: 'baseUrl', label: 'Jira site', value: state.baseUrl ?? NOT_SET },
  { action: 'email', label: 'Account email', value: state.email ?? NOT_SET },
  { action: 'token', label: 'API token', value: tokenSummary(state.token) },
  {
    action: 'out',
    label: 'Output folder',
    value: state.out ?? 'the working directory',
  },
  {
    action: 'allowJql',
    label: 'JQL queries',
    value: state.allowJql === false ? 'refused' : 'allowed',
  },
  { action: 'people', label: 'People', value: peopleSummary(state.people) },
];

/** The exits, kept apart from the rows so a menu can separate them. */
export const formExits = (state: FormState): FormRow[] => [
  { action: 'saveAndFilters', label: 'Save and set up filters', value: '' },
  { action: 'save', label: 'Save and stop here', value: '' },
  {
    action: 'quit',
    label: hasCredentials(state) ? 'Quit without saving the rest' : 'Quit without saving',
    value: '',
  },
];

/** A validator's answer, in the shape an interactive prompt wants: `true`, or why not. */
export type Validation = true | string;

const viaSchema = (
  field: 'baseUrl' | 'email' | 'out',
  raw: string,
): Validation => {
  const result = ConfigFile.shape[field].safeParse(raw.trim());
  return result.success ? true : result.error.issues[0]?.message ?? 'is not valid';
};

/**
 * The site address.
 *
 * Two checks, in the order they help: the schema's own URL rule, then `normalizeBaseUrl`, which is
 * what actually decides whether a scheme is acceptable — and which permits plain http for a
 * loopback host, so a local fake Jira can still be configured.
 */
export const validateBaseUrl = (raw: string): Validation => {
  const shape = viaSchema('baseUrl', raw);
  if (shape !== true) return shape;
  try {
    normalizeBaseUrl(raw);
    return true;
  } catch (cause) {
    return cause instanceof ConfigError ? cause.message : 'is not a usable site address';
  }
};

export const validateEmail = (raw: string): Validation => viaSchema('email', raw);

/** An empty answer means "leave it unset", which is a legitimate choice — the output folder then
 * falls back to the working directory. */
export const validateOut = (raw: string): Validation =>
  raw.trim() === '' ? true : viaSchema('out', raw);

/** A token is checked for being there and nothing else. Its validity is a question for the site,
 * and `src/setup/verify.ts` asks it. */
export const validateToken = (raw: string): Validation =>
  raw.trim() === '' ? 'an API token is needed to reach Jira' : true;

/**
 * The form state as a configuration to write.
 *
 * Merged onto whatever was loaded rather than built fresh, so a key this form does not offer — a
 * `filters` block, a `$schema` line — survives being edited here.
 */
export const toConfigFile = (
  loaded: Record<string, unknown>,
  state: FormState,
  projectRoot: string,
): Record<string, unknown> => ({
  ...loaded,
  project: projectRoot,
  ...(state.baseUrl ? { baseUrl: state.baseUrl } : {}),
  ...(state.email ? { email: state.email } : {}),
  ...(state.token ? { token: state.token } : {}),
  ...(state.out ? { out: state.out } : {}),
  ...(state.allowJql === undefined ? {} : { allowJql: state.allowJql }),
  ...(state.people ? { people: state.people } : {}),
});
