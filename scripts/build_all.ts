/**
 * Cross-compiles the CLI for every distribution target.
 *
 * `deno compile` bakes permission flags in at build time, so PERMISSIONS below is the single
 * source of truth: it must stay identical to the `--allow-*` string in the `dev` task in
 * deno.json, or the shipped binary behaves differently from `deno run`.
 */

export const PERMISSIONS = [
  '--allow-net',
  // Narrowed to the variables that locate the config directory, and nothing else. There are no
  // JIRA_* variables any more: credentials live in the config file, so a broad --allow-env would
  // grant a read of the whole environment for no reason the tool has.
  '--allow-env=HOME,APPDATA,USERPROFILE',
  '--allow-read',
  '--allow-write',
];

/** A distribution target: what to hand `deno compile --target`, what the binary is called on the
 * release page, and how npm spells the same platform.
 *
 * `os` and `cpu` are npm's vocabulary rather than ours on purpose. They go verbatim into the
 * platform packages' manifests, and they are what npm matches against to install exactly one of
 * the six — so the table stays the only place that knows the platform matrix. */
export type Target = {
  triple: string;
  name: string;
  os: 'darwin' | 'linux' | 'win32';
  cpu: 'x64' | 'arm64';
};

export const TARGETS: Target[] = [
  { triple: 'x86_64-apple-darwin', name: 'jira-fetch-macos-x86_64', os: 'darwin', cpu: 'x64' },
  { triple: 'aarch64-apple-darwin', name: 'jira-fetch-macos-aarch64', os: 'darwin', cpu: 'arm64' },
  { triple: 'x86_64-unknown-linux-gnu', name: 'jira-fetch-linux-x86_64', os: 'linux', cpu: 'x64' },
  {
    triple: 'aarch64-unknown-linux-gnu',
    name: 'jira-fetch-linux-aarch64',
    os: 'linux',
    cpu: 'arm64',
  },
  {
    triple: 'x86_64-pc-windows-msvc',
    name: 'jira-fetch-windows-x86_64.exe',
    os: 'win32',
    cpu: 'x64',
  },
  {
    triple: 'aarch64-pc-windows-msvc',
    name: 'jira-fetch-windows-aarch64.exe',
    os: 'win32',
    cpu: 'arm64',
  },
];

async function compile(target: Target | null): Promise<boolean> {
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
