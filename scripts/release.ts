/**
 * Cuts a release: bump, changelog, commit, tag.
 *
 * The version lives in two places — `deno.json` and `VERSION` in `src/cli/args.ts`, which the
 * --help banner prints — and nothing at type level can keep them equal, so this script owns both
 * and refuses to start when they have drifted.
 *
 *   deno task release patch | minor | major
 *   deno task release --set 0.0.1
 */

const DENO_JSON = 'deno.json';
const ARGS_TS = 'src/cli/args.ts';

const VERSION_IN_JSON = /(?<=^ {2}"version": ")(?<version>\d+\.\d+\.\d+)(?=",$)/m;
const VERSION_IN_ARGS = /(?<=^export const VERSION = ')(?<version>\d+\.\d+\.\d+)(?=';$)/m;

type Bump = 'patch' | 'minor' | 'major';

const git = async (...args: string[]): Promise<string> => {
  const { stdout, stderr, success } = await new Deno.Command('git', { args }).output();
  if (!success) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout).trim();
};

const run = async (cmd: string, ...args: string[]): Promise<void> => {
  const { success } = await new Deno.Command(cmd, { args, stdout: 'inherit', stderr: 'inherit' })
    .output();
  if (!success) throw new Error(`${cmd} ${args.join(' ')} failed`);
};

const readVersion = async (path: string, pattern: RegExp): Promise<string> => {
  const match = pattern.exec(await Deno.readTextFile(path));
  if (!match?.groups) throw new Error(`no version found in ${path}`);
  return match.groups.version;
};

const writeVersion = async (path: string, pattern: RegExp, version: string): Promise<void> => {
  const source = await Deno.readTextFile(path);
  await Deno.writeTextFile(path, source.replace(pattern, version));
};

const bumped = (current: string, bump: Bump): string => {
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

const fail = (message: string): never => {
  console.error(`error: ${message}`);
  Deno.exit(2);
};

if (import.meta.main) {
  const setIndex = Deno.args.indexOf('--set');
  const bump = Deno.args.find((a): a is Bump => ['patch', 'minor', 'major'].includes(a));
  const explicit = setIndex === -1 ? undefined : Deno.args[setIndex + 1];

  if (!bump && !explicit) fail('usage: deno task release <patch|minor|major> | --set <x.y.z>');
  if (explicit && !/^\d+\.\d+\.\d+$/.test(explicit)) fail(`"${explicit}" is not a semver version`);

  if (await git('status', '--porcelain') !== '') {
    fail('the working tree is dirty; commit or stash first');
  }

  const current = await readVersion(DENO_JSON, VERSION_IN_JSON);
  const inArgs = await readVersion(ARGS_TS, VERSION_IN_ARGS);
  if (current !== inArgs) {
    fail(`${DENO_JSON} says ${current} but ${ARGS_TS} says ${inArgs}; fix that first`);
  }

  const next = explicit ?? bumped(current, bump as Bump);
  console.log(`${current} -> ${next}`);

  await writeVersion(DENO_JSON, VERSION_IN_JSON, next);
  await writeVersion(ARGS_TS, VERSION_IN_ARGS, next);
  await run(Deno.execPath(), 'run', '-A', 'scripts/changelog.ts', '--release', next);
  await run(Deno.execPath(), 'task', 'check');

  await git('add', DENO_JSON, ARGS_TS, 'CHANGELOG.md');
  await git('commit', '-m', `chore(release): v${next}`);
  await git('tag', '-a', `v${next}`, '-m', `v${next}`);

  console.log(`\ntagged v${next}. To publish:`);
  console.log(`  git push origin main && git push origin v${next}`);
  console.log('  deno task build:all   # then attach dist/* to the GitHub release');
}
