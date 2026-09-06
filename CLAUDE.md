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
deno task dev config-file             # which config file a run in this repo would read
deno task dev setup                   # the interactive menu (needs a real terminal)
deno task mcp                         # the MCP server from source, on stdio
deno task check                       # typecheck + lint + fmt --check + assert the JSON Schema is current
deno check test/                      # `check` covers src/ and scripts/ only — tests need this separately
deno task lint
deno task fmt
deno task test                        # or: deno test -A
deno task verify:filters              # filter scenarios against the REAL site; needs credentials
deno test -A --filter "excludes anonymous reporter"   # single test by name
deno test -A src/adf/to_markdown_test.ts              # single test file
deno task schema                      # regenerate schema/jira-fetch.schema.json
deno task types                       # regenerate src/jira/schema_types.ts from spec/
deno task vendor:spec                 # re-fetch the Atlassian schemas into spec/ (the only networked task)
deno task build                       # host binary -> dist/
deno task build:all                   # all six release targets
deno task npm:pack                    # stage the npm packages in dist/npm
deno task hooks                       # once per clone: enable the commit-msg hook
deno task commitlint --from <rev>     # lint the commit messages after <rev>
deno task changelog                   # regenerate CHANGELOG.md from the history
deno task release patch               # bump, changelog, commit, tag, push, build, publish
deno task release patch --no-publish  # stop at the tag
deno task publish                     # push, build, checksum, attach to a release, publish to npm
```

The suite needs no credentials and no network — `test/e2e_test.ts` drives the whole CLI against a
fake Jira on localhost, which is what covers the wiring in `src/main.ts`.

**The suite is sealed, and `run` is what seals it.** `run(argv, deps)` takes `projectRoot` and
`configDir`; when they are given they are used **verbatim** — no walk for `.git`, and `$HOME` /
`%APPDATA%` are never consulted. `withJira` in `test/e2e_test.ts` passes both and writes a real
config file for a temp project root, so nothing resolves the developer's own configuration.

That is load-bearing rather than tidy, and the hazard moved rather than went away. It used to be
`.env` files found by walking upward past a real `JIRA_API_TOKEN`. It is now the derived path: an
unsealed run works out which git repository it is in and reads
`$HOME/.config/jira-fetch/users_<you>_code_jira-fetch.yml`, which is this repository's real
configuration, token included. Nothing asserts the token, so a leak would not turn the suite red;
it would just quietly stop being hermetic. **Any new entry point that calls `run` from a test must
pass both.**

The same file is why **`deno task dev` is live-fire in this repo**: it resolves the real
configuration for this checkout, so it talks to the real site.

The fake-Jira-on-localhost approach works at all only because `normalizeBaseUrl`
(`src/config/config.ts`) permits plain http for loopback hosts. Tightening it to https-only fails
every e2e test with exit 2, far from the change.

**`deno compile` bakes permission flags in at build time.** `PERMISSIONS` in `scripts/build_all.ts`
is the single source of truth and must stay identical to the `--allow-*` string in the `dev` task in
`deno.json`, or the shipped binary behaves differently from `deno run` — a bug that only appears
after distribution.

`deno task verify:filters` (`scripts/verify_filters.ts`) is the one thing that talks to a real Jira
site, and it is **not** part of `deno test -A` — that suite is sealed. It runs allow/deny/both
scenarios through `createSession`, and decides what each _should_ keep with a deliberately dumb
oracle written in that file, which imports nothing from `src/filter/`. Agreement between the two is
the evidence; hardcoding the expected keys would only prove the site had not changed. It skips
cleanly (exit 0) without credentials. Keep request-economy assertions — "this was never fetched" —
in the sealed suite instead: only `test/fake_jira.ts` records what went on the wire.

No CI: `deno task check` and the suite run locally. Release binaries are cross-compiled and
attached to a GitHub release by `deno task publish`, from a developer's machine — see Releases.

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
`CHANGELOG.md`, commits `chore(release): vX.Y.Z`, creates the annotated tag — and then pushes,
cross-compiles and publishes. It refuses a dirty tree and runs `deno task check` before committing.
`--no-publish` stops at the tag.

**Publishing is `scripts/publish.ts`, and it is a task of its own on purpose.** Cross-compiling six
targets is the step most likely to fail, and when it does the fix has to be `deno task publish`
again rather than a bumped, tagged version with nothing behind it. So every step is idempotent up
to `gh release create`, which is the one thing that refuses to happen twice — it fails when a
release for the tag already exists rather than adding to it.

Its preflight runs before anything leaves the machine: `gh` installed and authenticated, clean
tree, the tag pointing at `HEAD`, no existing release, and a `CHANGELOG.md` section for the version
(otherwise the release notes would be empty, which means `release.ts` did not make this tag). The
`gh` half of that is exported as `assertCanPublish` and called by `release.ts` _before_ it bumps
anything, so a missing `gh` never leaves a tag to unpick.

Release notes are the changelog section plus an install block built from `TARGETS`, so the platform
table cannot drift from what was compiled. That block carries the `xattr -d com.apple.quarantine`
line: **the macOS binaries are unsigned and unnotarised**, so Gatekeeper refuses to open them
otherwise. `SHA256SUMS` is digested in Deno rather than by shelling out to `shasum`, which is not
on every platform a release might be cut from.

`CHANGELOG.md` is generated, never hand-edited — a careless subject line becomes a careless
changelog entry. Non-conventional subjects are not silently dropped; they collect under "Other".
`deno task changelog --check` verifies a release commit carries a current file; it is deliberately
not part of `deno task check`, which would then fail on every unreleased commit.

**The version string lives in two files**: `deno.json` and `VERSION` in `src/cli/args.ts`, which
`--help` prints. Nothing at type level can hold them equal, so `scripts/release.ts` owns both and
refuses to start when they have drifted — the same class of hazard as `PERMISSIONS` above.

### npm is the install channel, and its publish is the one step that cannot be undone

`jira-fetch` is published to npm as seven packages (`scripts/npm_package.ts`): six platform
packages holding one compiled binary each and declaring the `os`/`cpu` npm matches against, plus
the `jira-fetch` package a user installs, which lists all six as `optionalDependencies` so exactly
one binary is downloaded. Its `bin` is a generated Node shim that resolves its platform sibling and
`spawnSync`s it with `stdio: 'inherit'`.

**npm ships the compiled binary, and that is why this channel is safe.** Permissions are baked in
by `deno compile`, so `PERMISSIONS` in `scripts/build_all.ts` stays the single source of truth for
what the MCP server may do. `deno install`/JSR would hand that decision to whatever `--allow-*`
flags the installing user typed, which is why this is not on JSR: convenience is not worth making
the permission set unknowable.

Three things about the shim are load-bearing, and `scripts/npm_package_test.ts` pins each:

- **It writes to stderr only.** Under `jira-fetch mcp` stdout is the JSON-RPC stream, and one line
  from the wrapper would corrupt the session far from its cause.
- **It forwards the exit code verbatim** (`status === null ? 1 : status`) and re-raises a signal
  rather than translating it. Exit 2 and 3 are part of the output contract; a wrapper that returned
  0 for them would be invisible until it mattered.
- **It contains no backtick**, because it is a JavaScript program embedded in a TypeScript template
  literal. One in a comment closed the literal early and broke the module; the test now refuses it.

`TARGETS` in `scripts/build_all.ts` carries `os` and `cpu` in npm's vocabulary for this, so the
platform matrix is still declared once. The manifests and the shim are **generated, never
hand-edited** — the same rule as `CHANGELOG.md` and `schema/jira-fetch.schema.json`.
`deno task npm:pack` stages them into `dist/npm` for inspection without publishing.

**`publishNpm` runs last in `scripts/publish.ts`, deliberately.** Everything before it can be
re-run; a published npm version cannot be unpublished after 72 hours and can never be republished,
so a bad shim in 0.5.1 is permanent and the fix is 0.5.2. It skips what the registry already has,
and that probe compares `npm view`'s **output** to the version rather than its exit status: for a
package that exists without that version, `npm view` exits 0 and prints nothing, so a `succeeds`
probe would read a missing version as a published one and silently skip the publish — passing the
first time, when everything still 404s.

`NPM_SCOPE` in `scripts/npm_package.ts` is the npm account the platform packages publish under, so
`assertCanPublish` checks `npm whoami` against it — again on the output, since being logged in as
somebody else also exits 0.

**Publishing authenticates with `NPM_TOKEN`, through the repository's `.npmrc`.** That file holds
the reference `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` and never the value, so it is safe to
commit; the token itself is a granular one scoped to these packages, kept in the gitignored
`.env.local` and loaded by direnv (`.envrc`). `assertCanPublish` refuses when `NPM_TOKEN` is unset,
because npm would otherwise send the literal string `${NPM_TOKEN}` and fail with an unauthorised
error that says nothing about why. A granular token needs no one-time code, so this is the normal
path and the one below is the fallback.

**GitHub Packages is not an option for this, despite hosting an npm registry.** Its npm registry
requires a GitHub token to _install_ from, even for public packages, and the scope must match the
owner — so `npm i -g jira-fetch` would become "add a registry line to your .npmrc, mint a token,
then install `@casaper/jira-fetch`". That is the opposite of the point. It suits private org-internal
packages; a public CLI belongs on npmjs.org.

**Without a token: one code per package, from `JIRA_FETCH_NPM_OTP`.** Set it to a command that
prints the current one-time code and `publishNpm` runs it before each publish:

```sh
export JIRA_FETCH_NPM_OTP='pass-cli item totp --output=json pass://pers/npmjs.com/totp | jq -r .totp'
```

Per package, not once: a TOTP is single-use, and seven packages of ~35 MB span several 30-second
windows anyway. When two publishes fall inside one window the same digits come back, so `nextOtp`
waits for the next window rather than handing npm a code it has already rejected — and that wait is
**bounded** (`OTP_ATTEMPTS`), because the unbounded version hangs the release for ever the moment
the command stops advancing. It throws rather than calling `fail` so the loop is testable at all;
`publishNpm` turns that back into a clean exit 2. Unset, npm prompts for itself, which works only
because `run` inherits stdin.

That check belongs behind `release.ts`'s `if (publishing)` gate and must stay there. `npm whoami`
is a **network** call, and `--no-publish` exists to stop at a local tag when cross-compilation
fails; making it depend on the registry being reachable would break the one path whose whole point
is that it needs nothing but this machine. `publish()` runs the same preflight itself, so a
standalone `deno task publish` is still checked.

## Layout

```
src/main.ts             orchestration; owns the exit codes and the mode dispatch
src/cli/args.ts         flag parsing and --help
src/config/schema.ts    Zod schemas — the single source of truth (see below)
src/config/location.ts  where a project's config file is — git root, slug, config dir
src/config/config.ts    reading and resolving that one file
src/setup/              the `setup` menu, the config writer, the Claude Code deny rules
src/jira/client.ts      auth, retry, and every REST call
src/filter/rules.ts     compiles validated rules into their runtime form
src/filter/evaluate.ts  the three filter stages
src/adf/to_markdown.ts  ADF -> Markdown
src/fetch/session.ts    the per-issue pipeline, shared by the CLI and the MCP server
src/mcp/server.ts       the MCP server: two read tools and nothing else
src/assets/download.ts  filename sanitising, the attachment manifest, downloads
src/document/           frontmatter + document assembly
scripts/                build matrix, JSON Schema generation, commit lint, changelog, release
spec/                   vendored Atlassian schemas, pinned (see below)
```

Tests are colocated as `*_test.ts`; fixtures live in `test/fixtures/`, and the fake Jira both
end-to-end suites drive is `test/fake_jira.ts`.

## Configuration is derived, never discovered

There is one config file per project and it is the **only** source of credentials and policy.
`src/config/location.ts` computes where it is; `src/config/config.ts` reads it. Nothing searches
for anything.

```
findProjectRoot(cwd)  ->  nearest ancestor with a .git entry, canonicalised
projectSlug(root)     ->  users_you_code_thing
configPathFor(...)    ->  $HOME/.config/jira-fetch/users_you_code_thing.yml
                          %APPDATA%\jira-fetch\... on Windows
