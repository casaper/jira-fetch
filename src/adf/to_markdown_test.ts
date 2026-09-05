import { assertEquals, assertStringIncludes } from '@std/assert';
import { adfToMarkdown } from './to_markdown.ts';
import { buildManifest } from '../assets/download.ts';
import type { AdfNode } from '../jira/types.ts';
import { issueFixture } from '../../test/fixtures.ts';

function doc(...content: AdfNode[]): AdfNode {
  return { type: 'doc', version: 1, content };
}

function para(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function text(value: string, marks?: AdfNode['marks']): AdfNode {
  return { type: 'text', text: value, ...(marks ? { marks } : {}) };
}

Deno.test('an absent or empty body converts to an empty string', () => {
  assertEquals(adfToMarkdown(null), '');
  assertEquals(adfToMarkdown(undefined), '');
  assertEquals(adfToMarkdown(doc()), '');
});

Deno.test('marks render as their Markdown equivalents', () => {
  const body = doc(para(
    text('bold', [{ type: 'strong' }]),
    text(' '),
    text('italic', [{ type: 'em' }]),
    text(' '),
    text('gone', [{ type: 'strike' }]),
    text(' '),
    text('code()', [{ type: 'code' }]),
  ));
  assertEquals(adfToMarkdown(body), '**bold** *italic* ~~gone~~ `code()`');
});

Deno.test('a code mark keeps its content literal despite escaping', () => {
  const body = doc(para(text('a[b]*c*', [{ type: 'code' }])));
  assertEquals(adfToMarkdown(body), '`a[b]*c*`');
});

Deno.test('link marks become inline links', () => {
  const body = doc(para(
    text('the RFC', [{ type: 'link', attrs: { href: 'https://example.com/a b' } }]),
  ));
  assertEquals(adfToMarkdown(body), '[the RFC](https://example.com/a%20b)');
});

Deno.test('Markdown syntax in plain text is escaped', () => {
  assertEquals(adfToMarkdown(doc(para(text('a * b _ c [d]')))), 'a \\* b \\_ c \\[d\\]');
});

Deno.test('headings clamp to the six Markdown levels', () => {
  const body = doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Two')] },
    { type: 'heading', attrs: { level: 99 }, content: [text('Deep')] },
  );
  assertEquals(adfToMarkdown(body), '## Two\n\n###### Deep');
});

Deno.test('nested lists indent by two spaces per level', () => {
  const body = doc({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [para(text('First'))] },
      {
        type: 'listItem',
        content: [
          para(text('Second')),
          { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('Nested'))] }] },
        ],
      },
    ],
  });
  assertEquals(adfToMarkdown(body), '- First\n- Second\n  - Nested');
});

Deno.test('ordered lists honour their start attribute', () => {
  const body = doc({
    type: 'orderedList',
    attrs: { order: 3 },
    content: [
      { type: 'listItem', content: [para(text('c'))] },
      { type: 'listItem', content: [para(text('d'))] },
    ],
  });
  assertEquals(adfToMarkdown(body), '3. c\n4. d');
});

Deno.test('a code block widens its fence past backticks in the code', () => {
  const body = doc({
    type: 'codeBlock',
    attrs: { language: 'md' },
    content: [text('here is ``` a fence')],
  });
  assertEquals(adfToMarkdown(body), '````md\nhere is ``` a fence\n````');
});

Deno.test('a rule does not emit `---`, which separates comments', () => {
  // A `---` inside a body would be indistinguishable from the comment separator.
  assertEquals(adfToMarkdown(doc({ type: 'rule' })), '***');
});

Deno.test('tables render with a header row', () => {
  const cell = (t: string, type = 'tableCell'): AdfNode => ({ type, content: [para(text(t))] });
  const body = doc({
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('A', 'tableHeader'), cell('B', 'tableHeader')] },
      { type: 'tableRow', content: [cell('1'), cell('2')] },
    ],
  });
  assertEquals(adfToMarkdown(body), '| A | B |\n| --- | --- |\n| 1 | 2 |');
});

Deno.test('pipes inside a table cell are escaped', () => {
  const body = doc({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('a|b'))] }] }],
  });
  assertStringIncludes(adfToMarkdown(body), 'a\\|b');
});

Deno.test('mentions, dates and inline cards degrade to text', () => {
  const body = doc(para(
    { type: 'mention', attrs: { text: '@Kim' } },
    text(' on '),
    { type: 'date', attrs: { timestamp: '1767225600000' } },
    text(' '),
    { type: 'inlineCard', attrs: { url: 'https://example.com/x' } },
  ));
  assertEquals(adfToMarkdown(body), '@Kim on 2026-01-01 <https://example.com/x>');
});

