// Headless harness for the dsh-obsidian client half.
//
// Not shipped (package.json `files` omits it). It executes client.js exactly the
// way the shell's module table does — capture the `__ModuleLoader__.load`
// registration, run the factory with a real `require`, call `apply` against a
// fake Cordis context — then server-renders every registered component with real
// React, so a render-time throw cannot wait for a page refresh to be found.
//
// Run: node test/render-check.cjs

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createRequire } = require('node:module')

// Resolve from this package's own devDependencies. It used to borrow React from
// the DSH source checkout, which made the harness hostage to a directory that has
// nothing to do with this plugin — and which was deleted out from under it.
const resolveFrom = createRequire(join(__dirname, '..', 'package.json'))
const React = resolveFrom('react')
const { renderToStaticMarkup } = resolveFrom('react-dom/server')

// The client half under test. `DSH_OBSIDIAN_CLIENT` points this at an INSTALLED copy (a
// disposable profile's node_modules) — test/profile-lifecycle.mjs does exactly that, so
// "the package activates" is asserted against what was installed, not against the tree
// it was packed from.
const CLIENT_PATH = process.env.DSH_OBSIDIAN_CLIENT ?? join(__dirname, '..', 'client.js')
const source = readFileSync(CLIENT_PATH, 'utf8')

// ── every marker the harnesses query must exist in the source ──────────────
// A harness that asserts on `data-dsh-obsidian-chat-*` while the client half contains no
// such string passes forever and proves nothing. That is exactly how five assertions here
// (and in mount-check) quietly rotted after the draggable conversation box was deleted:
// they were reworded to strings nothing writes, and stayed green. So every marker inside a
// quoted literal — which is where selectors and `includes(...)` arguments live — is checked
// against the half under test. It runs FIRST, before anything is registered, so a stale
// marker is reported as this failure rather than as whatever its assertion does next.
for (const harness of ['render-check.cjs', 'mount-check.cjs']) {
  const text = readFileSync(join(__dirname, harness), 'utf8')
  for (const literal of text.matchAll(/'[^'\r\n]*'|"[^"\r\n]*"/g)) {
    for (const marker of literal[0].match(/data-dsh-obsidian[a-z0-9-]*/g) ?? []) {
      if (!source.includes(marker)) {
        throw new Error('the harness queries "' + marker + '" but the client half never writes it')
      }
    }
  }
}

let registration = null
const windowStub = {
  __ModuleLoader__: { load: (value) => { registration = value } },
  open: () => {},
}

// Execute the artifact the way the loader does: a bare script with `window`.
new Function('window', 'fetch', source)(windowStub, () => Promise.reject(new Error('no fetch in harness')))

if (registration === null) throw new Error('client.js never called window.__ModuleLoader__.load')
if (registration.id !== 'dsh-obsidian-panel') throw new Error('unexpected module id: ' + registration.id)

const factoryRequire = (specifier) => {
  if (specifier === 'react') return React
  throw new Error('harness has no module for ' + specifier)
}

const api = registration.factory(factoryRequire)
if (typeof api.apply !== 'function') throw new Error('factory did not export apply')
if (!Array.isArray(api.inject)) throw new Error('factory did not declare an injection list')
for (const service of ['slots', 'sidebarRightTabs', 'sidebarRight']) {
  if (!api.inject.includes(service)) throw new Error('factory does not wait for service: ' + service)
}

// ── fake context, capturing every registration ─────────────────────────────
const registered = []
const tabTypes = []
const effects = []
const opened = []
const createdSessions = []
const workspaceCalls = []
const declaredChildren = new Map()

// Sessions and Workspaces are reachable ONLY through `ctx.get`: they are not in
// `inject` (a profile without them must still get the tree), and reading them as
// properties is what the shell answers with a throw.
const sessionsService = {
  create: (options) => { createdSessions.push(options); return Promise.resolve('session-fake') },
  retain: () => ({ release: () => {} }),
}
// `create` is documented as idempotently resolving an existing path, which is
// what keeps the knowledge base's Workspace from being registered twice.
const workspacesService = {
  create: (input) => {
    workspaceCalls.push(input)
    return Promise.resolve({ workspaceId: 'ws-vault', path: input.path, sessionIds: [], title: '知识库' })
  },
}

