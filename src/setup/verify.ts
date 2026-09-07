/** Checking credentials against the site before writing them down.
 *
 * Three answers are needed, not two: a token cannot be checked without knowing which site to check
 * it against. `GET /rest/api/3/myself` is the natural probe — it needs nothing but valid
 * credentials and returns the account's own name, so success can be reported as *who* you are
 * rather than as a bare tick.
 *
 * The failure this exists to catch is not a wrong token, which is easy. It is a wrong **site**: a
 * marketing page, an SSO portal or a corporate proxy answers `200 text/html` and `response.ok` is
 * `true`. So what came back is compared against what was expected, the same reasoning
 * `assertNotLoginPage` uses for attachment downloads — the status code proves nothing.
 *
 * The network call is injectable, so the sealed suite exercises every branch without a socket.
 */

import { ConfigError } from '../config/errors.ts';
import { normalizeBaseUrl } from '../config/config.ts';
import { JiraClient, JiraError } from '../jira/client.ts';

export type Credentials = {
  baseUrl: string;
  email: string;
  token: string;
};

/** Distinguished because each one points at a different thing to fix. */
export type VerifyFailure =
  | 'badUrl'
  | 'network'
  | 'notJira'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'server';

export type VerifyResult =
  | { ok: true; accountId: string; displayName: string; emailAddress?: string }
  | { ok: false; kind: VerifyFailure; message: string };

const failure = (kind: VerifyFailure, message: string): VerifyResult => ({
  ok: false,
  kind,
  message,
});

export const verifyCredentials = async (
  credentials: Credentials,
  fetchImpl?: typeof fetch,
): Promise<VerifyResult> => {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(credentials.baseUrl);
  } catch (cause) {
    // The loader's own message, so the words a user reads here are the words they would have read
    // on the next run.
    return failure('badUrl', cause instanceof ConfigError ? cause.message : String(cause));
  }

  const client = new JiraClient({
    baseUrl,
    email: credentials.email,
    token: credentials.token,
    fetch: fetchImpl,
    // The default three retries with backoff turn a 503 into a fifteen-second freeze at an
    // interactive prompt. A person can press "try again" faster than that, and choosing to is
    // better than being made to wait.
    maxRetries: 0,
  });

  let response: Response;
  try {
    response = await client.raw(`${baseUrl}/rest/api/3/myself`);
  } catch (cause) {
    const message = (cause as Error).message;
    // `raw` throws for a non-2xx as well as for a transport failure, and it carries the status on
    // the error rather than only in the text. Reading the property keeps these four cases apart
    // without the client having to classify them for one caller — and without a regex over a
    // message that could be reworded.
    const status = cause instanceof JiraError ? cause.status : undefined;
    if (status === 401) {
      return failure(
        'unauthorized',
        'the email and token did not match. An API token belongs to one account, so check both — ' +
          'and check the token has not been revoked.',
      );
    }
    if (status === 403) {
      return failure(
        'forbidden',
        'the credentials are valid but this account is not allowed to use the API.',
      );
    }
    if (status === 404) {
      return failure(
        'notFound',
        'that site answered, but it has no /rest/api/3/myself. Jira Server and Data Center expose ' +
          'only REST v2, which this tool does not read.',
      );
    }
    if (status !== undefined && status >= 500) {
      return failure('server', `the site returned an error: ${message}`);
    }
    return failure('network', `could not reach the site: ${message}`);
  }

  // A wrong host can answer 200 with an HTML login page, so the content type decides, not the code.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return failure(
      'notJira',
      "that address answered, but not with Jira's API — a wrong host can return an HTML login " +
        'page with a 200, so the status code proves nothing. Check the site address.',
    );
  }

  let body: { accountId?: string; displayName?: string; emailAddress?: string };
  try {
    body = await response.json();
  } catch {
    return failure('notJira', 'the site claimed to send JSON and did not. Check the site address.');
  }

  if (!body.accountId) {
    return failure('notJira', 'the reply had no account in it. Check the site address.');
  }

  return {
    ok: true,
    accountId: body.accountId,
    displayName: body.displayName ?? body.accountId,
    emailAddress: body.emailAddress,
  };
};

/**
 * What to do about a failure, as lines to print.
 *
 * Pure and separate from the probe so the words are testable, and so a caller cannot show a
 * failure without also showing what it means.
 */
export const describeFailure = (
  result: Extract<VerifyResult, { ok: false }>,
): string[] => {
  const lines = [result.message];
  if (result.kind === 'network' || result.kind === 'server') {
    // Verification is a convenience, not the boundary — the only hard one is what the token may
    // see on Atlassian's side. Refusing to save a configuration because a probe could not run
    // would break the offline and proxied cases for no gain.
    lines.push('Saving these anyway is reasonable: this may be the network rather than the keys.');
  }
  return lines;
};
