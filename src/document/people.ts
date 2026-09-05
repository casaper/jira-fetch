/** How the document names people.
 *
 * Two axes, from the `people` config block: `roles` decides who appears at all, `fields` decides
 * what is recorded about whoever does. This module is the only place that knows either — the
 * frontmatter builder and the comment headings both come through here, so they cannot drift into
 * saying different amounts about the same person.
 */

import type { PeopleConfig, PersonField } from '../config/schema.ts';
import type { JiraUser } from '../jira/types.ts';

/** Config spelling to frontmatter spelling. Config keys are camelCase like every other key in the
 * file; frontmatter keys are snake_case because they are the output contract. */
const OUTPUT_KEY: Record<PersonField, string> = {
  name: 'name',
  email: 'email',
  accountId: 'account_id',
};

const valueOf = (u: JiraUser, field: PersonField): string | undefined => {
  switch (field) {
    case 'name':
      return u.displayName || undefined;
    case 'email':
      return u.emailAddress || undefined;
    case 'accountId':
      return u.accountId || undefined;
  }
};

/** `Kaspar Vollenweider` -> `KV`, `Automation for Jira` -> `AFJ`.
 *
 * Splits on whitespace, hyphens and underscores, so a double-barrelled surname contributes both
 * letters. `Array.from` rather than `[0]` so a name outside the BMP is not cut mid-codepoint.
 *
 * Deliberately no particle handling — dropping `van`, `de` or `von` would make the result
 * unpredictable for exactly the names most likely to contain them. */
export const initials = (name: string): string =>
  name
    .split(/[\s\-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => (Array.from(part)[0] ?? '').toLocaleUpperCase())
    .join('');

const format = (value: string, field: PersonField, people: PeopleConfig): string =>
  field === 'name' && people.nameFormat === 'initials' ? initials(value) : value;

/** The frontmatter form: the selected fields that this user actually has, in the order the config
 * lists them.
 *
 * `null` when nothing is left — an anonymous portal reporter, an unassigned issue, or a selection
 * naming only fields this user lacks. The frontmatter builder then drops the key entirely. */
export const personRecord = (
  u: JiraUser | null | undefined,
  people: PeopleConfig,
): Record<string, string> | null => {
  if (!u) return null;
  const record: Record<string, string> = {};
  for (const field of people.fields) {
    const value = valueOf(u, field);
    if (value === undefined) continue;
    const formatted = format(value, field, people);
    if (formatted) record[OUTPUT_KEY[field]] = formatted;
  }
  return Object.keys(record).length > 0 ? record : null;
};

/** The one-line form, for a comment heading: the first selected field this user has.
 *
 * So `fields: [email]` gives a heading keyed by email rather than an empty one. `nameFormat`
 * still applies to `name` and only to `name` — initials is a *name* transform, and abbreviating
 * an address would destroy the one thing it is good for. */
export const personLabel = (
  u: JiraUser | null | undefined,
  people: PeopleConfig,
): string | undefined => {
  const record = personRecord(u, people);
  return record ? Object.values(record)[0] : undefined;
};