const ctx = {
  effect: (callback, label) => {
    effects.push(label)
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get: (service) => {
    if (service === 'sessions') return sessionsService
    if (service === 'workspaces') return workspacesService
    return undefined
  },
  sidebarRightTabs: {
    register: (definition) => { tabTypes.push(definition); return () => {} },
  },
  sidebarRight: {
    openTab: (kind) => { opened.push(kind) },
    openResource: (address) => { opened.push(address) },
  },
  slots: {
    inject(slot, register) {
      if (typeof register !== 'function') throw new Error('inject expected a callback for ' + slot)
      register()
    },
    register(metadata, component) {
      // Mirror the real slots core: a slot may be declared by exactly ONE entry,
      // and a second declaration THROWS. That throw lands inside `apply`, which
      // makes the shell roll back every registration the plugin made — so the
      // failure mode is not "one missing tab" but "the whole plugin is gone".
      // Leaving this unchecked is exactly what let that reach the user.
      if (metadata.children !== undefined) {
        for (const childKey of Object.keys(metadata.children)) {
          if (declaredChildren.has(childKey)) {
            throw new Error('slot "' + childKey + '" is already declared (by '
              + declaredChildren.get(childKey) + ')')
          }
          declaredChildren.set(childKey, 'an entry in "' + metadata.name + '"')
        }
      }
      registered.push({ metadata, component })
      return () => {}
    },
  },
}

// Mirror Cordis: reading a service PROPERTY that is not declared in `inject`
// throws. This plugin must reach a non-injected service only through `ctx.get`.
// It once read `ctx.uiWorkspace` inside a useCallback dependency array — which is
// evaluated during render — and that throw blanked the entire pane. `sessions`
// and `workspaces` are on this list for the same reason: they are deliberately
// NOT injected, so any `ctx.sessions` left in client.js throws right here.
const SERVICE_PROPS = new Set(['uiWorkspace', 'sessions', 'workspaces', 'layout', 'locale', 'theme', 'timer'])
const enforcingCtx = new Proxy(ctx, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && SERVICE_PROPS.has(prop) && target[prop] === undefined) {
      throw new Error('cannot get property "' + prop + '" without inject')
    }
    return Reflect.get(target, prop, receiver)
  },
})
api.apply(enforcingCtx)

// ── the activation contract ────────────────────────────────────────────────
// Requiring a service the profile does not hand out holds the ENTIRE entry back:
// the boot reports "1 entry did not activate", `apply` is never called, and the
// plugin vanishes from the sidebar with no client-side error at all.
// `sessions` and `workspaces` MUST NOT be required for exactly that reason: a
// profile without them would lose the tree along with the conversation, and the
// "conversation is broken but the tree still works" branch would be unreachable
// dead code. `uiWorkspace` likewise — a missing picker costs one button.
for (const forbidden of ['uiWorkspace', 'sessions', 'workspaces']) {
  if (api.inject.includes(forbidden)) {
    throw new Error(forbidden + ' must not be required: an unsatisfied inject skips the whole plugin')
  }
}
for (const required of ['slots', 'sidebarRightTabs', 'sidebarRight']) {
  if (!api.inject.includes(required)) throw new Error('the plugin no longer requires ' + required)
}

// ── two tab types, and their bodies ────────────────────────────────────────
// The tree and a note. The conversation is not a tab any more: the SHELL shows it in
// the centre, through `uiWorkspace.openSession`, so this plugin registers no
// conversation surface and no seat at all.
if (tabTypes.length !== 2) throw new Error('expected two tab types, got ' + tabTypes.length)
const tabType = tabTypes.find((entry) => entry.kind === api.__internals.TAB_KIND)
const noteType = tabTypes.find((entry) => entry.kind === api.__internals.NOTE_TAB_KIND)
if (tabType === undefined) throw new Error('missing the notes tab type')
if (noteType === undefined) throw new Error('missing the note tab type')
if (tabType.id !== api.__internals.TAB_ID) throw new Error('tab type id drifted from TAB_ID')
if (noteType.id !== api.__internals.NOTE_TAB_ID) throw new Error('note tab type id drifted from NOTE_TAB_ID')
for (const entry of [tabType, noteType]) {
  if (typeof entry.title !== 'function' || typeof entry.title('') !== 'string') {
    throw new Error('tab type has no usable title')
  }
}
// The note page is addressable: a file opens by its vault-relative path.
if (noteType.canOpen(api.__internals.noteAddress('笔记/foo.md')) !== true) {
  throw new Error('the note type rejects its own address')
}
if (noteType.canOpen('dsh-resource://file/session/x/y.md') !== false) {
  throw new Error('the note type accepts a foreign address')
}
if (noteType.title(api.__internals.noteAddress('笔记/foo.md')) !== 'foo.md') {
  throw new Error('the note title is not the note basename')
}

