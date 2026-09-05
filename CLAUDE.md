# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

A Deno CLI that fetches Jira **Cloud** issues into Markdown files with YAML frontmatter, plus their
attachments. One or more issue keys, or a JQL query. Shipped as a self-contained binary for macOS,
Linux and Windows. See README.md for user-facing docs.

Licensed MIT (`deno.json` carries `"license"`), and every dependency is permissive — keep it that
way when adding one; the shipped binaries already embed Deno and V8.

## Commands

```sh
deno task dev DN-1243 --out tmp      # run from source (no `--`: deno forwards it literally)
deno task check                       # typecheck + lint + fmt --check + assert the JSON Schema is current
deno check test/                      # `check` covers src/ and scripts/ only — tests need this separately
deno task lint
deno task fmt
deno task test                        # or: deno test -A
deno test -A --filter "excludes anonymous reporter"   # single test by name
deno test -A src/adf/to_markdown_test.ts              # single test file
deno task schema                      # regenerate schema/jira-fetch.schema.json
deno task types                       # regenerate src/jira/schema_types.ts from spec/
deno task vendor:spec                 # re-fetch the Atlassian schemas into spec/ (the only networked task)
deno task build                       # host binary -> dist/
deno task build:all                   # all six release targets
deno task hooks                       # once per clone: enable the commit-msg hook
deno task commitlint --from <rev>     # lint the commit messages after <rev>
deno task changelog                   # regenerate CHANGELOG.md from the history
deno task release patch               # bump + changelog + commit + tag
```

The suite needs no credentials and no network — `test/e2e_test.ts` drives the whole CLI against a
fake Jira on localhost, which is what covers the wiring in `src/main.ts`.

**The suite is sealed, and `run` is what seals it.** `run(argv, deps)` takes an optional `env`; when
it is given, that record is used verbatim — no `.env` file is read and `Deno.env` is never
consulted, not even for `HOME`. `withJira` in `test/e2e_test.ts` passes `{ env: { JIRA_API_TOKEN:
't' } }`, so an exported `JIRA_BASE_URL` no longer redirects the suite at a real site and
`env -u JIRA_BASE_URL … deno test` is no longer needed.

That parameter is load-bearing rather than tidy. `.env` and `.env.local` are credential sources now,
found by walking **upward**, and this repo has an untracked `.env.local` holding a real
`JIRA_API_TOKEN` — so an unsealed run started anywhere in the tree picks it up. Nothing asserts the
token, so a leak would not turn the suite red; it would just quietly stop being hermetic. Any new
entry point that calls `run` from a test must pass an explicit `env`.

The same file is why **`deno task dev` is live-fire in this repo**: it resolves a real token from
`.env.local` while `baseUrl` still comes from wherever you point it.

The fake-Jira-on-localhost approach works at all only because `normalizeBaseUrl`
(`src/config/config.ts`) permits plain http for loopback hosts. Tightening it to https-only fails
every e2e test with exit 2, far from the change.

**`deno compile` bakes permission flags in at build time.** `PERMISSIONS` in `scripts/build_all.ts`
is the single source of truth and must stay identical to the `--allow-*` string in the `dev` task in
`deno.json`, or the shipped binary behaves differently from `deno run` — a bug that only appears
after distribution.

No CI: `deno task check` and the suite run locally, and release binaries are built with
`deno task build:all` and attached to a GitHub release by hand.

## Code style

`deno lint` and `deno fmt` are the whole toolchain — no eslint, no prettier, which is the Deno
norm. `deno task check` runs typecheck, lint, `fmt --check` and the JSON Schema freshness check, so
it is the one command that has to pass — but it typechecks `src/` and `scripts/` only, so a change
touching test types needs `deno check test/` too.

Formatting is settled by `deno.json`'s `fmt` block plus `.editorconfig` (which `deno fmt` reads as
well): 2-space indent, LF, 100 columns, semicolons, **single quotes**, and `proseWrap: preserve` so
hand-wrapped Markdown is left alone.

Conventions the linter cannot express — follow them anyway:

- **Arrow functions** over `function` declarations.
- **`type`** over `interface`.
- **String-literal unions** over `enum`.

