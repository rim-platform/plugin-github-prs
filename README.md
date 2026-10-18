# GitHub Pull Requests

A [RIM](https://github.com/rim-platform) plugin that lists the open pull requests of up to 10
GitHub repositories in a panel: title, author, age and whether it is a draft. It starts
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

Reading its own settings needs no permission. Without a token it sees public repositories
only, and GitHub allows 60 requests an hour per IP address; with [your own token](#a-github-token)
it allows 5,000 an hour. Either way the plugin refreshes on its own every 5 minutes, at most
every 2 minutes when you ask, and stops asking and says so when GitHub refuses. Your list of
repositories is kept in the app's plugin store for your account on that device. Until you
change it, the list is the two project repositories; a list you emptied stays empty.

## A GitHub token

The plugin has one setting, **GitHub token**, which is optional. Open it from the plugin's
row in Settings → Plugins (**Settings**), from its row in the side rail's **Plugins** menu, or
from **settings** at the foot of the panel. To make a token:

1. On GitHub, open Settings → Developer settings → Personal access tokens → Fine-grained
   tokens → Generate new token.
2. Give it a name and an expiry. Under **Repository access**, **Public repositories** is
   enough for public repositories: the token can then read them and nothing else.
3. To list the pull requests of private repositories too, pick **Only select repositories**
   with those repositories and, under **Permissions**, give **Pull requests** read-only
   access (GitHub adds **Metadata** read-only on its own). The plugin only reads; never give
   it write access.
4. Generate the token and paste it into the field. A classic token (`ghp_…`) works too, with
   no scopes for public repositories.

Where it is kept:

- **On the desktop** the token is kept in the app's secret vault, for your account on that
  device. It is never synced or sent to the RIM server, the form shows only that it is set,
  and uninstalling the plugin deletes it. The plugin sends it to `api.github.com` alone, as
  `Authorization: Bearer`, and never puts it in a message, the panel or the log.
- **In the web app** there is no secret vault, so the field says it needs the desktop app and
  the plugin runs without a token there.

When GitHub's limit is used up, the panel says what you can do: add a token, unlock the
desktop's secret vault if it holds one that could not be read, or wait until the time it
names. When GitHub rejects the token (expired, revoked), the panel says so; replace or clear
it in the settings, and the plugin fetches again at once.

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