const bySlot = new Map(registered.map((entry) => [entry.metadata.name, entry]))
for (const slot of ['sidebar.right.pane.tab', 'sidebar.footer.action']) {
  if (!bySlot.has(slot)) throw new Error('missing registration for slot ' + slot)
}
// Exactly ONE way in. The plugin used to also register a `sidebar.panellist` icon
// plus a `main` body for a full-width centre view, which put a SECOND entry
// labelled 知识库 in the left sidebar next to the footer row. One entry per feature.
for (const slot of ['sidebar.panellist', 'main']) {
  if (bySlot.has(slot)) throw new Error('a duplicate sidebar entry came back: ' + slot)
}
const footerEntries = registered.filter((entry) => entry.metadata.name === 'sidebar.footer.action')
if (footerEntries.length !== 1) throw new Error('expected one footer entry, got ' + footerEntries.length)
if (footerEntries[0].metadata.label !== '知识库') throw new Error('the footer entry lost its label')
const bodyMeta = registered.find((entry) => entry.metadata.key === tabType.id).metadata
if (bodyMeta.key !== tabType.id) {
  throw new Error(`body seat key (${String(bodyMeta.key)}) must equal the tab type id (${String(tabType.id)})`)
}
// No surface of this plugin hosts a conversation any more, so NONE of them declares a
// child slot. That is the whole point of opening the vault Session through the shell:
// there is no seat of ours to collide with ui-subagent's, and none to keep fed.
for (const entry of registered) {
  if (entry.metadata.children === undefined) continue
  for (const childKey of Object.keys(entry.metadata.children)) {
    if (childKey === 'sidebar.chat.conversation') {
      throw new Error('the plugin declares the shell-owned sidebar.chat.conversation slot')
    }
    throw new Error('the plugin declares a slot it does not own: ' + childKey)
  }
}
// Prove the duplicate rule is live, because a silent guard is worse than none: a
// second declaration throws inside `apply`, and the shell then rolls back every
// registration the plugin made. That is the outage this harness once failed to catch.
// The probe declares its OWN key first, then repeats it — the harness enforces the same
// rule the shell does, and this asserts the mirror is still armed.
ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'duplicate-declaration-probe',
  children: { 'dsh-obsidian/probe.conversation': { kind: 'single', scope: 'session' } },
}, () => null)
let duplicateRejected = false
try {
  ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'duplicate-declaration-probe-2',
    children: { 'dsh-obsidian/probe.conversation': { kind: 'single', scope: 'session' } },
  }, () => null)
} catch (error) {
  duplicateRejected = /already declared/.test(String(error && error.message))
}
if (!duplicateRejected) throw new Error('a second declaration of a seat is not rejected')
if (registered.some((entry) => entry.metadata.key === 'duplicate-declaration-probe-2')) {
  throw new Error('the refused declaration was still recorded')
}

// A registration that throws must cost only ITSELF. The shell rolls back every
// registration the plugin made when `apply` throws, so an unguarded throw would
// erase the plugin's only way in — the sidebar would simply show nothing from it.
// This runs `apply` a second time against a context where one body refuses to
// register.
{
  const seen = []
  const hostile = {
    effect: (callback, label) => { seen.push('effect:' + label); callback(); return () => {} },
    get: (name) => (name === 'sessions' ? hostile.sessions : (name === 'workspaces' ? hostile.workspaces : undefined)),
    sidebarRightTabs: { register: (definition) => { seen.push('tab:' + definition.id); return () => {} } },
    sidebarRight: { openTab: () => {}, openTabFromTarget: () => {}, openResource: () => {} },
    sessions: { create: async () => 'session-x', retain: () => ({ release() {} }) },
    workspaces: { create: async () => ({ workspaceId: 'ws-x' }) },
    uiWorkspace: { pickDirectory: async () => null },
    slots: {
      inject: (slot, register) => { register() },
      register: (metadata) => {
        if (metadata.key === api.__internals.TAB_ID) throw new Error('hostile context: boom')
        seen.push('slot:' + metadata.name)
        return () => {}
      },
    },
  }
  api.apply(hostile)
  if (!seen.includes('slot:sidebar.footer.action')) {
    throw new Error('a throwing registration erased the sidebar-foot row')
  }
  // The note page comes AFTER the throwing body in registration order: guarding each
  // registration is what keeps one hostile body from erasing the rest.
  if (!seen.includes('slot:sidebar.right.pane.tab')) {
    throw new Error('a throwing registration erased the note page')
  }
}

// ── a profile WITHOUT Sessions/Workspaces ──────────────────────────────────
// The real reason they are out of `inject`. This context hands out neither, and the
// plugin must still register the tree and its way in. The conversation needs them, and
// it is now opened on demand — so a missing service costs a message when the reader
// asks for it, not the tree, and not the plugin's activation.
{
  const captured = []
  const bare = {
    effect: (callback) => { callback(); return () => {} },
    get: () => undefined,
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => {}, openResource: () => {} },
    slots: {
      inject: (slot, register) => { register() },
      register: (metadata, component) => { captured.push({ metadata, component }); return () => {} },
    },
  }
  api.apply(bare)
  const panel = captured.find((entry) => entry.metadata.key === api.__internals.TAB_ID)
  if (panel === undefined) throw new Error('the notes panel vanished when Sessions were missing')
  if (!captured.some((entry) => entry.metadata.name === 'sidebar.footer.action')) {
    throw new Error('the way into the notes panel vanished when Sessions were missing')
  }
  if (!captured.some((entry) => entry.metadata.key === api.__internals.NOTE_TAB_ID)) {
    throw new Error('the note page vanished when Sessions were missing')
  }
  const markup = renderToStaticMarkup(React.createElement(panel.component, {
    renderSlot: () => React.createElement('div', null, 'CONVERSATION_SEAT'),
    SessionProvider: (props) => props.children,
    inputActions: { setDraft: () => {} },
  }))
  if (!markup.includes('搜索整个库')) throw new Error('the tree panel did not render without Sessions')
  // The way in must be there and must SAY so rather than doing nothing. `对话` alone was
  // too generic to prove that — any label containing those two characters passed — so the
  // control is pinned by the marker the client half actually writes.
  if (!markup.includes('data-dsh-obsidian-chat-menu')) {
    throw new Error('the panel lost its way into the conversation')
  }
  if (markup.includes('CONVERSATION_SEAT')) {
    throw new Error('the panel rendered a conversation seat it does not declare')
  }
}
for (const entry of registered) {
  if (typeof entry.component !== 'function') throw new Error('slot ' + entry.metadata.name + ' has no component')
}
// One footer row: the notes panel. The conversation used to have its own row and
// its own tab, which is exactly what the user asked to be rid of.
const footerRows = registered.filter((entry) => entry.metadata.name === 'sidebar.footer.action')
if (footerRows.length !== 1) throw new Error('expected one footer row, got ' + footerRows.length)
if (footerRows[0].metadata.id !== 'dsh-obsidian') throw new Error('the single footer row is not the notes launcher')
if (typeof api.__internals.resolveVaultChatSession !== 'function') {
  throw new Error('the Session resolver is not exported for testing')
}

