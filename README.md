# GitHub Pull Requests

A [RIM](https://github.com/rim-platform) plugin that lists the open pull requests of up to 10
public GitHub repositories in a panel: title, author, age and whether it is a draft. It starts
with the project's own repositories, `rim-platform/rim-ui` and `rim-platform/rim-server`; add
and remove repositories as you like. It is a `WebSandboxed` plugin built on
[`@rim-platform/plugin-sdk`](https://www.npmjs.com/package/@rim-platform/plugin-sdk): it runs in
a sandboxed frame of the app, on the web and on the desktop alike.

## What it asks for

RIM shows the plugin as one that "Runs sandboxed in this app. It cannot read your files, run
programs, or use your RIM session. It reaches RIM only through the permissions below." It asks
for two permissions:

- **Render UI Panels** (`ui.panel`), to show the list in its **Pull requests** panel.
- **Connect to listed sites** (`network.fetch`), so it can send and receive data from
  `api.github.com` (the pull requests) and `avatars.githubusercontent.com` (the authors'
  pictures). The frame's content security policy blocks every other site.

It uses no token, so it sees public repositories only. GitHub allows 60 requests an hour per
IP address without one, so the plugin refreshes on its own every 5 minutes, at most every 2
minutes when you ask, and stops asking and says so when GitHub refuses. Your list of
repositories is kept in the app's plugin store for your account on that device. Until you
change it, the list is the two project repositories; a list you emptied stays empty.

## What it does

| Command                                              | What it does                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| **Pull requests: Refresh** (`refresh`)               | Fetches the open pull requests again. Keybind capable.                      |
| **Pull requests: Add repository** (`add_repo`)       | Adds `owner/name` (or a `https://github.com/owner/name` link), at most 10. |
| **Pull requests: Remove repository** (`remove_repo`) | Removes a repository.                                                       |

The **Pull requests** panel opens next to the tool panel. Add a repository at the top, remove
one with **×**; <kbd>r</kbd> refreshes and <kbd>/</kbd> jumps to the field. The panel has no
links: following one would navigate the panel's frame, which closes it.

## Install

Each way ends the same: RIM shows the plugin and its permissions, you approve them, enable the
plugin and open **Pull requests** from the side rail.

- **Install from git URL** (desktop): Settings → Plugins → Install from git URL, with
  `https://github.com/rim-platform/plugin-github-prs.git`. The desktop takes
  `rim-plugin.json`, the committed `main.mjs` and `panels/` from the checkout and leaves the
  rest of the repository out.
- **Install from link** (web and desktop): Settings → Plugins → Install from link, with the
  link a [release](https://github.com/rim-platform/plugin-github-prs/releases) gives:
  `https://github.com/rim-platform/plugin-github-prs/releases/download/v<version>/chat.rim.github-prs-<version>.rimbundle#sha256=<hash>`.
  The app checks that the bundle hashes to the value after `#sha256=` before it installs
  anything. Install from link with a GitHub release asset works on the desktop
  once it fetches links natively (a rim-ui issue); in the browser, install from a workspace
  registry or from a host that sends CORS headers.
- **Workspace registry**: when a workspace recommends or requires the plugin, the command
  palette's "Workspace plugins" offers it with its publisher's signature, and a required one
  is offered when the workspace opens. The app verifies the signed statement before it
  installs the exact version the workspace pinned.

## Develop

Node 22.18 or newer.

```sh
npm ci                 # install the SDK, esbuild and the test tools
npm test               # the plugin over a MessageChannel with a pretend GitHub, and the panel in jsdom
npm run typecheck      # tsc with the strict settings plugins use
npm run lint
npm run format:check
npm run build          # bundle src/main.ts into main.mjs; commit the result
npm run check          # main.mjs and panels/ match a fresh build, as CI checks
npm run bundle         # dist/chat.rim.github-prs-<version>.rimbundle, and its sha256
```

```text
rim-plugin.json   the manifest the app installs by
main.mjs          the built plugin, committed; npm run build writes it
panels/prs/       the panel page (plain HTML and JS, rendered with textContent only)
src/main.ts       the entry the build starts from
src/plugin.ts     the commands, the stored list, the refresh rules and the panel state
src/github.ts     the GitHub REST calls and what GitHub's refusals mean
```

A release is a tag `v<version>` matching the version in `rim-plugin.json` and `package.json`,
with a section for it in `CHANGELOG.md`. `CONTRIBUTING.md` has the rules for a pull request.

## License

Apache License 2.0, see `LICENSE` and `NOTICE`.
