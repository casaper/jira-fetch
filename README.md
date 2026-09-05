# jira-fetch

Fetch Jira Cloud issues into Markdown files with YAML frontmatter, attachments and all.

> **This project was written entirely by AI.** Every line of code, test and document in this
> repository was produced by Claude in a series of prompted sessions — it is fully vibe-coded.
> It is tested (158 tests, no network needed) and it does the job, but it has not been
> line-by-line reviewed by a human. Read it before you trust it with credentials.

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
deno task dev DN-1243
```

## Credentials

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>, then:

```sh
export JIRA_BASE_URL=https://your-site.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
```

Or put them in a `.env` (or `.env.local`) file beside your project:

```sh
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...
```

Values resolve per key in the order **CLI flags → environment → `.env` → config file**, so a flag
for one key never discards the file's value for another. Both files are found by **closeness** —
the nearest ancestor directory that has one wins, so running the tool from a subdirectory picks up
the project's settings:

|                                                   |                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `.env`, `.env.local`                              | nearest ancestor directory holding either; `.env.local` shadows `.env` |
| `.jira-fetch.yml` `.yaml` `.json`                 | searched upward from the working directory                             |
| `.jira-fetch.conf.yml` `.yaml` `.json`            | same, checked first within each directory                              |
| `jira-fetch.conf.yml` `.yaml` `.json`             | same again, without the leading dot                                    |
| `~/.config/jira-fetch[.conf].yml` `.yaml` `.json` | your own defaults                                                      |
| `~/.jira-fetch.conf.yml` `.yaml` `.json`          | likewise                                                               |

The **nearest config file found is the only one read** — configurations do not layer. Both walks run
to the filesystem root, so a `~/.env` applies everywhere, exactly as `~/.config/jira-fetch.yaml`
does.

### Commit the config, not the token

The config file is meant to be **checked into your project**. Its filters — and `allowJql: false` —
then apply to everyone working in that tree, which is the point of having them in a file rather
than in someone's shell history.

Your API token is not part of that. Keep it in `.env.local`, in the environment, or pass `--token`,
and add `.env.local` to the project's `.gitignore`. If a config file inside a project sets `token`,
the tool says so on every run. A token in your own `~/.config/jira-fetch.yaml` is your business and
is left alone.

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
`.jira-fetch.example.yaml` to `.jira-fetch.yaml` to start.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/casaper/jira-fetch/main/schema/jira-fetch.schema.json
filters:
  exclude:
    - project: [SUP]
    - labels: [wontfix]
    - field:
        Team: [Platform]
    - title:
        matches: '^spike:'
        flags: i
    - reporter: [null]
  comments:
    exclude:
      - author: [Automation for Jira]
```

JSON works just as well — every name above has a `.json` spelling, and there the binding is a
`"$schema"` key rather than a comment.

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
It is published at
<https://raw.githubusercontent.com/casaper/jira-fetch/main/schema/jira-fetch.schema.json>; point
`$schema` at a local copy instead if you would rather not fetch it.

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

Setting `allowJql: false` in a config shipped alongside the binary makes `--jql` fail with exit
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
deno task types      # regenerate src/jira/schema_types.ts from the vendored specs
deno task build      # host binary into dist/
deno task build:all  # all six release targets

deno task hooks      # once per clone: enable the Conventional Commits hook
deno task changelog  # regenerate CHANGELOG.md from the commit history
deno task release patch   # bump, changelog, commit, tag
```

The Jira and ADF types in `src/jira/schema_types.ts` are generated from Atlassian's own published
schemas, vendored and pinned under `spec/` (both Apache-2.0 — see [spec/NOTICE](spec/NOTICE)).
`deno task check` fails if that file has drifted from them. Only `deno task vendor:spec` touches
the network, and it is run by hand.

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) and
are checked by `.githooks/commit-msg`; `deno task hooks` is what turns that on in a fresh clone.
[CHANGELOG.md](CHANGELOG.md) is generated from those subjects.

The test suite needs no credentials and no network: `test/e2e_test.ts` runs the whole CLI against a
fake Jira on localhost.

## License

[MIT](LICENSE).

Nothing in the dependency tree stands in the way: Deno, the Deno standard library (`@std/*`) and
zod are all MIT. The **compiled binaries** are a slightly different matter — `deno compile` embeds
the Deno runtime and V8 into each artifact, so a release carries their notices too: Deno and `@std`
under MIT, V8 under BSD-3-Clause, and the Rust crates Deno links under MIT/Apache-2.0. All
permissive, none copyleft; the obligation is attribution, not disclosure.

`src/jira/schema_types.ts` is generated from Atlassian's published Jira and ADF schemas, which are
**Apache-2.0** and vendored under `spec/`. That file is compiled into the binaries, so the release
carries Atlassian's attribution as well — kept in [spec/NOTICE](spec/NOTICE) and in the generated
file's own header. Apache-2.0 is permissive and imposes no copyleft on the rest of this project.

One honest footnote to the copyright line, given the disclaimer above: purely AI-generated work may
not attract copyright protection in the first place in some jurisdictions, the US among them. MIT is
still the right label — it says plainly that you may use this for anything.
