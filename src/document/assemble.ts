/** Assembles the final Markdown document: frontmatter, description, then comments separated by
 * `---` horizontal rules. */

import { adfToMarkdown, escapeText } from '../adf/to_markdown.ts';
import type { PeopleConfig } from '../config/schema.ts';
import { commentExcluded } from '../filter/evaluate.ts';
import type { CompiledFilters } from '../filter/rules.ts';
import type { AssetManifest, IssueRef, JiraComment, JiraIssue } from '../jira/types.ts';
import { buildFrontmatter, renderFrontmatter } from './frontmatter.ts';
import { personLabel } from './people.ts';

export interface AssembleInput {
  issue: JiraIssue;
  comments: JiraComment[];
  siblings: IssueRef[];
  assets: AssetManifest;
  baseUrl: string;
  filters: CompiledFilters;
  people: PeopleConfig;
  fetchedAt?: Date;
}

export interface AssembleResult {
  markdown: string;
  /** Comments dropped by a comment-author filter, for --verbose. */
  skippedComments: number;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/** `2026-09-03T10:34:04.963+0200` -> `2026-09-03 10:34`, for a heading a person reads.
 *
 * A textual trim, deliberately not a `Date` round-trip: it keeps the wall-clock time Jira sent,
 * which is the one the commenter saw, instead of shifting it to whatever timezone the machine
 * running the fetch happens to be in. Seconds and the offset are dropped because a heading is not
 * where anyone reconstructs an instant — `created_at` and `updated_at` in the frontmatter keep the
 * full stamp for that. Anything that does not match is passed through untouched rather than
 * mangled. */
const readable = (timestamp: string): string => {
  const match = TIMESTAMP.exec(timestamp);
  return match ? `${match[1]} ${match[2]}` : timestamp;
};

/** `### Kaspar Vollenweider — 2026-09-03 10:34 (edited 2026-09-03 10:38)`.
 *
 * Both halves are optional. An anonymous comment, or one whose author the `people` config leaves
 * out, is headed by its date alone — absence is spelled by absence here too, rather than by a
 * placeholder like "Anonymous" that reads as a real name. */
function commentHeading(comment: JiraComment, people: PeopleConfig): string {
  const author = people.roles.includes('commenter')
    ? personLabel(comment.author, people)
    : undefined;
  const when = comment.created ? readable(comment.created) : '';
  const edited = comment.updated && comment.updated !== comment.created
    ? ` (edited ${readable(comment.updated)})`
    : '';
  const head = [author, when].filter((part): part is string => Boolean(part)).join(' — ');
  return `### ${head || 'Comment'}${edited}`;
}

export function assembleDocument(input: AssembleInput): AssembleResult {
  const { issue, comments, siblings, assets, baseUrl, filters, people } = input;

  const kept = comments.filter((c) => !commentExcluded(c, filters).excluded);

  const frontmatter = renderFrontmatter(
    buildFrontmatter({
      issue,
      baseUrl,
      siblings,
      assets,
      commentCount: kept.length,
      people,
      fetchedAt: input.fetchedAt,
    }),
  );

  // One `assigned` map for the whole document: a media UUID matched in the description must
  // resolve to the same attachment when a comment embeds it again. See `findAsset`.
  const convert = { assets, baseUrl, assigned: new Map() };
  const description = adfToMarkdown(issue.fields.description, convert);

  // The heading carries the link the frontmatter used to spell out as `url`. Escaped with the
  // converter's own escaper, since a summary containing `[` would otherwise break the label.
  const title = issue.fields.summary ?? issue.key;
  const parts = [
    frontmatter,
    `# [${escapeText(title)}](${baseUrl}/browse/${issue.key})`,
    description || '*No description.*',
  ];

  for (const comment of kept) {
    const body = adfToMarkdown(comment.body, convert);
    parts.push('---', `${commentHeading(comment, people)}\n\n${body || '*Empty comment.*'}`);
  }

  return {
    markdown: `${parts.join('\n\n')}\n`,
    skippedComments: comments.length - kept.length,
  };
}
