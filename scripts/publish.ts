/**
 * Publishes a tagged release to GitHub: push, cross-compile, checksum, attach.
 *
 * Split from `release.ts` on purpose. `deno task release` calls it as its last step, but it is
 * also a task of its own — cross-compiling six targets is the part most likely to fail, and when
 * it does the fix should be `deno task publish` again rather than a half-released version that
 * has to be untangled by hand. Every step below is therefore idempotent up to the point of
 * creating the release, which is the one thing that refuses to happen twice.
 *
 * The npm publish is a **second** such thing, and a harsher one: a version cannot be unpublished
 * after 72 hours and can never be republished, so a bad shim in 0.5.1 is permanent and the fix is
 * 0.5.2. That is why it runs last — everything freely repeatable has already succeeded by then —
 * and why it skips what the registry already has rather than trying and failing.
 *
 *   deno task publish
 */

import { TARGETS } from './build_all.ts';
import { NPM_SCOPE, stage } from './npm_package.ts';
import { git, output, run, succeeds } from './proc.ts';

const DENO_JSON = 'deno.json';
const ARGS_TS = 'src/cli/args.ts';
const CHANGELOG = 'CHANGELOG.md';
const NPM_DIST = 'dist/npm';

export const VERSION_IN_JSON = /(?<=^ {2}"version": ")(?<version>\d+\.\d+\.\d+)(?=",$)/m;
export const VERSION_IN_ARGS = /(?<=^export const VERSION = ')(?<version>\d+\.\d+\.\d+)(?=';$)/m;

export const readVersion = async (path: string, pattern: RegExp): Promise<string> => {
  const match = pattern.exec(await Deno.readTextFile(path));
  if (!match?.groups) throw new Error(`no version found in ${path}`);
  return match.groups.version;
};

export const fail = (message: string): never => {
  console.error(`error: ${message}`);
  Deno.exit(2);
};

/** The section of CHANGELOG.md for one version, without its own heading — the release page shows
 * the version as its title already. Throws rather than publishing empty notes: an unreleased
 * changelog means `release.ts` was not the thing that made this tag. */
export const changelogSection = async (version: string): Promise<string> => {
  const text = await Deno.readTextFile(CHANGELOG);
  const start = text.search(new RegExp(`^## ${version.replace(/\./g, '\\.')}( |$)`, 'm'));
  if (start === -1) throw new Error(`${CHANGELOG} has no section for ${version}`);
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const body = (end === -1 ? rest : rest.slice(0, end)).split('\n').slice(1).join('\n');
  return body.trim();
};

/** The half of the notes the changelog cannot generate: which file to take, and the two commands
 * a first-time user is otherwise stopped by. The table is built from `TARGETS`, so it cannot come
 * to disagree with what was actually compiled. */
const installSection = (): string => {
  const label = (name: string) =>
    name
      .replace('jira-fetch-', '')
      .replace('.exe', '')
      .replace('macos', 'macOS')
      .replace('linux', 'Linux')
      .replace('windows', 'Windows')
      .replace('-aarch64', ' (arm64)')
      .replace('-x86_64', ' (x86_64)');

  return [
    '## Install',
    '',
    '```sh',
    'npm install -g jira-fetch',
    '```',
    '',
    'That fetches one prebuilt binary for your platform. The binary is self-contained — npm is',
    'how it reaches you, not something it needs to run. `npx jira-fetch mcp` works too, if you',
    'would rather not install anything.',
    '',
    'Or take a binary from the assets below. They need no Deno installation either.',
    '',
    '| Platform | File |',
    '| --- | --- |',
    ...TARGETS.map((t) => `| ${label(t.name)} | \`${t.name}\` |`),
    '',
    '```sh',
    'chmod +x jira-fetch-macos-aarch64',
    '',
    '# macOS only: these binaries are not signed or notarised, so Gatekeeper quarantines them on',
    '# download and refuses to open them. This clears that flag for the file you downloaded.',
    'xattr -d com.apple.quarantine jira-fetch-macos-aarch64',
    '',
    './jira-fetch-macos-aarch64 --version',
    '```',
    '',
    'Verify what you downloaded against `SHA256SUMS`:',
    '',
    '```sh',
    'shasum -a 256 -c SHA256SUMS --ignore-missing',
    '```',
  ].join('\n');
};

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** `<hex>  <name>` per line — the format `shasum -a 256 -c` and `sha256sum -c` both read, which is
 * the point of shipping it. Digested in Deno rather than shelling out to `shasum`, which is not
 * on every platform this is released from. */
