import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ConfigError, type ConfigFile, discoverConfigFile, resolveConfig } from "./config.ts";

const CWD = "/work/project";

function resolve(
  flags: Record<string, string | undefined> = {},
  env: Record<string, string | undefined> = {},
  file?: ConfigFile,
) {
  return resolveConfig({ flags, env, file, cwd: CWD });
}

const ENV = {
  JIRA_BASE_URL: "https://env.atlassian.net",
  JIRA_EMAIL: "env@example.com",
  JIRA_API_TOKEN: "env-token",
};

Deno.test("flags beat environment, which beats the config file", () => {
  const config = resolve(
    { baseUrl: "https://flag.atlassian.net" },
    ENV,
    { baseUrl: "https://file.atlassian.net", email: "file@example.com", token: "file-token" },
  );
  assertEquals(config.baseUrl, "https://flag.atlassian.net");
  assertEquals(config.email, "env@example.com");
  assertEquals(config.token, "env-token");
});

Deno.test("precedence is per key: a flag for one key keeps the file's other values", () => {
  const config = resolve(
    { baseUrl: "https://flag.atlassian.net" },
    {},
    { baseUrl: "https://file.atlassian.net", email: "file@example.com", token: "file-token" },
  );
  assertEquals(config.baseUrl, "https://flag.atlassian.net");
  assertEquals(config.email, "file@example.com");
  assertEquals(config.token, "file-token");
});

Deno.test("missing credentials are reported together, naming all three sources", () => {
  const error = assertThrows(() => resolve({}, {}, {}), ConfigError);
  assertStringIncludes(error.message, "--base-url");
  assertStringIncludes(error.message, "JIRA_EMAIL");
  assertStringIncludes(error.message, "token in the config file");
});

Deno.test("a trailing slash on the base URL is removed", () => {
  assertEquals(
    resolve({}, { ...ENV, JIRA_BASE_URL: "https://x.atlassian.net//" }).baseUrl,
    "https://x.atlassian.net",
  );
});

Deno.test("a non-https base URL is rejected", () => {
  assertThrows(
    () => resolve({}, { ...ENV, JIRA_BASE_URL: "http://x.atlassian.net" }),
    ConfigError,
    "must use https",
  );
});

Deno.test("a malformed base URL is rejected with the value quoted", () => {
  assertThrows(
    () => resolve({}, { ...ENV, JIRA_BASE_URL: "not a url" }),
    ConfigError,
    "is not a valid URL",
  );
});

Deno.test("the output directory defaults to the working directory", () => {
  assertEquals(resolve({}, ENV).outDir, CWD);
});

Deno.test("a relative --out is resolved against the working directory", () => {
  assertEquals(resolve({ out: "tmp" }, ENV).outDir, join(CWD, "tmp"));
  assertEquals(resolve({ out: "/abs/out" }, ENV).outDir, "/abs/out");
});

Deno.test("allowJql defaults to true and only an explicit false turns it off", () => {
  assertEquals(resolve({}, ENV).allowJql, true);
  assertEquals(resolve({}, ENV, { allowJql: true }).allowJql, true);
  assertEquals(resolve({}, ENV, { allowJql: false }).allowJql, false);
});

Deno.test("filters in the config file are compiled during resolution", () => {
  const config = resolve({}, ENV, { filters: { exclude: [{ project: ["SUP"] }] } });
  assertEquals(config.filters.exclude.length, 1);
  assertEquals(config.filters.exclude[0].preFetch, true);
});

Deno.test("filters reaching resolution are already schema-validated", () => {
  // parseConfigFile rejects a malformed filter before resolveConfig ever sees it; see
  // src/config/schema_test.ts. Resolution therefore only compiles.
  const config = resolve({}, ENV, { filters: { comments: { exclude: [{ author: [null] }] } } });
  assertEquals(config.filters.commentExclude.length, 1);
});

Deno.test("discoverConfigFile walks upward from the working directory", async () => {
  const root = await Deno.makeTempDir();
  try {
    const nested = join(root, "a", "b");
    await Deno.mkdir(nested, { recursive: true });
    await Deno.writeTextFile(
      join(root, ".jira-fetch.json"),
      JSON.stringify({ email: "found@example.com" }),
    );

    const found = await discoverConfigFile(nested);
    assertEquals(found?.data.email, "found@example.com");
    assertEquals(found?.path, join(root, ".jira-fetch.json"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the nearest config file wins over one further up", async () => {
  const root = await Deno.makeTempDir();
  try {
    const nested = join(root, "a");
    await Deno.mkdir(nested);
    await Deno.writeTextFile(join(root, ".jira-fetch.json"), JSON.stringify({ out: "far" }));
    await Deno.writeTextFile(join(nested, ".jira-fetch.json"), JSON.stringify({ out: "near" }));

    assertEquals((await discoverConfigFile(nested))?.data.out, "near");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("YAML config files are accepted alongside JSON", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(root, ".jira-fetch.yaml"),
      "email: yaml@example.com\nallowJql: false\n",
    );
    const found = await discoverConfigFile(root);
    assertEquals(found?.data.email, "yaml@example.com");
    assertEquals(found?.data.allowJql, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a malformed config file names the file and the problem", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(root, ".jira-fetch.json"), "{ not json");
    await assertRejectsConfigError(() => discoverConfigFile(root), "is not valid JSON");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("discoverConfigFile returns undefined when there is nothing to find", async () => {
  const root = await Deno.makeTempDir();
  try {
    assertEquals(await discoverConfigFile(root), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function assertRejectsConfigError(fn: () => Promise<unknown>, includes: string) {
  try {
    await fn();
  } catch (error) {
    assertEquals(error instanceof ConfigError, true);
    assertStringIncludes((error as Error).message, includes);
    return;
  }
  throw new Error("expected a ConfigError");
}
