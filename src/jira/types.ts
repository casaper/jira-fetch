/** Shapes of the Jira Cloud REST v3 payloads this tool reads. Partial by design: only the
 * fields that are actually consumed are declared. */

/** A node in an Atlassian Document Format tree. Recursive and open-ended — unknown `type`s are
 * expected and must degrade gracefully rather than throw. */
export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** `null` whenever the account is absent — an anonymous portal reporter, or an unassigned issue.
 * That null is meaningful to the filter engine, so it is never normalised away. */
export interface JiraUser {
  accountId?: string;
  emailAddress?: string;
  displayName?: string;
  active?: boolean;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  /** Authenticated URL for the bytes; redirects to blob storage. */
  content: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: JiraUser | null;
}

export interface JiraComment {
  id: string;
  author?: JiraUser | null;
  updateAuthor?: JiraUser | null;
  /** ADF document. */
  body?: AdfNode;
  created?: string;
  updated?: string;
}

export interface IssueRef {
  id?: string;
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string } | null;
    issuetype?: { name?: string } | null;
  };
}

export interface JiraIssueFields {
  summary?: string;
  description?: AdfNode | null;
  created?: string;
  updated?: string;
  reporter?: JiraUser | null;
  assignee?: JiraUser | null;
  creator?: JiraUser | null;
  issuetype?: { name?: string; subtask?: boolean } | null;
  status?: { name?: string } | null;
  priority?: { name?: string } | null;
  resolution?: { name?: string } | null;
  project?: { key?: string; name?: string } | null;
  parent?: IssueRef | null;
  subtasks?: IssueRef[];
  labels?: string[];
  components?: Array<{ name?: string }>;
  fixVersions?: Array<{ name?: string }>;
  attachment?: JiraAttachment[];
  /** Custom fields arrive as `customfield_NNNNN` alongside the named ones. */
  [key: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: JiraIssueFields;
}

/** One entry from `GET /rest/api/3/field`, used to resolve a human field name such as "Team"
 * to the `customfield_NNNNN` key it occupies in `fields`. */
export interface JiraFieldMeta {
  id: string;
  key?: string;
  name: string;
  custom: boolean;
  clauseNames?: string[];
}

/** Attachment manifest entry: what the ADF converter needs to turn a `media` node's bare
 * attachment id into a working relative link. */
export interface AssetEntry {
  id: string;
  /** Sanitised, collision-free name as written inside the asset directory. */
  filename: string;
  /** Path relative to the Markdown file, e.g. `.DN-1243/screenshot.png`. */
  relativePath: string;
  contentUrl: string;
  mimeType?: string;
  size?: number;
}

export type AssetManifest = Map<string, AssetEntry>;
