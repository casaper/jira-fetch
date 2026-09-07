/** `jira-fetch filters`: building filter rules by picking from what the site actually has.
 *
 * Thin, because a menu cannot be driven by the suite. Every decision that could make a rule mean
 * something other than what was chosen lives in `filter_draft.ts` and `filter_render.ts`, which are
 * pure and tested; what is left here is which screen follows which.
 *
 * **Ctrl+C never returns here** — see `prompts.ts`. Nothing is written until the review screen is
 * confirmed, and the screens say so, so an interrupt costs the editing session and nothing else.
 */

import { loadProjectConfig } from '../config/config.ts';
import { ConfigError } from '../config/errors.ts';
import type { FiltersConfig, ValueMatcher } from '../config/schema.ts';
import { parseFilters } from '../config/schema.ts';
import { summarise } from '../cache/report.ts';
import { PROJECT_KEY } from '../cli/args.ts';
import { JiraClient } from '../jira/client.ts';
import { readConfigFileIfPresent, writeConfigFile } from './config_file.ts';
import {
  clearPredicate,
  draftIsEmpty,
  draftToFilters,
  draftToRule,
  emptyRuleDraft,
  type FiltersDraft,
  filtersToDraft,
  type PredicateKey,
  removeField,
  type RuleDraft,
  setFieldValues,
} from './filter_draft.ts';
import {
  choiceValuesToMatchers,
  COMMON_FIELDS,
  fieldChoiceList,
  filtersToLines,
  findField,
  nothingAvailable,
  predicateRows,
  resourceReport,
  ruleToText,
  testTitle,
  valueChoiceList,
} from './filter_render.ts';
import type { ChoiceList, LabelLookup } from './filter_render.ts';
import { ensureCache } from './ensure_cache.ts';
import type { ProjectChoice } from './ensure_cache.ts';
import { labelLookup, loadMetadataView } from './metadata.ts';
import type { MetadataView, NamedValue, Resource } from './metadata_view.ts';
import { askText, check, confirm, hasTerminal, type Item, pick, rule, say } from './prompts.ts';

export type FilterSetupOptions = {
  configPath: string;
  projectRoot: string;
  cacheDir: string;
  /** Injectable so the cache refresh can be pointed at a fake site; nothing but a test would. */
  fetch?: typeof fetch;
};

/** Project keys as typed by hand: upper-cased and split, so `dn, sup` is accepted. */
const splitKeys = (value: string): string[] =>
  value.split(',').map((key) => key.trim().toUpperCase()).filter((key) => key !== '');

/**
 * Which Jira projects the cache covers, and so which values this menu can offer.
 *
 * An empty offer is not a dead end. `GET /project/search` needs Browse Projects, and a token that
 * cannot list the site's projects can still read one it is told the key of — so the keys are typed
 * in that case rather than the screen being empty.
 */
const chooseProjects = async (offer: ProjectChoice[], current: string[]): Promise<string[]> => {
  say();
  if (offer.length === 0) {
    say('This token could not list the projects on this site, so name them yourself.');
    const answer = await askText({
      message: 'Jira project keys',
      hint: 'comma-separated, e.g. DN, SUP',
      ...(current.length > 0 ? { default: current.join(', ') } : {}),
      validate: (value) => {
        const keys = splitKeys(value);
        if (keys.length === 0) return 'name at least one project key';
        const bad = keys.find((key) => !PROJECT_KEY.test(key));
        return bad === undefined ? true : `"${bad}" is not a Jira project key`;
      },
    });
    return splitKeys(answer);
  }

  say('Components, versions, sprints, issue types and assignable people are per project, so this');
  say('decides what there is to pick from.');
  // No minimum. Choosing none is a real answer — someone filtering only on project keys and labels
  // needs nothing project-scoped, `loadMetadataView` handles an empty selection, and Escape is a
  // no-op at a prompt's top level, so a minimum here would leave Ctrl+C as the only way out.
  const chosen = await check<string>({
    message: 'Projects to offer values from',
    items: offer.map((project) => ({
      value: project.key,
      name: project.name ? `${project.key} — ${project.name}` : project.key,
      checked: current.includes(project.key),
    })),
    search: offer.length > 8,
  });
  if (chosen.length === 0) {
    say('  None chosen, so only site-wide values — labels, fields, priorities — will be offered.');
    say('  Projects on the main menu changes that.');
  }
  return chosen;
};

