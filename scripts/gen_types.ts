/** Generates src/jira/schema_types.ts from the vendored Atlassian schemas in spec/.
 *
 * Run via `deno task types`. `deno task check` runs it with `--check`, so the committed file can
 * never drift from the specs it was derived from — the same idiom as scripts/gen_schema.ts.
 *
 * Nothing here reaches the network: the specs are vendored by `deno task vendor:spec`.
 */

import { resolve, toFileUrl } from '@std/path';

export const OUT_PATH = new URL('../src/jira/schema_types.ts', import.meta.url);
const PLATFORM_PATH = new URL('../spec/jira-platform.subset.json', import.meta.url);
const ADF_PATH = new URL('../spec/adf-schema.json', import.meta.url);

type Schema = Record<string, unknown>;

/** Spec schema name -> the name this project exports it under. Unlisted schemas keep their own
 * name; the `Jira` prefix is reserved for the ones the rest of the codebase already refers to. */
const RENAME: Record<string, string> = {
  Attachment: 'JiraAttachment',
  Comment: 'JiraComment',
  FieldDetails: 'JiraFieldMeta',
  IssueBean: 'JiraIssueBean',
  PageOfComments: 'JiraCommentPage',
  SearchAndReconcileResults: 'JiraSearchPage',
  UserDetails: 'JiraUser',
};

/**
 * Requiredness overlay.
 *
 * 61% of the platform spec's object schemas carry no `required` array at all, and only 19.3% of
 * all properties are marked required — Atlassian simply does not model requiredness on response
 * bodies. Deriving optionality straight from the spec would therefore mark *everything* optional
 * and cascade `?.` and `?? ''` through the codebase, which is strictly worse than what this
 * project had before.
 *
 * So these fields are pinned required on purpose. Each is one the code treats as an invariant and
 * would be unable to do anything sensible without.
 */
const REQUIRED_OVERLAY: Record<string, readonly string[]> = {
  // Identify and locate the bytes; downloadAssets cannot name or fetch a file without them.
  Attachment: ['id', 'filename', 'content'],
  // The comment id is the anchor used when a comment is reported as skipped.
  Comment: ['id'],
  // makeFieldResolver builds its lookup from exactly these three.
  FieldDetails: ['id', 'name', 'custom'],
  // Every issue payload is addressed by key; `fields` is what the whole document is built from.
  IssueBean: ['id', 'key', 'fields'],
};

/**
 * Nullability overlay.
 *
 * Jira sends an explicit `null` for an absent account — an anonymous portal reporter, an
 * unassigned issue — and that null is *meaningful* to the filter engine, which lets a rule match
 * it deliberately. The platform spec never sets `nullable`, so it has to be stated here or the
 * derived types would claim a case the filters exist to handle cannot occur.
 */
const NULLABLE_OVERLAY: Record<string, readonly string[]> = {
  Attachment: ['author'],
  Comment: ['author', 'updateAuthor'],
};

/**
 * Properties the spec declines to type. `Comment.body` carries only a prose description pointing
 * at the ADF documentation, so this is where the two vendored specs are bridged.
 */
const TYPE_OVERRIDE: Record<string, string> = {
  // The bridge between the two vendored specs: the platform spec says only "this is ADF".
  'Comment.body': 'AdfNode',
  'Comment.renderedBody': 'string',
  // Genuinely arbitrary JSON — a property value and a field default can be any shape at all.
  // Listed rather than inferred so that a *new* untyped property still fails the build.
  'EntityProperty.value': 'unknown',
  'FieldMetadata.defaultValue': 'unknown',
  'FieldMetadata.allowedValues[]': 'unknown',
  'FieldMetadata.configuration{}': 'unknown',
  'JsonTypeBean.configuration{}': 'unknown',
  'IssueBean.properties{}': 'unknown',
  'IssueBean.renderedFields{}': 'unknown',
  'IssueBean.versionedRepresentations{}{}': 'unknown',
};

/** Keywords that constrain values without changing the TypeScript type. Listed explicitly so
 * that anything genuinely unrecognised still throws. */
