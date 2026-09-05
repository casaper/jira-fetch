# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Greenfield as of 2026-09-05** — the repo has no commits yet. Everything below describes intended
behavior and the constraints it has to satisfy, not code that exists. Delete this section once the
implementation lands, and correct any section that the real code contradicts.

## What this is

A single-purpose Deno CLI: fetch one Jira Cloud issue by key, write it as a Markdown file with YAML
frontmatter, and download its attachments alongside. Shipped as a self-contained binary for macOS,
Linux and Windows, so end users need no Deno install.

## Commands

```sh
deno task dev -- DN-1243        # run from source
deno check                       # typecheck
deno lint
deno fmt                         # deno fmt --check in CI
deno test -A                     # full suite
deno test -A --filter "converts media nodes"   # single test by name
deno test -A src/adf/convert_test.ts           # single test file
```

Release targets (`deno task build:all` fans out over these `deno compile --target` triples):

```
x86_64-apple-darwin      aarch64-apple-darwin
x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
x86_64-pc-windows-msvc   aarch64-pc-windows-msvc
```

**`deno compile` bakes permission flags in at build time.** The `--allow-*` set must be identical in
the `dev` task and in every `compile` task, or the shipped binary behaves differently from
`deno run` — a class of bug that only shows up after distribution. Required set:
`--allow-net --allow-env --allow-read --allow-write`.

## Configuration

Resolution order is **CLI flags → environment → config file**, first hit wins per key (not
per source — a flag for one key must not discard the config file's value for another).

- Flags: `--base-url`, `--email`, `--token`, `--out <dir>` (default: PWD)
- Env: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`
- File: `.jira-fetch.json`, discovered upward from PWD, then `~/.config/jira-fetch/config.json`

Auth is Jira Cloud Basic: `Authorization: Basic base64(email + ":" + token)`.

## Output contract

This is the user-facing contract; changing it breaks people's existing files.

- Document: `[target_dir]/<JIRA-ID>.md`
- Assets: `[target_dir]/.<JIRA-ID>/<asset_filename>` — note the **leading dot** on the directory
- Asset links in the Markdown are **relative** (`.DN-1243/screenshot_01.png`) so the file stays
  portable when moved with its asset dir
- Body order: YAML frontmatter → description → `---` → comments, each comment separated by `---`
- Frontmatter keys: `id`, `title`, `author`, `created_at`, `updated_at`, `fetched_at`, `type`,
  `status`, `parent`, `siblings`, `subtasks` (plus assignee/labels/project as they land).
  Timestamps ISO-8601.

## Architecture

The one coupling worth knowing before touching any module:

> **The ADF→Markdown converter cannot run without the attachment manifest.** Inline images and files
> appear in ADF as `media` nodes carrying only an attachment `id`; the human-readable filename and
> the download URL live in `fields.attachment[]` on the issue. So the fetch order is fixed:
> issue → build `id → {filename, contentUrl}` map → download assets → convert bodies with that map in
> hand. **Comment bodies carry `media` nodes too**, so the same map feeds the comment pass, not just
> the description.

Intended module boundaries (no file tree yet — write one here as the code lands): CLI/arg parsing,
config resolution, Jira HTTP client, ADF→Markdown converter, attachment downloader, and the
frontmatter/document assembler that joins them.

## Jira Cloud API (REST v3)

- `GET /rest/api/3/issue/{key}` — fields, `fields.attachment`, `fields.parent`, `fields.subtasks`;
  description arrives as ADF (Atlassian Document Format JSON), not markup
- `GET /rest/api/3/issue/{key}/comment` — **paginated**; loop `startAt`/`maxResults` rather than
  assuming one page
- Attachment bytes: the `content` URL on each attachment. It **needs the same auth header** and
  redirects to blob storage. Fetched unauthenticated it returns an HTML login page with a 200 rather
  than an error, so the downloader must assert on content-type/size instead of trusting the status.

This targets Jira **Cloud** specifically. Server/Data Center exposes only REST v2 with wiki-markup
bodies — a different converter entirely; don't blend the two paths without deciding that explicitly.

## Gotchas

- **`siblings` is not a Jira field.** It is the *other* children of `fields.parent`, so it needs a
  second call (JQL `parent = <parentKey>`, or reading the parent's subtasks) and must exclude the
  issue itself. It is the only frontmatter field that isn't a direct read.
- **Asset filename collisions.** Two attachments can both be `image.png`; filenames may be non-ASCII
  or contain path separators. Sanitize, then dedupe by suffixing the attachment id. The converter
  and the downloader must apply the *same* rule or the relative links break silently.
- ADF is a recursive node tree. Unknown node types should degrade to their text content rather than
  throw, so one unfamiliar macro never fails a whole fetch.
