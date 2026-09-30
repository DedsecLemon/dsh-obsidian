**English** · [中文](INSTALL.zh-CN.md)

# Installing on another machine

This plugin **needs no build**: `index.mjs` and `client.js` are the source that runs
directly, so copying the folder over is enough.

## 1. Put the folder in place

Keep the whole `dsh-obsidian` folder somewhere stable, for example:

- Windows: `D:\skill\dsh-obsidian`
- macOS / Linux: `~/dsh-obsidian`

**Avoid non-ASCII characters and spaces in the path** if you can — that skips a
whole class of trouble.

## 2. Hook it into a DSH profile

A DSH plugin hangs off a **profile**; dropping it into a directory is not enough. Edit:

```
~/.dsh/profiles/<your profile>/package.json
```

**a)** Add a line to `dependencies` (with **your own** path):

```json
"dsh-obsidian": "link:D:/skill/dsh-obsidian"
```

**b)** Add the package name to the top-level `bundles` array (create the field if it
does not exist):

```json
"bundles": ["dsh-obsidian"]
```

**c)** Run this in that profile directory:

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
| `sessions` + `workspaces` | Only the **conversation box at the foot**; the tree, search and note pages work as usual |
| `uiWorkspace` | The folder picker will not open; set the path by hand instead |
| The host service `webServer` | No HTTP route registers, so the panel has no data |
| Obsidian installed on this machine | Only "open in Obsidian" is unavailable; nothing else is affected |

The first two are past scars: naming a service in `inject` that the profile does not
hand out keeps the **whole entry** from activating, and `apply` is never called at
all.

## node_modules is not needed

`node_modules` is needed only by the three harnesses under `test/`. **You need
`pnpm install` only to run the tests.**

```
cd dsh-obsidian
pnpm install
node test/render-check.cjs     # client half: seats/registrations/render + the guards
node test/mount-check.cjs      # a real jsdom mount: tree, note page, drag, search, first run
node test/host-check.mjs       # host half: every HTTP route + the security boundary
```

> `host-check` reads and writes the **real state files**
> `~/.dsh/dsh-obsidian/{chat,vault,diag}.json`. It backs them up and restores them
> itself, putting them back exactly as they were — **do not delete these files by
> hand**.

### Why CI runs only the first two harnesses

- `render-check.cjs` and `mount-check.cjs` are completely self-contained — the host
  is stood in for by a fake `fetch`, so they need no real vault — and therefore
  **run in CI**.
- `host-check.mjs` drives the real HTTP routes and asserts things about **what one
  particular vault contains** (that a given `README.md` exists, that a wikilink
  resolves, that a note over the read cap is truncated), so it is **local only**.
  Running it in CI would be testing the fixture, not the plugin.
- Setting `DSH_OBSIDIAN_APP` lets it run in full (102 checks). Without it, the three
  checks that depend on where Obsidian is installed are explicitly marked **skip**,
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
| `chat.json` | The Session id of the conversation box (the history lives or dies with it) |
| `diag.json` | The client half's own self-check report (what registered, whether anything failed to render) |

**After copying to a new machine it is completely fine for these files not to
exist** — the first launch asks again which vault to use.
