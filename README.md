**English** · [中文](README.zh-CN.md)

# dsh-obsidian

An Obsidian vault inside the DSH right Sidebar. **Install steps: [INSTALL.md](INSTALL.md).**
No build step — `index.mjs` and `client.js` are the running source.

## Which folder is the vault

Obsidian's registry is a **guess**, not an answer. On first run the panel shows a
chooser instead of a tree, offering the detected vault and a folder picker; nothing
is read until the reader agrees to a folder. The choice is stored under `DSH_HOME`
(`dsh-obsidian/vault.json`) and from then on outranks the registry for every read.
The header keeps a folder button, so changing it later is one click.

`GET/POST /dsh-obsidian/vault` is that state. The `POST` validates that the folder
exists, is a directory, and **looks like a knowledge base** — it either carries
Obsidian's own `.obsidian` folder or has at least one `.md`/`.markdown`/`.canvas`/
`.txt` file within two levels. "Exists and is a directory" was true of every folder
on the machine, so aiming the panel at one served it as if it held notes; the
refusal names the path and what was missing. The host-check probe **backs the file
up and restores it** —
like the chat Session id, it is live state, not a fixture, and a harness that
overwrote it would silently change which folder the user's plugin reads.

A DeepSeek Harness **bundle** that puts an Obsidian vault in the app's **right
Sidebar**: a `知识库` (Knowledge Base) tab with the vault tree and full-vault search, a note page
that renders Markdown the way Obsidian's reading view does and lets you edit the
file in place, and a conversation with an agent whose Session lives in the vault's
own Workspace — opened in the app's own conversation panel, so the sidebar keeps
its space.

**It writes to the vault, and that is exactly one narrow path.** `POST
/dsh-obsidian/note` overwrites one *existing* note, and only when the path
resolves inside the vault, the target is a file this plugin already shows as a
note, and its current size fits the read cap — so a truncated view can never be
saved back over the whole file. Nothing else in this package writes into the
vault; the conversation Session id is DSH's own bookkeeping and lives under
`DSH_HOME`.

## What it contributes

| Surface | Kind | Where |
|---|---|---|
| Panel body | Client slot | `sidebar.right.pane.tab`, keyed `dsh-obsidian/notes` |
| Conversation | Shell panel | opened with `uiWorkspace.openSession(vault Session)` — `对话` in the tree panel and on the note page |
| Conversation seat occupant | Client slot | `dsh-obsidian/panel.conversation`, and `dsh-obsidian/note.conversation` on the note page |
| Note page body | Client slot | `sidebar.right.pane.tab`, keyed `dsh-obsidian/note` — also declares its own conversation child |
| Note outline | Client UI | the note page's `大纲` panel, anchored to the `dsh-obsidian-outline-*` ids `renderMarkdown` puts on headings |
| Launcher row | Client slot | `sidebar.footer.action` (id `dsh-obsidian`) |
| Tab types | Client service | `sidebarRightTabs.register({ id, kind, patterns, canOpen, title })` |
| `GET /dsh-obsidian/status` | Host route | what the plugin resolved (app, vault, config) |
| `POST /dsh-obsidian/open` | Host route | open/focus Obsidian, optional `{ "file": "笔记/x.md" }` |
| `GET /dsh-obsidian/tree` | Host route | **one** directory level, `?path=<dir>` (`''` = vault root) |
| `GET /dsh-obsidian/note` | Host route | `?path=<note>` → capped text + stat (+ `root`) |
| `GET /dsh-obsidian/search` | Host route | `?q=<term>&limit=<n>` → matching lines |
| `GET /dsh-obsidian/resolve-link` | Host route | `?name=<wikilink>` → matching note paths |
| `GET/POST /dsh-obsidian/chat` | Host route | the remembered conversation Session id |
| `GET/POST /dsh-obsidian/vault` | Host route | the folder the reader agreed to |
| `GET/POST /dsh-obsidian/diag` | Host route | the client half's own account of its registrations |
| `obsidian_open` | Agent tool | open/focus Obsidian, optionally on one note |

