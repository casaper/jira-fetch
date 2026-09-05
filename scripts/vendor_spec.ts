/** Vendors the upstream Atlassian schemas into `spec/`, pinned.
 *
 * Run by hand (`deno task vendor:spec`), never by `deno task check` — the check must stay
 * offline and reproducible, which it only is if the specs are committed rather than fetched.
 *
 * Two sources, both Apache-2.0:
 *   - the Jira Cloud platform OpenAPI document (pruned to the schemas this tool reads)
 *   - the Atlassian Document Format JSON Schema, which the OpenAPI document does not contain
 */

const PLATFORM_URL = 'https://developer.atlassian.com/cloud/jira/platform/swagger-v3.json';
const ADF_URL = 'https://go.atlassian.com/adf-json-schema';

export const SPEC_DIR = new URL('../spec/', import.meta.url);
export const PLATFORM_PATH = new URL('jira-platform.subset.json', SPEC_DIR);
export const ADF_PATH = new URL('adf-schema.json', SPEC_DIR);
export const NOTICE_PATH = new URL('NOTICE', SPEC_DIR);

/** The schemas we derive TypeScript from, plus whatever they transitively reference.
 *
 * `IssueBean` is here only because `SearchAndReconcileResults.issues` points at it; no type is
 * derived from it. Its `fields` is an untyped bag in the spec, which is exactly why
 * `JiraIssueFields` stays hand-written. */
export const SEED = [
  'Attachment',
  'Comment',
  'FieldDetails',
  'PageOfComments',
  'SearchAndReconcileResults',
  'UserDetails',
  'IssueBean',
] as const;

/** Collects `seed` and everything reachable from it through `$ref`. */
export const closure = (
  schemas: Record<string, unknown>,
  seed: readonly string[],
): Record<string, unknown> => {
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.split('/').at(-1) ?? value;
        if (!seen.has(name)) {
          seen.add(name);
          walk(schemas[name]);
        }
      } else walk(value);
    }
  };
  for (const name of seed) {
    seen.add(name);
    walk(schemas[name]);
  }

  const out: Record<string, unknown> = {};
  for (const name of [...seen].sort()) {
    if (schemas[name]) out[name] = schemas[name];
    else console.warn(`warning: $ref to unknown schema ${name}`);
  }
  return out;
};

const fetchJson = async (url: string): Promise<{ body: unknown; finalUrl: string }> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return { body: await response.json(), finalUrl: response.url };
};

if (import.meta.main) {
  await Deno.mkdir(SPEC_DIR, { recursive: true });

  const platform = await fetchJson(PLATFORM_URL);
  const spec = platform.body as {
    info: { version: string; license?: { name?: string } };
    components: { schemas: Record<string, unknown> };
  };
  const schemas = closure(spec.components.schemas, SEED);
  const subset = {
    'x-source-url': PLATFORM_URL,
    'x-source-version': spec.info.version,
    'x-source-license': spec.info.license?.name ?? 'unknown',
    'x-vendored-note':
      'Pruned to the transitive closure of the schemas jira-fetch reads. Regenerate with ' +
      '`deno task vendor:spec`; do not edit by hand.',
    schemas,
  };
  await Deno.writeTextFile(PLATFORM_PATH, `${JSON.stringify(subset, null, 2)}\n`);
  console.log(
    `wrote spec/jira-platform.subset.json — ${Object.keys(schemas).length} schemas, ` +
      `source version ${spec.info.version}`,
  );

  // The short link redirects to an exact @atlaskit/adf-schema version; record where it landed so
  // the pin is legible without re-resolving it.
  const adf = await fetchJson(ADF_URL);
  const adfDoc = {
    'x-source-url': ADF_URL,
    'x-source-resolved': adf.finalUrl,
    ...adf.body as object,
  };
  await Deno.writeTextFile(ADF_PATH, `${JSON.stringify(adfDoc, null, 2)}\n`);
  console.log(`wrote spec/adf-schema.json — resolved to ${adf.finalUrl}`);

  await Deno.writeTextFile(
    NOTICE_PATH,
    [
      'The files in this directory are vendored, unmodified in substance, from Atlassian.',
      'They are used to derive TypeScript types (see scripts/gen_types.ts); they are not',
      'redistributed as part of the compiled binaries.',
      '',
      'jira-platform.subset.json',
      `  Source:  ${PLATFORM_URL}`,
      `  Version: ${spec.info.version}`,
      '  The Jira Cloud platform REST API specification',
      '  Copyright Atlassian Pty Ltd',
      '  Licensed under the Apache License, Version 2.0',
      '  Pruned to the schemas this project reads; see scripts/vendor_spec.ts.',
      '',
      'adf-schema.json',
      `  Source:  ${ADF_URL}`,
      `  Resolved: ${adf.finalUrl}`,
      '  @atlaskit/adf-schema — the Atlassian Document Format JSON Schema',
      '  Copyright Atlassian Pty Ltd',
      '  Licensed under the Apache License, Version 2.0',
      '',
      'A copy of the Apache License, Version 2.0 is available at',
      'http://www.apache.org/licenses/LICENSE-2.0',
      '',
    ].join('\n'),
  );
  console.log('wrote spec/NOTICE');
}
