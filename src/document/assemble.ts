/** Assembles the final Markdown document: frontmatter, description, then comments separated by
 * `---` horizontal rules. */

import { adfToMarkdown } from "../adf/to_markdown.ts";
import { commentExcluded } from "../filter/evaluate.ts";
import type { CompiledFilters } from "../filter/rules.ts";
import type { AssetManifest, IssueRef, JiraComment, JiraIssue } from "../jira/types.ts";
import { buildFrontmatter, renderFrontmatter } from "./frontmatter.ts";

export interface AssembleInput {
  issue: JiraIssue;
  comments: JiraComment[];
  siblings: IssueRef[];
  assets: AssetManifest;
  baseUrl: string;
  filters: CompiledFilters;
  fetchedAt?: Date;
}

export interface AssembleResult {
  markdown: string;
  /** Comments dropped by a comment-author filter, for --verbose. */
  skippedComments: number;
}

function commentHeading(comment: JiraComment): string {
  const author = comment.author?.displayName ?? "Anonymous";
  const when = comment.created ?? "";
  const edited = comment.updated && comment.updated !== comment.created
    ? ` (edited ${comment.updated})`
    : "";
  return `### ${author}${when ? ` — ${when}` : ""}${edited}`;
}

export function assembleDocument(input: AssembleInput): AssembleResult {
  const { issue, comments, siblings, assets, baseUrl, filters } = input;

  const kept = comments.filter((c) => !commentExcluded(c, filters).excluded);

  const frontmatter = renderFrontmatter(
    buildFrontmatter({
      issue,
      baseUrl,
      siblings,
      assets,
      commentCount: kept.length,
      fetchedAt: input.fetchedAt,
    }),
  );

  const convert = { assets, baseUrl };
  const description = adfToMarkdown(issue.fields.description, convert);

  const parts = [
    frontmatter,
    `# ${issue.fields.summary ?? issue.key}`,
    description || "*No description.*",
  ];

  for (const comment of kept) {
    const body = adfToMarkdown(comment.body, convert);
    parts.push("---", `${commentHeading(comment)}\n\n${body || "*Empty comment.*"}`);
  }

  return {
    markdown: `${parts.join("\n\n")}\n`,
    skippedComments: comments.length - kept.length,
  };
}