No lint rule enforces any of these, and none forbids them either — that is deliberate. Deno has no
`prefer-arrow` rule, and its `ban-types` is about `String`/`Object` wrappers, not `type` vs
`interface`.

These govern **new** code. Most existing source predates them and still uses `function` and
`interface`; convert it only when already editing it, not as a sweep.

Two rules need a word of warning:

- **`camelcase`** is on, but the frontmatter keys are snake_case on purpose — it is the output
  contract. `UserRecord` in `src/document/frontmatter.ts` carries a targeted
  `// deno-lint-ignore camelcase` for exactly that reason; don't widen it.
- **`no-boolean-literal-for-arguments`** is why tests use `assert(x)` / `assertFalse(x)` rather
  than `assertEquals(x, true)`. That reads better anyway.

Rules deliberately left off: `no-console` (this is a CLI — console _is_ the output),
`no-top-level-await` (`src/main.ts` ends in one), `no-await-in-loop` (pagination and downloads are
sequential on purpose) and `prefer-ascii` (the prose uses real typography).

## Commit messages

Conventional Commits 1.0.0, enforced by `.githooks/commit-msg`. `core.hooksPath` is local config
and cannot be committed, so **every clone runs `deno task hooks` once** — until it does, nothing
checks anything.

```
type(scope)!: subject
```

- Types and their changelog headings are declared together in `scripts/commit_lint.ts`; adding a
  type there is the only edit needed for it to appear in the changelog.
- Scopes are optional and come from the layout: `config`, `cli`, `jira`, `filter`, `adf`, `assets`,
  `document`, `schema`, `scripts`, `deps`, `release`.
- Header ≤ 72 characters, imperative, lower-case, no trailing period. Bodies wrap at 100 to match
  `.editorconfig`, and long unbreakable tokens (URLs, paths) are exempt.
- **The convention governs the subject line only.** This project's commit bodies explain _why_, at
  length; keep writing them.
- `deno task commitlint --from <rev>` lints commits that already exist — that is how a history
  rewrite gets verified.

It is deliberately not commitlint: that is an npm dependency tree in a project whose toolchain is
`deno lint` and `deno fmt`, and it would not know these scopes. Husky is unnecessary for the same
reason `deno task hooks` is one line — husky exists to run that line from npm's `prepare` hook.

## Releases

`deno task release <patch|minor|major>` (or `--set x.y.z`) bumps the version, regenerates
`CHANGELOG.md`, commits `chore(release): vX.Y.Z` and creates the annotated tag. It refuses a dirty
tree and runs `deno task check` before committing. Pushing and `deno task build:all` stay manual.

`CHANGELOG.md` is generated, never hand-edited — a careless subject line becomes a careless
changelog entry. Non-conventional subjects are not silently dropped; they collect under "Other".
`deno task changelog --check` verifies a release commit carries a current file; it is deliberately
not part of `deno task check`, which would then fail on every unreleased commit.

**The version string lives in two files**: `deno.json` and `VERSION` in `src/cli/args.ts`, which
`--help` prints. Nothing at type level can hold them equal, so `scripts/release.ts` owns both and
refuses to start when they have drifted — the same class of hazard as `PERMISSIONS` above.

## Layout

```
src/main.ts             orchestration; owns the exit codes
src/cli/args.ts         flag parsing and --help
src/config/schema.ts    Zod schemas — the single source of truth (see below)
src/config/config.ts    flag/env/file resolution, per key
src/jira/client.ts      auth, retry, and every REST call
src/filter/rules.ts     compiles validated rules into their runtime form
src/filter/evaluate.ts  the three filter stages
src/adf/to_markdown.ts  ADF -> Markdown
src/assets/download.ts  filename sanitising, the attachment manifest, downloads
src/document/           frontmatter + document assembly
scripts/                build matrix, JSON Schema generation, commit lint, changelog, release
spec/                   vendored Atlassian schemas, pinned (see below)
```

Tests are colocated as `*_test.ts`; fixtures live in `test/fixtures/`.

## Configuration is discovered by closeness, and meant to be committed

`resolveConfig` resolves **per key**, across four layers:

```
CLI flag  >  process env  >  .env.local  >  .env  >  config file
```