/**
 * The picker at menu open, which asks only while nothing is selected.
 *
 * Opening this menu to change one label rule must not walk through a project picker first, every
 * time. So a selection is asked for once and then reused and merely refreshed; **Projects** on the
 * main menu is how it changes.
 *
 * An empty selection is asked about again on the next open, since it is indistinguishable from
 * never having been asked. That is the better of the two: one Enter dismisses it, where the
 * alternative is a menu that silently offers no project values for ever.
 */
const chooseIfUnset = (offer: ProjectChoice[], current: string[]): Promise<string[]> =>
  current.length > 0 ? Promise.resolve(current) : chooseProjects(offer, current);

const BACK = Symbol('back');
type Back = typeof BACK;

/** A checkbox over one resource's values, plus "(absent)" and an escape for typing a value the
 * cache has not heard of. The escape is not a convenience: a partial cache must not become a cage.
 */
const pickValues = async (
  message: string,
  list: ChoiceList,
  /** What one of these values is called, for the "type one" prompt: "label", "project key". */
  noun: string,
): Promise<ValueMatcher[]> => {
  const TYPE_ONE = 'type a value not listed here…';
  if (list.note) say(`  ${list.note}`);

  const items: Array<Item<string>> = list.items.map((choice) => ({
    value: choice.value,
    name: choice.name,
    ...(choice.checked ? { checked: true } : {}),
  }));
  items.push(rule(), { value: TYPE_ONE, name: TYPE_ONE });

  const chosen = await check({ message, items, search: list.items.length > 8 });
  const values = choiceValuesToMatchers(chosen.filter((value) => value !== TYPE_ONE));

  if (!chosen.includes(TYPE_ONE)) return values;

  const typed = await askText({
    message: `  ${noun}, or several separated by commas`,
    hint: 'a value no ticket has makes the rule match nothing',
  });
  const extra = typed.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  return [...values, ...extra];
};

/** Shorthand: every picker in this file wants the same three arguments. */
const valuesFor = (
  resource: Resource<NamedValue>,
  selected: ValueMatcher[],
  absentLabel: string,
): ChoiceList => valueChoiceList(resource, selected, { absentLabel });

/** Which resource a field's values should be offered from, where the field is a built-in that the
 * cache tracks separately. Anything else falls back to the field's own `allowedValues`.
 *
 * Keyed on the **display name**, deliberately, even though the rule records the id: a built-in's id
 * is not its name (`Issue Type` is `issuetype`), and `Sprint` is a custom field id entirely. */
const resourceForField = (view: MetadataView, name: string): Resource<NamedValue> | undefined => {
  switch (name.toLowerCase()) {
    case 'status':
      return view.statuses;
    case 'issue type':
      return view.issueTypes;
    case 'components':
      return view.components;
    case 'priority':
      return view.priorities;
    case 'sprint':
      return view.sprints;
    case 'labels':
      return view.labels;
    case 'fix version/s':
    case 'fix versions':
      return view.versions;
    default:
      return undefined;
  }
};

const editTitle = async (draft: RuleDraft): Promise<RuleDraft> => {
  const matches = await askText({
    message: '  Regular expression on the summary',
    ...(draft.title ? { default: draft.title.matches } : {}),
    hint: 'e.g. ^spike: — left blank, the condition is dropped',
  });
  if (matches.trim() === '') return clearPredicate(draft, 'title');

  const flags = await check({
    message: '  Flags',
    items: [
      { value: 'i', name: 'i — ignore case', checked: draft.title?.flags.includes('i') },
      {
        value: 'm',
        name: 'm — ^ and $ match each line',
        checked: draft.title?.flags.includes('m'),
      },
      { value: 's', name: 's — . matches a newline', checked: draft.title?.flags.includes('s') },
      { value: 'u', name: 'u — unicode', checked: draft.title?.flags.includes('u') },
    ],
  });
  const title = { matches: matches.trim(), flags: flags.join('') };

  // Trying it is optional and cheap, and a pattern that does not do what its author meant is the
  // one filter mistake nothing downstream can catch.
  const sample = await askText({
    message: '  A summary to try it on',
    hint: 'leave blank to skip',
  });
  if (sample.trim() !== '') {
    say(`  ${testTitle(title, sample) ? 'matches' : 'does not match'}: ${sample}`);
  }
  return { ...draft, title };
};