const IGNORED = new Set([
  'description',
  'format',
  'readOnly',
  'writeOnly',
  'xml',
  'example',
  'default',
  'title',
  'maxLength',
  'minLength',
  'pattern',
  'maximum',
  'minimum',
  'maxItems',
  'minItems',
  'uniqueItems',
  'deprecated',
  'name',
  'attribute',
  'additionalProperties',
  'required',
  'properties',
  'type',
  'enum',
  'items',
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'nullable',
]);

const refName = (ref: string): string => ref.split('/').at(-1) ?? ref;
const exported = (name: string): string => RENAME[name] ?? name;

/** How a `$ref` target becomes a TypeScript name. The ADF pass swaps this out, because inside
 * an ADF subtree a `$ref` points at a node definition rather than at an exported interface. */
let refResolver: (name: string) => string = exported;

/** JSON.stringify does the escaping, which matters: ADF's `hardBreak.attrs.text` is the enum
 * `["\n"]`, and hand-rolled quoting puts a real newline in the middle of a string literal.
 * `deno fmt` normalises the resulting double quotes to the project's single ones. */
const literal = (value: unknown): string => JSON.stringify(value);

/** Renders a JSON Schema node as a TypeScript type expression. Throws on anything it does not
 * recognise — silently emitting `unknown` would let an upstream change weaken the types. */
const tsType = (schema: Schema, path: string, indent = 2): string => {
  const override = TYPE_OVERRIDE[path];
  if (override) return override;

  for (const key of Object.keys(schema)) {
    if (!IGNORED.has(key)) throw new Error(`${path}: unhandled JSON Schema keyword "${key}"`);
  }

  const nullable = schema.nullable === true ? ' | null' : '';
  const wrap = (t: string) => `${t}${nullable}`;

  // An empty schema is a deliberate "any JSON here" — ADF uses it for open extension payloads
  // such as `extension.attrs.parameters` and `blockCard.attrs.data`. That is different from a
  // schema that carries prose but no type, which is an omission and must be overridden below.
  if (Object.keys(schema).length === 0) return 'unknown';

  if (typeof schema.$ref === 'string') return wrap(refResolver(refName(schema.$ref)));

  if (Array.isArray(schema.enum)) return wrap(schema.enum.map(literal).join(' | '));

  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const members = (schema.anyOf ?? schema.oneOf) as Schema[];
    const parts = members.map((m, i) => tsType(m, `${path}[${i}]`, indent));
    return wrap([...new Set(parts)].join(' | '));
  }

  if (Array.isArray(schema.allOf)) {
    const members = schema.allOf as Schema[];
    const parts = members.map((m, i) => tsType(m, `${path}&${i}`, indent));
    return wrap([...new Set(parts)].join(' & '));
  }

  if (schema.type === 'array') {
    const items = schema.items as Schema | undefined;
    if (!items) return wrap('unknown[]');
    const inner = tsType(items, `${path}[]`, indent);
    return wrap(/[ |&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`);
  }

  if (schema.type === 'object' || schema.properties) {
    if (schema.properties) return wrap(objectLiteral(schema, path, indent));
    const extra = schema.additionalProperties;
    const valueType = extra && typeof extra === 'object' && Object.keys(extra).length > 0
      ? tsType(extra as Schema, `${path}{}`, indent)
      : 'unknown';
    return wrap(`Record<string, ${valueType}>`);
  }

  switch (schema.type) {
    case 'string':
      return wrap('string');
    case 'integer':
    case 'number':
      return wrap('number');
    case 'boolean':
      return wrap('boolean');
  }

  if (Object.keys(schema).every((k) => IGNORED.has(k)) && !schema.type) {
    throw new Error(
      `${path}: schema declares no type — add a TYPE_OVERRIDE entry saying what it really is`,
    );
  }
  throw new Error(`${path}: cannot render ${JSON.stringify(schema).slice(0, 120)}`);
};

/** Renders `properties` as an inline object type, honouring the requiredness overlay. */
const objectLiteral = (schema: Schema, path: string, indent: number): string => {
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  const own = path.split('.')[0];
  const required = new Set([
    ...(schema.required as string[] ?? []),
    ...(path === own ? REQUIRED_OVERLAY[own] ?? [] : []),
  ]);
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const key = `${path}.${name}`;
    const nullable = path === own && (NULLABLE_OVERLAY[own] ?? []).includes(name);
    const rendered = tsType(prop, key, indent + 2);
    const type = nullable && !rendered.endsWith('| null') ? `${rendered} | null` : rendered;
    const doc = typeof prop.description === 'string' ? prop.description : undefined;
    if (doc) lines.push(...jsdoc(doc, pad));
    const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`;
    lines.push(`${pad}${safe}${required.has(name) ? '' : '?'}: ${type};`);
  }
  return `{\n${lines.join('\n')}\n${' '.repeat(indent - 2)}}`;
};

const jsdoc = (text: string, pad: string): string[] => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return [];
  const words = clean.split(' ');
  const width = 96 - pad.length;
  const rows: string[] = [];
  let row = '';
  for (const word of words) {
    if (row && (row + ' ' + word).length > width) {
      rows.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows.length === 1
    ? [`${pad}/** ${rows[0]} */`]
    : [`${pad}/**`, ...rows.map((r) => `${pad} * ${r}`), `${pad} */`];
};

// ---------------------------------------------------------------------------
// Atlassian Document Format
// ---------------------------------------------------------------------------

/** A node kind and the attrs the schema declares for it. */
type AdfKind = { kind: string; attrs?: string };

/** Node and mark *kinds* come from each definition's own `type` enum rather than from its
 * definition name — `paragraph_with_alignment_node` and `paragraph_with_no_marks_node` are both
 * just `paragraph` on the wire, and the enum is what says so. */
const adfKinds = (defs: Record<string, Schema>, suffix: string): AdfKind[] => {
  const byKind = new Map<string, Set<string>>();
  for (const [defName, def] of Object.entries(defs)) {
    if (!defName.endsWith(suffix)) continue;
    const props = def.properties as Record<string, Schema> | undefined;
    const kinds = props?.type?.enum as string[] | undefined;
    if (!kinds?.length) continue;
    for (const kind of kinds) {
      const attrs = byKind.get(kind) ?? new Set<string>();
      byKind.set(kind, attrs);
      if (props?.attrs) attrs.add(tsType(props.attrs, `adf.${kind}.attrs`, 4));
    }
  }
  return [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, attrs]) => ({
      kind,
      attrs: attrs.size > 0 ? [...attrs].join(' | ') : undefined,
    }));
};