// ── server-render the seats ────────────────────────────────────────────────
const notesEntry = registered.find((entry) => entry.metadata.key === tabType.id)
const notesLauncher = footerRows[0]
if (notesEntry === undefined) throw new Error('the notes tab body is missing')
const rendered = {
  panel: renderToStaticMarkup(React.createElement(notesEntry.component, {
    renderSlot: () => React.createElement('div', null, 'CONVERSATION_SEAT'),
    SessionProvider: (props) => props.children,
    inputActions: { setDraft: () => {} },
  })),
  footerWide: renderToStaticMarkup(React.createElement(notesLauncher.component, { wide: true })),
  footerRail: renderToStaticMarkup(React.createElement(notesLauncher.component, { wide: false })),
}
for (const [name, markup] of Object.entries(rendered)) {
  if (markup.length === 0) throw new Error('seat rendered empty: ' + name)
}
if (!rendered.panel.includes('搜索整个库')) throw new Error('panel is missing the search box')
// The render guard below turns a throw into visible text, so the harness has to
// assert the text is ABSENT — otherwise the guard would swallow every failure and
// this file would report success while the pane showed an error.
if (rendered.panel.includes('渲染失败')) {
  throw new Error('the notes panel threw while rendering: ' + rendered.panel.slice(0, 240))
} 
// The conversation is NOT in this panel's markup: the shell shows it in the centre, so
// the only thing the tree panel owes the reader is the control that opens it. That control
// is pinned by the marker the client half writes, and a conversation seat would show up as
// `renderSlot`'s own output — which this entry must never render, because it declares no
// child slot. (These two used to be asserted as `data-dsh-obsidian-chat-page` /
// `-chat-dock`, strings the source stopped containing when the draggable box was deleted —
// assertions that could never fail. See the marker meta-check at the top of this file.)
if (rendered.panel.includes('CONVERSATION_SEAT')) {
  throw new Error('a conversation rendered inside the tree panel')
}
if (!rendered.panel.includes('data-dsh-obsidian-chat-menu')) {
  throw new Error('the notes panel has no control for the conversation')
}
// Wide renders the visible label; the 56px rail keeps it to the icon, with the
// text surviving only in the accessible name and tooltip.
if (!rendered.footerWide.includes('<span') || !rendered.footerWide.includes('知识库')) {
  throw new Error('wide launcher is missing its visible label')
}
if (rendered.footerRail.includes('<span')) throw new Error('rail launcher must be icon-only')
if (!rendered.footerRail.includes('aria-label')) throw new Error('rail launcher lost its accessible name')

// A right-Sidebar pane is narrow: the panel must stack vertically, never
// side-by-side columns.
if (!rendered.panel.includes('flex-direction:column')) throw new Error('panel is not a vertical stack')

// ── the file-mention grammar (how a note is "dropped into" a conversation) ──
const { fileMention, absoluteVaultPath, parseNoteAddress, noteAddress } = api.__internals
if (fileMention('D:/知识库/笔记/foo.md') !== '@D:/知识库/笔记/foo.md') {
  throw new Error('a clean absolute path is not mentioned as @path')
}
if (fileMention('D:/知识库/笔记/foo bar.md') !== '@"D:/知识库/笔记/foo bar.md"') {
  throw new Error('a path with spaces is not quoted')
}
if (fileMention('D:/知识库/笔记/带"引号.md') !== undefined) {
  throw new Error('a path with a quote is not refused')
}
if (absoluteVaultPath('D:\\知识库', '笔记/foo.md') !== 'D:/知识库/笔记/foo.md') {
  throw new Error('the absolute vault path is not normalised: ' + absoluteVaultPath('D:\\知识库', '笔记/foo.md'))
}
// An unknown root has NO absolute path. Returning `'/笔记/x.md'` (or `'笔记/x.md'`)
// addressed a file that does not exist, and the mention control said "已附进对话".
if (absoluteVaultPath('', '笔记/foo.md') !== undefined) {
  throw new Error('an empty root produced an absolute path: ' + String(absoluteVaultPath('', '笔记/foo.md')))
}
if (absoluteVaultPath(undefined, '笔记/foo.md') !== undefined) {
  throw new Error('a missing root produced an absolute path')
}
if (api.__internals.mentionInto({ insertText: () => true, captureInsertion: () => ({}) }, undefined) !== 'no-path') {
  throw new Error('a missing root was not reported as no-path')
}
if (api.__internals.mentionInto(undefined, 'D:/知识库/笔记/foo.md') !== 'no-actions') {
  throw new Error('a missing composer was not reported as no-actions')
}
if (api.__internals.ATTACH_MESSAGE['no-path'] !== '无法引用这个路径') {
  throw new Error('ATTACH_MESSAGE lost its no-path line: ' + String(api.__internals.ATTACH_MESSAGE['no-path']))
}
const noteRoundTrip = parseNoteAddress(noteAddress('笔记/foo bar.md'))
if (noteRoundTrip !== '笔记/foo bar.md') throw new Error('note address does not round-trip: ' + noteRoundTrip)
if (parseNoteAddress('dsh-resource://file/session/x/y.md') !== undefined) {
  throw new Error('a foreign address is accepted as a note address')
}

