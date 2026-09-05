/** Attachment manifest construction and download.
 *
 * The manifest is built *before* any body is converted, because an ADF `media` node carries only
 * an attachment id — the filename and download URL live in `fields.attachment[]`. Filename
 * sanitisation therefore has exactly one home: if the converter and the downloader ever disagreed
 * on a name, the relative links would break silently.
 */

import { join } from "@std/path";
import type { AssetEntry, AssetManifest, JiraAttachment } from "../jira/types.ts";
import type { JiraClient } from "../jira/client.ts";

/** Reserved device names on Windows; the binary ships there too. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
// Control characters plus the set Windows forbids in a filename.
// deno-lint-ignore no-control-regex
const ILLEGAL = /[\x00-\x1f<>:"/\\|?*]/g;
const MAX_STEM = 80;

/** Makes an attachment filename safe on macOS, Linux and Windows without losing the extension. */
export function sanitizeFilename(raw: string): string {
  // Jira allows path separators in filenames; only the last segment is meaningful.
  const base = raw.split(/[/\\]/).pop() ?? "";
  // Whitespace becomes an underscore: the filename ends up in a Markdown link and in shell
  // commands, and `%20` in either is a needless annoyance.
  let name = base.replace(ILLEGAL, "_").replace(/\s+/g, "_").replace(/_{2,}/g, "_").trim();

  // A leading dot would hide the file, and trailing dots/spaces are illegal on Windows.
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");

  const dot = name.lastIndexOf(".");
  let stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";

  if (stem.length === 0) stem = "attachment";
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM);

  return `${stem}${ext}`;
}

/** Asset directory name for an issue: `.DN-1243`, sitting beside `DN-1243.md`. */
export function assetDirName(issueKey: string): string {
  return `.${issueKey}`;
}

/**
 * Builds the id -> asset map, resolving name collisions. Two attachments are routinely both
 * called `image.png`; the second one gets its attachment id folded into the stem so the two
 * never overwrite each other.
 */
export function buildManifest(
  attachments: JiraAttachment[] | undefined,
  issueKey: string,
): AssetManifest {
  const manifest: AssetManifest = new Map();
  const taken = new Set<string>();
  const dir = assetDirName(issueKey);

  for (const attachment of attachments ?? []) {
    if (!attachment?.id) continue;

    let filename = sanitizeFilename(attachment.filename ?? "attachment");
    if (taken.has(filename.toLowerCase())) {
      const dot = filename.lastIndexOf(".");
      const stem = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : "";
      filename = `${stem}-${attachment.id}${ext}`;
    }
    taken.add(filename.toLowerCase());

    const entry: AssetEntry = {
      id: attachment.id,
      filename,
      relativePath: `${dir}/${filename}`,
      contentUrl: attachment.content,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
    manifest.set(attachment.id, entry);
  }

  return manifest;
}

export interface DownloadResult {
  downloaded: number;
  failures: Array<{ filename: string; error: string }>;
}

/** Downloads every asset in the manifest into `targetDir`, which is created if missing. */
export async function downloadAssets(
  client: JiraClient,
  manifest: AssetManifest,
  targetDir: string,
  log: (message: string) => void = () => {},
): Promise<DownloadResult> {
  const result: DownloadResult = { downloaded: 0, failures: [] };
  if (manifest.size === 0) return result;

  await Deno.mkdir(targetDir, { recursive: true });

  for (const entry of manifest.values()) {
    try {
      const response = await client.raw(entry.contentUrl, { headers: { Accept: "*/*" } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertNotLoginPage(entry, response, bytes);
      await Deno.writeFile(join(targetDir, entry.filename), bytes);
      result.downloaded++;
      log(`    saved ${entry.relativePath} (${bytes.length} bytes)`);
    } catch (cause) {
      result.failures.push({ filename: entry.filename, error: (cause as Error).message });
    }
  }

  return result;
}

/**
 * An attachment requested without credentials comes back as an HTML login page carrying a 200,
 * so the status code proves nothing. Compare what arrived against what the attachment metadata
 * said it should be.
 */
function assertNotLoginPage(entry: AssetEntry, response: Response, bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new Error(`${entry.filename}: server returned an empty body`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const expectedHtml = (entry.mimeType ?? "").toLowerCase().includes("html");
  if (contentType.includes("text/html") && !expectedHtml) {
    throw new Error(
      `${entry.filename}: expected ${entry.mimeType ?? "binary"} but received HTML — ` +
        `the request was probably not authenticated`,
    );
  }
}