/** Pulls `57.3.4` out of the unpkg URL the short link resolved to. */
const adfVersion = (url: string): string => /adf-schema@([^/]+)/.exec(url)?.[1] ?? 'unknown';

const unionOf = (kinds: AdfKind[]): string => kinds.map((k) => `  | '${k.kind}'`).join('\n');

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/** Pipes the emitted source through `deno fmt` so the generated file is byte-identical to what
 * `deno fmt --check` wants. Without this, `deno task check` would flip between "types are out of
 * date" and "file is not formatted" forever. */
export const format = async (source: string): Promise<string> => {
  const fmt = new Deno.Command(Deno.execPath(), {
    args: ['fmt', '--ext=ts', '-'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const writer = fmt.stdin.getWriter();
  await writer.write(new TextEncoder().encode(source));
  await writer.close();
  const { code, stdout, stderr } = await fmt.output();
  if (code !== 0) throw new Error(`deno fmt failed: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout);
};

export const generate = (): string => {
  const platform = JSON.parse(Deno.readTextFileSync(PLATFORM_PATH)) as {
    'x-source-version': string;
    schemas: Record<string, Schema>;
  };
  const adf = JSON.parse(Deno.readTextFileSync(ADF_PATH)) as {
    'x-source-resolved': string;
    definitions: Record<string, Schema>;
  };

  const out: string[] = [];
  out.push(
    '/** Types derived from the vendored Atlassian schemas. DO NOT EDIT — regenerate with',
    ' * `deno task types`; `deno task check` fails if this file has drifted.',
    ' *',
    ` * Jira Cloud platform REST API: ${platform['x-source-version']}`,
    ` * Atlassian Document Format:   ${adfVersion(adf['x-source-resolved'])}`,
    ' *',
    ' * Both specs are Apache-2.0; see spec/NOTICE. What the specs cannot express stays',
    ' * hand-written in ./types.ts — most importantly `JiraIssueFields`, because the platform',
    " * spec models an issue's `fields` as an untyped bag.",
    ' */',
    '',
    '// ---------------------------------------------------------------------------',
    '// Atlassian Document Format',
    '// ---------------------------------------------------------------------------',
    '',
  );

  refResolver = () => 'AdfNode';
  const nodes = adfKinds(adf.definitions, '_node');
  const marks = adfKinds(adf.definitions, '_mark');
  refResolver = exported;

  out.push(
    `/** Every node kind the ADF schema declares (${nodes.length}). */`,
    'export type AdfNodeType =',
    `${unionOf(nodes)};`,
    '',
    `/** Every mark kind the ADF schema declares (${marks.length}). */`,
    'export type AdfMarkType =',
    `${unionOf(marks)};`,
    '',
    '/** The `attrs` each node kind carries, for the kinds that declare any. This is what the',
    ' * hand-written `Record<string, unknown>` could not say: `panel` has a closed set of',
    ' * `panelType`s, `status` requires a `text` and a `color`, and so on. */',
    'export type AdfAttrs = {',
  );
  for (const node of nodes) {
    if (node.attrs) out.push(`  ${node.kind}: ${node.attrs};`);
  }
  out.push('};', '');

  out.push(
    '/** A node in an ADF tree.',
    ' *',
    ' * Deliberately **open**: `type` admits any string, not just `AdfNodeType`. Jira Cloud ships',
    ' * node kinds ahead of this schema, and src/adf/to_markdown.ts is built to fall through an',
    ' * unrecognised node into its `content` rather than lose the document. Narrowing this to a',
    ' * closed union would turn a graceful degradation into a compile error, and eventually into',
    ' * dropped content. `AdfNodeType` is still exported, so a `switch` gets autocomplete and an',
    ' * explicit list of what the schema knows about. */',
    'export type AdfNode = {',
    '  type: AdfNodeType | (string & Record<never, never>);',
    '  version?: number;',
    '  text?: string;',
    '  content?: AdfNode[];',
    '  attrs?: Record<string, unknown>;',
    '  marks?: AdfMark[];',
    '};',
    '',
    '/** A mark on an ADF node. Open for the same reason as `AdfNode`. */',
    'export type AdfMark = {',
    '  type: AdfMarkType | (string & Record<never, never>);',
    '  attrs?: Record<string, unknown>;',
    '};',
    '',
    '/** The attrs a given node kind declares, or `Record<string, unknown>` for kinds the schema',
    ' * gives no attrs. Lets a converter branch read `attrs` with real types:',
    " * `(node.attrs as AttrsOf<'panel'>).panelType`. */",
    'export type AttrsOf<K extends AdfNodeType> = K extends keyof AdfAttrs ? AdfAttrs[K]',
    '  : Record<string, unknown>;',
    '',
  );

  out.push(
    '// ---------------------------------------------------------------------------',
    '// Jira Cloud platform REST API',
    '// ---------------------------------------------------------------------------',
    '',
  );

  for (const [name, schema] of Object.entries(platform.schemas)) {
    const doc = typeof schema.description === 'string' ? schema.description : undefined;
    if (doc) out.push(...jsdoc(doc, ''));
    const body = schema.properties ? objectLiteral(schema, name, 2) : tsType(schema, name, 2);
    out.push(`export type ${exported(name)} = ${body};`, '');
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

if (import.meta.main) {
  const targetFlag = Deno.args.indexOf('--target');
  const target = targetFlag >= 0 ? toFileUrl(resolve(Deno.args[targetFlag + 1])) : OUT_PATH;
  const source = await format(generate());

  if (Deno.args.includes('--check')) {
    const current = await Deno.readTextFile(target).catch(() => '');
    if (current !== source) {
      console.error('src/jira/schema_types.ts is out of date — run `deno task types`');
      Deno.exit(1);
    }
    console.log('derived types are up to date');
  } else {
    await Deno.writeTextFile(target, source);
    console.log(`wrote ${target.pathname}`);
  }
}