// ── markdown renderer against a real note ──────────────────────────────────
const sample = [
  '---',
  'tags: [demo]',
  '---',
  '# 标题',
  '',
  '普通段落，包含 **加粗**、`行内代码`、[[双链|别名]] 与 [链接](https://example.com)。',
  '',
  '- 项目一',
  '- 项目二',
  '',
  '1. 第一',
  '2. 第二',
  '',
  '> 引用一行',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '---',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| a1 | b1 |',
  '| a2 | b2 |',
  '',
  '结尾段落。',
].join('\n')

const blocks = api.__internals.renderMarkdown(sample)
if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('markdown renderer produced no blocks')
const markdownHtml = renderToStaticMarkup(React.createElement('div', null, blocks))
for (const needle of ['标题', '加粗', '双链', '项目一', '第一', '引用一行', 'const a = 1;', '结尾段落']) {
  if (!markdownHtml.includes(needle)) throw new Error('markdown output lost: ' + needle)
}
if (markdownHtml.includes('tags: [demo]')) throw new Error('frontmatter was not stripped')

// A GFM table must become a real table. Before this it rendered as a paragraph of
// pipes, which is most of what a note with a table looked like: 排版乱.
if (!markdownHtml.includes('<table')) throw new Error('a GFM table was not rendered as a table')
if (!markdownHtml.includes('<th')) throw new Error('the table lost its header cells')
if (!markdownHtml.includes('a1') || !markdownHtml.includes('b2')) throw new Error('the table lost its body rows')
if (markdownHtml.includes('| 列 A |')) throw new Error('the table header still rendered as raw pipes')
// A lone `---` is still a rule, not a table.
const ruleOnly = api.__internals.renderMarkdown('a\n\n---\n\nb')
if (renderToStaticMarkup(React.createElement('div', null, ruleOnly)).includes('<table')) {
  throw new Error('a thematic break was mistaken for a table')
}

// ── Obsidian reading-view metrics ──────────────────────────────────────────
// These are Obsidian's own default-theme numbers; drift here is what makes the
// page stop looking like Obsidian.
const typography = renderToStaticMarkup(React.createElement('div', null, api.__internals.renderMarkdown('# h1\n\n## h2\n\n正文\n')))
if (!typography.includes('1.618em')) throw new Error('h1 is not Obsidian\'s 1.618em')
if (!typography.includes('1.462em')) throw new Error('h2 is not Obsidian\'s 1.462em')
if (!typography.includes('font-weight:700')) throw new Error('h1 is not weight 700')
if (!typography.includes('2.5rem')) throw new Error('headings lost Obsidian\'s 2.5rem top spacing')
const quoteHtml = renderToStaticMarkup(React.createElement('div', null, api.__internals.renderMarkdown('> q\n')))
if (!quoteHtml.includes('border-left:2px')) throw new Error('the quote rule is not Obsidian\'s 2px')
if (!quoteHtml.includes('padding:0 0 0 24px')) throw new Error('the quote is not indented 24px')

// ── Obsidian callouts and raw <details> ─────────────────────────────────────
// `高性价比人生指南（合订本）` ends every one of its 767 items with
// `> [!cite]- 来源（点开展开）`. Before this the marker leaked and every DOI spilled
// into the prose as one long quote; the fold is what makes that note readable.
const citeHtml = renderToStaticMarkup(React.createElement('div', null, api.__internals.renderMarkdown(
  '> [!cite]- 来源（点开展开）\n> 1. Neal B 等 (2021). NEJM. https://doi.org/10.1056/NEJMoa2105675\n')))
if (!citeHtml.includes('aria-expanded="false"')) throw new Error('a `-` callout is not folded')
if (citeHtml.includes('[!cite]')) throw new Error('the callout marker leaked into the output')
if (!citeHtml.includes('display:none')) throw new Error('a folded callout still shows its body')
if (!citeHtml.includes('来源（点开展开）')) throw new Error('the callout title was lost')
if (!citeHtml.includes('https://doi.org/')) throw new Error('the folded body was dropped from the DOM')
if (!citeHtml.includes('border-left:2px solid #5f6b7a')) throw new Error('the cite callout lost its own rule')
// The folded body is real markdown: the numbered source is a list, not run-on text.
if (!citeHtml.includes('<ol')) throw new Error('the folded body was not rendered as markdown')

// `+` is Obsidian's "open but foldable" state.
const openCallout = renderToStaticMarkup(React.createElement('div', null,
  api.__internals.renderMarkdown('> [!cite]+ 来源\n> 正文\n')))
