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

/** `### Kaspar Vollenweider — 2026-09-03T10:34:04.963+0200 (edited …)`.
 *
 * Both halves are optional. An anonymous comment, or one whose author the `people` config leaves
 * out, is headed by its date alone — absence is spelled by absence here too, rather than by a
 * placeholder like "Anonymous" that reads as a real name. */
function commentHeading(comment: JiraComment, people: PeopleConfig): string {
  const author = people.roles.includes('commenter')
    ? personLabel(comment.author, people)
    : undefined;
  const when = comment.created ?? '';
  const edited = comment.updated && comment.updated !== comment.created
    ? ` (edited ${comment.updated})`
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

  const convert = { assets, baseUrl };
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
