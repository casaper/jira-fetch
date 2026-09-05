/**
 * Cross-compiles the CLI for every distribution target.
 *
 * `deno compile` bakes permission flags in at build time, so PERMISSIONS below is the single
 * source of truth: it must stay identical to the `--allow-*` string in the `dev` task in
 * deno.json, or the shipped binary behaves differently from `deno run`.
 */

export const PERMISSIONS = [
  '--allow-net',
  '--allow-env',
  '--allow-read',
  '--allow-write',
];

export const TARGETS = [
  { triple: 'x86_64-apple-darwin', name: 'jira-fetch-macos-x86_64' },
  { triple: 'aarch64-apple-darwin', name: 'jira-fetch-macos-aarch64' },
  { triple: 'x86_64-unknown-linux-gnu', name: 'jira-fetch-linux-x86_64' },
  { triple: 'aarch64-unknown-linux-gnu', name: 'jira-fetch-linux-aarch64' },
  { triple: 'x86_64-pc-windows-msvc', name: 'jira-fetch-windows-x86_64.exe' },
  { triple: 'aarch64-pc-windows-msvc', name: 'jira-fetch-windows-aarch64.exe' },
];

async function compile(target: { triple: string; name: string } | null): Promise<boolean> {
  const out = target ? `dist/${target.name}` : 'dist/jira-fetch';
  const args = [
    'compile',
    ...PERMISSIONS,
    ...(target ? ['--target', target.triple] : []),
    '-o',
    out,
    'src/main.ts',
  ];
  console.log(`  ${target?.triple ?? 'host'} -> ${out}`);
  const { success } = await new Deno.Command(Deno.execPath(), {
    args,
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  return success;
}

if (import.meta.main) {
  const hostOnly = Deno.args.includes('--host');
  console.log(hostOnly ? 'Building for host...' : `Building ${TARGETS.length} targets...`);

  const failures: string[] = [];
  if (hostOnly) {
    if (!await compile(null)) failures.push('host');
  } else {
    for (const target of TARGETS) {
      if (!await compile(target)) failures.push(target.triple);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFailed: ${failures.join(', ')}`);
    Deno.exit(1);
  }
  console.log('\nDone.');
}
