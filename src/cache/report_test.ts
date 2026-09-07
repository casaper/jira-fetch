import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { ResourceOutcome } from './metadata.ts';
import { describeNote, formatReport, formatShow, summarise } from './report.ts';
import type { CacheNote } from './schema.ts';

const NOW = 1_757_000_000_000;
const HOUR = 3_600_000;

const outcome = (over: Partial<ResourceOutcome> = {}): ResourceOutcome => ({
  resource: 'labels',
  state: 'ok',
  notes: [],
  count: 3,
  refreshed: true,
  ...over,
});

Deno.test('a complete resource is a name and a count', () => {
  const [line] = formatReport([outcome()]);
  assertStringIncludes(line, 'labels');
  assertStringIncludes(line, '3');
});

Deno.test('a short resource never appears without its reason', () => {
  // A count with no explanation beside it lets a partial list read as a complete one, which is the
  // failure this whole layer exists to avoid.
  const [line] = formatReport([
    outcome({ state: 'partial', notes: [{ code: 'forbidden' }], count: 0 }),
  ]);
  assertStringIncludes(line, 'this token may not read them');
  assertStringIncludes(line, '—', 'nothing readable shows a dash, not a zero');
});

Deno.test('a project-scoped resource says which project', () => {
  const [line] = formatReport([outcome({ resource: 'sprints', projectKey: 'DN' })]);
  assertStringIncludes(line, 'DN sprints');
});

Deno.test('every note code has words, so none can reach a reader as an identifier', () => {
  const codes: CacheNote['code'][] = [
    'forbidden',
    'notFound',
    'noneVisible',
    'truncated',
    'emailsHidden',
    'noBoard',
    'boardWithoutSprints',
    'agileUnavailable',
    'dependencyMissing',
    'partiallyForbidden',
    'notJson',
    'networkError',
  ];
  for (const code of codes) {
    const words = describeNote({ code });
    assert(words.length > 10, `${code} has no useful wording`);
    assert(!words.includes(code), `${code} leaks its own identifier`);
  }
});

Deno.test('a detail is carried into the wording', () => {
  assertStringIncludes(describeNote({ code: 'boardWithoutSprints', detail: 'board 8' }), 'board 8');
});

Deno.test('names are aligned so the counts read as a column', () => {
  const lines = formatReport([
    outcome({ resource: 'labels' }),
    outcome({ resource: 'fieldOptions', projectKey: 'DN' }),
  ]);
  const at = lines.map((line) => line.indexOf(line.trim().split(/\s{2,}/)[1] ?? ''));
  assertEquals(new Set(at).size, 1, lines.join('\n'));
});

Deno.test('an empty refresh says there is nothing to read rather than nothing', () => {
  assertStringIncludes(formatReport([])[0], 'no projects have been chosen');
});

Deno.test('the summary counts what was read and what came back short', () => {
  const summary = summarise([
    outcome(),
    outcome({ state: 'partial', notes: [{ code: 'truncated' }] }),
    outcome({ refreshed: false }),
  ]);
  assertStringIncludes(summary, '3 resources');
  assertStringIncludes(summary, '2 read');
  assertStringIncludes(summary, '1 incomplete');
});

Deno.test('a healthy summary does not mention incompleteness at all', () => {
  const summary = summarise([outcome()]);
  assert(!summary.includes('incomplete'), summary);
});

Deno.test('show reports an age in the units a reader cares about', () => {
  const ages: Array<[number, string]> = [
    [0, 'less than a minute'],
    [90_000, '1 minute'],
    [10 * 60_000, '10 minutes'],
    [HOUR, '1 hour'],
    [5 * HOUR, '5 hours'],
    [30 * HOUR, '1 day'],
    [80 * HOUR, '3 days'],
  ];
  for (const [age, expected] of ages) {
    const [line] = formatShow(
      [{ resource: 'priorities', fetchedAt: NOW - age, count: 2 }],
      NOW,
    );
    assertStringIncludes(line, expected);
  }
});

Deno.test('show marks what has aged out', () => {
  // labels last 12 hours.
  const [fresh] = formatShow([{ resource: 'labels', fetchedAt: NOW - HOUR, count: 2 }], NOW);
  assert(!fresh.includes('due for a refresh'), fresh);
  const [old] = formatShow([{ resource: 'labels', fetchedAt: NOW - 13 * HOUR, count: 2 }], NOW);
  assertStringIncludes(old, 'due for a refresh');
});

Deno.test('show names what is missing as well as what is there', () => {
  const [line] = formatShow([{ resource: 'sprints', projectKey: 'DN' }], NOW);
  assertStringIncludes(line, 'DN sprints');
  assertStringIncludes(line, 'not cached');
});

Deno.test('show on an empty cache says so', () => {
  assertStringIncludes(formatShow([], NOW)[0], 'nothing cached yet');
});

Deno.test('show marks a partial entry with its reason, not with a zero', () => {
  // `sprints 0` reads as "this project has no sprints" when what happened was that nobody could
  // find out. The same trap the refresh report avoids.
  const [line] = formatShow([{
    resource: 'sprints',
    projectKey: 'DN',
    fetchedAt: NOW - 60_000,
    state: 'partial',
    notes: [{ code: 'boardWithoutSprints', detail: 'board 8' }],
    count: 0,
  }], NOW);
  assertStringIncludes(line, '—');
  assertStringIncludes(line, 'board 8');
  assert(!/\s0\s/.test(line), line);
});

Deno.test('show leaves a complete entry as a plain count', () => {
  const [line] = formatShow([{
    resource: 'labels',
    fetchedAt: NOW - 60_000,
    state: 'ok',
    notes: [],
    count: 7,
  }], NOW);
  assertStringIncludes(line, '7');
  assert(!line.includes('—'), line);
});