`src/main.ts` merges the first two into one record and hands it over; `resolveConfig` itself never
reads ambient state. `loadDotenv` and `discoverConfigFile` share one `ancestors()` walk, so the two
closeness rules cannot drift: the **nearest** directory holding a match wins **outright**, and
levels never merge. Both walks run to the filesystem root.

That "outright" is the point of the feature, not an implementation detail. A project commits
`.jira-fetch.yaml` so its filters — and `allowJql: false` — apply to everyone working in the tree;
if a developer's `~/.config/jira-fetch.yaml` could layer underneath, the project's policy would be
overridable from a home directory.

Nine config file names are searched in each directory, `.conf` variants first, then the home
locations (including the pre-0.2 `~/.config/jira-fetch/config.*`). `parseConfigText` dispatches on
`.endsWith('.json')`, so a new `.yml`/`.yaml` name needs no parser change.

**The token warning classifies by location only.** `isHomeConfig` asks whether the file sits in
`$HOME`, `$HOME/.config` or `$HOME/.config/jira-fetch` — nothing reads `.gitignore` or shells out to
git, because the tool has no business guessing what is tracked. The condition is that the file _has_
a `token` key, not that the token was resolved from it: a secret on disk in a project is the
problem, whether or not `JIRA_API_TOKEN` overrode it today. Warnings are returned on `Config` rather
than logged, which keeps `resolveConfig` pure and the message directly testable.

`.env` parsing is `@std/dotenv`'s `parse()`, never `load()`. `load()` is deprecated upstream, and
its `export: true` mode writes `Deno.env` — which would make a `.env` value indistinguishable from a
genuinely exported one and silently jump the queue above.

**`parse()` expands `$NAME` only in _unquoted_ values.** `TOKEN="$OTHER"` — the spelling a shell
reads correctly, and the one npm `dotenv` expands — comes back as the literal text `$OTHER`, and a
name it cannot resolve comes back as the literal text `undefined`. That yields a well-formed
credential made of a variable name, which Jira answers with `404 Issue does not exist or you do not
have permission to see it`: an error pointing nowhere near its cause. `assertExpanded`
(`src/config/config.ts`) refuses a resolved value that is _entirely_ a reference, for the four keys
the tool reads and no others. Matching the whole value is what keeps a password containing a `$`
intact.

The expansion also **reads `Deno.env`**, so `parse()` is pure with respect to mutation but not to
ambient reads, and it throws `NotCapable` without `--allow-env` as soon as a value contains an
unquoted `$`. Do not take that permission away on the grounds that parsing needs none.

## Zod is the single source of truth for configuration

`src/config/schema.ts` defines the config file with Zod. Everything else derives from it:

- **TypeScript types** via `z.infer` (`ConfigFile`, `FiltersConfig`, `TicketRule`, …).
- **`schema/jira-fetch.schema.json`**, generated by `deno task schema` and asserted current by
  `deno task check`. Users bind it with a `$schema` key for editor autocomplete.
- **Runtime validation** — `parseConfigFile` is the only gate; by the time a rule reaches
  `src/filter/rules.ts` it is known to be well-formed, so that module only _shapes_ (lowercasing,
  compiling regexes) and never validates.

Adding a config option means editing the Zod schema and re-running `deno task schema` — nothing else
declares config shape.

Types that mirror config keys derive from `ConfigFile` at the type level rather than restating it:
`Config` and `ResolveOptions` (`src/config/config.ts`) and `Args` (`src/cli/args.ts`) use
`Pick`/`Required`/`NonNullable`, so renaming a schema key is a compile error at each. To confirm a
derivation actually bites, rename a key in `schema.ts`, check that every site fails, and revert.
`ClientOptions` (`src/jira/client.ts`) keeps its literal `baseUrl`/`email`/`token` **on purpose** —
Basic auth needs those three because it is Basic auth, and deriving them would make `jira/` depend
on `config/`.

The one thing that cannot be inferred is `CompiledTicketRule` in `src/filter/rules.ts`: it holds
`Set` and `RegExp` values, which have no JSON Schema representation. It still takes its **key set**
from the Zod type (`PredicateForms extends Record<keyof TicketRule, unknown>`), so adding a
predicate to the schema is a compile error until it is given a compiled form and handled in
`ruleMatchesIssue`.

## Jira types are derived from Atlassian's schemas

