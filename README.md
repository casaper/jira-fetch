# jira-fetch

[![CI](https://github.com/casaper/jira-fetch/actions/workflows/ci.yml/badge.svg)](https://github.com/casaper/jira-fetch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jira-fetch)](https://www.npmjs.com/package/jira-fetch)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/casaper/jira-fetch/blob/main/LICENSE)

Fetch Jira Cloud issues into Markdown files with YAML frontmatter, attachments and all — from the
terminal, or over MCP so an AI agent reads Jira through a config file it does not control.

> **This project was written entirely by AI.** Every line was produced by Claude — tested, but
> never human-reviewed. Read it before you trust it with credentials.

```sh
jira-fetch DN-1243 --out tmp
# tmp/DN-1243.md
# tmp/.DN-1243/screenshot_01.png
```

The document is a plain Markdown file: metadata in the frontmatter, a heading that links back to the
ticket, the description as Markdown, then every comment after a `---` rule. The frontmatter carries
only what the ticket actually has — a key you do not see is a value Jira did not have.

Attachments are downloaded next to it and linked relatively, so it stays readable offline. Only the
ones actually embedded in the description or a comment get a link in the body; the rest are still
listed in the frontmatter's `assets`, the complete index of what was fetched.

## Install

```sh
npm install -g jira-fetch
```

Works on macOS, Linux and Windows, x64 and arm64.

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

Nothing else changes, though `npm update` is then not available to you.

</details>

## Configuration

Your credentials and your filters live in **one YAML file per project**, in your own configuration
directory, outside every repository:

|              |                                                                                      |
| ------------ | ------------------------------------------------------------------------------------ |
| macOS, Linux | `~/.config/jira-fetch/<project-path>.yml`                                            |
| Windows      | `%APPDATA%\jira-fetch\<project-path>.yml` (that is `%USERPROFILE%\AppData\Roaming\`) |

The filename is derived from the git repository you are in, so you never have to pick it — and
there is nothing to pass: no environment variables, no flags naming a file, and no config file
inside the project. That is deliberate, and [the MCP server](#mcp-server) is
why. `jira-fetch` must be run inside a git repository, since the repository root names the file.

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

The directory is created `0700` and the file `0600`. On Windows there is nothing to set: everything
under `%APPDATA%` already inherits an ACL granting only you, `SYSTEM` and `Administrators`.

Two repository paths can land on the same filename, which is why the file carries a `project` key:
the tool compares it against the repository it is actually in and stops with exit 2 rather than
applying another project's filters. Run `jira-fetch setup` in the second project to write its own
file.

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
`jira-fetch setup` walks through them;
[`docs/config-example.yml`](https://github.com/casaper/jira-fetch/blob/main/docs/config-example.yml)
shows every option in one file.

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

- **Every predicate in a rule must match** (AND); **rules in a list are OR'd**. So the example drops
  a ticket in project SUP, _or_ labelled `wontfix`, _or_ …
- `include` works the same way: if it is non-empty, a ticket must match one of its rules to be
  fetched. **Exclude beats include.**
- **`null` means "absent"** — an anonymous portal reporter, an unassigned issue, an unset field. It
  cannot collide with someone actually named "anonymous".
- **`field` reaches every field, built-in ones included**, spelled exactly as Jira spells it:
  `field: {Status: [Done, Cancelled]}` and `field: {Issue Type: [Bug]}` are how you filter by status
  and by type, and there is no separate predicate for either. A raw `customfield_10101` works in
  place of a name.
- **A field name that does not resolve stops the run** with exit code 2, before any issue is
  fetched — as does one that resolves to _two_ fields, since Jira lets two custom fields share a
  name. The error names both ids so you can pick one.
- `tags` is an alias for `labels`.
- **Comment filters drop comments, never the ticket**, and are exclude-only.

The `$schema` line gives editors autocomplete and inline validation. It is generated from the same
Zod definitions the CLI validates against, so the two cannot drift; point it at a local copy if you
would rather not fetch it.

### People

How much the document says about the people on a ticket is up to you:

```yaml
people:
  roles: [reporter, assignee, commenter] # who appears at all; [] leaves people out entirely
  fields: [name, email] # what is recorded about them; at least one
  nameFormat: full # or: initials
```

Those are the defaults, and `roles` and `fields` are independent axes. `nameFormat: initials` writes
`Kaspar Vollenweider` as `KV`, in the frontmatter and in comment headings alike; it shortens a name
and only a name, so a heading falling through to an email address keeps it whole. All of this is
presentation only — `reporter` and `assignee` **filters** read the issue itself, so leaving someone
out of the document never changes which tickets are fetched.

### What "never fetched" really means

Only the **project prefix** is decided without fetching the issue, since it is read from the issue
key itself — so a rule is skipped before fetching whenever its `project` predicate alone already
rules the key out, whatever its other predicates say. Every other predicate needs the payload, so
the filter runs immediately after the issue is fetched and **before** comments are paginated or
attachments are downloaded — which is where the cost and every disk write live. A filtered ticket
transfers nothing large and leaves no trace on disk. `--dry-run` and `-v` show it happening.

### Restricting JQL

`allowJql: false` makes `--jql` fail with exit code 2, and removes the `search_issues` tool from the
MCP server so an agent cannot run a query either — useful when handing the tool to someone who
should only fetch tickets by key. It gates the flag only, not the requests the tool makes on its
own.

## MCP server

`jira-fetch mcp` serves the same pipeline over the
[Model Context Protocol](https://modelcontextprotocol.io) on stdin/stdout, so an agent — Claude
Code, or any other MCP client — can read Jira through this tool.

The reason to want that is not convenience. It is that **the agent's access is decided by a config
file, not by instructions you give it**:

- **It cannot write to Jira, because there is no tool that writes.** Not "the agent was told not
  to" — the capability is absent from `tools/list`, so there is nothing to talk it into.
- **The filters above decide which issues it may fetch**, exactly as they do at the terminal. There
  is no tool argument, no query and no prompt that reaches past them.
- **JQL is not a way around them.** A query only chooses candidate keys; each key then goes through
  the same filter stages as a key you typed yourself.

Which is cheaper than minting a separate read-only Atlassian token for every class of ticket you
want to fence off.

### Setting it up with Claude Code

```sh
npm install -g jira-fetch
claude mcp add --scope user jira-fetch -- jira-fetch mcp --out docs/jira
```

Or without installing anything, at the cost of npx resolving the package on each launch:

```sh
claude mcp add --scope user jira-fetch -- npx -y jira-fetch mcp --out docs/jira
```

There is nothing else to pass: the server finds the same config file the CLI would, derived from the
repository it is started in. `--scope user` puts the definition in `~/.claude.json` rather than a
`.mcp.json` in the project, which keeps the launch command itself out of the tree the agent edits.

**Check it once:** `-v` prints the config file the server resolved, on stderr, where Claude Code
shows it as MCP server output. If it is not the file you meant, nothing else here is true of your
setup.

### What the agent cannot do

- **It cannot rewrite the policy.** There is no config file inside the project; the path is computed
  from the repository root, so it lands outside the tree the agent edits.
- **It cannot reach the credentials.** The token is in that one file and nowhere else — not in the
  environment its shell inherits, and not in any flag it could pass.

**But this is not a sandbox.** The server runs as you, and so does the agent's shell — `cat
"$(jira-fetch config-file)"` is a command, not a trick. The only **hard** boundary is on Atlassian's
side, so use a token whose account cannot see what you do not want read.

The guarantee is also about **what the server will fetch**, not what an agent can read. Filters are
evaluated at fetch time, so tightening them later does not remove documents already written, and
those are readable with the agent's ordinary file tools. Point `--out` at a directory you can
clear if that matters to you.

<details>
<summary>Claude Code deny rules, which <code>jira-fetch setup</code> offers to write</summary>

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
any other, so a project cannot grant back what they take away. `Read` also covers `Grep`, `Glob` and
the file reads Claude Code recognises inside Bash. `setup` merges them into whatever is already in
those files and adds nothing on a second run — and it refuses to run without a terminal, which an
agent's shell does not have.

These stop the well-behaved path and are worth having for that, but they do not reach a script that
opens the file itself, and an agent with a shell can edit the settings files too.

</details>

### The tools

| Tool            | What it does                                                             |
| --------------- | ------------------------------------------------------------------------ |
| `fetch_issues`  | Writes a document for each issue key given, up to 50                     |
| `search_issues` | The same, for each issue a JQL query matches, up to `limit` (default 25) |

`search_issues` is **not offered at all** when the config sets `allowJql: false` — it is missing
from `tools/list`, rather than present and refusing.

Both write into the output directory fixed when the server starts and return a link to each
document. **No tool takes a path**: the agent chooses which issues it wants, never where bytes land.
No ticket content travels through the protocol — the agent reads the files.

An issue the config denies is reported as `not available (no such issue, or not permitted by this
server configuration)` and **no file is written for it**. A nonexistent issue gets the same
sentence, on purpose: answering differently would let an agent map your deny-list by probing keys
one at a time. Jira's own API already conflates the two.

## Contributing

[CONTRIBUTING.md](https://github.com/casaper/jira-fetch/blob/main/CONTRIBUTING.md)
