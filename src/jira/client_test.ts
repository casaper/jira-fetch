import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { JiraClient, JiraError } from "./client.ts";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

function stub(responder: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const client = new JiraClient({
    baseUrl: "https://example.atlassian.net/",
    email: "kim@example.com",
    token: "secret-token",
    maxRetries: 2,
    sleep: () => Promise.resolve(),
    fetch: async (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      return await responder(call, calls.length);
    },
  });
  return { client, calls };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

Deno.test("a trailing slash on the base URL does not double up in request paths", async () => {
  const { client, calls } = stub(() => json({ id: "1", key: "DN-1", fields: {} }));
  await client.getIssue("DN-1");
  assertEquals(calls[0].url, "https://example.atlassian.net/rest/api/3/issue/DN-1");
});

Deno.test("requests carry Basic auth built from the email and token", async () => {
  const { client, calls } = stub(() => json({ id: "1", key: "DN-1", fields: {} }));
  await client.getIssue("DN-1");

  const header = calls[0].headers.get("authorization") ?? "";
  assertEquals(header.startsWith("Basic "), true);
  assertEquals(
    new TextDecoder().decode(decodeBase64(header.slice(6))),
    "kim@example.com:secret-token",
  );
});

Deno.test("issue keys are URL-encoded", async () => {
  const { client, calls } = stub(() => json({ id: "1", key: "A B-1", fields: {} }));
  await client.getIssue("A B-1");
  assertStringIncludes(calls[0].url, "/issue/A%20B-1");
});

Deno.test("a 429 is retried after the interval the server asks for", async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1
      ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
      : json({ id: "1", key: "DN-1", fields: {} })
  );

  const issue = await client.getIssue("DN-1");
  assertEquals(issue.key, "DN-1");
  assertEquals(calls.length, 2);
});

Deno.test("a 500 is retried, and the last failure is reported", async () => {
  const { client, calls } = stub(() => new Response("boom", { status: 500 }));
  const error = await assertRejects(() => client.getIssue("DN-1"), JiraError);
  assertEquals(error.status, 500);
  assertEquals(calls.length, 3); // the initial attempt plus maxRetries
});

Deno.test("a 404 is not retried", async () => {
  const { client, calls } = stub(() =>
    json({ errorMessages: ["Issue does not exist"] }, { status: 404 })
  );
  const error = await assertRejects(() => client.getIssue("DN-9"), JiraError);
  assertEquals(calls.length, 1);
  assertStringIncludes(error.message, "Issue does not exist");
});

Deno.test("an error message keeps the path but drops the query string", async () => {
  const { client } = stub(() => new Response("nope", { status: 403 }));
  const error = await assertRejects(() => client.getSubtasksOf("DN-1"), JiraError);
  assertStringIncludes(error.message, "/rest/api/3/issue/DN-1");
  assertEquals(error.message.includes("fields=subtasks"), false);
});

Deno.test("comments are paginated until the reported total is reached", async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1
      ? json({ total: 3, comments: [{ id: "1" }, { id: "2" }] })
      : json({ total: 3, comments: [{ id: "3" }] })
  );

  const comments = await client.getComments("DN-1");
  assertEquals(comments.map((c) => c.id), ["1", "2", "3"]);
  assertStringIncludes(calls[0].url, "startAt=0");
  assertStringIncludes(calls[1].url, "startAt=2");
});

Deno.test("an empty comment page ends pagination even without a total", async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1 ? json({ comments: [{ id: "1" }] }) : json({ comments: [] })
  );
  assertEquals((await client.getComments("DN-1")).length, 1);
  assertEquals(calls.length, 2);
});

Deno.test("search asks only for keys, and follows nextPageToken", async () => {
  const { client, calls } = stub((_call, n) =>
    n === 1
      ? json({ issues: [{ key: "DN-1" }, { key: "DN-2" }], nextPageToken: "tok" })
      : json({ issues: [{ key: "DN-3" }], isLast: true })
  );

  const keys: string[] = [];
  for await (const key of client.searchIssueKeys("project = DN")) keys.push(key);

  assertEquals(keys, ["DN-1", "DN-2", "DN-3"]);
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url, "https://example.atlassian.net/rest/api/3/search/jql");

  // Only the key is requested: every issue is then fetched through the single-key path, so
  // batch mode behaves exactly like running single fetches in a row.
  assertEquals(JSON.parse(calls[0].body!).fields, ["key"]);
  assertEquals(JSON.parse(calls[1].body!).nextPageToken, "tok");
});

Deno.test("search stops when the last page carries no token", async () => {
  const { client, calls } = stub(() => json({ issues: [{ key: "DN-1" }] }));
  const keys: string[] = [];
  for await (const key of client.searchIssueKeys("project = DN")) keys.push(key);
  assertEquals(keys, ["DN-1"]);
  assertEquals(calls.length, 1);
});

Deno.test("siblings come from the parent's subtasks, not from a search", async () => {
  const { client, calls } = stub(() =>
    json({
      id: "1",
      key: "DN-1200",
      fields: { subtasks: [{ key: "DN-1243" }, { key: "DN-1244" }] },
    })
  );

  const subtasks = await client.getSubtasksOf("DN-1200");
  assertEquals(subtasks.map((s) => s.key), ["DN-1243", "DN-1244"]);
  assertStringIncludes(calls[0].url, "/rest/api/3/issue/DN-1200?fields=subtasks");
  assertEquals(calls[0].method, "GET");
});

Deno.test("field metadata is fetched at most once per client", async () => {
  const { client, calls } = stub(() => json([{ id: "customfield_10101", name: "Team" }]));
  await client.getFields();
  await client.getFields();
  assertEquals(calls.length, 1);
});

Deno.test("pagination is bounded, so a server that never advances cannot hang the CLI", async () => {
  // This server ignores startAt and returns a full page forever.
  const { client, calls } = stub(() => json({ comments: [{ id: "1" }] }));
  const comments = await client.getComments("DN-1");
  assertEquals(comments.length, calls.length);
  assertEquals(calls.length, 1000);
});

Deno.test("a network failure is retried and then reported", async () => {
  const { client, calls } = stub(() => {
    throw new TypeError("connection refused");
  });
  const error = await assertRejects(() => client.getIssue("DN-1"), JiraError);
  assertEquals(calls.length, 3);
  assertStringIncludes(error.message, "connection refused");
});
