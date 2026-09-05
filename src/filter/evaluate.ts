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
 * ("customfield_10101").
 *
 * `undefined` means the name resolved to no field, or to more than one. `makeFieldResolver` in
 * `src/fetch/session.ts` rejects both at startup for every name the filters mention, so by the
 * time a real run reaches here it cannot happen; the branch below is for the default resolver and
 * for direct callers in tests. */
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
    // Reads as absent, which for an exclude rule means "does not match" — i.e. denies nothing.
    // That is why an unresolvable name is refused at startup rather than tolerated here: a deny
    // rule that quietly denies nothing is the worst way for this to be wrong.
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
 * An **exclude** rule participates only when every one of its predicates is decidable from the
 * key, since a rule that still has a label or a field to check might not match at all.
 *
 * An **include** rule participates on the opposite footing: what matters is not whether the rule
 * could match, but whether it could *fail*. A rule carrying a `project` predicate the key does not
 * satisfy can never match, whatever the payload turns out to say — the remaining predicates cannot
 * rescue it, because every predicate in a rule must hold. So when every include rule is ruled out
 * that way, the ticket is unreachable and is dropped without being requested.
 *
 * That is strictly more than the older test, "every include rule is project-only", which let
 * `include: [{project: [DN], labels: [x]}]` fetch a SUP ticket in full before discarding it. It
 * matters beyond the wasted request: under the MCP server these rules are what an agent's access
 * is decided by, and a ticket that is going to be denied should not be read with the user's
 * credentials on the way to denying it.
 */
export function preFetchDecision(key: string, filters: CompiledFilters): Decision {
  for (const rule of filters.exclude) {
    if (rule.preFetch && ruleMatchesKey(rule, key)) {
      return { excluded: true, reason: `matched exclude rule ${rule.label}` };
    }
  }

  const prefix = projectPrefix(key);
  const unreachable = (rule: CompiledTicketRule) =>
    rule.project !== undefined && !rule.project.has(prefix);

  if (filters.include.length > 0 && filters.include.every(unreachable)) {
    return { excluded: true, reason: 'matched no include rule' };
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
