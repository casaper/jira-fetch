# jira-fetch

[![CI](https://github.com/casaper/jira-fetch/actions/workflows/ci.yml/badge.svg)](https://github.com/casaper/jira-fetch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jira-fetch)](https://www.npmjs.com/package/jira-fetch)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/casaper/jira-fetch/blob/main/LICENSE)

Fetch Jira Cloud issues into Markdown files with YAML frontmatter, attachments and all — from the
terminal, or over MCP so an AI agent reads Jira through a config file it does not control.

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

Every attachment is downloaded, but only the ones actually embedded in the description or a comment
get a link in the body — Jira's attachment panel holds files nobody ever referenced, and there is
no place in the text to put them. Those still appear in the frontmatter's `assets` list, which is
the complete index of what was fetched. So an `assets` entry with no matching link in the body is
an attachment nobody embedded, not a broken link.

## Install

```sh
npm install -g jira-fetch
```

That is the whole of it. npm downloads one prebuilt binary for your platform — nothing is compiled,
and nothing needs Node or Deno once it is there; npm is only how it is delivered. macOS, Linux and
Windows, on x64 and arm64.

```sh
npm update -g jira-fetch    # upgrade
npx jira-fetch DN-1243      # run it once, installing nothing
```

<details>
<summary>Without npm</summary>

Every release also attaches the six binaries directly, and they are the same files npm serves:
<https://github.com/casaper/jira-fetch/releases>. Download the one for your platform, make it
executable and put it on your `PATH`. On macOS they are neither signed nor notarised, so Gatekeeper
quarantines anything downloaded and you have to say so explicitly:

```sh
chmod +x jira-fetch-macos-aarch64
xattr -d com.apple.quarantine jira-fetch-macos-aarch64
```

Nothing else about the tool changes; `npm update` is simply not available to you.

</details>

## Configuration

Everything — your credentials and the filters — lives in **one YAML file per project**, in your own
configuration directory, outside every repository:

|              |                                                                                      |
| ------------ | ------------------------------------------------------------------------------------ |
| macOS, Linux | `~/.config/jira-fetch/<project-path>.yml`                                            |
| Windows      | `%APPDATA%\jira-fetch\<project-path>.yml` (that is `%USERPROFILE%\AppData\Roaming\`) |

The filename is derived from the git repository you are in, so you never have to pick it:

```sh
jira-fetch setup          # create or change it, interactively
jira-fetch config-file    # print its path, whether or not it exists yet
```

`setup` asks for each setting and explains what it is for, including where to create an API token.
To edit the file by hand afterwards:

```sh
$EDITOR "$(jira-fetch config-file)"
```

A minimal file:

```yaml
project: /home/you/code/thing # the repository this configuration is for
baseUrl: https://your-site.atlassian.net
email: you@example.com
token: ATATT3xFfGF0...
```

`jira-fetch` must be run inside a git repository — the repository root is what names the file. The
directory is created `0700` and the file `0600`. On Windows there is nothing to set: everything
under `%APPDATA%` already inherits an ACL granting only you, `SYSTEM` and `Administrators`.

### There is nothing else

No `JIRA_BASE_URL`, no `JIRA_EMAIL`, no `JIRA_API_TOKEN`, no `.env`, no `.env.local`, no config file
inside the project, and no `--config`, `--token`, `--base-url` or `--email` flag. Not deprecated —
absent. Configuration does not layer, and there is no search order, because there is no search: the
path is computed from the repository root and that is the only place the tool looks.

That is a deliberate trade against convenience, and the reason is [the MCP server](#mcp-server).
The tool's central claim is that an agent's access to Jira is decided by a file it does not
control, and every one of those inputs was a way around it — a `.jira-fetch.yml` created in the
working directory shadowed the real one, a flag named a different file outright, and an exported
`JIRA_API_TOKEN` was a credential the agent's own shell could send to Jira with `curl` without
going near this tool.

### If two projects share a filename

Path segments become `_`, and everything inside a segment is lower-cased with runs of punctuation
folded to `-`, so `/Users/you/code/My Thing` becomes `users_you_code_my-thing.yml`. That mapping is
not reversible: `/a/b_c` and `/a_b/c` produce the same name. This is why the file carries a
`project` key — the tool compares it against the repository it is actually in and stops with exit 2
rather than quietly applying another project's filters. Run `jira-fetch setup` in the second
project to write its own file, or rename one of the directories.

## Usage

```
jira-fetch <ISSUE-KEY>...          fetch one or more issues by key
jira-fetch --jql "<JQL>"           fetch every issue matching a query
jira-fetch mcp                     serve the same pipeline over MCP (see below)
jira-fetch setup                   configure this project, interactively
jira-fetch config-file             print the path of this project's config file

  -o, --out <dir>      output directory (default: current directory)
  -n, --dry-run        report what would be fetched and filtered; write nothing
  -v, --verbose        per-issue progress and filter decisions on stderr
```

Exit codes: `0` success · `1` runtime error · `2` usage or config error · `3` nothing written
because every issue was excluded by a filter.

## Filters

Filters decide which tickets are fetched at all, and which comments make it into the document.
`jira-fetch setup` walks through them; [`docs/config-example.yml`](https://github.com/casaper/jira-fetch/blob/main/docs/config-example.yml) shows
every option in one file.

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
- **The filters above decide which issues it may fetch**, exactly as they do at the terminal.
  There is no tool argument, no query and no prompt that reaches past them.
- **JQL is not a way around them.** A query only chooses candidate keys; each key then goes through
  the same two filter stages as a key you typed yourself. Issues the config denies are never
  fetched, whatever query found them.

That is a stronger guarantee than a prompt, and cheaper than minting a separate read-only Atlassian
token for every class of ticket you want to fence off.

### Setting it up with Claude Code

```sh
npm install -g jira-fetch
claude mcp add --scope user jira-fetch -- jira-fetch mcp --out docs/jira
```

Or without installing anything, at the cost of npx resolving the package on each launch:

```sh
claude mcp add --scope user jira-fetch -- npx -y jira-fetch mcp --out docs/jira
```

There is nothing else to pass. The server finds the same config file the CLI would — derived from
the repository it is started in — and neither a file appearing in your project nor an exported
variable can change which one that is.

`--scope user` puts the server definition in `~/.claude.json` rather than a `.mcp.json` in the
project, so the command the server is launched with is not itself a file the agent edits. That is
worth keeping even though the policy no longer depends on it.

**Check it once.** `-v` prints the config file the server resolved, on stderr, where Claude Code
shows it as MCP server output. If it is not the file you meant, nothing else on this page is true
of your setup.

### What the agent cannot do

An agent that edits files in your project and runs commands in it used to have two easy ways past a
server configured from that same project. Neither is available now, and neither closure depends on
you remembering a flag.

- **It cannot rewrite the policy**, because the policy is not in the project. It is not even in a
  file the tool will search for: the path is computed from the repository root, so creating a
  `.jira-fetch.yml` in the working directory — once enough to shadow a committed config, since the
  nearest file won outright — now does nothing at all.
- **It cannot skip the server with the token**, because the token is not in the environment its
  shell inherits, nor in a `.env.local` in the tree. It is in the config file and nowhere else, and
  there is no `--token` flag to put it in a process table either.

`jira-fetch setup` offers to write Claude Code deny rules as well:

```json
// ~/.claude/settings.json — one write, every project
{
  "permissions": {
    "deny": [
      "Read(~/.config/jira-fetch/**)",
      "Edit(~/.config/jira-fetch/**)"
    ]
  }
}
```

```json
// <project>/.claude/settings.local.json
{ "permissions": { "deny": ["Bash(jira-fetch setup:*)"] } }
```

The config-directory rules go at **user** scope deliberately: a deny at any scope beats an allow at
any other, so a project cannot grant back what they take away. `Read` also covers `Grep`, `Glob`
and the file reads Claude Code recognises inside Bash. `setup` merges them into whatever is already
in those files and adds nothing on a second run.

`jira-fetch setup` also refuses to run without a terminal, which an agent's shell does not have.

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

**None of this is a sandbox.** The server runs as you, and so does the agent's shell — `cat
"$(jira-fetch config-file)"` is not a trick, it is a command. The deny rules above stop the
well-behaved path, and they are worth having for that, but they do not reach a Python or Node
script that opens the file itself, and an agent with a shell can edit the settings files too. The
terminal check on `setup` is the same kind of thing: a barrier, not a boundary, since anything that
can allocate a pty gets past it.

What the design actually buys is that the policy and the credential are no longer things the agent
encounters in the course of its work. Reaching either means deliberately stepping outside the
workspace — unusual, and visible when it happens — rather than editing a file that was sitting in
the repository anyway. The only **hard** boundary is on Atlassian's side: an API token belonging to
an account that cannot see what you do not want read. This tool makes the soft boundary a great
deal harder to cross by accident or by improvisation; it does not replace the hard one.

The guarantee is also about **what the server will fetch**, not about what an agent can read.
Documents already sitting in the output directory are readable with its ordinary file tools, and
filters are evaluated at fetch time — tightening them later does not go back and remove documents
already written. Since the MCP server and the CLI share one `filters` block, the CLI cannot have written
something the server would deny under the same config; the gap is only ever a config that has since
been tightened. If that matters to you, point `--out` at a directory you can clear.

## Contributing

Issues and pull requests are welcome. Everything about working on this — the tasks, the code style,
the commit convention, how the test suite is sealed and how a release is cut — is in
[CONTRIBUTING.md](https://github.com/casaper/jira-fetch/blob/main/CONTRIBUTING.md).

The suite that runs on every push needs **no credentials and no network**: it drives the whole CLI,
and the MCP server, against a fake Jira on localhost. It runs on Linux, macOS and Windows, and the
badge at the top of this page is that run.

## License

[MIT](https://github.com/casaper/jira-fetch/blob/main/LICENSE).

Nothing in the dependency tree stands in the way: Deno, the Deno standard library (`@std/*`) and
zod are all MIT. The **compiled binaries** are a slightly different matter — `deno compile` embeds
the Deno runtime and V8 into each artifact, so a release carries their notices too: Deno and `@std`
under MIT, V8 under BSD-3-Clause, and the Rust crates Deno links under MIT/Apache-2.0. All
permissive, none copyleft; the obligation is attribution, not disclosure.

`src/jira/schema_types.ts` is generated from Atlassian's published Jira and ADF schemas, which are
**Apache-2.0** and vendored under `spec/`. That file is compiled into the binaries, so the release
carries Atlassian's attribution as well — kept in [spec/NOTICE](https://github.com/casaper/jira-fetch/blob/main/spec/NOTICE) and in the generated
file's own header. Apache-2.0 is permissive and imposes no copyleft on the rest of this project.

One honest footnote to the copyright line, given the disclaimer above: purely AI-generated work may
not attract copyright protection in the first place in some jurisdictions, the US among them. MIT is
still the right label — it says plainly that you may use this for anything.
