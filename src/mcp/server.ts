/** The MCP server: the same fetch pipeline the CLI runs, offered to an agent over stdio.
 *
 * The point of the mode is what it *cannot* do. There is no tool that writes to Jira, so no write
 * can happen — not because an agent was told not to, but because the capability is absent from
 * `tools/list`. The config's filters decide which issues may be fetched, and a client has no way
 * to reach past them: JQL resolves to keys, and every key goes through the same two filter stages
 * as a key typed at the terminal.
 *
 * Two rules govern everything in here:
 *
 * 1. **Nothing may write to stdout except the protocol.** The session (`src/fetch/session.ts`)
 *    already writes nothing there; keep it that way.
 * 2. **Nothing about a denied issue reaches the client.** Not the rule that matched, not a field
 *    of the payload, not even whether the issue exists. See `UNAVAILABLE`.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
// `node:stream` is a runtime builtin, not a fetched resource. `no-external-import` exists to keep
// https:// imports out and has no import-map form for a `node:` specifier, so the exemption is
// targeted rather than the rule being dropped. `StdioServerTransport` takes a Node Readable; this
// is how stdin reaches it — see `serveMcp` at the foot of the file.
// deno-lint-ignore no-external-import
import { Readable } from 'node:stream';
import { toFileUrl } from '@std/path';
import { z } from 'zod';
import { JiraError } from '../jira/client.ts';
import { ISSUE_KEY, VERSION } from '../cli/args.ts';
import type { Config } from '../config/config.ts';
import type { FetchSession, Outcome } from '../fetch/session.ts';

/** How the server describes itself to a client, before any tool is called. */
const INSTRUCTIONS =
  `Read-only access to Jira Cloud issues. Tools write Markdown documents into a fixed output
directory and return links to them; read the linked files to see an issue.

A configuration on the server decides which issues may be fetched. It cannot be overridden from
here, and issues it does not permit are reported as unavailable — that is expected, not an error
to work around. Nothing in this server can change anything in Jira.`;

/** One string for "denied" and for "does not exist", on purpose.
 *
 * Distinguishing them would let a client map the deny-list by probing keys, which is exactly the
 * control this mode exists to provide. Jira's own API already conflates the two — its 404 reads
 * "Issue does not exist or you do not have permission to see it" — so this follows the upstream
 * precedent rather than inventing a weaker one. */
const UNAVAILABLE = 'not available (no such issue, or not permitted by this server configuration)';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string };

/** What one call did, in the only two forms the client ever sees. */
type Report = {
  links: ContentBlock[];
  lines: string[];
  written: number;
};

const emptyReport = (): Report => ({ links: [], lines: [], written: 0 });

/** Reads `key` and `status` off an outcome, and nothing else.
 *
 * `Outcome['reason']` is `matched exclude rule ${JSON.stringify(rule)}` — the serialised policy —
 * and a stage-2 denial was decided with the whole issue payload in hand. Neither is in scope here,
 * which is the point of doing the formatting in one place. */
const record = (outcome: Outcome, into: Report): void => {
  if (outcome.status === 'denied') {
    into.lines.push(`${outcome.key}  ${UNAVAILABLE}`);
    return;
  }
  // `dryRun` cannot occur: the server never constructs a dry-run session.
  if (outcome.status === 'written') {
    into.links.push({
      type: 'resource_link',
      uri: toFileUrl(outcome.path).href,
      name: `${outcome.key}.md`,
      mimeType: 'text/markdown',
    });
    into.lines.push(
      `${outcome.key}  written${outcome.assets > 0 ? ` (+${outcome.assets} attachment(s))` : ''}`,
    );
    into.written++;
  }
};

/** A failure fetching one key must not fail the whole call — the other keys still have answers.
 *
 * Jira's own 404 and 403 collapse into `UNAVAILABLE` alongside a filter denial, which is what
 * makes that string mean what it says. Reporting "no such issue" separately would hand a client
 * the one bit it needs to map the deny-list: ask for a key, and a different answer for "denied"
 * than for "absent" tells it the issue exists and is being withheld. Everything else — a network
 * failure, a bad token, a 500 — is a real error and says so, since none of those depend on which
 * key was asked for. */
const attempt = async (session: FetchSession, key: string, into: Report): Promise<void> => {
  try {
    record(await session.fetch(key), into);
  } catch (cause) {
    const status = cause instanceof JiraError ? cause.status : undefined;
    into.lines.push(
      status === 404 || status === 403
        ? `${key}  ${UNAVAILABLE}`
        : `${key}  failed: ${(cause as Error).message}`,
    );
  }
};