const editFieldPredicate = async (
  draft: RuleDraft,
  view: MetadataView,
): Promise<RuleDraft> => {
  const list = fieldChoiceList(view.fields, COMMON_FIELDS);
  if (list.note) say(`  ${list.note}`);
  say('  Recorded by id and shown by name. A field the site does not have, or one that two fields');
  say('  share the name of, stops the run — a condition that quietly matches nothing is worse.');

  const items: Array<Item<string | Back>> = list.items.map((choice) => ({
    value: choice.value,
    name: choice.name,
  }));
  items.push(rule(), { value: BACK, name: '‹ back' });

  const picked = await pick<string | Back>({
    message: '  Which field',
    items,
    search: list.items.length > 8,
  });
  if (picked === BACK) return draft;

  // The picker hands back an id; a draft loaded from a hand-written config may hold a display name.
  // Both spellings are the same predicate, so resolving here is what stops an already-configured
  // field opening with nothing ticked and a save producing two entries for it.
  const own = findField(view.fields, picked);
  const key = own?.id ?? picked;
  const shown = own?.name ?? picked;
  const same = (spelling: string): boolean =>
    spelling.toLowerCase() === key.toLowerCase() ||
    (own !== undefined && spelling.toLowerCase() === own.name.toLowerCase());

  const existing = draft.field.find((entry) => same(entry.name))?.values ?? [];
  const resource = resourceForField(view, shown);
  const valueList = resource
    ? valuesFor(resource, existing, '(absent — the field is unset)')
    : own?.allowedValues
    ? valuesFor(
      { status: view.fields.status, items: own.allowedValues },
      existing,
      '(absent — the field is unset)',
    )
    : valuesFor(
      {
        status: 'unavailable',
        reason: `this site does not publish the values for "${shown}", so they are typed`,
        items: [],
      },
      existing,
      '(absent — the field is unset)',
    );

  const values = await pickValues(`  Accepted values for ${shown}`, valueList, 'value');
  return values.length === 0
    ? removeField(draft, key, same)
    : setFieldValues(draft, key, values, same);
};

/** One rule, edited until it is done or abandoned. */
const editRule = async (
  initial: RuleDraft,
  view: MetadataView,
  labels: LabelLookup,
  what: 'include' | 'exclude',
): Promise<RuleDraft | undefined> => {
  let draft = initial;
  for (;;) {
    say();
    say(
      what === 'include'
        ? 'An include rule: a ticket must match one of them to be fetched.'
        : 'An exclude rule: matching any of them drops the ticket. Exclude beats include.',
    );
    say('Every condition below must hold for this rule to match.');

    const rows = predicateRows(draft, labels);
    const width = Math.max(...rows.map((row) => row.label.length));
    const items: Array<Item<PredicateKey | 'done' | 'cancel'>> = rows.map((row) => ({
      value: row.key,
      name: `${row.label.padEnd(width)}  ${row.value}`,
    }));
    items.push(rule());
    items.push({
      value: 'done',
      name: draftIsEmpty(draft) ? 'Done — but nothing is set, so no rule is added' : 'Done',
    });
    items.push({ value: 'cancel', name: 'Cancel this rule' });

    const chosen = await pick({ message: `${what} rule`, items });
    if (chosen === 'cancel') return undefined;
    if (chosen === 'done') return draftIsEmpty(draft) ? undefined : draft;

    switch (chosen) {
      case 'project': {
        say('  The only condition decidable from the key alone, so a ticket it rules out is never');
        say('  requested from Jira at all.');
        const values = await pickValues(
          '  Projects',
          valuesFor(view.projects, draft.project, '(no project — impossible; ignore this)'),
          'project key',
        );
        draft = {
          ...draft,
          project: values.filter((value): value is string => value !== null),
        };
        break;
      }
      case 'labels': {
        const values = await pickValues(
          '  Labels',
          valuesFor(view.labels, draft.labels, '(absent — the ticket has no labels)'),
          'label',
        );
        draft = { ...draft, labels: values };
        break;
      }
      case 'field':
        draft = await editFieldPredicate(draft, view);
        break;
      case 'title':
        draft = await editTitle(draft);
        break;
      case 'reporter': {
        const values = await pickValues(
          '  Reporter',
          valuesFor(view.users, draft.reporter, '(absent — an anonymous portal submission)'),
          'name, email or account id',
        );
        draft = { ...draft, reporter: values };
        break;
      }
      case 'assignee': {
        const values = await pickValues(
          '  Assignee',
          valuesFor(view.users, draft.assignee, '(absent — unassigned)'),
          'name, email or account id',
        );
        draft = { ...draft, assignee: values };
        break;
      }
    }
  }
};

