/** Shared fixture loaders for the test suite. */

import { fromFileUrl } from "@std/path";
import type { JiraComment, JiraIssue } from "../src/jira/types.ts";

const dir = fromFileUrl(new URL("./fixtures/", import.meta.url));

function load<T>(name: string): T {
  return JSON.parse(Deno.readTextFileSync(`${dir}${name}`)) as T;
}

export function issueFixture(): JiraIssue {
  return load<JiraIssue>("issue.json");
}

export function commentsFixture(): JiraComment[] {
  return load<{ comments: JiraComment[] }>("comments.json").comments;
}