Deno.test('an unknown node keeps its content instead of throwing', () => {
  const body = doc({
    type: 'someAppMacro',
    attrs: { whatever: true },
    content: [para(text('still here'))],
  });
  assertEquals(adfToMarkdown(body), 'still here');
});

Deno.test('a media node resolves through the attachment manifest', () => {
  const issue = issueFixture();
  const assets = buildManifest(issue.fields.attachment, issue.key);
  const body = doc({
    type: 'mediaSingle',
    content: [{ type: 'media', attrs: { id: '20001', type: 'file', alt: 'the screen' } }],
  });
  assertEquals(adfToMarkdown(body, { assets }), '![the screen](.DN-1243/screenshot_01.png)');
});

Deno.test('a non-image attachment becomes a link, not an embed', () => {
  const assets = buildManifest(
    [{ id: '9', filename: 'spec.pdf', content: 'https://x/9', mimeType: 'application/pdf' }],
    'DN-1',
  );
  const body = doc({ type: 'media', attrs: { id: '9' } });
  assertEquals(adfToMarkdown(body, { assets }), '[spec.pdf](.DN-1/spec.pdf)');
});

Deno.test('media missing from the manifest leaves a visible marker', () => {
  const body = doc({ type: 'media', attrs: { id: 'does-not-exist' } });
  assertEquals(adfToMarkdown(body, { assets: new Map() }), '*[missing attachment does-not-exist]*');
});

Deno.test('the fixture description converts end to end', () => {
  const issue = issueFixture();
  const assets = buildManifest(issue.fields.attachment, issue.key);
  const markdown = adfToMarkdown(issue.fields.description, { assets });

  assertEquals(
    markdown,
    [
      'The exporter needs **streaming** output. See [the RFC](https://example.com/rfc).',
      '',
      '- First',
      '- Second',
      '  - Nested',
      '',
      '```typescript',
      'const x = 1;',
      '```',
      '',
      '![screenshot 01.png](.DN-1243/screenshot_01.png)',
      '',
      'still here',
    ].join('\n'),
  );
});

Deno.test('a media node is matched to its attachment by filename, not by id', () => {
  // What Jira Cloud actually sends: a media-service UUID that appears nowhere in the REST
  // payload, and the attachment's filename repeated in `alt`.
  const assets = buildManifest(
    [{ id: '66707', filename: 'diagram.png', content: 'https://x/1', mimeType: 'image/png' }],
    'DN-1',
  );
  const body = doc({
    type: 'media',
    attrs: { id: '7ad7af8b-228f-45ad-90da-d57a8032eb01', type: 'file', alt: 'diagram.png' },
  });
  assertEquals(adfToMarkdown(body, { assets }), '![diagram.png](.DN-1/diagram.png)');
});

Deno.test('same-named attachments are matched in document order, then reused', () => {
  const assets = buildManifest([
    { id: '1', filename: 'shot.png', content: 'https://x/1', mimeType: 'image/png' },
    { id: '2', filename: 'shot.png', content: 'https://x/2', mimeType: 'image/png' },
  ], 'DN-1');
  const media = (id: string) => ({ type: 'media', attrs: { id, type: 'file', alt: 'shot.png' } });
  const assigned = new Map();

  // Two distinct UUIDs take one attachment each, in the order they appear.
  assertEquals(
    adfToMarkdown(doc(media('uuid-a')), { assets, assigned }),
    '![shot.png](.DN-1/shot.png)',
  );
  assertEquals(
    adfToMarkdown(doc(media('uuid-b')), { assets, assigned }),
    '![shot.png](.DN-1/shot-2.png)',
  );
  // The same UUID again resolves to what it resolved to before, rather than consuming a third.
  assertEquals(
    adfToMarkdown(doc(media('uuid-a')), { assets, assigned }),
    '![shot.png](.DN-1/shot.png)',
  );
});

Deno.test('an alt that names no attachment stays a visible marker', () => {
  const assets = buildManifest(
    [{ id: '1', filename: 'shot.png', content: 'https://x/1', mimeType: 'image/png' }],
    'DN-1',
  );
  // `alt` is editable in the Jira editor. A caption that matches nothing is not fuzzy-matched:
  // linking the wrong file silently is the failure this path exists to avoid.
  const body = doc({ type: 'media', attrs: { id: 'uuid-a', type: 'file', alt: 'a screenshot' } });
  assertEquals(adfToMarkdown(body, { assets }), '*[missing attachment uuid-a]*');
});
