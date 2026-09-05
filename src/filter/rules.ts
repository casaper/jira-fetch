/** Compiles validated filter configuration into the form the evaluator uses.
 *
 * Validation lives in src/config/schema.ts — the Zod schema is the single source of truth for
 * both the TypeScript types and the published JSON Schema. By the time a rule reaches this
 * module it is already known to be well-formed, so everything here is pure shaping: lowercasing
 * for case-insensitive comparison, compiling regexes, and working out which rules can be decided
 * from the issue key alone.
 */

import type { CommentRule, FiltersConfig, TicketRule, ValueMatcher } from "../config/schema.ts";

export type { CommentRule, FiltersConfig, TicketRule, ValueMatcher };
export { ConfigError } from "../config/errors.ts";

/** A set of accepted values plus whether "absent" (`null` in the config) is one of them. */
export interface MatchSet {
  values: Set<string>;
  allowAbsent: boolean;
}

/**
 * The compiled counterpart of each predicate.
 *
 * These runtime forms cannot be `z.infer`red: a `Set` and a `RegExp` have no JSON Schema
 * representation, which is exactly why they are not in the schema. What they *can* do is take
 * their key set from the Zod type — `Record<keyof TicketRule, unknown>` means adding a predicate
 * to the schema fails to compile here until it is given a compiled form and handled below. The
 * schema stays the single source of truth for which predicates exist.
 */
type PredicateForms = {
  project: Set<string>;
  labels: MatchSet;
  /** Folded into `labels` during compilation; it is an alias, not a second predicate. */
  tags: never;
  field: Array<{ name: string; match: MatchSet }>;
  title: RegExp;
  reporter: MatchSet;
  assignee: MatchSet;
} extends infer T ? T extends Record<keyof TicketRule, unknown> ? T : never : never;

export type CompiledTicketRule =
  & { [K in Exclude<keyof TicketRule, "tags">]?: PredicateForms[K] }
  & {
    /** True when every predicate in this rule is decidable from the issue key alone. */
    preFetch: boolean;
    /** Human-readable form of the rule, for --verbose skip reasons. */
    label: string;
  };

export type CompiledCommentRule =
  & { [K in keyof Required<CommentRule>]: MatchSet }
  & { label: string };

export interface CompiledFilters {
  include: CompiledTicketRule[];
  exclude: CompiledTicketRule[];
  commentExclude: CompiledCommentRule[];
  /** Field names needing resolution against `GET /rest/api/3/field`. Empty means the endpoint
   * is never called. */
  fieldNames: string[];
}

function buildMatchSet(raw: ValueMatcher[]): MatchSet {
  const values = new Set<string>();
  let allowAbsent = false;
  for (const entry of raw) {
    if (entry === null) allowAbsent = true;
    else values.add(entry.toLowerCase());
  }
  return { values, allowAbsent };
}

function compileTicketRule(rule: TicketRule): CompiledTicketRule {
  const compiled: CompiledTicketRule = {
    preFetch: Object.keys(rule).every((k) => k === "project"),
    label: JSON.stringify(rule),
  };

  if (rule.project) {
    compiled.project = new Set(rule.project.map((p) => p.toUpperCase()));
  }

  const labels = rule.labels ?? rule.tags;
  if (labels) compiled.labels = buildMatchSet(labels);

  if (rule.field) {
    compiled.field = Object.entries(rule.field).map(([name, values]) => ({
      name,
      match: buildMatchSet(values),
    }));
  }

  if (rule.title) compiled.title = new RegExp(rule.title.matches, rule.title.flags ?? "");
  if (rule.reporter) compiled.reporter = buildMatchSet(rule.reporter);
  if (rule.assignee) compiled.assignee = buildMatchSet(rule.assignee);

  return compiled;
}

function compileCommentRule(rule: CommentRule): CompiledCommentRule {
  return { author: buildMatchSet(rule.author), label: JSON.stringify(rule) };
}

export function compileFilters(config: FiltersConfig | undefined): CompiledFilters {
  const include = (config?.include ?? []).map(compileTicketRule);
  const exclude = (config?.exclude ?? []).map(compileTicketRule);
  const commentExclude = (config?.comments?.exclude ?? []).map(compileCommentRule);

  const fieldNames = new Set<string>();
  for (const rule of [...include, ...exclude]) {
    for (const f of rule.field ?? []) fieldNames.add(f.name);
  }

  return { include, exclude, commentExclude, fieldNames: [...fieldNames] };
}

export function hasAnyFilter(filters: CompiledFilters): boolean {
  return filters.include.length > 0 || filters.exclude.length > 0 ||
    filters.commentExclude.length > 0;
}
