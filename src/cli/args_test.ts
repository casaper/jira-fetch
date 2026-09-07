import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from '@std/assert';
import { parseCliArgs, UsageError } from './args.ts';

Deno.test('issue keys are normalised to upper case', () => {
  assertEquals(parseCliArgs(['dn-1243']).keys, ['DN-1243']);
});

Deno.test('duplicate keys are collapsed so the same file is not written twice', () => {
  assertEquals(parseCliArgs(['DN-1', 'dn-1', 'DN-2']).keys, ['DN-1', 'DN-2']);
});

Deno.test('something that is not an issue key is rejected', () => {
  assertThrows(() => parseCliArgs(['not-a-key-']), UsageError, 'is not an issue key');
  assertThrows(() => parseCliArgs(['1243']), UsageError);
});

Deno.test('an unknown option is rejected rather than ignored', () => {
  assertThrows(() => parseCliArgs(['--jsl', 'x']), UsageError, 'unknown option');
});

Deno.test('passing neither a key nor --jql is a usage error', () => {
  assertThrows(() => parseCliArgs([]), UsageError, 'nothing to fetch');
});

Deno.test('--jql alone is enough', () => {
  const args = parseCliArgs(['--jql', 'project = DN']);
  assertEquals(args.jql, 'project = DN');
  assertEquals(args.keys, []);
});

Deno.test('keys and --jql combine', () => {
  const args = parseCliArgs(['DN-1', '--jql', 'project = SUP']);
  assertEquals(args.keys, ['DN-1']);
  assertEquals(args.jql, 'project = SUP');
});

Deno.test('short aliases match their long forms', () => {
  const args = parseCliArgs(['DN-1', '-o', 'tmp', '-n', '-v']);
  assertEquals(args.out, 'tmp');
  assert(args.dryRun);
  assert(args.verbose);
});

Deno.test('every flag that could override the policy is refused, and says where it went', () => {
  // Not folded into "unknown option": each of these was documented, so trying the old spelling
  // should say where the setting lives now rather than leaving the reader to guess.
  for (
    const [flag, needle] of [
      ['--config', 'jira-fetch config-file'],
      ['-c', 'jira-fetch config-file'],
      ['--token', 'jira-fetch setup'],
      ['--base-url', 'baseUrl in the config file'],
      ['--email', 'email in the config file'],
    ]
  ) {
    const error = assertThrows(() => parseCliArgs(['DN-1', flag, 'x']), UsageError);
    assertStringIncludes(error.message, needle);
  }
});

Deno.test('the removed flags are refused in their --flag=value form too', () => {
  const error = assertThrows(() => parseCliArgs(['DN-1', '--token=secret']), UsageError);
  assertStringIncludes(error.message, 'jira-fetch setup');
  // And the value never lands anywhere it could be printed back.
  assertFalse(error.message.includes('secret'));
});

Deno.test('--help and --version short-circuit the key requirement', () => {
  assertEquals(parseCliArgs(['--help']).help, 'cli');
  assert(parseCliArgs(['--version']).version);
});

Deno.test('every spelling of help resolves to one of the two pages', () => {
  assertEquals(parseCliArgs(['--help']).help, 'cli');
  assertEquals(parseCliArgs(['help']).help, 'cli');
  assertEquals(parseCliArgs(['--mcp-help']).help, 'mcp');
  assertEquals(parseCliArgs(['mcp', '--help']).help, 'mcp');
  assertEquals(parseCliArgs(['help', 'mcp']).help, 'mcp');
  // `setup` has no page of its own, and the two spellings must still agree.
  assertEquals(parseCliArgs(['help', 'setup']).help, 'cli');
  assertEquals(parseCliArgs(['setup', '--help']).help, 'cli');
  assertFalse(parseCliArgs(['DN-1']).help);
});

Deno.test('help refuses a topic that is not a command', () => {
  assertThrows(() => parseCliArgs(['help', 'nonsense']), UsageError, 'no help for');
  assertThrows(() => parseCliArgs(['help', 'mcp', 'setup']), UsageError, 'one command at most');
});

Deno.test('flags default to false rather than undefined', () => {
  const args = parseCliArgs(['DN-1']);
  assertFalse(args.dryRun);
  assertFalse(args.verbose);
  assertFalse(args.help);
  assertEquals(args.out, undefined);
});

Deno.test('cache is a subcommand, and its default is to do whatever is needed', () => {
  const args = parseCliArgs(['cache']);
  assertEquals(args.mode, 'cache');
  assertEquals(args.cacheAction, 'choose');
});

Deno.test('each cache flag names the whole run', () => {
  assertEquals(parseCliArgs(['cache', '--refresh']).cacheAction, 'refresh');
  assertEquals(parseCliArgs(['cache', '--show']).cacheAction, 'show');
  assertEquals(parseCliArgs(['cache', '--clear']).cacheAction, 'clear');
});

Deno.test('two cache flags at once is a usage error, not a precedence rule', () => {
  assertThrows(
    () => parseCliArgs(['cache', '--refresh', '--show']),
    UsageError,
    'cannot be combined',
  );
  assertThrows(
    () => parseCliArgs(['cache', '--show', '--clear']),
    UsageError,
    'cannot be combined',
  );
});

Deno.test('a cache flag outside cache mode is refused rather than ignored', () => {
  // A flag that silently does nothing is worse than one that says where it belongs.
  assertThrows(() => parseCliArgs(['--refresh']), UsageError, 'outside jira-fetch cache');
  assertThrows(() => parseCliArgs(['DN-1', '--show']), UsageError, 'outside jira-fetch cache');
  assertThrows(() => parseCliArgs(['setup', '--clear']), UsageError, 'outside jira-fetch cache');
});

Deno.test('cache takes project keys, not issue keys', () => {
  assertEquals(parseCliArgs(['cache', 'DN', 'SUP']).cacheProjects, ['DN', 'SUP']);
  // Named twice is named once: the same project is not read twice.
  assertEquals(parseCliArgs(['cache', 'DN', 'DN']).cacheProjects, ['DN']);
  assertEquals(parseCliArgs(['cache']).cacheProjects, []);
});

Deno.test('a cache argument that is not a project key is refused', () => {
  // It reaches a filename and a REST path segment, so the shape is checked here rather than
  // discovered later.
  for (const bad of ['DN-1', 'dn', '../etc', 'D N']) {
    assertThrows(
      () => parseCliArgs(['cache', bad]),
      UsageError,
      'is not a Jira project key',
    );
  }
});

Deno.test('cache fetches no issues, so the fetch flags have no meaning', () => {
  assertThrows(() => parseCliArgs(['cache', '--jql', 'x']), UsageError, '--jql has no meaning');
  assertThrows(() => parseCliArgs(['cache', '--dry-run']), UsageError, '--dry-run has no meaning');
});

Deno.test('help wins over a misplaced cache flag', () => {
  // The help short-circuit is above every command guard, so `--help` prints help whatever else is
  // on the line.
  assertEquals(parseCliArgs(['--help', '--refresh']).help, 'cli');
  assert(parseCliArgs(['--version', '--show']).version);
});

Deno.test('cache has no help page of its own, and both spellings agree', () => {
  assertEquals(parseCliArgs(['help', 'cache']).help, 'cli');
  assertEquals(parseCliArgs(['cache', '--help']).help, 'cli');
});
