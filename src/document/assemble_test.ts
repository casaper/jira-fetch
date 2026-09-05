import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { assembleDocument } from "./assemble.ts";
import { buildManifest } from "../assets/download.ts";
import { compileFilters } from "../filter/rules.ts";
import type { FiltersConfig } from "../config/schema.ts";
import { commentsFixture, issueFixture } from "../../test/fixtures.ts";

const FETCHED_AT = new Date("2026-09-05T15:00:00.000Z");

function assemble(filters?: FiltersConfig) {
  const issue = issueFixture();
  return assembleDocument({
    issue,
    comments: commentsFixture(),
    siblings: [{ key: "DN-1245" }, { key: "DN-1246" }],
    assets: buildManifest(issue.fields.attachment, issue.key),
    baseUrl: "https://example.atlassian.net",
    filters: compileFilters(filters),
    fetchedAt: FETCHED_AT,
  });
}

function frontmatterOf(markdown: string): Record<string, unknown> {
  const end = markdown.indexOf("\n---", 4);
  return parseYaml(markdown.slice(4, end)) as Record<string, unknown>;
}

Deno.test("the document opens with a YAML frontmatter block", () => {
  const { markdown } = assemble();
  assertEquals(markdown.startsWith("---\n"), true);
  assertStringIncludes(markdown, "\n---\n\n# Spike: evaluate the export pipeline");
});

Deno.test("frontmatter carries the ticket's machine-readable metadata", () => {
  const data = frontmatterOf(assemble().markdown);

  assertEquals(data.id, "DN-1243");
  assertEquals(data.internal_id, "10234");
  assertEquals(data.title, "Spike: evaluate the export pipeline");
  assertEquals(data.url, "https://example.atlassian.net/browse/DN-1243");
  assertEquals(data.type, "Task");
  assertEquals(data.status, "In Progress");
  assertEquals(data.project, "DN");
  assertEquals(data.created_at, "2026-08-01T09:12:00.000+0200");
  assertEquals(data.updated_at, "2026-08-14T16:40:11.000+0200");
  assertEquals(data.fetched_at, FETCHED_AT.toISOString());
  assertEquals(data.labels, ["backend", "wontfix"]);
  assertEquals(data.components, ["api", "exporter"]);
});

Deno.test("an anonymous reporter stays null rather than becoming an empty object", () => {
  const data = frontmatterOf(assemble().markdown);
  assertEquals(data.author, null);
  assertEquals(data.reporter, null);
  assertEquals(data.assignee, {
    name: "Kim Rivera",
    email: "kim@example.com",
    account_id: "5b10a2844c20165700ede21g",
  });
});

Deno.test("parent, siblings and subtasks are recorded", () => {
  const data = frontmatterOf(assemble().markdown);
  assertEquals((data.parent as Record<string, unknown>).key, "DN-1200");
  assertEquals(data.siblings, ["DN-1245", "DN-1246"]);
  assertEquals(data.subtasks, [{
    key: "DN-1244",
    title: "Write the exporter",
    type: "Sub-task",
    status: "To Do",
  }]);
});

Deno.test("assets are listed with the relative path used in the body", () => {
  const data = frontmatterOf(assemble().markdown);
  const assets = data.assets as Array<Record<string, unknown>>;
  assertEquals(assets.length, 2);
  assertEquals(assets[0].path, ".DN-1243/screenshot_01.png");
  assertEquals(assets[1].path, ".DN-1243/screenshot_01-20002.png");
});

Deno.test("comments follow the description, each behind a horizontal rule", () => {
  const { markdown } = assemble();
  const body = markdown.slice(markdown.indexOf("\n---\n", 4) + 5);
  assertEquals(body.split("\n---\n").length - 1, 3);
  assertStringIncludes(markdown, "### Kim Rivera — 2026-08-05T11:00:00.000+0200");
  assertStringIncludes(markdown, "### Anonymous — 2026-08-06T09:30:00.000+0200");
});

Deno.test("a comment's media resolves through the same manifest as the description", () => {
  const { markdown } = assemble();
  // The label is escaped (underscores would otherwise italicise); the path is not.
  assertStringIncludes(markdown, "![screenshot\\_01-20002.png](.DN-1243/screenshot_01-20002.png)");
});

Deno.test("filtered comments are dropped and counted", () => {
  const result = assemble({ comments: { exclude: [{ author: [null] }] } });
  assertEquals(result.skippedComments, 1);
  assertEquals(result.markdown.includes("Reported from the portal"), false);
  assertEquals(frontmatterOf(result.markdown).comment_count, 2);
});

Deno.test("an issue with no description says so rather than leaving a gap", () => {
  const issue = issueFixture();
  issue.fields.description = null;
  const { markdown } = assembleDocument({
    issue,
    comments: [],
    siblings: [],
    assets: new Map(),
    baseUrl: "https://example.atlassian.net",
    filters: compileFilters(undefined),
  });
  assertStringIncludes(markdown, "*No description.*");
  assertEquals(markdown.endsWith("\n"), true);
});