Every route answers GET and POST; any other method is a `405`, not a silent GET.
There is deliberately no `sidebar.panellist` or `main` registration: this plugin
used to add a second entry labelled 知识库 to the left sidebar, and the footer row
is the only way in.

Three identifiers have to agree, and each fails differently: the tab type's
`title` is the chip text, its `kind` is what `openTab` names, and its `id` is the
key the body registers under in `sidebar.right.pane.tab`.

## What this deliberately does *not* do

It does not embed the Obsidian window. Obsidian is a native Electron app with no
addressable web surface, so no `iframe`, `<webview>` or browser tab can host it —
the shell's own browser tab loads URLs, and Obsidian is not a URL.

The asymmetry is worth stating because the reverse direction *does* work: the
`dsh-harness` Obsidian plugin embeds this app inside Obsidian. That succeeds only
because DSH **is** a web page. The mirror image has no equivalent.

So this plugin brings the vault's **content** into the right Sidebar, and leaves
the real Obsidian one click away through the `obsidian_open` route/tool.

## The vault conversation

A real agent conversation is opened in the centre as an ordinary Session whose Workspace
is the vault — not a tab of the shell's chat, and not on the "start a new Session"
screen. It is one Session that is created on first use and reused afterwards, so a plan
survives a reload and can be refined across days.

**It has to belong to the vault's Workspace, not merely to its directory.** This
is the part that is easy to get wrong, and getting it wrong is visible: a Session
created with only a `cwd` belongs to *no* Workspace, so the conversation opens on
the blank new-Session screen with a workspace picker, and the whole thing reads as
"just another new conversation". `resolveVaultChatSession` therefore asks
`ctx.workspaces.create({ path })` **first** — documented as idempotently resolving
an existing path, so the vault's Workspace is never registered twice — and passes
the resulting `workspaceId` (plus `cwd`) to `ctx.sessions.create`.

**Nothing about the conversation UI is reimplemented, and no seat is occupied.** The
app already has one good place for a conversation and one panel that renders it: the
centre, whose `main` key `conversation` hosts the shipped Conversation. `对话` therefore
does not mount anything of ours — it selects the vault's Session through
`uiWorkspace.openSession(sessionId)` and the shell draws it:

```js
navigator.openSession(sessionId)   // ctx.get('uiWorkspace')
```

That is also why this plugin declares **no slot children**: an earlier version declared a
conversation seat on two of its own surfaces (and, before that, tried to occupy
`sidebar.chat.conversation`, which ui-subagent owns — a second declaration throws inside
`apply` and the shell rolls back every registration the plugin made). Declaring nothing
costs nothing and cannot collide.

**Handoff is about files, not about the AI's plan.** A note is "dropped into" a
conversation by inserting its `@path` mention at the caret —
`inputActions.captureInsertion()` + `inputActions.insertText(' @… ', span)`, the
exact mechanism a drag-and-drop would produce. The mention is ABSOLUTE
(`@D:/知识库/笔记/foo.md`) because the receiving conversation's Workspace is not the
vault: a relative mention would resolve against the wrong root. The controls live
next to the selected note in the tree and in the note page's header.

## The note page

A note opens in its own tab, not inline: full-height rendered Markdown with its
`[[wikilink]]`s clickable. Each link resolves against the vault via
`/dsh-obsidian/resolve-link` and opens the target as **its own page** — following a
link never loses the page you were reading. The tree stays put in the `知识库`
panel; the note does not replace it.

**The typography is Obsidian's, transcribed.** The numbers in `READ` are the
default theme's own reading-view values — 16px at line-height 1.5, the heading
ladder (`1.618em`/`1.462em`/`1.318em`/`1.188em`/`1.076em`/`1em`) with its weights
(700 for h1, 600 for the rest) and line heights, `1rem` between blocks, `2.5rem`
above a heading that follows another block, `2.25em` of list indent, a `2px`
accent rule and `24px` of padding on a quote, and an unadorned code surface.
`render-check` pins several of them, because drift here is exactly what makes the
page stop looking like Obsidian.

