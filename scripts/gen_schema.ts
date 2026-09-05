/** Regenerates schema/jira-fetch.schema.json from the Zod schema.
 *
 * Run via `deno task schema`. The check task verifies the committed file is up to date, so the
 * schema an editor loads can never drift from the one the CLI enforces.
 */

import { z } from 'zod';
import { ConfigFile } from '../src/config/schema.ts';

export const SCHEMA_PATH = new URL('../schema/jira-fetch.schema.json', import.meta.url);

export function generate(): string {
  const schema = z.toJSONSchema(ConfigFile, { target: 'draft-7', io: 'input' });
  return `${
    JSON.stringify(
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'https://github.com/kaspi/jira-fetch/schema/jira-fetch.schema.json',
        title: 'jira-fetch configuration',
        ...schema,
      },
      null,
      2,
    )
  }\n`;
}

if (import.meta.main) {
  const json = generate();
  if (Deno.args.includes('--check')) {
    const current = await Deno.readTextFile(SCHEMA_PATH).catch(() => '');
    if (current !== json) {
      console.error('schema/jira-fetch.schema.json is out of date — run `deno task schema`');
      Deno.exit(1);
    }
    console.log('schema is up to date');
  } else {
    await Deno.mkdir(new URL('../schema/', import.meta.url), { recursive: true });
    await Deno.writeTextFile(SCHEMA_PATH, json);
    console.log(`wrote ${SCHEMA_PATH.pathname}`);
  }
}