`src/jira/schema_types.ts` is **generated** — `deno task types`, checked by `deno task check`.
Do not edit it. It comes from two vendored, pinned, Apache-2.0 specs in `spec/`:

- `jira-platform.subset.json` — the Jira Cloud OpenAPI document, pruned to the 30-schema
  transitive closure this tool reads (38 KB, not the 3.6 MB original).
- `adf-schema.json` — the Atlassian Document Format schema. **The OpenAPI document does not
  contain ADF**; it types `Comment.body` as prose only. Bridging the two is what gives
  `JiraComment.body` a real `AdfNode` type.

`deno task vendor:spec` is the only task that touches the network, and it is run by hand. Nothing
in `deno task check` fetches anything — that is what keeps the check reproducible offline.
`spec/` is excluded from `deno fmt`, or re-vendoring and `fmt --check` would fight.

**Why the client is not generated.** `openapi-generator-cli` runs cleanly on this spec and emits
70,770 lines to replace the 314 in `client.ts` + `types.ts` — but the spec types an issue's
`fields` as `{[key: string]: any}` and a comment's `body` as `any`, which is everything this tool
reads. The generated client also carries none of what `client.ts` is actually for: retry,
`Retry-After`, the `MAX_PAGES` bound, Basic auth, and the login-page-with-200 detection. It would
have to be wrapped in all of that anyway. `client.ts` stays hand-written on purpose.

**Two overlays in `scripts/gen_types.ts` are load-bearing**, because the spec under-specifies
responses — 61% of its object schemas carry no `required` at all, and only 19.3% of properties are
marked required:

- `REQUIRED_OVERLAY` pins the fields the code treats as invariants. Without it every field becomes
  optional and `src/` stops compiling in 15 places.
- `NULLABLE_OVERLAY` restores `| null` on `author`/`updateAuthor`. Jira sends an explicit null for
  an anonymous account, and the filter engine matches that deliberately; the spec never says so.

`src/jira/types_test.ts` guards both at compile time. Changing an overlay without updating it is
the failure this catches.

The emitter **throws on any JSON Schema construct it does not recognise** rather than emitting
`unknown` — otherwise an upstream change would quietly weaken the types. Genuinely untyped spots
(`extension.attrs.parameters`, `EntityProperty.value`) are listed by path in `TYPE_OVERRIDE`, so a
_new_ one is still a build failure.

**`AdfNode.type` is deliberately open** (`AdfNodeType | (string & Record<never, never>)`). Jira
ships node kinds ahead of the published schema, and `to_markdown.ts` falls through an unrecognised
node into its `content` rather than losing the document. A closed union would turn that graceful
degradation into a compile error, and then into dropped content.

`AdfAttrs`/`AttrsOf` are a **catalogue, not a cast**. The converter reads attrs defensively
(`typeof node.attrs?.x === 'string' ? … : default`) because the payload is unvalidated wire data;
`node.attrs as AttrsOf<'panel'>` would assert a shape nothing checked and let `undefined` reach
string operations. Use them to know what exists, not to skip the guard.

`JiraIssueFields` stays hand-written for the same reason it cannot be derived: the spec models
`fields` as an untyped bag, and its index signature is what makes `customfield_NNNNN` reachable.

## Filters have three evaluation stages

This is the part that spans modules, so it is worth stating plainly:

> **"Never fetched at all" is only literally achievable for the project prefix.** `DN` comes from
> the issue key with zero API calls. Labels, components, custom fields, title and users all need the
> issue payload — by the time they can be evaluated, the issue JSON has been fetched.
>
> 1. **`preFetchDecision`** — the key alone. The issue is never requested.
> 2. **`ticketDecision`** — the full payload, and it _must_ run before comment pagination and before
>    any attachment download. That is where the cost and every disk write live, so this is the
>    honest and still-valuable version of "never fetched".
> 3. **`commentExcluded`** — per comment, during assembly. Drops comments, never the ticket.

`projectPrefix()` reads the **issue key**, deliberately not `fields.project.key`: using the field
would demote stage 1 to stage 2, and the two disagree after a project rename, since old keys keep
resolving.

Filters are **not** folded into server-side JQL. The user's contract is that batch mode behaves
exactly like running single fetches in a row, and one client-side evaluation path is the only way to
guarantee that.

## The converter/manifest coupling