/** One list of rules — include or exclude — with per-rule edit and removal. */
const editRuleList = async (
  drafts: RuleDraft[],
  view: MetadataView,
  labels: LabelLookup,
  what: 'include' | 'exclude',
): Promise<RuleDraft[]> => {
  let rules = [...drafts];
  for (;;) {
    const items: Array<Item<number | 'add' | 'back'>> = rules.map((draft, index) => {
      const asRule = draftToRule(draft);
      return {
        value: index,
        name: asRule ? ruleToText(asRule, labels) : 'nothing set',
      };
    });
    items.push(rule());
    items.push({ value: 'add', name: '+ add a rule' });
    items.push({ value: 'back', name: '‹ back' });

    const chosen = await pick({ message: `${what} rules`, items });
    if (chosen === 'back') return rules;

    if (chosen === 'add') {
      const built = await editRule(emptyRuleDraft(), view, labels, what);
      if (built) rules = [...rules, built];
      continue;
    }

    const action = await pick<'edit' | 'remove' | 'back'>({
      message: '  This rule',
      items: [
        { value: 'edit', name: 'Edit it' },
        { value: 'remove', name: 'Remove it' },
        { value: 'back', name: '‹ back' },
      ],
    });
    if (action === 'remove') {
      rules = rules.filter((_, index) => index !== chosen);
    } else if (action === 'edit') {
      const edited = await editRule(rules[chosen], view, labels, what);
      rules = edited
        ? rules.map((existing, index) => index === chosen ? edited : existing)
        : rules.filter((_, index) => index !== chosen);
    }
  }
};

const editCommentAuthors = async (
  authors: ValueMatcher[],
  view: MetadataView,
): Promise<ValueMatcher[]> => {
  say();
  say('Comment filters drop comments, never the ticket, and are exclude-only by design: an');
  say('include list would mean "drop every comment not explicitly allowed", which is a footgun');
  say('on a document meant to be an archive.');
  return await pickValues(
    '  Authors to leave out',
    valuesFor(view.users, authors, '(absent — an anonymous author)'),
    'name, email or account id',
  );
};

