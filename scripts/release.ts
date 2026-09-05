/**
 * Cuts a release: bump, changelog, commit, tag — then push, build and publish it to GitHub.
 *
 * The version lives in two places — `deno.json` and `VERSION` in `src/cli/args.ts`, which the
 * --help banner prints — and nothing at type level can keep them equal, so this script owns both
 * and refuses to start when they have drifted.
 *
 * Publishing lives in `publish.ts` and is a task of its own as well. That split is what makes a
 * failed cross-compile recoverable: `deno task publish` picks up from the tag rather than leaving
 * a bumped, tagged version with nothing behind it.
 *
 *   deno task release patch | minor | major
 *   deno task release --set 0.0.1
 *   deno task release patch --no-publish    stop at the tag; publish later
 */

import { git, run } from './proc.ts';
import {
  assertCanPublish,
  fail,
  publish,
  readVersion,
  VERSION_IN_ARGS,
  VERSION_IN_JSON,
} from './publish.ts';

const DENO_JSON = 'deno.json';
const ARGS_TS = 'src/cli/args.ts';

type Bump = 'patch' | 'minor' | 'major';

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

if (import.meta.main) {
  const setIndex = Deno.args.indexOf('--set');
  const bump = Deno.args.find((a): a is Bump => ['patch', 'minor', 'major'].includes(a));
  const explicit = setIndex === -1 ? undefined : Deno.args[setIndex + 1];

  if (!bump && !explicit) fail('usage: deno task release <patch|minor|major> | --set <x.y.z>');
  if (explicit && !/^\d+\.\d+\.\d+$/.test(explicit)) fail(`"${explicit}" is not a semver version`);

  if (await git('status', '--porcelain') !== '') {
    fail('the working tree is dirty; commit or stash first');
  }

  // Checked here rather than after the tag exists: a missing `gh` should not leave a bumped,
  // committed and tagged version behind for someone to unpick.
  const publishing = !Deno.args.includes('--no-publish');
  if (publishing) await assertCanPublish();

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

  console.log(`tagged v${next}`);

  if (!publishing) {
    console.log('\n--no-publish: stopping here. When you are ready:');
    console.log('  deno task publish');
    Deno.exit(0);
  }

  await publish(next);
}