if (!openCallout.includes('aria-expanded="true"')) throw new Error('a `+` callout is not expanded')

// A callout with no fold marker is expanded and NOT foldable, exactly like Obsidian.
const plainCallout = renderToStaticMarkup(React.createElement('div', null,
  api.__internals.renderMarkdown('> [!tip] 2026-07-18 新增\n> 内容\n')))
if (plainCallout.includes('aria-expanded')) throw new Error('a bare callout became foldable')
if (plainCallout.includes('display:none')) throw new Error('a bare callout hid its body')
if (!plainCallout.includes('2026-07-18 新增')) throw new Error('the tip callout title was lost')

// A `>` block that is not a callout must keep the quote typography asserted above.
const stillQuote = renderToStaticMarkup(React.createElement('div', null,
  api.__internals.renderMarkdown('> [!not a callout\n')))
if (!stillQuote.includes('border-left:2px')) throw new Error('a non-callout quote lost its rule')

// The same note folds its 41-term glossary in raw HTML <details>.
const detailsHtml = renderToStaticMarkup(React.createElement('div', null, api.__internals.renderMarkdown([
  '<details>',
  '<summary>展开 41 条术语</summary>',
  '',
  '| 术语 | 意思 |',
  '| --- | --- |',
  '| HR | 风险比 |',
  '',
  '</details>',
  '',
  '结尾段落。',
].join('\n'))))
if (detailsHtml.includes('&lt;details&gt;')) throw new Error('raw <details> leaked as text')
if (!detailsHtml.includes('aria-expanded="false"')) throw new Error('a <details> block is not folded')
if (!detailsHtml.includes('展开 41 条术语')) throw new Error('the <summary> text was lost')
if (!detailsHtml.includes('<table')) throw new Error('the table inside <details> was not rendered')
if (!detailsHtml.includes('结尾段落')) throw new Error('content after </details> was swallowed')

// ── same-note heading links (`[[#标题]]`, `[x](#锚点)`) ─────────────────────
// The compiled guide's entire table of contents is 45 cells of
// `[[#第 N 节 …\|N. 短标题]]`: an ALIAS PIPE escaped for the table parser, and a
// heading in the same note. Every one was a dead button before this.
function walkElements(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit)
    return
  }
  if (typeof node !== 'object' || node.props === undefined) return
  visit(node)
  walkElements(node.props.children, visit)
}

function buttonsIn(blocks) {
  const found = []
  walkElements(blocks, (element) => {
    if (element.type === 'button' && typeof element.props.onClick === 'function') found.push(element)
  })
  return found
}

