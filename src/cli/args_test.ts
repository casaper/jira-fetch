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
  assert(parseCliArgs(['--help']).help);
  assert(parseCliArgs(['--version']).version);
});

Deno.test('flags default to false rather than undefined', () => {
  const args = parseCliArgs(['DN-1']);
  assertFalse(args.dryRun);
  assertFalse(args.verbose);
  assertEquals(args.out, undefined);
});
