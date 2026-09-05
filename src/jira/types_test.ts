/** Conformance tests for the derived types.
 *
 * `src/jira/schema_types.ts` is regenerated from the vendored Atlassian schemas, so a spec change
 * can silently reshape it. `deno task check` catches drift between the specs and the file; this
 * catches the thing that matters more — drift between the file and what the rest of this project
 * needs from it.
 *
 * Most of the value here is at compile time: if a field the code depends on is dropped, renamed,
 * or turned optional by a regeneration, this file stops compiling. The runtime assertions exist
 * so the failure shows up as a named test rather than only as a typecheck error.
 */

import { assert, assertEquals } from '@std/assert';
import type {
  AdfNode,
  AdfNodeType,
  AttrsOf,
  JiraAttachment,
  JiraComment,
  JiraFieldMeta,
  JiraIssue,
  JiraUser,
} from './types.ts';

Deno.test('an issue payload keeps the shape the document builder reads', () => {
  const issue: JiraIssue = {
    id: '10001',
    key: 'DN-1243',
    fields: {
      summary: 'A ticket',
      description: { type: 'doc', version: 1, content: [] },
      // The index signature is why JiraIssueFields cannot be derived: the spec models `fields`
      // as an untyped bag, so a generated type would lose custom field access entirely.
      customfield_10101: 'Platform',
    },
  };
  assertEquals(issue.fields.customfield_10101, 'Platform');
  assertEquals(issue.fields.description?.type, 'doc');
});

Deno.test('absent accounts stay expressible as null', () => {
  // An anonymous portal reporter and an unassigned issue both arrive as an explicit null, and the
  // filter engine lets a rule match that on purpose. The platform spec never marks these
  // nullable, so this is the nullability overlay in scripts/gen_types.ts being load-bearing.
  const comment: JiraComment = { id: '1', author: null, updateAuthor: null };
  const attachment: JiraAttachment = {
    id: 'a',
    filename: 'f.png',
    content: 'https://x/y',
    author: null,
  };
  assertEquals(comment.author, null);
  assertEquals(attachment.author, null);
});

Deno.test('fields the resolver treats as invariants are required, not optional', () => {
  // Deriving optionality straight from the spec would mark all of these optional — 61% of its
  // object schemas carry no `required` at all — and cascade `?.` through the codebase.
  const field: JiraFieldMeta = { id: 'customfield_10101', name: 'Team', custom: true };
  const user: JiraUser = { displayName: 'Someone' };
  assertEquals(field.name, 'Team');
  assert(user.displayName);
});

Deno.test('the ADF node type stays open to kinds the schema has not caught up with', () => {
  // to_markdown.ts falls through an unrecognised node into its content rather than losing the
  // document. A closed union would turn that into a compile error and eventually dropped content.
  const future: AdfNode = { type: 'somethingJiraShipsNextQuarter', content: [] };
  const known: AdfNodeType = 'panel';
  assertEquals(future.content?.length, 0);
  assertEquals(known, 'panel');
});

Deno.test('per-node attrs carry the enums the schema declares', () => {
  const panel: AttrsOf<'panel'> = { panelType: 'warning' };
  const status: AttrsOf<'status'> = { text: 'In progress', color: 'blue' };
  assertEquals(panel.panelType, 'warning');
  assertEquals(status.color, 'blue');
});
