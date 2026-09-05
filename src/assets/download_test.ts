import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { assetDirName, buildManifest, downloadAssets, sanitizeFilename } from './download.ts';
import { JiraClient } from '../jira/client.ts';
import type { JiraAttachment } from '../jira/types.ts';
import { issueFixture } from '../../test/fixtures.ts';

function attachment(id: string, filename: string, mimeType = 'image/png'): JiraAttachment {
  return { id, filename, content: `https://example.atlassian.net/attachment/${id}`, mimeType };
}

Deno.test('sanitizeFilename keeps a plain name untouched', () => {
  assertEquals(sanitizeFilename('diagram.png'), 'diagram.png');
});

Deno.test('sanitizeFilename replaces whitespace and illegal characters', () => {
  assertEquals(sanitizeFilename('screenshot 01.png'), 'screenshot_01.png');
  assertEquals(sanitizeFilename('a:b"c<d>e|f?g*h.png'), 'a_b_c_d_e_f_g_h.png');
});

Deno.test('sanitizeFilename strips directory components', () => {
  assertEquals(sanitizeFilename('../../etc/passwd'), 'passwd');
  assertEquals(sanitizeFilename('C:\\Users\\kim\\note.txt'), 'note.txt');
});

Deno.test('sanitizeFilename keeps non-ASCII names', () => {
  assertEquals(sanitizeFilename('Übersicht_Ärger.png'), 'Übersicht_Ärger.png');
});

Deno.test('sanitizeFilename un-hides dotfiles and drops trailing dots', () => {
  assertEquals(sanitizeFilename('.hidden.png'), 'hidden.png');
  assertEquals(sanitizeFilename('report.pdf.'), 'report.pdf');
});

Deno.test('sanitizeFilename escapes names Windows reserves for devices', () => {
  assertEquals(sanitizeFilename('con.txt'), '_con.txt');
  assertEquals(sanitizeFilename('LPT1.log'), '_LPT1.log');
});

Deno.test('sanitizeFilename truncates a long stem but keeps the extension', () => {
  const result = sanitizeFilename(`${'a'.repeat(300)}.png`);
  assert(result.endsWith('.png'));
  assert(result.length <= 84);
});

Deno.test('sanitizeFilename always yields something usable', () => {
  assertEquals(sanitizeFilename(''), 'attachment');
  assertEquals(sanitizeFilename('...'), 'attachment');
});

Deno.test('assetDirName hides the directory beside the document', () => {
  assertEquals(assetDirName('DN-1243'), '.DN-1243');
});

Deno.test('colliding filenames are disambiguated by attachment id', () => {
  const manifest = buildManifest(
    [attachment('1', 'image.png'), attachment('2', 'image.png')],
    'DN-7',
  );
  assertEquals(manifest.get('1')?.filename, 'image.png');
  assertEquals(manifest.get('2')?.filename, 'image-2.png');
  assertEquals(manifest.get('2')?.relativePath, '.DN-7/image-2.png');
});

Deno.test('collision detection is case-insensitive, as on macOS and Windows', () => {
  const manifest = buildManifest(
    [attachment('1', 'Image.PNG'), attachment('2', 'image.png')],
    'DN-7',
  );
  assertEquals(manifest.get('1')?.filename, 'Image.png');
  assertEquals(manifest.get('2')?.filename, 'image-2.png');
});

Deno.test("the fixture's two identically named screenshots do not collide", () => {
  const issue = issueFixture();
  const manifest = buildManifest(issue.fields.attachment, issue.key);
  const names = [...manifest.values()].map((a) => a.filename);
  assertEquals(names, ['screenshot_01.png', 'screenshot_01-20002.png']);
});

Deno.test('an empty attachment list yields an empty manifest', () => {
  assertEquals(buildManifest(undefined, 'DN-1').size, 0);
  assertEquals(buildManifest([], 'DN-1').size, 0);
});

function clientReturning(response: () => Response): JiraClient {
  return new JiraClient({
    baseUrl: 'https://example.atlassian.net',
    email: 'a@b.c',
    token: 't',
    fetch: () => Promise.resolve(response()),
    maxRetries: 0,
  });
}

Deno.test('downloadAssets writes each attachment into the asset directory', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifest = buildManifest([attachment('1', 'shot.png')], 'DN-1');
    const client = clientReturning(() =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      })
    );

    const result = await downloadAssets(client, manifest, dir);
    assertEquals(result.downloaded, 1);
    assertEquals(result.failures, []);
    assertEquals((await Deno.readFile(`${dir}/shot.png`)).length, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('an HTML login page is rejected even though it arrives with a 200', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifest = buildManifest([attachment('1', 'shot.png')], 'DN-1');
    const client = clientReturning(() =>
      new Response('<html><body>Log in to Jira</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );

    const result = await downloadAssets(client, manifest, dir);
    assertEquals(result.downloaded, 0);
    assertStringIncludes(result.failures[0].error, 'received HTML');
    // Nothing must be left behind for the Markdown to link at.
    assertEquals((await Array.fromAsync(Deno.readDir(dir))).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('one failed attachment does not stop the others', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const manifest = buildManifest(
      [attachment('1', 'bad.png'), attachment('2', 'good.png')],
      'DN-1',
    );
    let call = 0;
    const client = clientReturning(() =>
      ++call === 1
        ? new Response('', { headers: { 'content-type': 'image/png' } })
        : new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } })
    );

    const result = await downloadAssets(client, manifest, dir);
    assertEquals(result.downloaded, 1);
    assertEquals(result.failures.length, 1);
    assertStringIncludes(result.failures[0].error, 'empty body');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
