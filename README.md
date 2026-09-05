# jira-fetch

Fetch Jira Cloud issues into Markdown files with YAML frontmatter, attachments and all.

```sh
jira-fetch DN-1243 --out tmp
# tmp/DN-1243.md
# tmp/.DN-1243/screenshot_01.png
```

The document is a plain Markdown file: machine-readable metadata in the frontmatter, the description
as Markdown, then every comment appended after a `---` rule. Images and files from both the
description and the comments are downloaded next to it and linked relatively, so the document stays
readable offline and survives being moved with its asset directory.

## Install

Grab the binary for your platform from the release artifacts — it is self-contained and needs no
Deno installation. Or run from source:

```sh
deno task dev -- DN-1243
```

## Credentials

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>, then:

```sh
export JIRA_BASE_URL=https://your-site.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
```

Values resolve per key in the order **CLI flags → environment → config file**, so a flag for one key
never discards the file's value for another. The config file is `.jira-fetch.json` (or `.yaml`),
searched upward from the working directory, then `~/.config/jira-fetch/config.json`. Keeping the
token in the environment rather than the file is the safer habit.

## Usage

```
jira-fetch <ISSUE-KEY>...          fetch one or more issues by key
jira-fetch --jql "<JQL>"           fetch every issue matching a query

  -o, --out <dir>      output directory (default: current directory)
  -c, --config <path>  config file to use, skipping discovery
  -n, --dry-run        report what would be fetched and filtered; write nothing
  -v, --verbose        per-issue progress and filter decisions on stderr
```

Exit codes: `0` success · `1` runtime error · `2` usage or config error · `3` nothing written
because every issue was excluded by a filter.

## Filters

Filters decide which tickets are fetched at all, and which comments make it into the document. Copy
`.jira-fetch.example.json` to `.jira-fetch.json` to start.

```jsonc
{
  "$schema": "./schema/jira-fetch.schema.json",
  "filters": {
    "exclude": [
      { "project": ["SUP"] },
      { "labels": ["wontfix"] },
      { "field": { "Team": ["Platform"] } },
      { "title": { "matches": "^spike:", "flags": "i" } },
      { "reporter": [null] }
    ],
    "comments": { "exclude": [{ "author": ["Automation for Jira"] }] }
  }
}
```

- **Every predicate in a rule must match** (AND); **rules in a list are OR'd**. So the example drops
  a ticket in project SUP, _or_ labelled `wontfix`, _or_ …
- `include` works the same way: if it is non-empty, a ticket must match one of its rules to be
  fetched. **Exclude beats include.**
- **`null` means "absent"** — an anonymous portal reporter, an unassigned issue, an unset field. It
  is spelled as JSON `null` so it can never collide with someone actually named "anonymous".
- **`field` accepts a human name or a raw id.** `"Team"` is resolved against your site's fields;
  `"customfield_10101"` is used directly. A field that does not exist on the site reads as absent
  rather than failing, so one config can be shared across sites.
- `tags` is an alias for `labels`.
- **Comment filters drop comments, never the ticket** — and they are exclude-only on purpose: an
  include list would mean "drop every comment not explicitly allowed", which is the wrong default
  for a document meant to be an archive.

The `$schema` line gives editors autocomplete and inline validation. The schema is generated from
the same Zod definitions the CLI validates against (`deno task schema`), so the two cannot drift.

### What "never fetched" really means

Only the **project prefix** can be decided without fetching the issue — it is read from the issue
key itself. (With `--jql` the search has already named the key, so what stage 1 saves there is the
per-issue request, not the query.) Every other predicate needs the issue payload, so the filter runs
immediately after the issue is fetched and **before** comments are paginated or any attachment is
downloaded. That is where the cost and all the disk writes are, so nothing is written and nothing
large is transferred for a ticket you filtered out.

`--dry-run` and `-v` are how you see this happening: a filtered ticket deliberately leaves no trace
on disk.

### Restricting JQL

Setting `"allowJql": false` in a config shipped alongside the binary makes `--jql` fail with exit
code 2 — useful when handing the tool to someone who should only fetch tickets by key. It gates the
flag only, not the requests the tool makes on its own.

## Development

```sh
deno task check      # typecheck + lint + fmt --check + JSON Schema freshness
deno task lint
deno task fmt
deno task test       # or: deno test -A
deno test -A --filter "excludes anonymous reporter"
deno task schema     # regenerate schema/jira-fetch.schema.json
deno task build      # host binary into dist/
deno task build:all  # all six release targets
```

The test suite needs no credentials and no network: `test/e2e_test.ts` runs the whole CLI against a
fake Jira on localhost.