const writeChecksums = async (): Promise<string> => {
  const lines: string[] = [];
  for (const target of TARGETS) {
    const bytes = await Deno.readFile(`dist/${target.name}`);
    lines.push(`${hex(await crypto.subtle.digest('SHA-256', bytes))}  ${target.name}`);
  }
  const path = 'dist/SHA256SUMS';
  await Deno.writeTextFile(path, `${lines.join('\n')}\n`);
  return path;
};

/** Whether the registry already has that exact version.
 *
 * Compared against the printed version rather than the exit status on purpose: for a package that
 * exists *without* this version, `npm view` exits 0 and prints nothing — so a `succeeds`-style
 * probe would read a missing version as a published one, skip the publish, and report a release
 * that never reached the registry. It would pass the first time, when everything still 404s. */
const alreadyPublished = async (name: string, version: string): Promise<boolean> =>
  await output('npm', 'view', `${name}@${version}`, 'version') === version;

/** A command that prints a fresh npm one-time code on stdout, read from the environment so no
 * password-manager path lives in the repository. Optional: without it npm prompts for itself,
 * which works now that `run` inherits stdin.
 *
 *   export JIRA_FETCH_NPM_OTP='pass-cli item totp --output=json pass://pers/npmjs.com/totp | jq -r .totp'
 */
export const OTP_ENV = 'JIRA_FETCH_NPM_OTP';

/** Seconds until the next TOTP window opens. Codes step every 30 seconds on the Unix epoch, and
 * the extra second is to land inside the new window rather than exactly on its edge. */
export const untilNextWindow = (now = Date.now()): number => 31 - (Math.floor(now / 1000) % 30);

/** How many windows to wait through before giving up on a fresh code. Two is enough for the
 * intended case — one spent code, one wait — and small enough that a command returning a constant
 * fails in about a minute instead of hanging the release for good. */
const OTP_ATTEMPTS = 3;

/**
 * A one-time code npm has not seen yet in this run, or `undefined` when no command is configured.
 *
 * Fetching once and reusing the code would not work: a TOTP is single-use, and seven packages of
 * ~35 MB take several 30-second windows to upload anyway. So each publish gets its own code — and
 * when two publishes fall inside one window the same digits come back, which is why this waits for
 * the next window instead of handing npm a code it has already rejected.
 *
 * Bounded, because the unbounded version hangs forever the moment the command stops advancing —
 * a cached or stale value, a misconfigured entry — and a release script that waits silently for
 * ever is worse than one that stops and says why.
 */
export const nextOtp = async (
  used: Set<string>,
  wait: (seconds: number) => Promise<void> = (seconds) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
): Promise<string | undefined> => {
  const command = Deno.env.get(OTP_ENV)?.trim();
  if (!command) return undefined;

  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt++) {
    // Its own Deno.Command rather than `output`: stdout is captured because the code is the
    // answer, while stdin and stderr stay on the terminal so a locked vault can ask for a
    // passphrase instead of hanging with its prompt swallowed.
    const { stdout, success } = await new Deno.Command('sh', {
      args: ['-c', command],
      stdin: 'inherit',
      stderr: 'inherit',
    }).output();
    const code = new TextDecoder().decode(stdout).trim();
    if (!success || !/^\d{6,8}$/.test(code)) {
      throw new Error(`${OTP_ENV} did not print a one-time code:\n  ${command}`);
    }
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
    if (attempt === OTP_ATTEMPTS) break;
    const seconds = untilNextWindow();
    console.log(`  that code is spent; waiting ${seconds}s for the next one...`);
    await wait(seconds);
  }
  // Thrown rather than `fail`ed so the loop can be tested at all: `fail` exits the process, which
  // would take the test runner with it. publishNpm turns it back into a clean exit-2 message.
  throw new Error(
    `${OTP_ENV} kept returning a code this run has already used, after ${OTP_ATTEMPTS} tries:\n` +
      `  ${command}\n` +
      '  It should print the current one-time code, which changes every 30 seconds.',
  );
};

/** Stages and publishes the seven packages, in the order `stage` returns them: every platform
 * package before the one that depends on them, so `jira-fetch` never sits on the registry with
 * optional dependencies that cannot resolve. */
const publishNpm = async (version: string): Promise<void> => {
  const packages = await stage(version, NPM_DIST);
  const used = new Set<string>();
  for (const pkg of packages) {
    if (await alreadyPublished(pkg.name, version)) {
      console.log(`  ${pkg.name}@${version} is already published`);
      continue;
    }
    console.log(`  ${pkg.name}@${version}`);
    const otp = await nextOtp(used).catch((cause) => fail((cause as Error).message));
    // Scoped packages default to restricted, which would publish something nobody can install.
    await run(
      'npm',
      'publish',
      '--access',
      'public',
      ...(otp ? [`--otp=${otp}`] : []),
      pkg.dir,
    );
  }
};

