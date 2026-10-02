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
    renderSlot: () => null,
    SessionProvider: (props) => props.children,
    inputActions: { setDraft: () => {} },
  }))
  if (!markup.includes('搜索整个库')) throw new Error('the tree panel did not render without Sessions')
  // The way in must be there and must SAY so rather than doing nothing: the click runs
  // `openVaultConversation`, which reports the missing navigation.
  if (!markup.includes('对话')) throw new Error('the panel lost its way into the conversation')
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
// The conversation is NOT in this panel's markup: the shell shows it in the centre,
// so the only thing the tree panel owes the reader is the control that opens it.
if (rendered.panel.includes('data-dsh-obsidian-chat-page') || rendered.panel.includes('data-dsh-obsidian-chat-dock')) {
  throw new Error('a conversation rendered inside the tree panel')
}
if (!rendered.panel.includes('对话')) {
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

// ── report ─────────────────────────────────────────────────────────────────
console.log('client.js harness OK')
console.log('  tab type   :', tabType.kind, '-> id', tabType.id, 'title', JSON.stringify(tabType.title('')))
console.log('  seats      :', registered.map((entry) => entry.metadata.name).join(', '))
console.log('  effects    :', effects.join(', '))
console.log('  markdown   :', blocks.length, 'blocks ->', markdownHtml.length, 'bytes of HTML')
console.log('  panel HTML :', rendered.panel.length, 'bytes')
