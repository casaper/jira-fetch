# Changelog

Every notable change, grouped by release. Generated from the commit history by
`deno task changelog` — edit the commits, not this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and its commit
subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## 0.5.4 — 2026-09-06

### Breaking changes

- keep the project path's case, renaming every config file ([37dfb53](https://github.com/casaper/jira-fetch/commit/37dfb535cba533d541d21c8f4b89fdbc1c25226a))

### Bug Fixes

- **config:** keep the project path's case, renaming every config file ([37dfb53](https://github.com/casaper/jira-fetch/commit/37dfb535cba533d541d21c8f4b89fdbc1c25226a))

### Documentation

- describe only what jira-fetch does, not what it did ([025d299](https://github.com/casaper/jira-fetch/commit/025d299938e58dd93a89eecfe7ec787707d7772a))

## 0.5.3 — 2026-09-06

### Features

- **release:** say the package is an MCP server where npm searches ([841417a](https://github.com/casaper/jira-fetch/commit/841417a702926fca6152faf67e213d7a0de6ce42))
- **release:** publish with a scoped token instead of a one-time code ([4787de2](https://github.com/casaper/jira-fetch/commit/4787de24e7355f594edcda59db7427095ad577b2))

### Bug Fixes

- **config:** build the config path with the target os's separator ([069ccca](https://github.com/casaper/jira-fetch/commit/069cccaee7f5085aa2e3ecb37686ad5f16694b50))

### Documentation

- record what the Windows runner actually found ([9060e7d](https://github.com/casaper/jira-fetch/commit/9060e7dba81cd7e906fdc510aef2c9e8051ea2a3))
- make the README user-facing and move development into CONTRIBUTING ([29e66ce](https://github.com/casaper/jira-fetch/commit/29e66cee6bf5b871fe364b697759cb8a274f7b9e))
- **release:** record how to verify a published release on Linux ([e019542](https://github.com/casaper/jira-fetch/commit/e019542543ecd6b2d209440ea3320b215f7b42d1))

### Tests

- import proc.ts by URL, since a Windows path is not a specifier ([207e34d](https://github.com/casaper/jira-fetch/commit/207e34d4338290cc8a5829ecfd844ba2857a7121))
- give the Windows subprocess a SYSTEMROOT, and keep stderr ([10eabd4](https://github.com/casaper/jira-fetch/commit/10eabd4d06f29008ba31c7cf7295d5c09d7adabe))
- fix the last two Windows failures, in the two subprocess tests ([818c071](https://github.com/casaper/jira-fetch/commit/818c07129ea14e44bc0f91d545d90eeec86c63e7))
- stop assuming POSIX paths, so the suite runs on Windows ([bfcfa88](https://github.com/casaper/jira-fetch/commit/bfcfa8864ad577b742e0326e8f2a232b522d9cb3))

### Build & Tooling

- run check and the sealed suite in GitHub Actions ([abc298a](https://github.com/casaper/jira-fetch/commit/abc298ab7931a801c0aba6302827a95d6263bd94))

### Chores

- remove path overwrite from .envrc ([29575ec](https://github.com/casaper/jira-fetch/commit/29575ecff69e5246a23fe4aa7813c4cd18a249ea))

## 0.5.2 — 2026-09-06

### Features

- **release:** take a fresh npm one-time code per package ([fa00d70](https://github.com/casaper/jira-fetch/commit/fa00d70babbb1efe3647b94b6ce8730c61d87bc1))

### Bug Fixes

- **release:** prompt from a child of run, and resume a half-done release ([b7f7d71](https://github.com/casaper/jira-fetch/commit/b7f7d715787b00b78de2bf7c7f819409bf8142a3))

## 0.5.1 — 2026-09-06

### Features

- **release:** publish jira-fetch to npm ([f4977cb](https://github.com/casaper/jira-fetch/commit/f4977cb2c82305fbce054292cc1f5906353b63a5))
- **scripts:** package the compiled binaries for npm ([fba43ae](https://github.com/casaper/jira-fetch/commit/fba43ae47791a8a021f4619ee245af056fa7a1aa))

### Documentation

- install with npm ([2196b0b](https://github.com/casaper/jira-fetch/commit/2196b0bc743c183b42d64e860cddc6d828010bdb))

### Chores

- load dotenv files with direnv ([436ecf8](https://github.com/casaper/jira-fetch/commit/436ecf87d12eec0c1c438e1cb1c6b2fa1acd0848))
- ignore the plan file ([1d58371](https://github.com/casaper/jira-fetch/commit/1d58371b70cc2868773f31ffd13b8e758a569012))

## 0.5.0 — 2026-09-06

### Breaking changes

- document the config directory ([f7833bc](https://github.com/casaper/jira-fetch/commit/f7833bc6ec1c602a4f86d1036a6c396693aadc7d))
- drop the flags that could override the policy ([11ada29](https://github.com/casaper/jira-fetch/commit/11ada290a5075b348ca089261867e3b3cc326e8a))
- read one config file per project from the user config dir ([9b0fd1c](https://github.com/casaper/jira-fetch/commit/9b0fd1cc36af13301a93c6c81631a4379d3f4f5b))

### Features

- **setup:** configure a project interactively ([811a127](https://github.com/casaper/jira-fetch/commit/811a1271b93527618dfb4471f429a39d84f2ea40))
- **setup:** deny agents access to the config directory ([edf4ab7](https://github.com/casaper/jira-fetch/commit/edf4ab78810787e378b10cb54b9d9875aa2042ac))
- **cli:** print the config file path ([b41f720](https://github.com/casaper/jira-fetch/commit/b41f7206b49075d05b23aee4ecca2561730f9565))
- **cli:** drop the flags that could override the policy ([11ada29](https://github.com/casaper/jira-fetch/commit/11ada290a5075b348ca089261867e3b3cc326e8a))
- **config:** read one config file per project from the user config dir ([9b0fd1c](https://github.com/casaper/jira-fetch/commit/9b0fd1cc36af13301a93c6c81631a4379d3f4f5b))
- **config:** locate a project's config file without reading it ([f00e05c](https://github.com/casaper/jira-fetch/commit/f00e05ca1ecf430a1ad2da749c2272eb2712021a))

### Bug Fixes

- **setup:** refuse to write a deny rule against an unknown home ([b6c8615](https://github.com/casaper/jira-fetch/commit/b6c86157b9315af56dc67f1c32a224fe75195574))

### Documentation

- **config:** document the config directory ([f7833bc](https://github.com/casaper/jira-fetch/commit/f7833bc6ec1c602a4f86d1036a6c396693aadc7d))

## 0.4.1 — 2026-09-06

### Documentation

- **mcp:** document keeping the policy and token outside the project ([588c303](https://github.com/casaper/jira-fetch/commit/588c3038854becf822fc853c97ae791fad282848))

## 0.4.0 — 2026-09-06

### Breaking changes

- refuse a field name this site cannot resolve ([d8d7dec](https://github.com/casaper/jira-fetch/commit/d8d7dec9a8d613ffb6ffd94fad46b75a3db9a143))

### Features

- **filter:** refuse a field name this site cannot resolve ([d8d7dec](https://github.com/casaper/jira-fetch/commit/d8d7dec9a8d613ffb6ffd94fad46b75a3db9a143))
- **mcp:** serve the fetch pipeline as a read-only MCP server ([98ef375](https://github.com/casaper/jira-fetch/commit/98ef37588448ff49eb81406fb868602e09d5e929))

### Bug Fixes

- **mcp:** report what a fetch actually produced, not what it planned ([b25a556](https://github.com/casaper/jira-fetch/commit/b25a55625604690c5c6c1bc9efdbac9143aa971d))

### Refactoring

- **fetch:** extract the per-issue pipeline into a session ([dbc6be3](https://github.com/casaper/jira-fetch/commit/dbc6be357579d1daa687a628f7e4684d09cec610))

### Documentation

- **mcp:** tell the reader to check which config was loaded ([1e29bed](https://github.com/casaper/jira-fetch/commit/1e29bed85437a2b8c15177a2404b07faeecb0a7d))
- **mcp:** document the server and Claude Code setup ([ae0f8e7](https://github.com/casaper/jira-fetch/commit/ae0f8e75a11dec40a3927b26c8bd71b42c0997ac))

### Tests

- **filter:** cover the custom-field path against the real site ([32f66fc](https://github.com/casaper/jira-fetch/commit/32f66fc647c1363536395271e4ead22bfb6caa67))

## 0.3.2 — 2026-09-05

### Breaking changes

- shorten comment heading timestamps ([543348a](https://github.com/casaper/jira-fetch/commit/543348a3ab7dd77f3a3ae5083c65182885ec5e70))
- list assets as paths rather than records ([50f35a4](https://github.com/casaper/jira-fetch/commit/50f35a429e573f305b82c96f4601684bbc331650))

### Features

- **document:** shorten comment heading timestamps ([543348a](https://github.com/casaper/jira-fetch/commit/543348a3ab7dd77f3a3ae5083c65182885ec5e70))
- **document:** list assets as paths rather than records ([50f35a4](https://github.com/casaper/jira-fetch/commit/50f35a429e573f305b82c96f4601684bbc331650))

## 0.3.1 — 2026-09-05

### Features

- **scripts:** publish the GitHub release from the release task ([65f7169](https://github.com/casaper/jira-fetch/commit/65f716983380880694bccb7c780cbce8f2d5ce0a))

## 0.3.0 — 2026-09-05

### Breaking changes

- trim the frontmatter and make people configurable ([9ef0f8f](https://github.com/casaper/jira-fetch/commit/9ef0f8f3b16b186987645694c7da9c529b2d941d))

### Features

- **document:** trim the frontmatter and make people configurable ([9ef0f8f](https://github.com/casaper/jira-fetch/commit/9ef0f8f3b16b186987645694c7da9c529b2d941d))

### Bug Fixes

- **adf:** match media nodes to attachments by filename ([c75f8cd](https://github.com/casaper/jira-fetch/commit/c75f8cdf5a868091de6d811e3027c2c7c416df0d))
- **document:** match Jira's timestamp format and drop copied titles ([96eb6f8](https://github.com/casaper/jira-fetch/commit/96eb6f8ed14fcd118762ad1f7107e2ca4a07bd5d))
- **config:** refuse a credential that is only a variable reference ([b992027](https://github.com/casaper/jira-fetch/commit/b992027a8f947d076b1dcdad6bbadee4c8c57a32))

### Chores

- rename the example config to .yml and add an .envrc ([1ca9e40](https://github.com/casaper/jira-fetch/commit/1ca9e409fcf70da1d36014b9a8aef25e788a2e8a))

## 0.2.0 — 2026-09-05

### Features

- **config:** read .env files and widen config discovery ([185bb65](https://github.com/casaper/jira-fetch/commit/185bb65bbf9c4db7568e45c1e3b36e2e7c79dfc5))

### Bug Fixes

- **schema:** point the schema $id at the published URL ([64705b7](https://github.com/casaper/jira-fetch/commit/64705b74f1d6ef1dbe61b9f5bc30b32b448bd6cc))

### Documentation

- ship a YAML example and explain committing a config ([2ef650d](https://github.com/casaper/jira-fetch/commit/2ef650db2474575b3177d321422d14780dcbbba6))

### Chores

- ignore secret .env.local file ([feef0be](https://github.com/casaper/jira-fetch/commit/feef0be5514408a33aac5462a276bca66f906567))

## 0.1.0 — 2026-09-05

### Refactoring

- **jira:** derive the wire types from Atlassian's schemas ([d58ca3a](https://github.com/casaper/jira-fetch/commit/d58ca3ac2d6fa7ad38c15499e0734e934692cb88))

### Documentation

- record how the Jira types are derived ([6058824](https://github.com/casaper/jira-fetch/commit/6058824067c7a942f78a05dbae7d5246b3b8b014))

### Build & Tooling

- **scripts:** derive Jira and ADF types from vendored schemas ([03ad381](https://github.com/casaper/jira-fetch/commit/03ad381074877d3e7893425e3a75b0b47e2e113e))
- **deps:** vendor the Jira and ADF schemas ([28cbb7d](https://github.com/casaper/jira-fetch/commit/28cbb7d76d7759a078f53ad2efb8656340757557))

## 0.0.1 — 2026-09-05

### Features

- fetch Jira Cloud issues into Markdown documents ([40dfbdb](https://github.com/casaper/jira-fetch/commit/40dfbdb03f059d9b7812da66466fdc9f9087c743))

### Refactoring

- **config:** derive the config-shaped types from the Zod schema ([394cd45](https://github.com/casaper/jira-fetch/commit/394cd45ed95a687cec6c6fb3e6c5cbd82120f8eb))

### Documentation

- correct the documented dev invocation ([4739b3d](https://github.com/casaper/jira-fetch/commit/4739b3dd495c90ebc5ef0366897e5d4e9455390b))
- document the commit convention and the release workflow ([e18aff1](https://github.com/casaper/jira-fetch/commit/e18aff1a30cd72b185dc7ec4dc7c82b43dec5c0f))
- warn that ambient Jira env vars break the e2e suite ([8fda918](https://github.com/casaper/jira-fetch/commit/8fda91806fd322e40ce09660b0a72942a233f55a))
- record the test typecheck gap and the config-type derivations ([1a2bc5a](https://github.com/casaper/jira-fetch/commit/1a2bc5a68349ef85045b6891e9ce64948f215635))
- add the MIT license and a publication-ready README ([eb09dd3](https://github.com/casaper/jira-fetch/commit/eb09dd3d9df9237109c786c861ca85c19764b037))
- record the loopback-http and new-code-only conventions ([97d6b4f](https://github.com/casaper/jira-fetch/commit/97d6b4f3c942ffe04e7359976a221676b0b66ba0))

### Build & Tooling

- add Conventional Commits linting, changelog and release tooling ([d11da0c](https://github.com/casaper/jira-fetch/commit/d11da0cec5c8cba9bc5171aecbdeb669a2e7dd97))
- enforce strict lint and format configuration ([37faf89](https://github.com/casaper/jira-fetch/commit/37faf8903ff432e7e55cc4115418fe0384376482))

### Formatting

- bring the tree into line with the lint and format configuration ([d612d82](https://github.com/casaper/jira-fetch/commit/d612d828f571a941616572e9c2572c8ba8c401da))

### Other

- init claude md ([f0c4d92](https://github.com/casaper/jira-fetch/commit/f0c4d92542baa4c8499c9d8d542818c2ea77ffe7))