A GFM table renders as a table. Before that it rendered as a paragraph of pipes,
which is most of what a note with a table looked like.

**The outline.** `大纲` in the note's header opens a floating list of its headings
down the right edge of the pane: clicking one scrolls the reading area to it, and
the row for the heading you are currently inside is the one marked. Depth is
indentation, so a `###` under a `##` reads as nested.

It is deliberately a *view over the rendered page*, not a second parse of the note.
`renderMarkdown` writes each heading's anchor (`id`) and its depth (`data-outline`)
as DOM attributes while it renders, and the panel reads them back with
`querySelectorAll` — one parse, so the list can never describe a page other than the
one on screen. That includes the capped case: a note longer than `MAX_RENDER_LINES`
renders only its head, and the outline lists exactly the headings that exist, with
nothing trailing off the end pointing at a heading that was never drawn. Anchors are
numbered per page, so two note tabs open at once cannot collide.

The panel closes with its own control, with the `×`, and on entering edit mode — the
rendered page is gone, so there is nothing left to outline. `mount-check` drives
open → pick → jump → close against a note whose heading ladder is one/two/three/two,
and asserts the anchors, the indentation and the scroll target.

**Editing.** `编辑` swaps the rendered view for a plain-text editor over the same
file; `保存` posts the whole text to `/dsh-obsidian/note`. A note whose read was
truncated is refused editing outright — the partial view is not a safe base for
overwriting the file.

**Quoting a note into the conversation.** One control, because there is one place the
mention can land: `引用到对话` inserts the note's absolute `@path` at the caret of the
conversation the centre is showing — the same thing dragging the file in would do. The
path is ABSOLUTE because the receiving conversation's Workspace need not be the vault: a
relative mention would resolve against the wrong root. An unknown vault root is a refusal
(`no-path`), never an `@undefined` mention.

There is no second composer to reach for any more, which is why this is one control and
not two: the vault conversation is simply the Session the reader opened from `对话`.
`mount-check` asserts the click hands that Session to the shell and that the quote lands
in the composer the page was given.

## The conversation: opened in the centre, hosted by the shell

The conversation is an ordinary DSH Session — one whose Workspace is the vault — and
`对话` hands it to the app: `uiWorkspace.openSession(sessionId)` selects it, and the
centre shows it in the shell's own conversation panel. This plugin renders none of it,
and none of it touches the right Sidebar's layout: the tree and the note stay visible
beside it, and the plugin's own chrome is one button.

That is the whole design, and it is the answer to a question this plugin got wrong three
times. A right-Sidebar pane is a few hundred pixels of tool space, so a conversation put
there has two possible shapes and both are wrong: it either eats the tree's height (the
old footer, then the draggable popup) or replaces it (a tab of its own). Either way the
plugin has to invent a size for something the reader uses in bursts, next to a column
whose whole job is showing the vault. The centre is where the app puts conversations: it
is full width, it already has the composer, the transcript, the stop control and the
rest, and the Session is host-side — so opening and closing this view costs the
conversation nothing.

Two consequences worth stating:

- **This plugin now declares no slot children at all.** It used to declare a conversation
  seat of its own on two surfaces, which meant owning a second copy of a conversation's
  state and keeping it fed. There is nothing of ours to collide with
  `sidebar.chat.conversation` (ui-subagent owns that one in this profile) and nothing to
  keep alive.
- **`引用到对话` on the note page writes into the conversation on screen.** The
  `inputActions` a tab body receives belong to the Session whose Sidebar this is — the
  one the centre is showing — so quoting a note puts its absolute `@path` into whatever
  conversation is open, which is the vault conversation whenever the reader arrived
  through `对话`. Nothing is published module-side any more, because there is no second
  composer to reach.

### Continue, or start over

