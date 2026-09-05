/** Filter evaluation.
 *
 * Three stages, because "never fetched at all" is only literally achievable for the project
 * prefix — every other predicate needs the issue payload:
 *
 *   1. `preFetchDecision`  — key alone, no API call at all.
 *   2. `ticketDecision`    — full issue JSON, run BEFORE comment pagination and before any
 *                            attachment download, which is where the cost and the disk writes are.
 *   3. `commentExcluded`   — per comment, while assembling the document.
 */

import type { JiraComment, JiraIssue, JiraUser } from '../jira/types.ts';
import type { CompiledFilters, CompiledTicketRule, MatchSet } from './rules.ts';

export interface Decision {
  excluded: boolean;
  /** Populated when excluded, for --verbose / --dry-run output. */
  reason?: string;
}

const KEEP: Decision = { excluded: false };

/** Resolves a configured field name ("Team") to the key it occupies in `issue.fields`
 * ("customfield_10101"). Returns undefined when the field does not exist on this site. */
export type FieldResolver = (name: string) => string | undefined;

/** The project prefix comes from the issue key, not `fields.project.key`. Reading the field
 * would demote this predicate to stage 2, and the two disagree after a project rename — old
 * keys keep resolving under the previous prefix. */
export function projectPrefix(key: string): string {
  const hyphen = key.lastIndexOf('-');
  return (hyphen === -1 ? key : key.slice(0, hyphen)).toUpperCase();
}

/** Flattens any Jira field value to comparable lowercase strings. Field values arrive as a bare
 * string, `{value}` for select lists, `{name}` for components and versions, `{displayName}` for
 * users, or arrays of any of those. An empty result means "absent". */
export function normalizeValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeValues);
  if (typeof value === 'string') return value.length > 0 ? [value.toLowerCase()] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ['value', 'name', 'displayName', 'emailAddress', 'accountId', 'key']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) out.push(v.toLowerCase());
    }
    return out;
  }
  return [];
}

/** A user matches on any of accountId, email or display name. Email is absent when the site
 * hides it, so none of the three can be relied on alone. An absent user yields []. */
export function userTokens(user: JiraUser | null | undefined): string[] {
  if (!user) return [];
  return normalizeValues(user);
}

function matches(match: MatchSet, tokens: string[]): boolean {
  if (tokens.length === 0) return match.allowAbsent;
  return tokens.some((t) => match.values.has(t));
}

function ruleMatchesIssue(
  rule: CompiledTicketRule,
  issue: JiraIssue,
  resolveField: FieldResolver,
): boolean {
  if (rule.project && !rule.project.has(projectPrefix(issue.key))) return false;

  if (rule.labels && !matches(rule.labels, normalizeValues(issue.fields.labels))) return false;

  if (rule.title) {
    if (!rule.title.test(issue.fields.summary ?? '')) return false;
  }

  if (rule.reporter && !matches(rule.reporter, userTokens(issue.fields.reporter))) return false;
  if (rule.assignee && !matches(rule.assignee, userTokens(issue.fields.assignee))) return false;

  for (const { name, match } of rule.field ?? []) {
    const key = resolveField(name);
    // An unresolvable field is treated as absent rather than as an error: a filter config shared
    // across Jira sites should not hard-fail on a site where the custom field does not exist.
    const raw = key === undefined ? undefined : issue.fields[key];
    if (!matches(match, normalizeValues(raw))) return false;
  }

  return true;
}

function ruleMatchesKey(rule: CompiledTicketRule, key: string): boolean {
  return !rule.project || rule.project.has(projectPrefix(key));
}

/**
 * Stage 1. Decides from the issue key alone, so a matching ticket is genuinely never requested.
 *
 * Include rules only participate here when *all* of them are pre-fetch rules — otherwise a
 * ticket might still satisfy an include rule that needs the payload, and dropping it now would
 * be wrong.
 */
export function preFetchDecision(key: string, filters: CompiledFilters): Decision {
  for (const rule of filters.exclude) {
    if (rule.preFetch && ruleMatchesKey(rule, key)) {
      return { excluded: true, reason: `matched exclude rule ${rule.label}` };
    }
  }

  if (filters.include.length > 0 && filters.include.every((r) => r.preFetch)) {
    if (!filters.include.some((r) => ruleMatchesKey(r, key))) {
      return { excluded: true, reason: 'matched no include rule' };
    }
  }

  return KEEP;
}

/**
 * Stage 2. Full evaluation against the issue payload. Must run before comments are paginated and
 * before any attachment is downloaded.
 */
export function ticketDecision(
  issue: JiraIssue,
  filters: CompiledFilters,
  resolveField: FieldResolver = () => undefined,
): Decision {
  // Exclude beats include, so it is evaluated first and short-circuits.
  for (const rule of filters.exclude) {
    if (ruleMatchesIssue(rule, issue, resolveField)) {
      return { excluded: true, reason: `matched exclude rule ${rule.label}` };
    }
  }

  if (filters.include.length > 0) {
    if (!filters.include.some((r) => ruleMatchesIssue(r, issue, resolveField))) {
      return { excluded: true, reason: 'matched no include rule' };
    }
  }

  return KEEP;
}

/** Stage 3. Drops the comment from the document; never the ticket. */
export function commentExcluded(comment: JiraComment, filters: CompiledFilters): Decision {
  for (const rule of filters.commentExclude) {
    if (rule.author && matches(rule.author, userTokens(comment.author))) {
      return { excluded: true, reason: `matched comment exclude rule ${rule.label}` };
    }
  }
  return KEEP;
}
