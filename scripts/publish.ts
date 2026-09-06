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

/** Stages and publishes the seven packages, in the order `stage` returns them: every platform
 * package before the one that depends on them, so `jira-fetch` never sits on the registry with
 * optional dependencies that cannot resolve. */
const publishNpm = async (version: string): Promise<void> => {
  const packages = await stage(version, NPM_DIST);
  for (const pkg of packages) {
    if (await alreadyPublished(pkg.name, version)) {
      console.log(`  ${pkg.name}@${version} is already published`);
      continue;
    }
    console.log(`  ${pkg.name}@${version}`);
    // Scoped packages default to restricted, which would publish something nobody can install.
    await run('npm', 'publish', '--access', 'public', pkg.dir);
  }
};

/** The checks that depend on nothing but this machine, so `release.ts` can run them *before* it
 * bumps and tags. Discovering a missing `gh` after the tag exists is a mess to unpick. */
export const assertCanPublish = async (): Promise<void> => {
  if (!await succeeds('gh', '--version')) {
    fail('the GitHub CLI is not installed: https://cli.github.com');
  }
  if (!await succeeds('gh', 'auth', 'status')) fail('not logged in to GitHub: run `gh auth login`');

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
  if (await succeeds('gh', 'release', 'view', tag)) {
    fail(`a release for ${tag} already exists; delete it first, or bump the version`);
  }
  const notes = `${await changelogSection(version)}\n\n${installSection()}\n`;

  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  console.log(`\npushing ${branch} and ${tag}...`);
  await run('git', 'push', 'origin', branch);
  await run('git', 'push', 'origin', tag);

  console.log(`\nbuilding ${TARGETS.length} targets...`);
  await run(Deno.execPath(), 'task', 'build:all');

  const checksums = await writeChecksums();
  console.log(`wrote ${checksums}`);

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
