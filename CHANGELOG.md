# Changelog

Every notable change, grouped by release. Generated from the commit history by
`deno task changelog` — edit the commits, not this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and its commit
subjects follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

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
