/** Atlassian Document Format -> Markdown.
 *
 * ADF is a recursive, open-ended node tree: Jira sites gain node types from apps and from
 * Atlassian itself. Unknown nodes therefore degrade to their text content instead of throwing,
 * so one unfamiliar macro can never fail a whole fetch.
 *
 * The converter needs the attachment manifest: a `media` node carries only an attachment id, and
 * the filename and download URL live in `fields.attachment[]`. See src/assets/download.ts, which
 * builds the manifest, and note that comment bodies carry `media` nodes too.
 */

import type { AdfNode, AssetManifest } from "../jira/types.ts";

export interface ConvertOptions {
  assets?: AssetManifest;
  /** Absolute Jira base URL, used to build a fallback link for media with no manifest entry. */
  baseUrl?: string;
}

const IMAGE_MIME = /^image\//;

/** Escapes the characters that would otherwise be read as Markdown syntax. Deliberately narrow:
 * over-escaping turns readable prose into backslash soup. */
function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : prefix.trimEnd()))
    .join("\n");
}

class Converter {
  constructor(private readonly opts: ConvertOptions) {}

  /** Block-level nodes, joined by a blank line. */
  blocks(nodes: AdfNode[] | undefined): string {
    if (!nodes) return "";
    return nodes
      .map((node) => this.block(node))
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
  }

  private block(node: AdfNode): string {
    switch (node.type) {
      case "doc":
        return this.blocks(node.content);

      case "paragraph":
        return this.inline(node.content);

      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
        return `${"#".repeat(level)} ${this.inline(node.content)}`;
      }

      case "bulletList":
      case "orderedList":
        return this.list(node, 0);

      case "codeBlock": {
        const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
        const code = (node.content ?? []).map((c) => c.text ?? "").join("");
        // Widen the fence past any run of backticks inside the code.
        const longest = [...code.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        return `${fence}${lang}\n${code}\n${fence}`;
      }

      case "blockquote":
        return indent(this.blocks(node.content), "> ");

      case "panel": {
        const kind = typeof node.attrs?.panelType === "string" ? node.attrs.panelType : "info";
        const body = this.blocks(node.content);
        return indent(`**${kind.toUpperCase()}**\n\n${body}`, "> ");
      }

      case "rule":
        // A horizontal rule inside a body would collide with the `---` that separates comments,
        // so it is rendered with a different (still valid) marker.
        return "***";

      case "table":
        return this.table(node);

      case "mediaSingle":
      case "mediaGroup":
        return (node.content ?? []).map((c) => this.media(c)).join("\n\n");

      case "media":
        return this.media(node);

      case "expand":
      case "nestedExpand": {
        const title = typeof node.attrs?.title === "string" ? node.attrs.title : "Details";
        return `<details>\n<summary>${escapeText(title)}</summary>\n\n${
          this.blocks(node.content)
        }\n\n</details>`;
      }

      case "taskList":
      case "decisionList":
        return (node.content ?? []).map((item) => this.taskItem(item)).join("\n");

      case "taskItem":
      case "decisionItem":
        return this.taskItem(node);

      case "listItem":
        return this.blocks(node.content);

      case "text":
        return this.inline([node]);

      default:
        // Unknown block: keep whatever content it holds rather than dropping it.
        return node.content ? this.blocks(node.content) : escapeText(node.text ?? "");
    }
  }

  private taskItem(node: AdfNode): string {
    const done = node.attrs?.state === "DONE" || node.attrs?.state === "DECIDED";
    return `- [${done ? "x" : " "}] ${this.inline(node.content)}`;
  }

  private list(node: AdfNode, depth: number): string {
    const ordered = node.type === "orderedList";
    const start = Number(node.attrs?.order ?? 1);
    const pad = "  ".repeat(depth);

    return (node.content ?? [])
      .map((item, i) => {
        const marker = ordered ? `${start + i}.` : "-";
        const parts: string[] = [];
        let text = "";

        for (const child of item.content ?? []) {
          if (child.type === "bulletList" || child.type === "orderedList") {
            parts.push(this.list(child, depth + 1));
          } else if (text === "") {
            text = this.block(child);
          } else {
            // Continuation paragraph inside the list item.
            parts.push(indent(this.block(child), `${pad}  `));
          }
        }

        const head = `${pad}${marker} ${indent(text, `${pad}  `).trimStart()}`;
        return [head, ...parts].join("\n");
      })
      .join("\n");
  }

