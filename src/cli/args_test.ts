import { assert, assertEquals, assertFalse, assertThrows } from '@std/assert';
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
  const args = parseCliArgs(['DN-1', '-o', 'tmp', '-n', '-v', '-c', 'cfg.json']);
  assertEquals(args.out, 'tmp');
  assertEquals(args.config, 'cfg.json');
  assert(args.dryRun);
  assert(args.verbose);
});

Deno.test('credential flags are read', () => {
  const args = parseCliArgs([
    'DN-1',
    '--base-url',
    'https://x.atlassian.net',
    '--email',
    'a@b.co',
    '--token',
    't',
  ]);
  assertEquals(args.baseUrl, 'https://x.atlassian.net');
  assertEquals(args.email, 'a@b.co');
  assertEquals(args.token, 't');
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