The remembered Session is the one holding the history, so "open the vault conversation"
should mean that one — which is what the button used to do, silently. That made the
other intention (start fresh) impossible without hunting through the workspace, and the
opposite mistake (always starting a new one) throws the history away. So `对话` resolves
first and *asks* when there is something to come back to:

```
继续上次对话   回到知识库里的那段历史
新开一个对话   同一工作区，从空白开始
```

No remembered Session means no menu: the first use creates one and opens it. "New" is a
real new Session in the vault's Workspace, and the remembered id is replaced only after
that Session exists — a failure leaves the history addressable.

### The workspace appears when the folder is chosen

The vault's Workspace is registered the moment the reader confirms a folder, not on the
first `对话`. The Workspace is what makes the folder a place the agent can be sent to and
what the sidebar lists, so resolving it lazily meant nothing appeared until the reader
went looking for the conversation. `workspaces.create` is idempotent by contract, so the
lazy path in `resolveVaultChatTarget` still works and costs nothing when the Workspace is
already there.

### The sidebar comes back

The right Sidebar's tabs are **session-scoped**, so selecting another Session hands the
pane a fresh, empty tab set: the tree — or the note page the reader was on — disappeared
with the Session it belonged to. Opening a conversation is not closing the tree, so the
plugin remembers which of its surfaces was on screen (`rememberSurface`) and puts it back
after `openSession` (`restoreSurface`), retrying briefly because the pane remounts for
the new Session. The tree's own browse state — expansion, selection, search text, the
levels already fetched — is kept across that remount too, because it is the same vault;
it is dropped outright if the vault turns out to be a different one.

### Editing looks like reading

`编辑` swaps the rendered page for a `textarea` over the same file, and the two have to
be the same box: 16px on 1.5, the same `18px 22px 96px` padding, the same typeface. The
editor used to be 13px monospace with its own padding, so pressing the button reflowed
the page before a character was typed, and the mode change was the most visible thing
about it. `mount-check` asserts the editor's metrics against the reading view's.

## One slot, one declarer — and why that took the whole plugin down

`sidebar.chat.conversation` is a `single` slot, and the slots core refuses a second
declaration of it (`dsh-client-ui-slots`):