/** The checks that depend on nothing but this machine, so `release.ts` can run them *before* it
 * bumps and tags. Discovering a missing `gh` after the tag exists is a mess to unpick. */
export const assertCanPublish = async (): Promise<void> => {
  if (!await succeeds('gh', '--version')) {
    fail('the GitHub CLI is not installed: https://cli.github.com');
  }
  // `gh api user` rather than `gh auth status`: it makes a request with whichever credential gh
  // will actually use, instead of asking gh's opinion about the accounts it knows. That matters
  // here because there are usually two — a keyring login and a GH_TOKEN that direnv exports for
  // this directory — and gh silently prefers the token. `gh auth status` does validate the active
  // one (an invalid GH_TOKEN fails it too, checked), so this is a tightening rather than a fix:
  // one request, one answer, no reasoning about which account the exit code described.
  if (!await succeeds('gh', 'api', 'user')) {
    fail(
      'GitHub authentication is not working: run `gh auth login`.\n' +
        '  If GH_TOKEN is set, gh prefers it over the keyring — check that one first.',
    );
  }

  // The repository's .npmrc authenticates with ${NPM_TOKEN}, which direnv loads from .env.local.
  // Unset, npm sends the literal string and fails with an unauthorised error that says nothing
  // about the cause — so it is named here, before the tag exists.
  if (!Deno.env.get('NPM_TOKEN')?.trim()) {
    fail(
      'NPM_TOKEN is not set, and .npmrc publishes with it.\n' +
        '  It lives in .env.local, which direnv loads for this directory — check `direnv status`,\n' +
        '  or export it for this command.',
    );
  }

  // Checked on output, not on exit status: being logged in as somebody else also exits 0, and the
  // platform packages can only be published by whoever owns the scope they are named after.
  const who = await output('npm', 'whoami');
  if (who === null) fail('not logged in to npm: run `npm login`');
  if (who !== NPM_SCOPE) {
    fail(
      `npm says you are "${who}", but the platform packages publish under @${NPM_SCOPE};\n` +
        `  log in as ${NPM_SCOPE}, or change NPM_SCOPE in scripts/npm_package.ts`,
    );
  }
};

export const publish = async (version: string): Promise<void> => {
  const tag = `v${version}`;

  // Preflight, all of it before anything leaves this machine.
  await assertCanPublish();
  if (await git('status', '--porcelain') !== '') {
    fail('the working tree is dirty; the release would not match the tag');
  }
  if (await git('rev-parse', tag + '^{}') !== await git('rev-parse', 'HEAD')) {
    fail(`${tag} does not point at HEAD; check out the release commit first`);
  }
  // An existing release for this tag is a **resume**, not a mistake. The check above has already
  // established that the tag points at HEAD, so the only way to get here is to have published
  // this exact commit and then had a later step fail — which is what this script promises can be
  // fixed by running it again. It used to refuse instead, and that made the promise false the
  // first time it mattered: the npm publish sits after the release, so an npm failure left no way
  // forward but editing the script.
  const releaseExists = await succeeds('gh', 'release', 'view', tag);
  const notes = `${await changelogSection(version)}\n\n${installSection()}\n`;

  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  console.log(`\npushing ${branch} and ${tag}...`);
  await run('git', 'push', 'origin', branch);
  await run('git', 'push', 'origin', tag);

  console.log(`\nbuilding ${TARGETS.length} targets...`);
  await run(Deno.execPath(), 'task', 'build:all');

  const checksums = await writeChecksums();
  console.log(`wrote ${checksums}`);

  if (releaseExists) {
    console.log(`\nthe ${tag} release already exists; leaving it as it is`);
  } else {
    const notesFile = await Deno.makeTempFile({ suffix: '.md' });
    await Deno.writeTextFile(notesFile, notes);
    try {
      console.log(`\ncreating the ${tag} release...`);
      await run(
        'gh',
        'release',
        'create',
        tag,
        ...TARGETS.map((t) => `dist/${t.name}`),
        checksums,
        '--title',
        tag,
        '--notes-file',
        notesFile,
        // Refuses if the tag is somehow not on the remote, rather than quietly creating one.
        '--verify-tag',
        '--latest',
      );
    } finally {
      await Deno.remove(notesFile);
    }
  }

  // Last, and deliberately: everything above can be re-run, and this cannot be undone.
  console.log(`\npublishing ${TARGETS.length + 1} packages to npm...`);
  await publishNpm(version);
};

if (import.meta.main) {
  const version = await readVersion(DENO_JSON, VERSION_IN_JSON);
  const inArgs = await readVersion(ARGS_TS, VERSION_IN_ARGS);
  if (version !== inArgs) {
    fail(`${DENO_JSON} says ${version} but ${ARGS_TS} says ${inArgs}; fix that first`);
  }
  await publish(version);
}