/** `isError` when the call produced nothing, which is MCP's convention for a tool-execution
 * failure the model should react to — as against a JSON-RPC error, which is for a malformed or
 * unknown call. A mixed call is an ordinary result whose text says which keys came back. */
const finish = (report: Report, summary: string) => ({
  ...(report.written === 0 ? { isError: true } : {}),
  content: [...report.links, {
    type: 'text' as const,
    text: [...report.lines, '', summary].join('\n'),
  }],
});

export const createMcpServer = (session: FetchSession, config: Config): McpServer => {
  const server = new McpServer(
    { name: 'jira-fetch', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  // Honest hints, not a boundary: these tools are read-only against *Jira*, but they do write
  // files, so `readOnlyHint` is false. The boundary is that no write tool is registered at all.
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  server.registerTool('fetch_issues', {
    description:
      'Fetch Jira issues by key into Markdown documents, with their attachments alongside, and ' +
      'return a link to each document written. Issues the server configuration does not permit ' +
      'are reported as unavailable and no file is written for them.',
    inputSchema: z.object({
      // Shape-checked here, not just for tidiness: an unvalidated key is interpolated straight
      // into `GET /rest/api/3/issue/{key}`, so `..` in one would address a different endpoint.
      // The CLI has always validated its positional arguments; this is the same gate.
      keys: z.array(z.string().regex(ISSUE_KEY, 'must look like DN-1243')).min(1).max(50)
        .describe('Issue keys, e.g. ["DN-1243", "DN-1250"]'),
    }),
    annotations: { title: 'Fetch Jira issues by key', ...annotations },
  }, async ({ keys }) => {
    const report = emptyReport();
    // De-duplicated: the same key twice would fetch and overwrite one file twice.
    for (const key of new Set(keys.map((k) => k.trim().toUpperCase()))) {
      await attempt(session, key, report);
    }
    return finish(report, `${report.written} of ${report.lines.length} issue(s) written.`);
  });

  // Registered only when the configuration allows JQL — absent from tools/list rather than
  // refused when called, which is the same guarantee as having no write tools.
  if (config.allowJql) {
    server.registerTool('search_issues', {
      description:
        'Run a JQL query and fetch each issue it matches into a Markdown document, returning a ' +
        'link to each. The query only selects candidates: every issue still passes the same ' +
        'server configuration as fetch_issues, so a query cannot reach issues it does not permit.',
      inputSchema: z.object({
        jql: z.string().min(1).describe(
          'A JQL query, e.g. project = DN AND status = "In Progress"',
        ),
        limit: z.number().int().min(1).max(100).default(25).describe(
          'Maximum number of matching issues to consider (default 25)',
        ),
      }),
      annotations: { title: 'Fetch Jira issues by JQL', ...annotations },
    }, async ({ jql, limit }) => {
      const report = emptyReport();
      let seen = 0;
      for await (const key of session.keys(jql)) {
        if (seen === limit) break;
        seen++;
        await attempt(session, key, report);
      }
      // The limit counts issues *considered*, not documents written, so a query whose first N
      // hits are all unavailable writes nothing. Saying which ending this was is what lets a
      // client tell "you are being filtered" from "that is all there is".
      const ending = seen === limit
        ? `${seen} issue(s) considered (limit reached; more may match)`
        : `${seen} issue(s) considered (query exhausted)`;
      return finish(report, `${report.written} written. ${ending}`);
    });
  }

  return server;
};

/** Serves on stdin/stdout until the client closes the connection.
 *
 * The transport is constructed here rather than left to `serveStdio` so that stdin's `end` is
 * reachable: `serveStdio` owns the transport it makes, overwrites `onclose`, and does not close it
 * when the stream ends — the process would simply run out of work, which `Deno.exit(await run())`
 * in `src/main.ts` turns into "top-level await promise never resolved" and a non-zero exit. Owning
 * the stream gives one honest signal for "the client went away".
 */
export const serveMcp = async (session: FetchSession, config: Config): Promise<void> => {
  const stdin = Readable.fromWeb(Deno.stdin.readable);
  const ended = Promise.withResolvers<void>();
  stdin.once('end', () => ended.resolve());

  serveStdio(() => createMcpServer(session, config), {
    transport: new StdioServerTransport(stdin),
    // Out-of-band transport errors. stderr, never stdout: stdout is the protocol.
    onerror: (error) => console.error(`error: ${error.message}`),
  });

  await ended.promise;
};