```js
if (options.children) for (const childKey of Object.keys(options.children)) {
  const childRec = this.records.get(childKey);
  if (childRec?.spec) throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy})`);
}
```

That throw happens inside `apply`, and the shell answers a failed `apply` by
**rolling back every registration the plugin made**. So declaring the seat from both
the notes panel and the note page did not cost one tab — it cost the entire plugin,
and the sidebar showed nothing from it at all.

The note page therefore declares its **own** seat, `dsh-obsidian/note.conversation`,
and occupies it. A different name cannot collide — and declaring a session-scoped
child is also what EARNS that body the two things a conversation needs, because the
renderer grants `renderSlot` and `SessionProvider` only to an entry that declares
one:

```js
if (entry.children !== void 0) {
  kit["renderSlot"] = boundRenderSlot(host, entry);
  if (Object.values(entry.children).some((spec) => spec.scope !== "root")) {
    kit["SessionProvider"] = scopeAreaProvider(adapter);
  }
}
```

`renderFactorySlot`, by contrast, is handed to every entry — but it is not enough on
its own: without `SessionProvider` the factory has no session scope to render, which
is why a factory-only note page showed "no seat and no factory" instead of a
conversation.

That is the mechanism an earlier version used to host a conversation of its own. The
current plugin declares no child slot, so it never receives `renderSlot`/`SessionProvider`
— and does not need them: the vault conversation is drawn by the shell's Conversation
panel, which the plugin reaches by Session id.

Both client harnesses mirror the slots core's rule and **throw on a second declaration**,
and `render-check` proves the guard is live by declaring the same seat twice, then asserts
that this plugin declares no child slot at all. A silent guard would be worse than none:
this is the outage they failed to catch the first time.

## Why a remembered Session always wins

`resolveVaultChatSession` reuses the remembered Session id **unconditionally**,
before consulting Workspaces at all. The remembered Session is the one holding the
conversation history; deciding whether to reuse it by re-deriving Workspace
membership means the history disappears the moment that derivation disagrees —
which is what "my history is gone after restart" looks like. The Workspace is
consulted only to *create* a Session, so a new one is grouped under 知识库 rather
than orphaned.

**A failed read is not "nothing was remembered."** Answering `''` for a failed
`GET /chat` made the box create a fresh Session and POST its id over the remembered
one: one transient read error and the history was gone. A read failure now raises a
visible failure state and **never writes**. A failed *write* is visible too — the
host answers `400` with the failing path, instead of a `200` that made "the id was
never remembered" look like success.

**Sessions and Workspaces are looked up lazily** (`ctx.get`), never declared in
`exports.inject`. Requiring a service the profile does not hand out holds the whole
entry back from activating — `apply` never runs and the sidebar loses the plugin,
tree included. Lazy lookup is what makes "the conversation is unavailable but the
tree still works" a reachable state instead of dead code.

The box retains its `SessionReference` on mount and releases it on unmount. The
resolver is built once per registration, not inline in the render: a fresh function
identity each render would re-run that effect on every render, retaining and
releasing the Session in a loop. The harness counts the retains and fails on more
than one.

## Why the panel stacks vertically

A right-Sidebar pane is a few hundred pixels wide, so the panel keeps one column:
the body shows the tree (or live search results). A note never takes this column
over — it opens as its own page — and the conversation is not in this column at all:
the shell shows it in the centre. Nothing here competes for the pane's height.
The harness asserts the vertical stack, so a future edit that reintroduces
side-by-side columns fails the test rather than the layout.

## Why the tree is fetched one level at a time

A vault can hold a full source checkout next to its notes. Asking the host for
the whole tree in one response lets one deep, wide directory spend the entire
node budget, and the rest of the vault then disappears **silently** — an early
build of this plugin returned only 4 of 17 root entries for exactly that reason.

`/tree` therefore answers exactly one directory level, and the panel fetches a
level the first time its folder is expanded. Every level is complete, arbitrarily
large vaults stay responsive, and nothing is dropped without the reader noticing:
when the host's per-level cap does bite, the panel says **仅显示前 N 项** instead of
ending the list silently.

A level whose fetch fails is **not** cached as an empty directory. `[]` claimed the
folder was empty and stopped it from ever being retried; the failed key is dropped
instead, the message is shown, and a 重试 control fetches it again. Search results
carry the same truncation notice, and an answer to an older query (or an older
note) can never overwrite a newer one — each request carries a sequence number and
a stale answer is discarded.

## How it resolves your machine

Nothing is hard-coded to one install. At call time the host half:

1. reads `%APPDATA%\obsidian\obsidian.json` — Obsidian's own vault registry —
   and picks the most recently opened vault (the vault name Obsidian's URI
   handler expects is the folder basename);
2. locates `Obsidian.exe` from `DSH_OBSIDIAN_APP`, then the common install
   locations;
3. launches it with `obsidian://open?vault=<vault>[&file=<file>]`.

An already-running Obsidian is *focused* rather than duplicated, because
Obsidian enforces single-instance itself. If no executable is found, the launch
falls back to Windows' registered `obsidian://` protocol handler.

`GET /dsh-obsidian/status` reports exactly what resolved.

## Safety

