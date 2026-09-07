import { VERSION } from './args.ts';

/**
 * The two help pages, kept apart on purpose.
 *
 * Half of what a reader wants to know about `jira-fetch mcp` is a threat model, and none of it
 * helps somebody who ran `--help` to remember whether the flag is `-o` or `--out`. So the CLI page
 * names `mcp` as a subcommand and stops there; `MCP_HELP` carries the rest and no CLI usage at all.
 * `src/cli/help_test.ts` pins that separation, since merging them back is a one-line edit.
 */
export const HELP = `jira-fetch ${VERSION}
Fetch Jira Cloud issues into Markdown files with YAML frontmatter.

USAGE
  jira-fetch <ISSUE-KEY>...     fetch one or more issues by key
  jira-fetch --jql "<JQL>"      fetch every issue matching a query
  jira-fetch setup              configure this project, interactively
  jira-fetch config-file        print the path of this project's config file
  jira-fetch cache <KEY>...     read what your Jira projects contain, for the menus
  jira-fetch mcp                run as an MCP server; see jira-fetch help mcp
  jira-fetch help [<command>]   this help, or one command's

OPTIONS
  -o, --out <dir>      output directory (default: current directory)
      --jql <query>    fetch by JQL; refused when the config sets allowJql: false
  -n, --dry-run        report what would be fetched and filtered; write nothing
  -v, --verbose        per-issue progress and filter decisions on stderr
  -h, --help           show this help
      --mcp-help       show the MCP server help
      --version        show the version

  for jira-fetch cache:
      --refresh        read everything again, however recently it was read
      --show           report what is cached and how old it is; read nothing
      --clear          delete this project's cache

CONFIGURATION
  One YAML file per project holds the credentials and the filters that decide which
  tickets are fetched:

    ~/.config/jira-fetch/<project-path>.yml     macOS and Linux
    %APPDATA%\\jira-fetch\\<project-path>.yml     Windows

  The name comes from the git repository you are in, so there is nothing to pass and
  jira-fetch runs only inside one. Run jira-fetch setup to create it.

  What your Jira site contains — labels, fields and the values they accept, people,
  components, versions, sprints — is cached beside it, so a filter can be built from
  what exists rather than from memory:

    ~/.cache/jira-fetch/<hash>/                 macOS and Linux
    %APPDATA%\\jira-fetch\\cache\\<hash>\\          Windows

  It refreshes itself when it ages out. jira-fetch cache --show reports it, and
  --clear deletes it; nothing there is anything a fresh read cannot produce again.

OUTPUT
  <out>/<ISSUE-KEY>.md    the document (overwritten if it already exists)
  <out>/.<ISSUE-KEY>/     its attachments

EXIT CODES
  0 success   1 runtime error   2 usage or config error
  3 nothing written because every issue was excluded by a filter
`;

export const MCP_HELP = `jira-fetch ${VERSION} — MCP server

jira-fetch mcp speaks the Model Context Protocol on stdin/stdout, so an MCP client —
Claude Code, or any other — can read Jira through this tool.

REGISTERING IT WITH CLAUDE CODE
  claude mcp add --scope user jira-fetch -- jira-fetch mcp --out docs/jira

  There is nothing else to pass: the server reads the same config file the CLI does,
  derived from the git repository it starts in. --scope user keeps the launch command
  out of the project tree.

TOOLS
  fetch_issues     write a document for each issue key given
  search_issues    the same, for each issue a JQL query matches; absent from
                   tools/list entirely when the config sets allowJql: false

  Both write into the output directory fixed at startup and return a link to each
  document. No tool writes to Jira, and none takes a path.

THE GUARANTEE, AND ITS LIMIT
  The config file decides which issues may be fetched. It lives outside the
  repository, so an agent working there cannot rewrite the policy, and the token is
  in that file and nowhere else.

  This is not a sandbox: the server runs as you, and so does the agent's shell. The
  only hard boundary is what the API token may see on Atlassian's side, so use one
  whose account cannot reach what you do not want read.

  jira-fetch setup offers Claude Code deny rules for the config directory. They stop
  the well-behaved path and nothing more.

OPTIONS
  -o, --out <dir>      output directory (default: current directory)
  -v, --verbose        print the config file the server resolved, on stderr
`;
