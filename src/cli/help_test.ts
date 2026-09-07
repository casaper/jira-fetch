import { assert, assertFalse, assertStringIncludes } from '@std/assert';
import { VERSION } from './args.ts';
import { HELP, MCP_HELP } from './help.ts';

Deno.test('the CLI page says how to reach the MCP page', () => {
  for (const needle of ['--mcp-help', 'jira-fetch help mcp']) {
    assertStringIncludes(HELP, needle);
  }
});

Deno.test('the CLI page mentions mcp only as a command', () => {
  // Everything below is what the MCP page is for. Merging the two back together is a one-line
  // edit, so the separation is pinned rather than remembered.
  for (const needle of ['fetch_issues', 'search_issues', 'claude mcp add', 'tools/list']) {
    assertFalse(HELP.includes(needle), `the CLI page should not mention ${needle}`);
  }
});

Deno.test('the MCP page carries no CLI usage', () => {
  for (
    const needle of ['EXIT CODES', '<ISSUE-KEY>', '--dry-run', '--jql', 'config-file', '.config/']
  ) {
    assertFalse(MCP_HELP.includes(needle), `the MCP page should not mention ${needle}`);
  }
});

Deno.test('both pages name the version, so neither can drift from --version', () => {
  for (const page of [HELP, MCP_HELP]) {
    assertStringIncludes(page.split('\n')[0], `jira-fetch ${VERSION}`);
  }
});

Deno.test('neither page needs a wide terminal', () => {
  // `deno fmt` cannot reflow the inside of a template literal, so `fmt --check` would pass a
  // 110-column help line. Characters, not bytes: the em-dash is three of the latter.
  for (const page of [HELP, MCP_HELP]) {
    const wide = page.split('\n').filter((line) => [...line].length > 92);
    assert(wide.length === 0, `too wide: ${wide.join(' | ')}`);
  }
});

Deno.test('the CLI page documents the cache and its flags', () => {
  assertStringIncludes(HELP, 'jira-fetch cache');
  for (const flag of ['--refresh', '--show', '--clear']) {
    assertStringIncludes(HELP, flag);
  }
  // Where it is, in both spellings, because a user who wants to delete it needs to find it.
  assertStringIncludes(HELP, '~/.cache/jira-fetch/');
  assertStringIncludes(HELP, '%APPDATA%\\jira-fetch\\cache\\');
});

Deno.test('the MCP page still carries no cache usage', () => {
  // The separation the two pages exist for: the cache is a CLI concern, and the server reads it
  // without anyone needing to know that from this page.
  for (const needle of ['--refresh', '--show', '--clear', 'jira-fetch cache']) {
    assertFalse(MCP_HELP.includes(needle), `MCP_HELP should not mention ${needle}`);
  }
});

Deno.test('the CLI page names the filter menu as a command', () => {
  assertStringIncludes(HELP, 'jira-fetch filters');
});

Deno.test('the MCP page says where the policy it describes is built', () => {
  // Naming the command is threat-model content on this page, not CLI usage: a reader who has just
  // been told that a config file decides an agent's access needs to know where that file is
  // edited. The separation this page keeps is about usage — flags, keys, exit codes — and the
  // needles above are what pin it.
  assertStringIncludes(MCP_HELP, 'jira-fetch filters');
});