/** Runs the filter menu. Returns the process exit code. */
export const runFilterSetup = async (opts: FilterSetupOptions): Promise<number> => {
  if (!hasTerminal()) {
    throw new ConfigError(
      'jira-fetch filters needs a terminal.\n' +
        `  To see the file it would change: jira-fetch config-file\n  ${opts.configPath}`,
    );
  }

  // loadProjectConfig rather than a bare read, because it runs assertProjectMatches: projectSlug
  // is not injective, and rewriting a file that declares another project would clobber somebody
  // else's filters.
  const file = await loadProjectConfig(opts.configPath, opts.projectRoot);
  // All three, because this menu now reads the site to find out what there is to filter on rather
  // than only editing a file. Naming the missing ones beats a 401 three screens later. Destructured
  // so the three are `string` from here on without an assertion.
  const { baseUrl, email, token } = file;
  if (!baseUrl || !email || !token) {
    const missing = [['baseUrl', baseUrl], ['email', email], ['token', token]]
      .filter(([, value]) => !value)
      .map(([key]) => key);
    throw new ConfigError(
      `${opts.configPath} has no ${missing.join(', ')} yet — run jira-fetch setup first`,
    );
  }

  say();
  say(`Filters for ${opts.projectRoot}`);
  say(`  ${opts.configPath}`);

  const client = new JiraClient({
    baseUrl,
    email,
    token,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });

  /**
   * Fill the cache, then read it back.
   *
   * Both halves together, always: a refresh without a re-read would leave the menu offering the
   * values it had before, which is the failure that is hardest to notice. The refresh skips
   * anything still inside its TTL, so opening this menu twice in a minute costs no requests the
   * second time.
   */
  const load = async (
    choose: (offer: ProjectChoice[], current: string[]) => Promise<string[]>,
  ): Promise<{ view: MetadataView; projectKeys: string[] }> => {
    say();
    say('Reading what this site has to filter on. This can take a few seconds; anything already');
    say('cached and still current is not fetched again.');
    const ensured = await ensureCache({
      client,
      cacheDir: opts.cacheDir,
      project: opts.projectRoot,
      baseUrl,
      now: () => Date.now(),
      // The cache's own log is the --verbose channel and speaks in cache terms; a menu should not
      // relay it. What happened is reported below, in the words `jira-fetch cache` uses.
      log: () => {},
      chooseProjects: choose,
    });

    say();
    if (ensured.failure !== undefined) {
      // A Jira failure is a note on a resource, never a throw, so only a cache directory that
      // cannot be written reaches here. Whatever is already on disk is still usable.
      say(`The cache could not be written: ${ensured.failure}`);
      say('Carrying on with whatever was cached before.');
      say();
    }

    const view = await loadMetadataView({
      cacheDir: opts.cacheDir,
      project: opts.projectRoot,
      baseUrl,
      projectKeys: ensured.projectKeys,
      now: () => Date.now(),
    });

    // The view rather than the refresh outcomes: this screen answers "what can I pick from", and
    // every reason a list is short travels with it. `summarise` adds the half the view cannot
    // know — how much of that came off the wire just now rather than out of the cache.
    say('What this site has to filter on');
    for (const line of resourceReport(view)) say(line);
    if (ensured.failure === undefined) say(`  ${summarise(ensured.outcomes)}`);

    return { view, projectKeys: ensured.projectKeys };
  };

  let loaded = await load(chooseIfUnset);
  let view = loaded.view;
  let projectKeys = loaded.projectKeys;

  if (nothingAvailable(view)) {
    say();
    say('Nothing could be read from this site, so there is nothing to pick from. That usually');
    say('means the credentials are wrong, or the token may not browse these projects.');
    if (!await confirm({ message: 'Carry on and type every value by hand?', default: false })) {
      say('Nothing was written.');
      return 0;
    }
  }

  let labels = labelLookup(view);
  let draft: FiltersDraft = filtersToDraft(file.filters);

  say();
  say('Filters decide which tickets may be fetched — by the CLI and by an agent through the MCP');
  say('server alike. Nothing is written until you confirm.');

  for (;;) {
    const current = draftToFilters(draft);
    say();
    for (const line of filtersToLines(current, labels)) say(line);

    const chosen = await pick<
      'include' | 'exclude' | 'comments' | 'projects' | 'save' | 'quit'
    >({
      message: 'Filters',
      items: [
        {
          value: 'include',
          name: `Include — a ticket must match one of these   (${draft.include.length})`,
        },
        {
          value: 'exclude',
          name: `Exclude — matching any of these drops it      (${draft.exclude.length})`,
        },
        {
          value: 'comments',
          name: `Comments — authors to leave out              (${draft.commentAuthors.length})`,
        },
        rule(),
        {
          value: 'projects',
          name: `Projects — where values are offered from     (${
            projectKeys.length > 0 ? projectKeys.join(', ') : 'none'
          })`,
        },
        rule(),
        { value: 'save', name: 'Review and save' },
        { value: 'quit', name: 'Discard and quit' },
      ],
    });

    if (chosen === 'quit') {
      say('Nothing was written.');
      return 0;
    }
    if (chosen === 'include') {
      draft = { ...draft, include: await editRuleList(draft.include, view, labels, 'include') };
      continue;
    }
    if (chosen === 'exclude') {
      draft = { ...draft, exclude: await editRuleList(draft.exclude, view, labels, 'exclude') };
      continue;
    }
    if (chosen === 'comments') {
      draft = { ...draft, commentAuthors: await editCommentAuthors(draft.commentAuthors, view) };
      continue;
    }
    if (chosen === 'projects') {
      loaded = await load(chooseProjects);
      view = loaded.view;
      projectKeys = loaded.projectKeys;
      labels = labelLookup(view);
      continue;
    }

    const filters = draftToFilters(draft);
    say();
    say('Save these filters?');
    for (const line of filtersToLines(filters, labels)) say(line);
    say();
    say('  Nothing has been written yet.');

    // Removing every filter widens what an agent may fetch, so it takes a deliberate second
    // answer rather than falling out of an empty form.
    if (filters === undefined && file.filters !== undefined) {
      say();
      say('This removes every filter. Any ticket your token can see becomes fetchable — by you');
      say('and by an agent through the MCP server.');
      if (!await confirm({ message: 'Really save?', default: false })) continue;
    } else if (!await confirm({ message: 'Save', default: true })) {
      continue;
    }

    if (filters !== undefined) {
      // Through the loader's own gate, so a rule this menu built cannot be one the tool refuses.
      try {
        parseFilters(filters, opts.configPath);
      } catch (cause) {
        say(`Not saved: ${(cause as Error).message}`);
        continue;
      }
    }

    // Merged onto the file as it is on disk, never built fresh: writeConfigFile re-reads nothing,
    // so a fresh object would drop the token.
    const onDisk = await readConfigFileIfPresent(opts.configPath) ?? file;
    const next = { ...onDisk, project: opts.projectRoot } as Record<string, unknown>;
    if (filters === undefined) delete next.filters;
    else next.filters = filters as FiltersConfig;

    try {
      await writeConfigFile(opts.configPath, next as Parameters<typeof writeConfigFile>[1]);
    } catch (cause) {
      say(`Not saved: ${(cause as Error).message}`);
      continue;
    }
    say();
    say(`Saved ${opts.configPath}`);
    return 0;
  }
};