- Every path from the browser is resolved against the vault root and rejected
  when it escapes; `..` and Windows-style `..\` both fail.
- **A string prefix is not containment.** The root's `realpathSync` is the anchor,
  and an existing target is resolved again and must land back inside it, so a
  symlink or NTFS junction *inside* the vault can no longer read or overwrite a
  file outside it — via `/note`, `/tree` or the write path. A `realpathSync` that
  fails (EPERM, a dangling or corrupt link) is a refusal, never a pass.
- Dot-directories and build/VCS directories (`.obsidian`, `.git`, `node_modules`,
  …) are never listed — and a path with **any** `.`-prefixed segment is refused by
  the tree, by a note read and by a note write alike, so `.git/config`,
  `.mcp.json` and `.obsidian/*` are unreachable. A note read must also name a real
  note file (`NOTE_FILE`), the same guard the write path has always had.
- Note reads are capped at 512 KB. A search is bounded four ways — 200 results,
  3000 files read, 5000 directories entered, depth 24 — and skips files above
  1 MB.
- **`truncated` means the answer is incomplete, for any of those reasons.**
  A search that hit a cap, or that skipped an oversized note, sets
  `truncated: true`, and the count of skipped oversized notes is reported
  separately as `skippedLarge`. The two are deliberately not the same thing:
  `truncated` is what the panel acts on, and `skippedLarge` is what tells it
  *which* incompleteness this was. Skipping a large note used to be silent, so a
  vault of large notes answered "searched, nothing found" while never having read
  one — the panel now says the note was not searched, and says it even when there
  are no other results. A search that read everything still answers
  `truncated: false`.
- A depth-capped branch is pruned rather than fatal: the walk stops descending
  into it, still searches the rest of the vault, and reports the truncation. An
  abort there would let one deep folder hide every note beside it.
- **Request bodies are capped at 8 MB while they are read**, not after: over the
  cap the read stops, the request is torn down, and the route answers `413`. The
  4 MB note limit used to be the only bound and it ran once the whole body was
  already in memory, so an upload was buffered in full before any check applied.
- **Writes.** There is exactly one: `POST /dsh-obsidian/note` overwrites one
  note. It refuses a path that escapes the vault, a hidden path, a target that
  does not exist, a target that is not a file, a target that is not a note this
  plugin already shows, a note whose current size exceeds the read cap (a
  truncated view is not a safe base for an overwrite), and content above 4 MB. The
  bytes are written untransformed, UTF-8.
- **`/diag` stores only what the client half reports.** It accepts `inject`,
  `report` and `renderError` and drops everything else, and its `at` timestamp is
  assigned by the server *after* those keys are copied — `{ at: Date.now(), ...body }`
  let a caller both overwrite the time and put any key into a file this plugin
  writes to disk.
- The conversation Session id is written to `<DSH_HOME>/dsh-obsidian/chat.json`.
  That is DSH's own bookkeeping, not vault content. A write that cannot reach disk
  is a `400` naming the path, so "it was not remembered" is never silent.
- `host-check` exercises the write path against a probe file it creates and
  removes, so no existing note is touched, and asserts each refusal above. It reads
  and restores `chat.json`, `vault.json` and `diag.json`: all three are live state,
  not fixtures. Protocol probes — the junction escape, the caps, the folder
  validation — run against vaults created under `os.tmpdir()` and switched in
  through the real `/vault` route, so the user's own vault is never entered.

## Layout

```
package.json        # dsh.bundle.patch + dsh.client
cordis.patch.yml    # bundle layer: mounts this package by name
index.mjs           # host half: resolution, routes, obsidian_open tool
client.js           # client half: the right-Sidebar tab type + its launcher
test/               # headless harnesses, not shipped
```

## Tests

Both halves run without a browser or a live DSH — the host harness fakes the
subprocess service, so it never launches Obsidian.

```sh
npm install                  # once: the client harnesses need react/jsdom
node test/mount-check.cjs    # mounts the panel into jsdom with a stubbed fetch
                             # and drives every state the shell can put it in
node test/render-check.cjs   # executes client.js as the module table does,
                             # then server-renders every seat with real React
node test/host-check.mjs     # drives every route against the real vault
```

The two client harnesses resolve `react`, `react-dom`, and `jsdom` from **this
package's own** `devDependencies`, with React pinned to the `18.2.0` the shell
bundles. They used to borrow them from the DSH source checkout, which made them
hostage to a directory that has nothing to do with this plugin — and which was
then deleted out from under them.

`mount-check.cjs` exists because server rendering is not enough. It walks the
panel through mount → tree → expand → note → outline → conversation → back → search →
launcher with effects actually running. The first version of
this plugin used a
`const` above its own declaration: the throw happened inside a passive mount
effect, which SSR never executes, and the slot framework's entry boundary
responded by **retiring the tab body** — so the right Sidebar came up blank with
nothing in the product pointing at the cause. That class of bug is only visible to
a real mount.

It is also where the two defects that shipped to the user were caught by
regression: the box retaining its Session on **every** render (the resolver had a
fresh identity each time, so the acquire effect re-ran in a loop), and the phase
expectations that came with suppressing the Hero.

`render-check.cjs` covers the wiring that cannot be seen by eye: that the tab
type's `id` equals its body seat key, that the panel body declares its own
conversation seat and occupies it, that the conversation never renders the Hero,
that there is exactly one footer row and no conversation tab, that `sessions`,
`workspaces` and `uiWorkspace` are **not** in `inject` (and that reading any of
them as a property throws), that an unrecognised Session snapshot is handed to the
factory with the selector actually invoked, that a profile without Sessions still
registers and renders the tree panel, and that an unknown vault root is a
`no-path` refusal rather than an `@undefined` mention. It also pins the Obsidian
reading-view typography and the GFM table.

`host-check.mjs` drives all nine routes against the real vault and asserts that
the conversation Session id lands under `DSH_HOME` rather than inside the vault —
against the **real** store path, since the old assertion named a file this plugin
never writes. It also asserts that `.git/config`, `.mcp.json` and `.obsidian/*`
cannot be read or listed, that a non-note file cannot be read, that `PUT`/`DELETE`
are `405`, that `/diag` round-trips, that a chat write which cannot reach disk is a
`400` naming the path, and that an 8 MB body is a `413` whose read stopped early.

The probes that need a vault of their own — a junction pointing out of it, notes
above the per-file cap, a 26-deep chain, 5001 sibling directories, an empty folder
offered as a vault — use **temporary vaults under `os.tmpdir()`**, switched in
through the real `/vault` route and restored afterwards. The user's vault is never
written to; the junction probe is created and deleted inside the temp tree. A
junction the process cannot create is reported as a **skip with its reason**, never
as a pass. `host-check` prints the check count and any skips on its last line.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-obsidian
```

The profile's `dsh.profile.bundles` gains `dsh-obsidian` and the row loads from
`cordis.patch.yml`. Remove it with:

```sh
dsh plugin --profile <name> remove dsh-obsidian
```

A newly installed host half is imported at boot, and Node caches ESM by resolved
URL — so a **restart** is what activates a changed host half. A changed
`client.js` additionally needs a page refresh, unless the shell is running with
its client watcher.

## Development notes

`client.js` is a hand-written loader artifact rather than a tsdown output, so the
package needs no build step:

```js
window.__ModuleLoader__.load({
  id: '<package name>',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    // `require` answers only from the shell's frozen table:
    // react, react/jsx-runtime, react-dom, @deepseek-ai/cordis,
    // @deepseek-ai/dsh-client-store, -ui-slots, -ui-primitives, -ui-dockkit.
    exports.apply = (ctx) => { /* ctx.slots.inject(...) */ };
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
    return module.exports;
  },
});
```

Anything outside that baseline must go through `dsh.client.external` and a real
build; cross-plugin value imports are forbidden — collaborate through Cordis
services instead. The panel's palette comes from the shell's published theme
tokens (`--dsw-alias-*`), so it follows light/dark without a stylesheet.

**`inject` is a promise, not a wishlist.** An entry that requires a service the
profile does not hand out never activates — no error, no pane, the whole plugin
simply absent. So `inject` names only what the plugin cannot work without, and
everything a profile may legitimately lack (Sessions, Workspaces, the folder
picker) is reached with `ctx.get('name')` at the moment it is needed. Reading such
a service as a **property** throws inside the shell (`cannot get property "X"
without inject`), which is why the harness spells that rule out with a Proxy.

`openTab` writes into the **currently mounted** Session's right Sidebar and
throws when no session surface is mounted, so the launcher catches that and says
so instead of failing silently.
