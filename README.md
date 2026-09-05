# jira-fetch

Fetch Jira Cloud issues into Markdown files with YAML frontmatter, attachments and all.

> **This project was written entirely by AI.** Every line of code, test and document in this
> repository was produced by Claude in a series of prompted sessions — it is fully vibe-coded.
> It is tested (no credentials or network needed) and it does the job, but it has not been
> line-by-line reviewed by a human. Read it before you trust it with credentials.

```sh
jira-fetch DN-1243 --out tmp
# tmp/DN-1243.md
# tmp/.DN-1243/screenshot_01.png
```

The document is a plain Markdown file: machine-readable metadata in the frontmatter, a heading that
links back to the ticket, the description as Markdown, then every comment appended after a `---`
rule. The frontmatter carries only what the ticket actually has — a key you do not see is a value
Jira did not have. Images and files from both the
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

Point one key at another **unquoted** — `JIRA_API_TOKEN=$ATLASSIAN_API_TOKEN`, never
`JIRA_API_TOKEN="$ATLASSIAN_API_TOKEN"`. A quoted value is taken literally, which would otherwise
send Jira a variable name as your token and get back a 404 on the issue; the tool refuses such a
value instead.

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
jira-fetch mcp                     serve the same pipeline over MCP (see below)

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
- **`field` reaches every field, built-in ones included.** `Status`, `Issue Type`, `Components`,
  `Priority`, `Resolution` and `Fix Version/s` are spelled exactly as Jira spells them, so
  `field: {Status: [Done, Cancelled]}` and `field: {Issue Type: [Bug]}` do what they look like.
  That is how you filter by type or status; there is no separate predicate for them.
- **`field` accepts a human name or a raw id.** `"Team"` is resolved against your site's fields;
  `"customfield_10101"` is used directly.
- **A field name that does not resolve stops the run** with exit code 2, before any issue is
  fetched. So does one that resolves to _two_ fields — Jira lets two custom fields share a name,
  and the error names both ids so you can pick one. Both used to be warnings, which is a bad way
  to be wrong: a `Teem` in an `exclude` rule is a deny rule that silently denies nothing, and in
  an `include` rule it silently denies everything.
- `tags` is an alias for `labels`.
- **Comment filters drop comments, never the ticket** — and they are exclude-only on purpose: an
  include list would mean "drop every comment not explicitly allowed", which is the wrong default
  for a document meant to be an archive.

The `$schema` line gives editors autocomplete and inline validation. The schema is generated from
the same Zod definitions the CLI validates against (`deno task schema`), so the two cannot drift.
It is published at
<https://raw.githubusercontent.com/casaper/jira-fetch/main/schema/jira-fetch.schema.json>; point
`$schema` at a local copy instead if you would rather not fetch it.

### People

How much the document says about the people on a ticket is up to you:

```yaml
people:
  roles: [reporter, assignee, commenter] # who appears at all; [] leaves people out entirely
  fields: [name, email] # what is recorded about them; at least one
  nameFormat: full # or: initials
```

Those are the defaults. `roles` and `fields` are independent axes — narrow either without touching
the other — and `nameFormat: initials` writes `Kaspar Vollenweider` as `KV`, in the frontmatter and
in comment headings alike. It shortens a **name** and only a name: when someone has no display name
and a heading falls through to their email address, the address is left whole.

This is presentation only. `reporter` and `assignee` **filters** read the issue itself, so leaving
someone out of the document never changes which tickets are fetched.

### What "never fetched" really means

Only the **project prefix** can be decided without fetching the issue — it is read from the issue
key itself. (With `--jql` the search has already named the key, so what stage 1 saves there is the
per-issue request, not the query.) Every other predicate needs the issue payload, so the filter runs
immediately after the issue is fetched and **before** comments are paginated or any attachment is
downloaded. That is where the cost and all the disk writes are, so nothing is written and nothing
large is transferred for a ticket you filtered out.

A rule is also skipped before fetching when its `project` predicate alone already rules the key
out, even if the rule has other predicates that would need the payload — nothing the payload could
say would rescue a rule whose project constraint already failed.

`--dry-run` and `-v` are how you see this happening: a filtered ticket deliberately leaves no trace
on disk.

### Restricting JQL

Setting `allowJql: false` in a config shipped alongside the binary makes `--jql` fail with exit
code 2 — useful when handing the tool to someone who should only fetch tickets by key. It gates the
flag only, not the requests the tool makes on its own. It also removes the `search_issues` tool from
the MCP server, so an agent cannot run a query either.

## MCP server