  private table(node: AdfNode): string {
    const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
    if (rows.length === 0) return "";

    const grid = rows.map((row) =>
      (row.content ?? []).map((cell) => escapeCell(this.blocks(cell.content)))
    );
    const width = grid.reduce((n, row) => Math.max(n, row.length), 0);
    const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];

    const headerIsReal = (rows[0].content ?? []).some((c) => c.type === "tableHeader");
    const header = headerIsReal ? pad(grid[0]) : Array(width).fill("");
    const body = headerIsReal ? grid.slice(1) : grid;

    return [
      `| ${header.join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...body.map((row) => `| ${pad(row).join(" | ")} |`),
    ].join("\n");
  }

  private media(node: AdfNode): string {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : undefined;
    const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : undefined;
    const entry = id ? this.opts.assets?.get(id) : undefined;

    if (entry) {
      const label = escapeText(alt ?? entry.filename);
      const isImage = IMAGE_MIME.test(entry.mimeType ?? "");
      const link = `[${label}](${encodeURI(entry.relativePath)})`;
      return isImage ? `!${link}` : link;
    }

    // Media whose attachment is not in the manifest: an external URL, a deleted attachment, or
    // one on an issue the token cannot see. Keep a visible marker rather than dropping content.
    const url = typeof node.attrs?.url === "string" ? node.attrs.url : undefined;
    if (url) return `![${escapeText(alt ?? "media")}](${encodeURI(url)})`;
    return `*[missing attachment${id ? ` ${id}` : ""}]*`;
  }

  /** Inline nodes, concatenated without separators. */
  inline(nodes: AdfNode[] | undefined): string {
    if (!nodes) return "";
    return nodes.map((node) => this.inlineNode(node)).join("");
  }

  private inlineNode(node: AdfNode): string {
    switch (node.type) {
      case "text":
        return this.applyMarks(escapeText(node.text ?? ""), node);

      case "hardBreak":
        return "  \n";

      case "mention": {
        const text = typeof node.attrs?.text === "string" ? node.attrs.text : "";
        return escapeText(text || "@unknown");
      }

      case "emoji": {
        const attrs = node.attrs ?? {};
        const text = typeof attrs.text === "string" ? attrs.text : undefined;
        const short = typeof attrs.shortName === "string" ? attrs.shortName : "";
        return text ?? short;
      }

      case "date": {
        const ts = Number(node.attrs?.timestamp);
        return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "";
      }

      case "status": {
        const text = typeof node.attrs?.text === "string" ? node.attrs.text : "";
        return text ? `\`${text}\`` : "";
      }

      case "inlineCard":
      case "blockCard":
      case "embedCard": {
        const url = typeof node.attrs?.url === "string" ? node.attrs.url : "";
        return url ? `<${url}>` : "";
      }

      case "media":
      case "mediaInline":
        return this.media(node);

      default:
        return node.content ? this.inline(node.content) : escapeText(node.text ?? "");
    }
  }

  private applyMarks(text: string, node: AdfNode): string {
    if (!node.marks || text.length === 0) return text;

    let out = text;
    for (const mark of node.marks) {
      switch (mark.type) {
        case "strong":
          out = `**${out}**`;
          break;
        case "em":
          out = `*${out}*`;
          break;
        case "strike":
          out = `~~${out}~~`;
          break;
        case "code":
          // Code spans are literal, so undo the escaping applied to the raw text.
          out = `\`${out.replace(/\\([\\`*_[\]<>])/g, "$1")}\``;
          break;
        case "underline":
          out = `<u>${out}</u>`;
          break;
        case "link": {
          const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
          if (href) out = `[${out}](${encodeURI(href)})`;
          break;
        }
        case "subsup": {
          const tag = mark.attrs?.type === "sub" ? "sub" : "sup";
          out = `<${tag}>${out}</${tag}>`;
          break;
        }
          // textColor, backgroundColor, alignment and friends carry no Markdown meaning.
      }
    }
    return out;
  }
}

/** Converts an ADF document to Markdown. Returns "" for an absent or empty body. */
export function adfToMarkdown(
  doc: AdfNode | null | undefined,
  opts: ConvertOptions = {},
): string {
  if (!doc) return "";
  const converter = new Converter(opts);
  const text = doc.type === "doc" ? converter.blocks(doc.content) : converter.blocks([doc]);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
