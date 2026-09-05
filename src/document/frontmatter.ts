/** Builds the YAML frontmatter block: everything about the ticket that is worth having in a
 * machine-readable form. */

import { stringify as stringifyYaml } from "@std/yaml";
import type { AssetManifest, IssueRef, JiraIssue, JiraUser } from "../jira/types.ts";

export interface UserRecord {
  name?: string;
  email?: string;
  account_id?: string;
}

/** Anonymous reporters (portal submissions) and unassigned issues stay `null` rather than
 * becoming an empty object, so downstream tooling can tell "absent" from "unknown". */
function user(u: JiraUser | null | undefined): UserRecord | null {
  if (!u) return null;
  const record: UserRecord = {};
  if (u.displayName) record.name = u.displayName;
  if (u.emailAddress) record.email = u.emailAddress;
  if (u.accountId) record.account_id = u.accountId;
  return Object.keys(record).length > 0 ? record : null;
}

function ref(r: IssueRef | null | undefined) {
  if (!r?.key) return null;
  return {
    key: r.key,
    title: r.fields?.summary ?? null,
    type: r.fields?.issuetype?.name ?? null,
    status: r.fields?.status?.name ?? null,
  };
}

function names(list: Array<{ name?: string }> | undefined): string[] {
  return (list ?? []).map((v) => v.name).filter((n): n is string => typeof n === "string");
}

export interface FrontmatterInput {
  issue: JiraIssue;
  baseUrl: string;
  /** Other children of the same parent, excluding this issue. */
  siblings: IssueRef[];
  assets: AssetManifest;
  commentCount: number;
  fetchedAt?: Date;
}

export function buildFrontmatter(input: FrontmatterInput): Record<string, unknown> {
  const { issue, baseUrl, siblings, assets, commentCount } = input;
  const f = issue.fields;

  return {
    id: issue.key,
    internal_id: issue.id,
    title: f.summary ?? null,
    url: `${baseUrl}/browse/${issue.key}`,
    type: f.issuetype?.name ?? null,
    status: f.status?.name ?? null,
    priority: f.priority?.name ?? null,
    resolution: f.resolution?.name ?? null,
    project: f.project?.key ?? null,
    project_name: f.project?.name ?? null,
    // `author` is the reporter — who raised the ticket, which is what the word means here.
    author: f.reporter?.displayName ?? null,
    reporter: user(f.reporter),
    assignee: user(f.assignee),
    creator: user(f.creator),
    created_at: f.created ?? null,
    updated_at: f.updated ?? null,
    fetched_at: (input.fetchedAt ?? new Date()).toISOString(),
    labels: f.labels ?? [],
    components: names(f.components),
    fix_versions: names(f.fixVersions),
    parent: ref(f.parent),
    siblings: siblings.map((s) => s.key),
    subtasks: (f.subtasks ?? []).map(ref).filter((s) => s !== null),
    comment_count: commentCount,
    assets: [...assets.values()].map((a) => ({
      filename: a.filename,
      path: a.relativePath,
      mime_type: a.mimeType ?? null,
      size: a.size ?? null,
    })),
  };
}

export function renderFrontmatter(data: Record<string, unknown>): string {
  // lineWidth: -1 disables folding. A width of 0 would fold *every* string into a block scalar,
  // turning `id: DN-1243` into an unreadable `id: >-` block.
  const yaml = stringifyYaml(data, { lineWidth: -1, skipInvalid: true }).trimEnd();
  return `---\n${yaml}\n---`;
}
