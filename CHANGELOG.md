# Changelog

What changes between releases of the GitHub Pull Requests plugin, for the people who use it and the
workspaces that recommend it. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); a release is the tag `v<version>`,
the version in `rim-plugin.json` and in `package.json`.

## How entries are written

- A pull request that changes what a user or a workspace sees adds its line under `Unreleased`
  in the same pull request. Refactors, tests and internal documentation do not.
- Each line goes under one heading: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or
  `Security`. It says what changed for the reader, not how it was built.
- A change to the plugin's permissions or commands names them: a new permission makes every
  install ask again.
- At release time `Unreleased` becomes `## [<version>] - <YYYY-MM-DD>` and a new empty
  `Unreleased` starts above it.

## [Unreleased]

### Added

- A **GitHub token** setting, optional and secret, in the desktop app only: with your own token
  GitHub allows 5,000 requests an hour instead of 60. The desktop keeps it in its encrypted
  secret vault on the device and the plugin sends it only to `api.github.com`; the web app has
  no secret settings, so the plugin runs without a token there. A token that cannot be sent is
  named in the panel. The panel's foot opens the settings. No new permission is asked for.

### Changed

- When GitHub's hourly limit is used up, the message says how to add a token in the desktop
  app, or that the saved one could not be read while the desktop's secret vault is locked. A
  token GitHub rejects is named as the reason instead of an error per repository.

## [0.0.1] - 2026-10-16

### Added

- The GitHub Pull Requests plugin, first released from its own repository. It lists the open
  pull requests of up to 10 public GitHub repositories in its **Pull requests** panel, with
  the commands **Pull requests: Refresh**, **Add repository** and **Remove repository**. It
  talks only to `api.github.com` and `avatars.githubusercontent.com`, without a token.
- A new list starts with the project's own repositories, `rim-platform/rim-ui` and
  `rim-platform/rim-server`, until you save one of your own.
- The repository holds the built plugin at its root (`rim-plugin.json`, `main.mjs` and
  `panels/`), so the desktop installs it from its git URL; each release attaches a
  `.rimbundle` for Install from link.

[Unreleased]: https://github.com/rim-platform/plugin-github-prs/compare/v0.0.1...master
[0.0.1]: https://github.com/rim-platform/plugin-github-prs/releases/tag/v0.0.1