`jira-fetch mcp` serves the same pipeline over the [Model Context Protocol](https://modelcontextprotocol.io) on stdin/stdout, so an agent — Claude Code, or any other
MCP client — can read Jira through this tool.

The reason to want that is not convenience. It is that **the agent's access is decided by a config
file, not by instructions you give it**:

- **It cannot write to Jira, because there is no tool that writes.** Not "the agent was told not
  to" — the capability is absent from `tools/list`, so there is nothing to talk it into.
- **The filters above decide which issues it may fetch**, exactly as they do at the terminal. An
  agent cannot see them, override them, or pass anything that reaches past them.
- **JQL is not a way around them.** A query only chooses candidate keys; each key then goes through
  the same two filter stages as a key you typed yourself. Issues the config denies are never
  fetched, whatever query found them.

That is a stronger guarantee than a prompt, and cheaper than minting a separate read-only Atlassian
token for every class of ticket you want to fence off.

### Setting it up with Claude Code

```sh
claude mcp add jira-fetch -- jira-fetch mcp
```

Or commit a `.mcp.json` next to your config so everyone on the project gets the same server:

```json
{
  "mcpServers": {
    "jira-fetch": {
      "command": "jira-fetch",
      "args": ["mcp", "--out", "docs/jira"]
    }
  }
}
```

Credentials are resolved exactly as they are for the CLI, so `JIRA_API_TOKEN` in `.env.local` is
picked up and does not belong in `.mcp.json`. Config discovery walks up from the directory the
server is started in, which for a project-scoped `.mcp.json` is the project itself — so a committed
`.jira-fetch.yml` beside it is the policy that applies. **Check that once**: `-v` prints the config
file it found on stderr, and if it is not the one you expect, pass `--config` explicitly in `args`.
The whole guarantee rests on the right file being loaded, so it is worth a minute rather than an
assumption.

### The tools

| Tool            | What it does                                                             |
| --------------- | ------------------------------------------------------------------------ |
| `fetch_issues`  | Writes a document for each issue key given, up to 50                     |
| `search_issues` | The same, for each issue a JQL query matches, up to `limit` (default 25) |

`search_issues` is **not offered at all** when the config sets `allowJql: false` — it is missing
from `tools/list`, rather than present and refusing.

Both write into the output directory fixed when the server starts, and return a link to each
document. **No tool takes a path**: the agent chooses which issues it wants, never where bytes
land. No ticket content travels through the protocol — the agent reads the files, which is what
makes "it only gets what the config allowed" literal.

An issue the config denies is reported as `not available (no such issue, or not permitted by this
server configuration)` and **no file is written for it**. That is the same sentence a nonexistent
issue gets, on purpose: answering differently would let an agent map your deny-list by asking for
keys one at a time and watching which answer comes back. Jira's own API already conflates the two.

### What this does and does not guarantee

The guarantee is about **what the server will fetch**, not about what an agent can read. Documents
already sitting in the output directory are readable with its ordinary file tools, and filters are
evaluated at fetch time — tightening them later does not go back and remove documents already
written. Since the MCP server and the CLI share one `filters` block, the CLI cannot have written
something the server would deny under the same config; the gap is only ever a config that has since
been tightened. If that matters to you, point `--out` at a directory you can clear.

## Development

```sh
deno task check      # typecheck + lint + fmt --check + JSON Schema freshness
deno task lint
deno task fmt
deno task test       # or: deno test -A
deno test -A --filter "excludes anonymous reporter"
deno task verify:filters  # filter scenarios against the real Jira site (needs credentials)
deno task schema     # regenerate schema/jira-fetch.schema.json
deno task types      # regenerate src/jira/schema_types.ts from the vendored specs
deno task mcp        # run the MCP server from source
deno task build      # host binary into dist/
deno task build:all  # all six release targets

deno task hooks      # once per clone: enable the Conventional Commits hook
deno task changelog  # regenerate CHANGELOG.md from the commit history
deno task release patch   # bump, changelog, commit, tag, push, build, publish
deno task publish         # just the publish half, if a cross-compile failed
```

The Jira and ADF types in `src/jira/schema_types.ts` are generated from Atlassian's own published
schemas, vendored and pinned under `spec/` (both Apache-2.0 — see [spec/NOTICE](spec/NOTICE)).
`deno task check` fails if that file has drifted from them. Only `deno task vendor:spec` touches
the network, and it is run by hand.

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) and
are checked by `.githooks/commit-msg`; `deno task hooks` is what turns that on in a fresh clone.
[CHANGELOG.md](CHANGELOG.md) is generated from those subjects.

The test suite needs no credentials and no network: `test/e2e_test.ts` runs the whole CLI against a
fake Jira on localhost (`test/fake_jira.ts`), and `test/mcp_test.ts` drives the MCP server against
the same one.

`deno task verify:filters` is the complement, and is deliberately outside that suite: it runs a
table of allow/deny/both scenarios against your **real** Jira site, computes what each one should
keep from the tickets' actual fields, and compares. It skips with a message when no credentials are
configured. Documents land in `tmp/filters/` and are left there, so the run doubles as a way to see
what the tool produces for real tickets.

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