```

Resolution is `--out` > `out:` in the file > cwd, and that is the whole of it — `--out` is the only
flag that still overlaps a config key. There is no environment layer, no `.env`, no `--config`,
`--token`, `--base-url` or `--email`, and no `.yaml`/`.json` spelling.

**This is the feature, not the plumbing.** `jira-fetch mcp` claims an agent's access is decided by
a file it does not control, and discovery-by-closeness meant it very nearly was not: an agent that
could write in the project did not need to edit a committed `.jira-fetch.yml`, because _creating_
one with empty filters in the directory the server started from shadowed it, the nearest file
winning outright. An exported `JIRA_API_TOKEN` made the question moot anyway. Do not reintroduce
any of it — not a `--config` escape hatch "for testing" (that is what `RunDeps` is for), not an
environment override "for CI", not a project-local file "for team defaults". Each one is the
bypass, restored.

**`findProjectRoot` walks for `.git` instead of running `git rev-parse --show-toplevel`**, and must
keep doing so. Spawning git needs `--allow-run`; `deno compile` bakes permissions in at build time
with no per-subcommand grant, so the MCP server binary would gain the ability to spawn processes.
It matches `.git` as a file as well as a directory (worktrees, submodules) and ignores `GIT_DIR` /
`GIT_WORK_TREE`, which are environment overrides of the thing this exists to make underivable. It
**canonicalises** its result, because `Deno.cwd()` reports `/private/var` on macOS where an
argument may carry `/var`, and a filename derived from the path must not depend on which symlink
you arrived through.

**`projectSlug` is not injective and the `project` key is the guard.** `/a/b_c` and `/a_b/c` land
on the same filename; `assertProjectMatches` compares the file's `project` against the repository
in hand and throws `ConfigError`. Do not soften that to a warning — running under another
project's filters is the failure the whole layout exists to prevent, and the same reasoning applies
here as for `makeFieldResolver` below. The slug is a pure string transform that deliberately does
not resolve its argument, so a Windows path slugs identically on every host and the rules are
testable without a Windows runner.

`PERMISSIONS` is now `--allow-net --allow-env=HOME,APPDATA,USERPROFILE --allow-read --allow-write`.
Those three variables locate the config directory and are the only environment reads left. The
narrowing can only fail at runtime, so the subprocess test in `test/mcp_test.ts` runs the real
server under exactly that set — keep it in step with `PERMISSIONS` and `deno.json`.

## Setup writes files outside the repository, and only when asked

`src/setup/` has three parts, split so that the two that can be tested are.

- **`config_file.ts`** composes and writes the config: validated through the loader's own
  `parseConfigFile`, so `setup` cannot produce a file the tool would refuse. Modes are passed at
  **creation** (`0700` directory, `0600` file) rather than chmod'ed afterwards — a chmod after the
  write leaves a window where a file holding a token is world-readable. `repairMode` then fixes
  anything that already existed. Windows is skipped: `%APPDATA%` already carries the equivalent ACL.
- **`claude_settings.ts`** merges Claude Code deny rules. It **preserves every other key** — these
  files carry the user's own `allow`, `ask`, `hooks`, `enabledPlugins` — appends only missing
  rules, and refuses to rewrite a file it could not parse, naming the rules to add by hand instead.
  Config-directory denies go to `~/.claude/settings.json` (user scope, because a deny at any scope
  beats an allow at any other, and one write covers every project); the `setup` deny goes in the
  project so a teammate sees it.
- **`tui.ts`** is the menu, and is kept thin because a menu cannot be driven by the suite. It
  refuses without `Deno.stdin.isTerminal()` — an agent's shell has no controlling terminal, which
  is a real barrier at zero permission cost and **not** a boundary; say so rather than implying
  otherwise. It spawns nothing: "open it in your editor" would cost `--allow-run` in every binary,
  the MCP server included, so it prints the path.

Only `setup` writes any of this. `fetch` and `mcp` must never touch Claude Code configuration — a
Jira fetcher rewriting permission files on every run would fight the user's own edits.

`space` is `promptSelect`'s selection key, so a scripted pty test cannot use a filter string
containing one. That cost an hour; it is written down here so it costs nobody else one.

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

**Stage 1 rules include rules out, rather than ruling them in.** A rule whose `project` predicate
the key fails can never match — every predicate in a rule must hold, so the rest cannot rescue it —
which means the ticket is unreachable when _every_ include rule fails that way. That is stronger
than the older "every include rule is project-only" test, and it is what keeps
`include: [{project: [DN], labels: [x]}]` from fetching a SUP ticket in full before discarding it.
Under the MCP server it is also the difference between denying a ticket and reading it with the
user's credentials on the way to denying it.

**An unresolvable or ambiguous field name is a `ConfigError`, thrown by `makeFieldResolver`
(`src/fetch/session.ts`) before a single issue is fetched.** It used to be a warning, and the
asymmetry is why that was wrong: an unresolvable name in an `exclude` rule matches nothing, so the
rule **denies nothing**, silently — and `Team` and `Teams` can both exist on one site. In an
`include` rule the same name denies _everything_, equally silently. Jira Cloud also permits two
custom fields with the same display name (the development site has four such pairs), so resolving
by name has to refuse the ambiguity rather than take whichever the API listed last; the error names
the ids, and a raw id always resolves unambiguously. Do not soften this back into a warning on the
grounds that a config might be shared across sites — the same block is what an agent's access is
decided by.

`field` predicates reach **built-in** fields too, since `GET /rest/api/3/field` lists them:
`Status`, `Issue Type`, `Components`, `Priority` and so on all work, which is why there are no
separate `type`/`status` predicates. `deno task verify:filters` exercises exactly that against the
real site.

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

## The MCP server

`jira-fetch mcp` (`src/mcp/server.ts`) exists for one reason: **an agent's access to Jira is decided
by the config file, not by anything it can be told or talked out of.** Every rule below serves that,
so none of them is cosmetic.

- **stdout is the protocol.** One stray line corrupts the JSON-RPC stream and the session dies far
  from its cause. `src/fetch/session.ts` is shared with the CLI and writes nothing to stdout —
  keep it that way; `src/main.ts` additionally replaces `console.log` with a **throw** in this mode,
  deliberately not a redirect to stderr, because a redirect would launder a leak into something
  `test/mcp_test.ts`'s subprocess purity check cannot see.
- **Nothing about a denied issue reaches the client.** `Outcome.reason` is
  `matched exclude rule ${JSON.stringify(rule)}` — the string _is_ the serialised policy — and a
  stage-2 denial is decided with the whole payload in hand. `record()` reads `key` and `status` and
  nothing else; that is why the formatting lives in one function.
- **Denied, 404 and 403 are one message**, `UNAVAILABLE`. Answering differently would let a client
  map the deny-list by probing keys and watching which reply comes back. Jira's own API conflates
  them ("Issue does not exist or you do not have permission to see it"), so this follows upstream
  rather than inventing something weaker. Do not "improve" it into a more helpful error.
- **`allowJql: false` un-registers `search_issues`** rather than refusing it when called. Absent
  from `tools/list` is the same kind of guarantee as having no write tool at all.
- **Tool annotations are hints, not the boundary.** `readOnlyHint` is `false` and that is honest:
  these tools are read-only against _Jira_ but they write files. The boundary is that no write tool
  is registered. Do not set it to `true`.
- **No tool takes a path**, and the output directory is fixed at startup. A path parameter would
  hand back exactly the control this mode exists to remove.
- **Keys are shape-checked** against `ISSUE_KEY` from `src/cli/args.ts`, because an unvalidated key
  is interpolated straight into `GET /rest/api/3/issue/{key}`.
- **A denied issue gets no file.** An earlier design wrote a stub `<KEY>.md`; it was dropped because
  the output contract overwrites unconditionally, so a stub would destroy a real document written
  under a looser config.

**Where the config lives is part of the feature.** The code guarantee — filters decide access —
holds only because the file carrying them is one the agent does not control, and that is now a
property of `src/config/location.ts` rather than of an invocation someone has to get right. See
_Configuration is derived, never discovered_ above: there is nothing to pass, so
`claude mcp add --scope user jira-fetch -- jira-fetch mcp --out docs/jira` is the whole of the
recommended setup and the README says so. `--scope user` is still worth keeping — it puts the
launch command outside the tree the agent edits — but no part of the guarantee depends on it any
more.

`jira-fetch setup` offers Claude Code deny rules for the config directory. Those are a speed bump
and both the README and `src/setup/claude_settings.ts` say so in those words: `Read` rules do not
reach a script that opens the file itself, and an agent with a shell can edit the settings files
too. Do not let that language drift into implying a sandbox. The only hard boundary is what the
API token may see on Atlassian's side.

`serveMcp` constructs the transport itself rather than letting `serveStdio` do it. `serveStdio`
overwrites the transport's `onclose` and does not close it when stdin ends — the process merely runs
out of work, which `Deno.exit(await run())` turns into "top-level await promise never resolved" and
a non-zero exit. Owning the stream gives one honest signal for "the client went away". The server
also stops the moment stdin ends, so a test must hold the pipe open until its replies arrive.

`npm:@modelcontextprotocol/server` (v2), not `@modelcontextprotocol/sdk` (v1): two transitive
dependencies against express, hono, jose, ajv and cross-spawn for HTTP transports this never uses,
and — the deciding point — **it needs no permission beyond the four already baked in**. `deno
compile` bakes permissions at build time and there is no per-mode grant, so anything this mode
needed the CLI binary would carry too.

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
- The frontmatter's `assets` is a list of **relative path strings**, not records. The filename is
  the tail of the path, and mime type and size are properties of a file sitting right there beside
  the document; restating them in the frontmatter is a copy that can only go stale.
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
  recursion means nested records go ragged, so `parent` may be just `{ key }` when Jira sent
  nothing else about it.
- **What the document says about people is configurable**, through the `people` block and
  `src/document/people.ts` — `roles` decides who appears (`reporter`, `assignee`, `commenter`;
  empty omits all of them), `fields` decides what is recorded about them, and `nameFormat:
  initials` shortens a display name in the frontmatter and in comment headings alike. Both paths go
  through `personRecord`/`personLabel` so they cannot drift into saying different amounts about the
  same person. None of it reaches the filter engine: `reporter`/`assignee` predicates read the
  issue payload, so hiding someone never changes which tickets are fetched.
- Comment headings carry `YYYY-MM-DD HH:MM`, trimmed textually from Jira's stamp so it keeps the
  wall-clock time the commenter saw rather than shifting to the fetching machine's timezone. The
  full stamp stays in the frontmatter's `created_at`/`updated_at`.
- An anonymous comment is headed by its date alone. There is no `Anonymous` placeholder — it would
  read as a real display name, and absence is already spelled by absence everywhere else.
- Exit codes: `0` success · `1` runtime error · `2` usage/config error · `3` nothing written because
  everything was filtered. Partial runs resolve in that order — **any ticket written → `0`**.
