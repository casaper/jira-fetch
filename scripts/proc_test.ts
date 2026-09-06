/** `run` is what the release scripts drive git, gh, deno and npm with, so what it does to the
 * child's streams is part of the release working at all. */

import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import { fromFileUrl, join } from '@std/path';
import { output, succeeds } from './proc.ts';

const PROC = fromFileUrl(import.meta.resolve('./proc.ts'));

/** The child `run` is pointed at: it echoes back whatever it was handed on stdin. Deliberately a
 * script file rather than `sh -c` (which does not exist on Windows) or `deno eval` (whose program
 * would travel as one argument, and Windows rebuilds an argument vector into a command line, so
 * the quotes in it do not survive). The subject here is the stream, not the program at the other
 * end of it. */
const ECHO_STDIN = [
  'const buffer = new Uint8Array(4096);',
  'const read = await Deno.stdin.read(buffer);',
  'console.log("got:[" + new TextDecoder().decode(buffer.subarray(0, read ?? 0)) + "]");',
].join('\n');

/** Runs a one-line program that uses `run`, in a subprocess whose stdin we control. Nothing else
 * can answer "does the child of `run` see our stdin?" — the test process's own stdin is whatever
 * `deno test` was given. */
const throughRun = async (stdin: string): Promise<string> => {
  const dir = await Deno.makeTempDir();
  try {
    const echo = join(dir, 'echo.ts');
    await Deno.writeTextFile(echo, ECHO_STDIN);
    const script = join(dir, 'driver.ts');
    await Deno.writeTextFile(
      script,
      `import { run } from ${JSON.stringify(PROC)};\n` +
        `await run(${JSON.stringify(Deno.execPath())}, 'run', ${JSON.stringify(echo)});\n`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', script],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
    const { stdout } = await child.output();
    return new TextDecoder().decode(stdout);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

Deno.test('run passes its own stdin to the child', async () => {
  // Not a nicety. Deno.Command().output() hands the child an *empty* stdin unless told otherwise,
  // which turns every prompt into an instant failure: `npm publish` under two-factor auth could
  // not ask for confirmation and died with EOTP — after the GitHub release had been created, so
  // the release was half-done and the documented "just run it again" recovery was unavailable.
  assertStringIncludes(await throughRun('a-secret-code'), 'got:[a-secret-code]');
});

Deno.test('succeeds reports a failure as an answer rather than throwing', async () => {
  assert(await succeeds('sh', '-c', 'exit 0'));
  assertFalse(await succeeds('sh', '-c', 'exit 1'));
  // A command that is not installed is an answer too, not a crash.
  assertFalse(await succeeds('definitely-not-a-real-command-xyz'));
});

Deno.test('output returns what a command printed, and null when it failed', async () => {
  assertEquals(await output('sh', '-c', 'echo "  spaced  "'), 'spaced');
  // The distinction publishNpm depends on: printing nothing is not the same as failing.
  assertEquals(await output('sh', '-c', "printf ''"), '');
  assertEquals(await output('sh', '-c', 'echo out; exit 1'), null);
  assertEquals(await output('definitely-not-a-real-command-xyz'), null);
});