const clicks = []
const anchors = []
const inline = api.__internals.renderMarkdown(
  '| 节 |\n| --- |\n| [[#第 1 节 不要早死\\|1. 不要早死]] |\n',
  (target) => clicks.push('link:' + target),
  undefined,
  (anchor) => anchors.push(anchor),
)
const inlineHtml = renderToStaticMarkup(React.createElement('div', null, inline))
if (!inlineHtml.includes('1. 不要早死')) throw new Error('the aliased TOC cell lost its label')
if (inlineHtml.includes('[!')) throw new Error('raw markdown leaked into the TOC cell')
const tocButtons = buttonsIn(inline)
if (tocButtons.length !== 1) throw new Error('a same-note heading link is not one button: ' + tocButtons.length)
if (tocButtons[0].props.children !== '1. 不要早死') throw new Error('the TOC button shows the wrong label')
tocButtons[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
if (anchors.length !== 1 || anchors[0] !== '第 1 节 不要早死') {
  throw new Error('the escaped-pipe anchor was not unescaped: ' + JSON.stringify(anchors))
}
if (clicks.length !== 0) throw new Error('a same-note heading link went to the note resolver')

// `[x](#锚点)` is the other same-note spelling (53 of them in this vault).
const mdAnchors = []
const mdInline = api.__internals.renderMarkdown('[目录](#目录) 与 [外链](https://example.com)\n', undefined, undefined, (anchor) => mdAnchors.push(anchor))
const mdHtml = renderToStaticMarkup(React.createElement('div', null, mdInline))
if (!mdHtml.includes('href="https://example.com"')) throw new Error('a real external link stopped being a link')
if (!mdHtml.includes('target="_blank"')) throw new Error('an external link lost target=_blank')
const mdButtons = buttonsIn(mdInline)
if (mdButtons.length !== 1) throw new Error('a fragment link is not one button: ' + mdButtons.length)
mdButtons[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
if (mdAnchors.length !== 1 || mdAnchors[0] !== '目录') throw new Error('the #目录 link did not target its heading: ' + JSON.stringify(mdAnchors))

// `[[笔记#标题]]` opens the NOTE and carries the anchor: the heading is not part of its
// name, but the opened page needs it to scroll after it has drawn the note.
const crossClicks = []
const cross = api.__internals.renderMarkdown(
  '[[沙盘游戏治疗/团体箱庭疗法#团体沙盘游戏规则|团体]], [[普通笔记]]\n',
  (target, anchor) => crossClicks.push(target + ' § ' + (anchor === undefined ? '' : anchor)),
)
for (const button of buttonsIn(cross)) button.props.onClick({ preventDefault() {}, stopPropagation() {} })
if (crossClicks.join('|') !== '沙盘游戏治疗/团体箱庭疗法 § 团体沙盘游戏规则|普通笔记 § ') {
  throw new Error('cross-note links resolve wrongly: ' + JSON.stringify(crossClicks))
}

// Without an anchor navigator there is no dead button: the span says the link is inert.
const inert = renderToStaticMarkup(React.createElement('div', null, api.__internals.renderMarkdown('[[#目录|目录]]\n')))
if (inert.includes('<button')) throw new Error('an anchor became a button with no navigator')
if (!inert.includes('dashed')) throw new Error('an inert anchor lost its dashed underline')

// Obsidian matches the heading TEXT; the slug form is the fallback for converted notes.
if (api.__internals.obsidianSlug('一、概述与定义') !== '一概述与定义') throw new Error('the heading slug is not GitHub-flavoured')
if (api.__internals.decodeFragment('%E7%9B%AE%E5%BD%95') !== '目录') throw new Error('a percent-encoded fragment is not decoded')

// `^block-id` marks a block; the marker is notation, never content, and the block carries
// the id so `[[笔记#^block-id]]` can land on it.
function findByProp(blocks, prop) {
  let found = null
  walkElements(blocks, (element) => { if (found === null && element.props[prop] !== undefined) found = element })
  return found
}
const markedParagraph = api.__internals.renderMarkdown('一段需要被引用的文字 ^abc-1\n')
const markedNode = findByProp(markedParagraph, 'data-block-id')
if (markedNode === null) throw new Error('a ^block-id paragraph did not expose its block id')
if (markedNode.props['data-block-id'] !== 'abc-1') throw new Error('the block id is wrong: ' + markedNode.props['data-block-id'])
const markedHtml = renderToStaticMarkup(React.createElement('div', null, markedParagraph))
if (markedHtml.includes('^abc-1')) throw new Error('the ^block-id marker leaked into the page')
if (!markedHtml.includes('一段需要被引用的文字')) throw new Error('a marked block lost its text')
const markedItem = findByProp(api.__internals.renderMarkdown('- 列表项 ^list-1\n'), 'data-block-id')
if (markedItem === null || markedItem.props['data-block-id'] !== 'list-1') throw new Error('a ^block-id list item did not expose its block id')

// The matching chain: exact (Obsidian's rule) → slug → UNIQUE containment. An ambiguous
// containment is refused rather than guessed.
if (api.__internals.matchHeading(['5.1 整合性 (Integration)', '二、别的'], '5.1 整合性 (Integration)') !== '5.1 整合性 (Integration)') {
  throw new Error('an exact heading no longer matches')
}
if (api.__internals.matchHeading(['5.1 整合性 (Integration)', '二、别的'], '整合性') !== '5.1 整合性 (Integration)') {
  throw new Error('an abbreviated anchor no longer matches a unique heading')
}
if (api.__internals.matchHeading(['1. 整合性 A', '2. 整合性 B'], '整合性') !== null) {
  throw new Error('an ambiguous anchor was guessed instead of refused')
}
if (api.__internals.matchHeading(['一、概述与定义'], '一概述与定义') !== '一、概述与定义') {
  throw new Error('the slug fallback stopped matching')
}
if (api.__internals.matchHeading(['目录'], '') !== null) throw new Error('an empty anchor matched something')

// The render cap must not cut a note the host is willing to send. The compiled guide
// is 11,738 lines; at 3,000 the page ended at its 7th chapter, so 39 of the 45 table
// of contents links pointed at headings that were never drawn.
const longNote = []
for (let index = 0; index < 4000; index += 1) {
  longNote.push('第 ' + index + ' 行正文。')
  if (index % 500 === 0) longNote.push('## 小节 ' + index)
}
longNote.push('## 末尾标题 3999')
let sawLastHeading = false
walkElements(api.__internals.renderMarkdown(longNote.join('\n')), (element) => {
  if (element.props['data-outline'] === undefined) return
  if (JSON.stringify(element.props.children).includes('末尾标题 3999')) sawLastHeading = true
})
if (!sawLastHeading) throw new Error('the render cap cut a 4,000-line note before its last heading')

// ── properties (frontmatter) ───────────────────────────────────────────────
// Frontmatter used to be dropped as "metadata, not prose". A sidebar reader wants
// the opposite: what the note IS, and how it is filed.
const parsed = api.__internals.parseProperties([
  '---',
  'title: "中国本土化发展"',
  'type: entity',
  'tags: [心理学, 沙盘游戏]',
  'aliases:',
  '  - 本土化',
  '  - 中国文化',
  'draft: true',
  'weight: 12',
  'created: 2026-06-06',
  'parent: "[[沙盘游戏治疗]]"',
  '---',
  '',
  '# 正文',
].join('\n'))
const kinds = Object.fromEntries(parsed.rows.map((row) => [row.key, row.kind]))
if (kinds.title !== 'text') throw new Error('a quoted title is not text: ' + kinds.title)
if (kinds.tags !== 'list') throw new Error('an inline list is not a list: ' + kinds.tags)
if (kinds.aliases !== 'list') throw new Error('a block list is not a list: ' + kinds.aliases)
if (kinds.draft !== 'boolean') throw new Error('a boolean property is not a boolean: ' + kinds.draft)
if (kinds.weight !== 'number') throw new Error('a number property is not a number: ' + kinds.weight)
if (kinds.created !== 'date') throw new Error('a date property is not a date: ' + kinds.created)
if (parsed.rows.find((row) => row.key === 'aliases').value.length !== 2) throw new Error('a block list lost its items')
if (parsed.body.includes('title:')) throw new Error('the body still carries frontmatter')
if (!parsed.body.includes('# 正文')) throw new Error('the body lost its prose')
const propertiesHtml = renderToStaticMarkup(React.createElement(api.__internals.PropertiesCard, {
  rows: parsed.rows,
  onLink: () => {},
}))
if (!propertiesHtml.includes('data-dsh-obsidian-properties="8"')) throw new Error('the properties card did not render every row')
if (!propertiesHtml.includes('沙盘游戏治疗')) throw new Error('a link-valued property lost its link text')
if (propertiesHtml.includes('title:</span>')) throw new Error('a property key leaked its YAML form')

// ── broken-link styling + hover preview (link hints) ───────────────────────
const hints = {
  statusOf: (target) => (target === '不存在的笔记' ? { known: true, missing: true } : { known: true, missing: false }),
  preview: () => {},
  hidePreview: () => {},
}
const hintedHtml = renderToStaticMarkup(React.createElement('div', null,
  api.__internals.renderMarkdown('[[存在]] 和 [[不存在的笔记]]\n', () => {}, undefined, () => {}, hints)))
if (!hintedHtml.includes('笔记不存在：不存在的笔记')) throw new Error('a broken link does not say it is broken')
if (!hintedHtml.includes('text-decoration-style:dashed')) throw new Error('a broken link is not styled apart from a working one')
const status = api.__internals.linkStatus({ notes: { 'a.md': { links: [{ target: '存在', resolved: 'b.md' }, { target: '不存在', resolved: null }] } } }, 'a.md', '不存在')
if (status.known !== true || status.missing !== true) throw new Error('linkStatus does not report a broken link')
if (api.__internals.linkStatus(null, 'a.md', 'x').known !== false) throw new Error('linkStatus invented an opinion without an index')

// Backlinks are derived from the index, not stored: the note never writes them.
const index = {
  notes: {
    'a.md': { title: '甲', excerpt: '甲的开头', tags: [], links: [{ target: '乙', anchor: '', line: '见 [[乙]]', resolved: 'b.md' }] },
    'b.md': { title: '乙', excerpt: '乙的开头', tags: [], links: [] },
    'c.md': { title: '丙', excerpt: '丙的开头', tags: [], links: [{ target: '乙', anchor: '小节', line: '丙里提到 [[乙#小节]]', resolved: 'b.md' }] },
  },
}
const backlinks = api.__internals.backlinksOf(index, 'b.md')
if (backlinks.length !== 2) throw new Error('backlinks were not derived: ' + backlinks.length)
if (backlinks[0].line === '' || backlinks[1].line === '') throw new Error('a backlink row lost the line that makes it')
if (api.__internals.outlinksOf(index, 'a.md').length !== 1) throw new Error('outlinks were not derived')
if (api.__internals.previewOf(index, '乙') === null || api.__internals.previewOf(index, '乙').title !== '乙') {
  throw new Error('previewOf does not find a note by name')
}
const backHtml = renderToStaticMarkup(React.createElement(api.__internals.RelatedPanel, {
  backlinks,
  outlinks: api.__internals.outlinksOf(index, 'a.md'),
  onOpen: () => {},
  onRefresh: () => {},
  error: '',
}))
if (!backHtml.includes('data-dsh-obsidian-related="2:1"')) throw new Error('the related panel did not count its edges')
if (!backHtml.includes('引用本文') || !backHtml.includes('本文引用')) throw new Error('the related panel lost a section')
const previewHtml = renderToStaticMarkup(React.createElement(api.__internals.LinkPreview, {
  preview: { title: '乙', excerpt: '乙的开头', missing: false, x: 10, y: 10 },
}))
if (!previewHtml.includes('data-dsh-obsidian-preview="note"')) throw new Error('the hover card did not render')
const missingPreview = renderToStaticMarkup(React.createElement(api.__internals.LinkPreview, {
  preview: { title: '无', excerpt: '', missing: true, x: 10, y: 10 },
}))
if (!missingPreview.includes('这篇笔记不存在')) throw new Error('the hover card does not say when the target is missing')

// ── report ─────────────────────────────────────────────────────────────────
console.log('client.js harness OK')
console.log('  tab type   :', tabType.kind, '-> id', tabType.id, 'title', JSON.stringify(tabType.title('')))
console.log('  seats      :', registered.map((entry) => entry.metadata.name).join(', '))
console.log('  effects    :', effects.join(', '))
console.log('  markdown   :', blocks.length, 'blocks ->', markdownHtml.length, 'bytes of HTML')
console.log('  panel HTML :', rendered.panel.length, 'bytes')
