/** The npm layout is generated, and what it has to get right is mostly structural: one package per
 * platform, npm's own `os`/`cpu` spelling so exactly one of them installs, and a shim that hands
 * over faithfully. These pin that. */

import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';
import { TARGETS } from './build_all.ts';
import {
  binaryName,
  MAIN_PACKAGE,
  mainManifest,
  NPM_SCOPE,
  platformManifest,
  platformPackage,
  SHIM,
  stage,
} from './npm_package.ts';

Deno.test('every target maps to a distinct, scoped package name', () => {
  const names = TARGETS.map(platformPackage);
  assertEquals(new Set(names).size, TARGETS.length);
  for (const name of names) assert(name.startsWith(`@${NPM_SCOPE}/${MAIN_PACKAGE}-`));
});

Deno.test('a platform package installs only on its platform', () => {
  const target = TARGETS.find((t) => t.os === 'darwin' && t.cpu === 'arm64');
  assert(target);
  const manifest = platformManifest(target, '1.2.3');

  assertEquals(manifest.name, '@casaper/jira-fetch-darwin-arm64');
  // These two fields are the whole mechanism: npm reads them and skips the other five.
  assertEquals(manifest.os, ['darwin']);
  assertEquals(manifest.cpu, ['arm64']);
  assertEquals(manifest.files, ['jira-fetch']);
  assertEquals(manifest.version, '1.2.3');
});

Deno.test('the Windows packages ship an .exe, and only those', () => {
  for (const target of TARGETS) {
    assertEquals(binaryName(target), target.os === 'win32' ? 'jira-fetch.exe' : 'jira-fetch');
  }
});

Deno.test('the installed package pins every platform at the exact version', () => {
  const manifest = mainManifest('1.2.3');

  assertEquals(Object.keys(manifest.optionalDependencies).length, TARGETS.length);
  // Pinned, not caret-ranged: the shim resolves a sibling and expects the binary compiled from
  // this same source tree, not a newer one npm felt free to substitute.
  for (const range of Object.values(manifest.optionalDependencies)) assertEquals(range, '1.2.3');
  assertEquals(manifest.bin, { 'jira-fetch': 'bin/jira-fetch.mjs' });
});

Deno.test('the shim never writes to stdout', () => {
  // In `jira-fetch mcp` stdout is the JSON-RPC stream. One stray line from the wrapper corrupts
  // the session far from its cause, so the wrapper has no business writing there at all.
  assertFalse(SHIM.includes('process.stdout'));
  assertFalse(SHIM.includes('console.log'));
  assertStringIncludes(SHIM, 'process.stderr.write');
});

Deno.test('the shim forwards the exit code rather than inventing one', () => {
  // jira-fetch's exit codes are part of its contract: 2 for usage, 3 for "everything was
  // filtered". A wrapper that returned 0 for those would be invisible until it mattered.
  assertStringIncludes(SHIM, 'process.exit(status === null ? 1 : status)');
  assertStringIncludes(SHIM, "stdio: 'inherit'");
});

Deno.test('the shim carries no backtick, because it is embedded in a template literal', () => {
  // This is not hypothetical: writing one in a comment inside the shim closed the literal early
  // and broke the whole module. The generated file is JavaScript in a string, and stays quotable.
  assertFalse(SHIM.includes('`'));
  assert(SHIM.startsWith('#!/usr/bin/env node\n'));
});

const nodeAvailable = await new Deno.Command('node', {
  args: ['--version'],
  stdout: 'null',
  stderr: 'null',
})
  .output().then((r) => r.success).catch(() => false);

Deno.test({
  name: 'the shim is valid JavaScript',
  // Node is not a dependency of this project, so this is the one check that bows out rather than
  // failing on a machine without it. The string assertions above hold regardless.
  ignore: !nodeAvailable,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      const file = `${dir}/jira-fetch.mjs`;
      await Deno.writeTextFile(file, SHIM);
      const { success, stderr } = await new Deno.Command('node', { args: ['--check', file] })
        .output();
      assert(success, new TextDecoder().decode(stderr));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test('staging lays out seven packages, platform ones first', async () => {
  const root = await Deno.makeTempDir();
  try {
    // A stand-in for dist/: staging must not need a real cross-compile to be testable.
    const dist = `${root}/dist`;
    await Deno.mkdir(dist);
    for (const target of TARGETS) await Deno.writeTextFile(`${dist}/${target.name}`, 'binary');

    const staged = await stage('1.2.3', `${root}/npm`, dist);

    assertEquals(staged.length, TARGETS.length + 1);
    // The order is the publish order: the main package must land last, or its
    // optionalDependencies would not resolve for anyone installing in between.
    assertEquals(staged.at(-1)?.name, MAIN_PACKAGE);
    assertFalse(staged.slice(0, -1).some((p) => p.name === MAIN_PACKAGE));

    const main = staged.at(-1);
    assert(main);
    for (const file of ['package.json', 'bin/jira-fetch.mjs', 'README.md', 'LICENSE']) {
      assert((await Deno.stat(`${main.dir}/${file}`)).isFile, file);
    }

    const darwin = staged.find((p) => p.name.endsWith('darwin-arm64'));
    assert(darwin);
    const binary = await Deno.stat(`${darwin.dir}/jira-fetch`);
    // The executable bit is the one thing that would fail on a user's machine and not here.
    if (Deno.build.os !== 'windows') assertEquals((binary.mode ?? 0) & 0o111, 0o111);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
