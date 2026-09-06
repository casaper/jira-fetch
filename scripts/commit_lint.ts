/**
 * Validates commit messages against Conventional Commits 1.0.0.
 *
 * This is the `.githooks/commit-msg` hook's whole implementation, and it is deliberately not
 * commitlint: that would mean an npm dependency tree in a project whose toolchain is `deno lint`
 * and `deno fmt`, and it would not know this repository's scopes.
 *
 *   deno run -R scripts/commit_lint.ts <file>          one message, as the hook calls it
 *   deno run -A scripts/commit_lint.ts --from <rev>    every commit after <rev>, for history checks
 */

/** Commit types, and the changelog heading each one lands under. `scripts/changelog.ts` reads this
 * map, so a type added here shows up in the changelog without a second edit. */
export const TYPES = {
  feat: 'Features',
  fix: 'Bug Fixes',
  perf: 'Performance',
  refactor: 'Refactoring',
  docs: 'Documentation',
  test: 'Tests',
  build: 'Build & Tooling',
  style: 'Formatting',
  chore: 'Chores',
  revert: 'Reverts',
} as const;

/** Optional scopes: one per module in the layout, plus the cross-cutting ones. */
export const SCOPES = [
  'config',
  'cli',
  'jira',
  'filter',
  'fetch',
  'adf',
  'assets',
  'document',
  'mcp',
  'setup',
  'schema',
  'scripts',
  'deps',
  'release',
] as const;

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

const MAX_HEADER = 72;
const MAX_BODY_LINE = 100;

export type ParsedHeader = {
  type: keyof typeof TYPES;
  scope?: string;
  breaking: boolean;
  subject: string;
};

/** A conventional header, or undefined when the line does not follow the grammar at all. */
export const parseHeader = (header: string): ParsedHeader | undefined => {
  const match = HEADER.exec(header);
  if (!match?.groups) return undefined;
  const { type, scope, breaking, subject } = match.groups;
  if (!(type in TYPES)) return undefined;
  return { type: type as keyof typeof TYPES, scope, breaking: breaking === '!', subject };
};

/** Messages git generates itself, or that are resolved later, are none of this hook's business. */
const isExempt = (header: string): boolean =>
  header.startsWith('Merge ') || header.startsWith('Revert "') ||
  header.startsWith('fixup!') || header.startsWith('squash!') || header.startsWith('amend!');

/** Everything wrong with one message. Empty means it passes. */
export const lint = (message: string): string[] => {
  // Comment lines are what git strips before storing, so they are stripped before judging too.
  const lines = message.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('#'));
  const header = (lines[0] ?? '').trimEnd();
  const problems: string[] = [];

  if (header.length === 0) return ['the message is empty'];
  if (isExempt(header)) return [];

  const parsed = parseHeader(header);
  if (!parsed) {
    return [
      `"${header}" is not a conventional commit header`,
      'expected: type(scope)!: subject',
      `types:    ${Object.keys(TYPES).join(', ')}`,
      `scopes:   ${SCOPES.join(', ')} (optional)`,
    ];
  }

  if (parsed.scope !== undefined && !(SCOPES as readonly string[]).includes(parsed.scope)) {
    problems.push(
      `unknown scope "${parsed.scope}" — use one of: ${SCOPES.join(', ')}, or drop the scope`,
    );
  }
  if (header.length > MAX_HEADER) {
    problems.push(`the header is ${header.length} characters; keep it to ${MAX_HEADER}`);
  }
  if (/^[A-Z][a-z]/.test(parsed.subject)) {
    problems.push(`the subject starts with a capital: "${parsed.subject}"`);
  }
  if (parsed.subject.endsWith('.')) {
    problems.push('the subject ends with a period');
  }
  if (lines.length > 1 && lines[1].trim() !== '') {
    problems.push('the body must be separated from the header by a blank line');
  }

  // A long unbroken token — a URL, a path, a stack frame — cannot be wrapped, so only lines that
  // could have been wrapped are flagged.
  for (const [index, line] of lines.slice(2).entries()) {
    const wrappable = line.includes(' ') && !/\S{40,}/.test(line);
    if (line.length > MAX_BODY_LINE && wrappable) {
      problems.push(
        `body line ${index + 3} is ${line.length} characters; wrap at ${MAX_BODY_LINE}`,
      );
    }
  }

  return problems;
};

const report = (label: string, problems: string[]): void => {
  console.error(`\n${label}`);
  for (const problem of problems) console.error(`  ${problem}`);
};

/** Commits oldest first. \x1e delimits records, since a commit body may contain anything else. */
const gitLog = async (range: string): Promise<Array<{ sha: string; message: string }>> => {
  const { stdout } = await new Deno.Command('git', {
    args: ['log', '--reverse', '--no-merges', '--format=%H%n%B\x1e', range],
  }).output();
  return new TextDecoder().decode(stdout)
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const newline = entry.indexOf('\n');
      return { sha: entry.slice(0, newline), message: entry.slice(newline + 1) };
    });
};

if (import.meta.main) {
  const fromIndex = Deno.args.indexOf('--from');

  if (fromIndex !== -1) {
    const base = Deno.args[fromIndex + 1];
    if (!base) {
      console.error('usage: commit_lint.ts --from <rev>');
      Deno.exit(2);
    }
    const commits = await gitLog(`${base}..HEAD`);
    let failed = 0;
    for (const { sha, message } of commits) {
      const problems = lint(message);
      if (problems.length > 0) {
        failed++;
        report(`${sha.slice(0, 7)} ${message.split('\n')[0]}`, problems);
      }
    }
    console.log(
      failed === 0
        ? `${commits.length} commit(s) after ${base}: all conventional`
        : `\n${failed} of ${commits.length} commit(s) after ${base} are not conventional`,
    );
    Deno.exit(failed === 0 ? 0 : 1);
  }

  const path = Deno.args[0];
  if (!path) {
    console.error('usage: commit_lint.ts <message-file> | --from <rev>');
    Deno.exit(2);
  }

  const problems = lint(await Deno.readTextFile(path));
  if (problems.length > 0) {
    report('commit rejected:', problems);
    console.error('\n  see the "Commit messages" section of CLAUDE.md');
    console.error('  to bypass once: git commit --no-verify\n');
    Deno.exit(1);
  }
}