> **The ADF→Markdown converter cannot run without the attachment manifest.** Inline images and files
> appear in ADF as `media` nodes carrying only an attachment `id`; the filename and download URL
> live in `fields.attachment[]`. So the order is fixed: issue → `buildManifest()` → convert.
> **Comment bodies carry `media` nodes too**, so the same manifest feeds the comment pass.

Filename sanitising therefore has exactly one home (`sanitizeFilename` in `src/assets/download.ts`).
If the converter and the downloader ever disagreed on a name, the relative links would break
silently. Collisions — two attachments both called `image.png` — are resolved by folding the
attachment id into the stem.

## Jira Cloud API notes

- `GET /rest/api/3/issue/{key}` — description arrives as ADF (JSON), not markup.
- `GET /rest/api/3/issue/{key}/comment` — paginated with **`startAt`/`maxResults`**.
- `POST /rest/api/3/search/jql` — paginated with **`nextPageToken`**, and there is **no `total`**.
  The old `/rest/api/3/search` was sunset in 2025 and returns **410 Gone**. Search is asked for
  **keys only**; each key then goes through the same single-key path, which is what keeps batch mode
  equivalent to running singles in a row. Do not reach for `fields=*all` here.
- `GET /rest/api/3/field` — resolves a human field name ("Team") to its `customfield_NNNNN` id.
  Called at most once per run, and only when a `field` predicate exists.
- **Siblings are not a Jira field.** They come from the parent's subtasks via
  `GET /rest/api/3/issue/{parentKey}?fields=subtasks` — one plain GET, deliberately not a JQL
  `parent = ...` search, which would need the search endpoint and would be awkward when a config
  sets `allowJql: false`. (That flag gates the user-facing `--jql` only, never internal requests.)
- **An attachment fetched without the auth header returns an HTML login page with a 200**, not an
  error. `assertNotLoginPage` checks content-type against the attachment's declared mime type,
  because the status code proves nothing.

This targets Jira **Cloud**. Server/Data Center exposes only REST v2 with wiki-markup bodies — a
different converter entirely; don't blend the paths without deciding that explicitly.

## Output contract

Changing any of this breaks people's existing files.

- `<out>/<JIRA-ID>.md`, **overwritten** if it exists (re-fetching is the normal case, given
  `fetched_at`) — so the document is not a safe place for a user's own annotations.
- `<out>/.<JIRA-ID>/` for assets — note the **leading dot**.
- Asset links are **relative**, so the document stays portable with its asset directory.
- Body order: frontmatter → `# [title](<baseUrl>/browse/<KEY>)` → description → `---` → each
  comment, `---`-separated. The heading is a **link**, which is why the frontmatter carries no
  `url` key; its label goes through `escapeText` from `src/adf/to_markdown.ts`, exported for
  exactly that, because a summary containing `[` would otherwise break it.
- A `rule` node in ADF renders as `***`, not `---`, so it cannot be confused with the comment
  separator.
- **Absence is spelled by absence.** `prune` in `src/document/frontmatter.ts` drops any key whose
  value is `null`, `undefined`, `[]` or `{}`, recursively — there is no `resolution: null` and no
  `components: []`. It is deliberately not "falsy": `comment_count: 0` is a fact and stays. The
  recursion means nested records go ragged, so `parent` may be just `{ key }` and one `assets`
  entry may carry `size` where another does not.
- **What the document says about people is configurable**, through the `people` block and
  `src/document/people.ts` — `roles` decides who appears (`reporter`, `assignee`, `commenter`;
  empty omits all of them), `fields` decides what is recorded about them, and `nameFormat:
  initials` shortens a display name in the frontmatter and in comment headings alike. Both paths go
  through `personRecord`/`personLabel` so they cannot drift into saying different amounts about the
  same person. None of it reaches the filter engine: `reporter`/`assignee` predicates read the
  issue payload, so hiding someone never changes which tickets are fetched.
- An anonymous comment is headed by its date alone. There is no `Anonymous` placeholder — it would
  read as a real display name, and absence is already spelled by absence everywhere else.
- Exit codes: `0` success · `1` runtime error · `2` usage/config error · `3` nothing written because
  everything was filtered. Partial runs resolve in that order — **any ticket written → `0`**.
