import { assertEquals } from "@std/assert";
import { compileFilters, hasAnyFilter } from "./rules.ts";

// Validation lives in the Zod schema; see src/config/schema_test.ts. These tests cover the
// shaping that happens after a rule is known to be well-formed.

Deno.test("a rule is pre-fetch only when project is its sole predicate", () => {
  const { exclude } = compileFilters({
    exclude: [{ project: ["DN"] }, { project: ["DN"], labels: ["x"] }, { labels: ["x"] }],
  });
  assertEquals(exclude.map((r) => r.preFetch), [true, false, false]);
});

Deno.test("project keys are upper-cased so config casing does not matter", () => {
  const { exclude } = compileFilters({ exclude: [{ project: ["dn", "SuP"] }] });
  assertEquals([...exclude[0].project!].sort(), ["DN", "SUP"]);
});

Deno.test("value lists are lower-cased and null is lifted out as allowAbsent", () => {
  const { exclude } = compileFilters({ exclude: [{ reporter: ["Kim@Example.com", null] }] });
  assertEquals([...exclude[0].reporter!.values], ["kim@example.com"]);
  assertEquals(exclude[0].reporter!.allowAbsent, true);
});

Deno.test("labels and tags compile to the same predicate", () => {
  const viaLabels = compileFilters({ exclude: [{ labels: ["x"] }] }).exclude[0];
  const viaTags = compileFilters({ exclude: [{ tags: ["x"] }] }).exclude[0];
  assertEquals([...viaLabels.labels!.values], [...viaTags.labels!.values]);
});

Deno.test("the title regex is compiled once, with its flags", () => {
  const { exclude } = compileFilters({ exclude: [{ title: { matches: "^a", flags: "i" } }] });
  assertEquals(exclude[0].title?.flags, "i");
  assertEquals(exclude[0].title?.test("Abc"), true);
});

Deno.test("each rule keeps a readable label for --verbose skip reasons", () => {
  const { exclude } = compileFilters({ exclude: [{ project: ["SUP"] }] });
  assertEquals(exclude[0].label, '{"project":["SUP"]}');
});

Deno.test("field names are collected once for lazy resolution", () => {
  const filters = compileFilters({
    include: [{ field: { Team: ["Platform"] } }],
    exclude: [{ field: { Team: ["Ops"], "customfield_10999": ["x"] } }],
  });
  assertEquals(filters.fieldNames.sort(), ["Team", "customfield_10999"]);
});

Deno.test("no field predicates means the field endpoint is never needed", () => {
  assertEquals(compileFilters({ exclude: [{ labels: ["x"] }] }).fieldNames, []);
});

Deno.test("hasAnyFilter reports whether anything is configured", () => {
  assertEquals(hasAnyFilter(compileFilters(undefined)), false);
  assertEquals(hasAnyFilter(compileFilters({})), false);
  assertEquals(hasAnyFilter(compileFilters({ exclude: [{ labels: ["x"] }] })), true);
});
