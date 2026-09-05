/** Jira Cloud REST v3 client. */

import { encodeBase64 } from '@std/encoding/base64';
import type { IssueRef, JiraComment, JiraFieldMeta, JiraIssue } from './types.ts';

export class JiraError extends Error {
  override readonly name = 'JiraError';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface ClientOptions {
  baseUrl: string;
  email: string;
  token: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  maxRetries?: number;
  /** Injectable for tests, so retry logic does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Ceiling on any paginated loop: at 100 items a page this is far past any real issue, and it
 * turns a server that never advances into an error instead of a hang. */
const MAX_PAGES = 1000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class JiraClient {
  readonly baseUrl: string;
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private fieldCache?: Promise<JiraFieldMeta[]>;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.auth = `Basic ${encodeBase64(`${opts.email}:${opts.token}`)}`;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Shared by API calls and attachment downloads — an attachment fetched without this header
   * comes back as an HTML login page with a 200, not an error. */
  authHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set('Authorization', this.auth);
    headers.set('Accept', 'application/json');
    return headers;
  }

  async raw(url: string, init: RequestInit = {}): Promise<Response> {
    let lastError = '';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: this.authHeaders(init.headers),
          redirect: 'follow',
        });
      } catch (cause) {
        lastError = `network error: ${(cause as Error).message}`;
        if (attempt === this.maxRetries) break;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.ok) return response;

      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt),
        );
        continue;
      }

      throw new JiraError(
        `${init.method ?? 'GET'} ${
          redact(url)
        } failed: ${response.status} ${response.statusText}${await detail(response)}`,
        response.status,
      );
    }
    throw new JiraError(`${init.method ?? 'GET'} ${redact(url)} failed: ${lastError}`);
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(`${this.baseUrl}${path}`, init);
    return await response.json() as T;
  }

  /** Full issue payload, including the attachment manifest the ADF converter depends on. */
  getIssue(key: string): Promise<JiraIssue> {
    return this.json<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}`);
  }

  /**
   * Siblings are the other children of the issue's parent. There is no sibling field, so they
   * come from the parent's own subtask list — one plain issue GET, deliberately not a JQL
   * `parent = ...` search, which would both need the search endpoint and be blocked when the
   * config forbids JQL.
   */
  async getSubtasksOf(parentKey: string): Promise<IssueRef[]> {
    const issue = await this.json<JiraIssue>(
      `/rest/api/3/issue/${encodeURIComponent(parentKey)}?fields=subtasks`,
    );
    return issue.fields?.subtasks ?? [];
  }

  /** Comments are paginated with startAt/maxResults (unlike search, which is token-paged). */
  async getComments(key: string): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    const pageSize = 100;
    // A server that ignores startAt would otherwise return the same page forever. This binary
    // ships to other people, so the loop is bounded rather than trusting the server to advance.
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.json<{ comments?: JiraComment[]; total?: number; startAt?: number }>(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment` +
          `?startAt=${startAt}&maxResults=${pageSize}&orderBy=created`,
      );
      const batch = body.comments ?? [];
      out.push(...batch);
      startAt += batch.length;
      if (batch.length === 0 || (body.total !== undefined && startAt >= body.total)) break;
    }
    return out;
  }

  /**
   * Enumerates issue keys for a JQL query.
   *
   * Keys only: every key returned here is then fetched through the same single-key path, which
   * is what makes batch mode behave exactly like running single fetches in a row. Asking search
   * for full issues would build a second, divergent code path — `/search/jql` returns a partial
   * field set by default.
   *
   * `/rest/api/3/search` was sunset in 2025 and now returns 410 Gone; this is its replacement,
   * paginated by `nextPageToken` with no `total` in the response.
   */
  async *searchIssueKeys(jql: string, pageSize = 100): AsyncGenerator<string> {
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const page = await this.json<
        { issues?: Array<{ key: string }>; nextPageToken?: string; isLast?: boolean }
      >('/rest/api/3/search/jql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql, maxResults: pageSize, fields: ['key'], nextPageToken }),
      });

      for (const issue of page.issues ?? []) yield issue.key;

      if (page.isLast || !page.nextPageToken) break;
      nextPageToken = page.nextPageToken;
    }
  }

  /** Field metadata, fetched at most once per run and only when a `field` filter needs it. */
  getFields(): Promise<JiraFieldMeta[]> {
    this.fieldCache ??= this.json<JiraFieldMeta[]>('/rest/api/3/field');
    return this.fieldCache;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/** Keeps query strings (which can carry JQL, but never credentials) out of error messages when
 * they are long enough to bury the actual failure. */
function redact(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

async function detail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    try {
      const body = JSON.parse(text) as {
        errorMessages?: string[];
        errors?: Record<string, string>;
      };
      const messages = [
        ...(body.errorMessages ?? []),
        ...Object.values(body.errors ?? {}),
      ];
      if (messages.length > 0) return ` — ${messages.join('; ')}`;
    } catch {
      // Not JSON: a login page or a proxy error. Show a short prefix.
    }
    return ` — ${text.slice(0, 200)}`;
  } catch {
    return '';
  }
}
