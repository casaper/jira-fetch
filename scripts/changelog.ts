/**
 * Generates CHANGELOG.md from the commit history.
 *
 * Commits are grouped per release — a release being a `v*` tag — and within a release by
 * conventional-commit type, using the headings declared in `scripts/commit_lint.ts`. Commits whose
 * subject is not conventional are not dropped: they collect under "Other", which is what makes an
 * unconverted history visibly worse than a converted one.
 *
 *   deno task changelog                 rewrite CHANGELOG.md
 *   deno task changelog --check         fail if the committed file is stale
 *   deno run -A scripts/changelog.ts --release 0.0.1    label the unreleased commits as a version
 */

import { parseHeader, TYPES } from './commit_lint.ts';

const FILE = 'CHANGELOG.md';

const PREAMBLE = `# Changelog

Every notable change, grouped by release. Generated from the commit history by
\`deno task changelog\` — edit the commits, not this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and its commit
subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
`;

type Commit = {
  sha: string;
  subject: string;
  body: string;
};

type Release = {
  /** The version heading, or undefined for the not-yet-released commits at the top. */
  version?: string;
  date: string;
  commits: Commit[];
};

const git = async (...args: string[]): Promise<string> => {
  const { stdout, success, stderr } = await new Deno.Command('git', { args }).output();
  if (!success) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout).trim();
};

/** Commits in `range`, newest first. \x1e delimits records; a body may contain anything else. */
const commitsIn = async (range: string): Promise<Commit[]> => {
  const log = await git('log', '--no-merges', '--format=%H%n%s%n%b\x1e', range);
  return log.split('\x1e')
    .map((entry) => entry.replace(/^\n+/, ''))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => {
      const [sha, subject, ...rest] = entry.split('\n');
      return { sha, subject, body: rest.join('\n').trim() };
    })
    // A release commit records the release; listing it inside that release is noise.
    .filter((commit) => !commit.subject.startsWith('chore(release):'));
};

/** `https://github.com/owner/repo` when origin is a GitHub remote, else undefined. */
const remoteBase = async (): Promise<string | undefined> => {
  let url: string;
  try {
    url = await git('remote', 'get-url', 'origin');
  } catch {
    return undefined;
  }
  const match = /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(url);
  return match?.groups
    ? `https://github.com/${match.groups.owner}/${match.groups.repo}`
    : undefined;
};

/** Releases newest first, with the unreleased commits (if any) at the front. */
const collectReleases = async (releaseAs?: string): Promise<Release[]> => {
  const tags = (await git('tag', '--list', 'v*', '--sort=-v:refname')).split('\n')
    .filter((t) => t.length > 0);
  const today = new Date().toISOString().slice(0, 10);
  const releases: Release[] = [];

  const head = tags.length > 0 ? `${tags[0]}..HEAD` : 'HEAD';
  const unreleased = await commitsIn(head);
  if (unreleased.length > 0) {
    releases.push({ version: releaseAs, date: today, commits: unreleased });
  }

  for (const [index, tag] of tags.entries()) {
    const previous = tags[index + 1];
    const range = previous ? `${previous}..${tag}` : tag;
    releases.push({
      version: tag.replace(/^v/, ''),
      date: await git('log', '-1', '--format=%ad', '--date=short', tag),
      commits: await commitsIn(range),
    });
  }

  return releases;
};

const renderRelease = (release: Release, base: string | undefined): string => {
  const heading = release.version ? `## ${release.version} — ${release.date}` : '## Unreleased';
  const lines = [heading, ''];

  const link = (sha: string) =>
    base ? ` ([${sha.slice(0, 7)}](${base}/commit/${sha}))` : ` (${sha.slice(0, 7)})`;

  const breaking = release.commits.filter((c) => {
    const parsed = parseHeader(c.subject);
    return parsed?.breaking || /^BREAKING CHANGE:/m.test(c.body);
  });
  if (breaking.length > 0) {
    lines.push('### Breaking changes', '');
    for (const commit of breaking) {
      const parsed = parseHeader(commit.subject);
      lines.push(`- ${parsed?.subject ?? commit.subject}${link(commit.sha)}`);
    }
    lines.push('');
  }

  const other: Commit[] = [];
  const byType = new Map<string, Commit[]>();
  for (const commit of release.commits) {
    const parsed = parseHeader(commit.subject);
    if (!parsed) {
      other.push(commit);
      continue;
    }
    const bucket = byType.get(parsed.type) ?? [];
    bucket.push(commit);
    byType.set(parsed.type, bucket);
  }

  for (const [type, heading] of Object.entries(TYPES)) {
    const commits = byType.get(type);
    if (!commits) continue;
    lines.push(`### ${heading}`, '');
    for (const commit of commits) {
      const parsed = parseHeader(commit.subject);
      const scope = parsed?.scope ? `**${parsed.scope}:** ` : '';
      lines.push(`- ${scope}${parsed?.subject ?? commit.subject}${link(commit.sha)}`);
    }
    lines.push('');
  }

  if (other.length > 0) {
    lines.push('### Other', '');
    for (const commit of other) lines.push(`- ${commit.subject}${link(commit.sha)}`);
    lines.push('');
  }

  return lines.join('\n');
};

export const render = async (releaseAs?: string): Promise<string> => {
  const base = await remoteBase();
  const releases = await collectReleases(releaseAs);
  return [PREAMBLE, ...releases.map((r) => renderRelease(r, base))].join('\n').trimEnd() + '\n';
};

if (import.meta.main) {
  const releaseIndex = Deno.args.indexOf('--release');
  const content = await render(releaseIndex === -1 ? undefined : Deno.args[releaseIndex + 1]);

  if (Deno.args.includes('--check')) {
    const current = await Deno.readTextFile(FILE).catch(() => '');
    if (current !== content) {
      console.error(`${FILE} is out of date — run: deno task changelog`);
      Deno.exit(1);
    }
    console.log(`${FILE} is up to date`);
    Deno.exit(0);
  }

  await Deno.writeTextFile(FILE, content);
  console.log(`wrote ${FILE}`);
}
