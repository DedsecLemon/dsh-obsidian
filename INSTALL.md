**English** · [中文](INSTALL.zh-CN.md)

# Installing on another machine

This plugin **needs no build**: `index.mjs` and `client.js` are the source that runs
directly, so copying the folder over is enough.

## 1. Get the code

Clone or download this repository and keep the folder somewhere stable, for example:

- Windows: `D:\skill\dsh-obsidian`
- macOS / Linux: `~/dsh-obsidian`

The folder name does not matter — the plugin's identity comes from `package.json`, whose
package name is **`dsh-obsidian-panel`** (the project is `dsh-obsidian`, and it is **not on
npm**; see the naming note in the README). **Avoid non-ASCII characters and spaces in the
path** if you can — that skips a whole class of trouble.

## 2. Hook it into a DSH profile

A DSH plugin hangs off a **profile**; dropping it into a directory is not enough. Edit:

```
~/.dsh/profiles/<your profile>/package.json
```

The bundle list lives at **`dsh.profile.bundles`** — a **nested** field, **not** a top-level
`bundles`. That distinction matters: a top-level `bundles` (or a missing one) leaves the
dependency installed but the bundle **never mounts**, so the plugin is simply absent with no
error anywhere. The whole file, ready to copy (put in **your own** path; keep any fields the
profile already has):

```json
{
  "dependencies": {
    "dsh-obsidian-panel": "link:D:/skill/dsh-obsidian"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-obsidian-panel"]
    }
  }
}
```

Then run this in that profile directory:

```
pnpm install
```

> Alternatively, let the AI inside DSH do it: tell it "use `plugin_manager` to install
> `link:<your path>` as a bundle".
> Install logs are under `~/.dsh/profiles/<profile>/.plugin-manager/logs/`.

## 3. Restart DSH

- Changed `index.mjs` (the **host half**) → you must **restart the process**
- Changed only `client.js` (the **client half**) → a page refresh is enough

Once it is installed, `知识库` (Knowledge Base) appears at the foot of the left
Sidebar.

## 4. First run

Open `知识库` and it first asks you to **choose a vault folder** (it pre-detects the
vaults Obsidian has already registered). Only then does the tree appear — until you
confirm a folder it reads **nothing**.

## Requirements (and what is missing without them)

| What it needs | What is missing without it |
|---|---|
| The client services `slots`, `sidebarRightTabs`, `sidebarRight` | **The entire plugin does not activate** (no entry anywhere in the left Sidebar) |
| `sessions` + `workspaces` | Only the conversation: the tree, the note page and the outline work as usual, and `对话` says so |
| `uiWorkspace` | The folder picker will not open and `对话` cannot navigate — set the path by hand instead |
| The host service `webServer` | No HTTP route registers, so the panel has no data |
| Obsidian installed on this machine | Only "open in Obsidian" is unavailable; nothing else is affected |

The first two are past scars: naming a service in `inject` that the profile does not
hand out keeps the **whole entry** from activating, and `apply` is never called at
all.

## node_modules is not needed

`node_modules` is needed only by the harnesses under `test/`. **You need
`pnpm install` only to run the tests.**

```
cd dsh-obsidian
pnpm install
node test/render-check.cjs     # client half: registration, render, guards
node test/mount-check.cjs      # a real jsdom mount: tree, note page, outline, edit mode, first run
node test/manifest-check.mjs   # the contract declared in package.json
node test/platform-check.mjs   # per-platform Obsidian locations, registry path and URI opener
node test/host-check.mjs       # host half: every HTTP route + the security boundary
node test/profile-lifecycle.mjs  # install → start → uninstall in a throwaway profile (docs/LIFECYCLE.md)
```

> `host-check` reads and writes the **real state files**
> `~/.dsh/dsh-obsidian/{chat,vault,diag}.json`. It backs them up and restores them
> itself, putting them back exactly as they were — **do not delete these files by
> hand**.

### What CI runs, and what it deliberately does not

`.github/workflows/ci.yml` runs **five** harnesses:

- `render-check.cjs` and `mount-check.cjs` are completely self-contained — the host is
  stood in for by a fake `fetch`, so they need no real vault.
- `manifest-check.mjs` checks the declarations in `package.json` (compatibility,
  permissions, bundle identity).
- `platform-check.mjs` checks the per-platform Obsidian locations, registry path and
  URI-delivery choice as pure functions, so all three systems are asserted from any
  one machine.
- `profile-lifecycle.mjs --skip-host` packs the tarball, installs it into a throwaway
  profile and runs the client half against the installed copy, then uninstalls it.
- `host-check.mjs` is deliberately **not** there. It drives the real HTTP routes and
  asserts things about **what one particular vault contains** (that a given `README.md`
  exists, that a wikilink resolves, that a note over the read cap is truncated), so it is
  **local only**. Running it in CI would be testing the fixture, not the plugin.
- Setting `DSH_OBSIDIAN_APP` lets `host-check` run in full (102 checks). Without it, the
  three checks that depend on where Obsidian is installed are explicitly marked **skip**,
  never passed off as a success.

`.github/workflows/ci.yml` encodes exactly that split, and this section is kept in
step with it.

## State files

```
Windows:     C:\Users\<you>\.dsh\dsh-obsidian\
macOS/Linux: ~/.dsh/dsh-obsidian/
```

| File | Contents |
|---|---|
| `vault.json` | The vault path you chose (outranks Obsidian's registry) |
| `chat.json` | The Session id of the vault conversation (history is resumed from it; `对话` offers "continue or start over" because of it) |
| `diag.json` | The client half's own self-check report (what registered, whether anything failed to render) |

**After copying to a new machine it is completely fine for these files not to
exist** — the first launch asks again which vault to use.
