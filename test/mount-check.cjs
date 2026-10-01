// Real mount test for the dsh-obsidian panel.
//
// The render-check harness server-renders, which never runs effects and never
// reaches the populated states. That gap is exactly where the panel's first real
// bug hid: the slot framework retired the tab body after a render crash
// (`reportEntryError` → `abdicated`), so the pane came up blank. This harness
// mounts the panel into jsdom with a stubbed fetch and drives it through every
// state the shell can put it in.
//
// Run: node test/mount-check.cjs

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createRequire } = require('node:module')

// Resolve from this package's own devDependencies (react/react-dom pinned to the
// 18.2.0 the shell itself bundles). It used to borrow these from the DSH source
// checkout, which made the harness hostage to a directory that has nothing to do
// with this plugin — and which was deleted out from under it.
const resolveFrom = createRequire(join(__dirname, '..', 'package.json'))
const { JSDOM } = resolveFrom('jsdom')
const React = resolveFrom('react')
const ReactDOMClient = resolveFrom('react-dom/client')
const { Simulate } = resolveFrom('react-dom/test-utils')

// ── jsdom environment ──────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:19387/',
})
const { window } = dom

// A 2D context stand-in: jsdom has no canvas, so any future drawing path runs
// here instead of bailing out at `getContext() === null` and hiding its own bugs.
const context2d = {
  globalAlpha: 1, strokeStyle: '', fillStyle: '', lineWidth: 1,
  font: '', textAlign: '', textBaseline: '',
  setTransform() {}, clearRect() {}, save() {}, restore() {},
  translate() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {},
  stroke() {}, arc() {}, fill() {}, fillText() {}, setLineDash() {},
  measureText: (text) => ({ width: String(text).length * 6 }),
}
window.HTMLCanvasElement.prototype.getContext = function getContext() { return context2d }

window.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.window = window
global.document = window.document
global.navigator = window.navigator
global.HTMLElement = window.HTMLElement
global.HTMLCanvasElement = window.HTMLCanvasElement
global.Element = window.Element
global.Node = window.Node
global.MouseEvent = window.MouseEvent
global.Event = window.Event
global.getComputedStyle = window.getComputedStyle.bind(window)
global.requestAnimationFrame = window.requestAnimationFrame.bind(window)
global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
global.ResizeObserver = window.ResizeObserver
global.IS_REACT_ACT_ENVIRONMENT = false

// ── capture anything React or the page throws ──────────────────────────────
const failures = []
const originalError = console.error
console.error = (...args) => {
  const text = args.map((value) => (value instanceof Error ? value.stack : String(value))).join(' ')
  // React's act() advisory is noise here; everything else is a real signal.
  if (!/not wrapped in act|ReactDOMTestUtils.act/.test(text)) failures.push(text)
}

// ── load the artifact exactly as the module table does ─────────────────────
let registration = null
window.__ModuleLoader__ = { load: (value) => { registration = value } }
new Function('window', 'fetch', readFileSync(join(__dirname, '..', 'client.js'), 'utf8'))(
  window,
  (...args) => global.fetch(...args),
)
if (registration === null) throw new Error('client.js never registered with the module loader')

const api = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('no module for ' + specifier)
})

// ── a vault-shaped fetch stub ──────────────────────────────────────────────
const TREE = {
  '': [
    { type: 'dir', name: '笔记', path: '笔记' },
    { type: 'file', name: 'README.md', path: 'README.md' },
  ],
  '笔记': [
    { type: 'file', name: '知识索引.md', path: '笔记/知识索引.md' },
    { type: 'file', name: '双向链接.md', path: '笔记/双向链接.md' },
  ],
}
const NOTE = '---\ntags: [demo]\n---\n# 标题\n\n正文 **加粗** 与 [[双向链接|别名]]。\n\n- 一\n- 二\n'

// A note whose heading ladder exercises the outline: three depths, and a second
// heading at a level that has already been used, so the list cannot pass by
// rendering a straight line.
const OUTLINE_NOTE_PATH = '大纲.md'
const OUTLINE_NOTE = '# 一级\n\n段落\n\n## 二级甲\n\n文字\n\n### 三级\n\n文字\n\n## 二级乙\n\n文字\n'
const OUTLINE_TEXTS = ['一级', '二级甲', '三级', '二级乙']

const requests = []
const posts = []
// The vault folder the reader has agreed to. `null` is the first-run state: the
// panel must show the chooser and must NOT read any folder.
let chosenVault = null
const vaultPosts = []
// Empty means "nothing remembered yet"; the reuse step below sets an id.
let rememberedChatSession = ''
// Session ids the fake service's own `binding` lookup does NOT know, i.e. the
// remembered id names a Session that no longer exists. A step adds an id here to
// make it stale without touching any real state file.
const missingSessionIds = new Set()
// Failures and truncation the harness turns on per step.
let chatReadFails = false
let treeTruncated = false
let searchTruncated = false
let failTreePath = ''
// Responses this harness RELEASES by hand, so a stale one can be made to land
// after a newer one and prove the client dropped it.
const deferredNoteReleases = []
const deferredSearchReleases = []
let deferNotePath = ''
let deferSearchQuery = ''
const SLOW_NOTE_PATH = '笔记/慢.md'
const SLOW_NOTE_TEXT = '慢内容一行'
const FAST_NOTE_PATH = '笔记/快.md'
const FAST_NOTE_TEXT = '快内容一行'
const SLOW_SEARCH_QUERY = '慢查询'
const SLOW_SEARCH_TEXT = '旧搜索结果'
const FAST_SEARCH_TEXT = '命中一行'

/** A response object at the shape the client's `getJson` expects. */
const respond = (body, ok, status) => ({
  ok: ok === undefined ? true : ok,
  status: status === undefined ? 200 : status,
  json: () => Promise.resolve(body),
})

global.fetch = (url, options) => {
  const target = String(url)
  requests.push(target)
  if (options !== undefined && options.method === 'POST') {
    let parsed = {}
    try { parsed = JSON.parse(options.body || '{}') } catch (err) { parsed = { _unparsable: true } }
    posts.push({ url: target, body: parsed })
  }
  let body
  if (target.startsWith('/dsh-obsidian/tree')) {
    const query = target.indexOf('?path=') >= 0 ? decodeURIComponent(target.slice(target.indexOf('?path=') + 6)) : ''
    if (query !== '' && query === failTreePath) return Promise.resolve(respond({ error: 'boom-dir' }))
    body = { vault: '知识库', root: 'D:\\知识库', path: query, truncated: treeTruncated, entries: TREE[query] ?? [] }
  } else if (target.startsWith('/dsh-obsidian/note')) {
    const query = target.indexOf('?path=') >= 0 ? decodeURIComponent(target.slice(target.indexOf('?path=') + 6)) : ''
    const text = query === SLOW_NOTE_PATH ? SLOW_NOTE_TEXT
      : (query === FAST_NOTE_PATH ? FAST_NOTE_TEXT
        : (query === OUTLINE_NOTE_PATH ? OUTLINE_NOTE : NOTE))
    body = { root: 'D:\\知识库', path: query, size: text.length, mtimeMs: Date.now(), truncated: false, text }
    // The stale answer is held until the harness releases it.
    if (query === deferNotePath && deferNotePath !== '') {
      return new Promise((resolve) => { deferredNoteReleases.push(() => resolve(respond(body))) })
    }
  } else if (target.startsWith('/dsh-obsidian/resolve-link')) {
    body = { name: '双向链接', matches: [{ path: '笔记/知识索引.md', name: '知识索引.md' }], ambiguous: false }
  } else if (target.startsWith('/dsh-obsidian/search')) {
    const query = target.indexOf('?q=') >= 0 ? decodeURIComponent(target.slice(target.indexOf('?q=') + 3).split('&')[0]) : ''
    const hits = query === SLOW_SEARCH_QUERY
      ? [{ path: '旧.md', line: 1, text: SLOW_SEARCH_TEXT }]
      : [{ path: 'README.md', line: 1, text: FAST_SEARCH_TEXT }]
    body = { query, results: hits, truncated: searchTruncated, filesScanned: 3 }
    if (query === deferSearchQuery && deferSearchQuery !== '') {
      return new Promise((resolve) => { deferredSearchReleases.push(() => resolve(respond(body))) })
    }
  } else if (target.startsWith('/dsh-obsidian/open')) {
    body = { opened: true, uri: 'obsidian://open', vault: '知识库', app: 'D:/APP/Obsidian/Obsidian.exe', via: 'executable' }
  } else if (target.startsWith('/dsh-obsidian/chat')) {
    // What the host remembers as the vault conversation. Empty on a first run, and
    // a Session id afterwards — which is what makes history survive a restart.
    if (chatReadFails) return Promise.resolve(respond({ error: 'chat read failed' }, false, 500))
    body = { sessionId: rememberedChatSession }
  } else if (target.startsWith('/dsh-obsidian/vault')) {
    // The remembered vault folder. A POST records the choice; a GET reports it.
    if (options !== undefined && options.method === 'POST') {
      const sent = JSON.parse(String(options.body))
      chosenVault = sent.path
      vaultPosts.push(sent.path)
    }
    body = { path: chosenVault, name: '知识库', detected: 'D:\\知识库', chosen: chosenVault, source: chosenVault === null ? 'none' : 'chosen' }
  } else if (target.startsWith('/dsh-obsidian/status')) {
    body = {
      vault: '知识库',
      vaultPath: 'D:\\知识库',
      app: 'D:/APP/Obsidian/Obsidian.exe',
      appFound: true,
      subprocess: true,
    }
  } else {
    body = { error: 'unexpected request: ' + target }
  }
  return Promise.resolve(respond(body))
}
window.fetch = global.fetch

// ── fake context, capturing the seats ──────────────────────────────────────
const registered = []
const chatSessionId = 'session-vault-chat'
const createdSessions = []
const workspaceCalls = []
const retained = []
const inserted = []
const openedResources = []
const declaredChildren = new Map()
let chatWindow = { entries: [] }
// The sessions service's own lookup for "does this Session exist". The resolver
// uses it to tell a remembered Session from a stale id; undefined is the answer
// for an id in `missingSessionIds`, anything else is a live binding.
const sessionBinding = (id) => (missingSessionIds.has(id)
  ? undefined
  : { id, options: {}, release: () => {} })
const sessionsService = {
  create: (options) => { createdSessions.push(options); return Promise.resolve(chatSessionId) },
  retain: (id, options) => {
    const reference = { binding: { eventSource: { getSnapshot: () => chatWindow } }, id, options, released: false }
    reference.release = () => { reference.released = true }
    retained.push(reference)
    return reference
  },
  binding: sessionBinding,
}
// Idempotent by contract, which is what stops the vault's Workspace being
// registered twice on every mount.
const workspacesService = {
  create: (input) => {
    workspaceCalls.push(input)
    return Promise.resolve({
      workspaceId: 'ws-vault',
      path: input.path,
      title: '知识库',
      sessionIds: [chatSessionId],
    })
  },
}
const ctx = {
  effect: (callback) => { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
  // Sessions and Workspaces are reached ONLY through `get` in client.js: they are
  // not injected, so a profile without them still gets the tree.
  get: (name) => {
    if (name === 'sessions') return sessionsService
    if (name === 'workspaces') return workspacesService
    return undefined
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: {
    openTab: () => {},
    openResource: (address) => { openedResources.push(address) },
  },
  slots: {
    inject(slot, register) { register() },
    register(metadata, component) {
      // Mirror the real slots core: one declaration per slot, and a second THROWS
      // inside apply — which rolls back every registration the plugin made.
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
api.apply(ctx)

const pane = registered.find((entry) => entry.metadata.name === 'sidebar.right.pane.tab'
  && entry.metadata.key === api.__internals.TAB_ID)
if (pane === undefined) throw new Error('the notes tab body was never registered')

// React 18 commits concurrently and jsdom fires rAF on a real timer, so give it
// wall-clock time rather than only microtask turns.
const flush = async (rounds) => {
  const total = rounds ?? 8
  for (let i = 0; i < total; i += 1) await new Promise((resolve) => setTimeout(resolve, 4))
}

const host = document.getElementById('host')
const root = ReactDOMClient.createRoot(host)

const steps = []
function step(label, run) { steps.push({ label, run }) }

const findButton = (label) => [...host.querySelectorAll('button')]
  .find((button) => (button.textContent || '').includes(label))

/** Click the element whose own text (not its descendants') is exactly `label`. */
const clickText = (label) => {
  const own = (element) => [...element.childNodes]
    .filter((child) => child.nodeType === 3)
    .map((child) => child.textContent)
    .join('')
    .trim()
  const node = [...host.querySelectorAll('*')].filter((element) => own(element) === label).pop()
  if (node === undefined) {
    const seen = [...host.querySelectorAll('*')].map(own).filter((text) => text !== '').slice(0, 25)
    throw new Error('no element with text ' + JSON.stringify(label) + '; saw ' + JSON.stringify(seen))
  }
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

// Props every panel occurrence needs: the conversation seat's render share, and
// the input face the "attach this note" button writes into.
const seatProps = {
  renderSlot: () => React.createElement('div', null, 'CONVERSATION_SEAT'),
  SessionProvider: (props) => props.children,
  inputActions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: (text) => { inserted.push(text); return true },
  },
}

step('mount the tab body', async () => {
  root.render(React.createElement(pane.component, seatProps))
  await flush()
  const input = host.querySelector('input')
  if (input === null || (input.placeholder || '').includes('搜索') === false) {
    throw new Error('search box did not render')
  }
})

step('the conversation box sits inside the panel, bound to the knowledge base', async () => {
  const dock = host.querySelector('[data-dsh-obsidian-chat-dock]')
  if (dock === null) throw new Error('the knowledge base panel has no conversation box')
  if (dock.getAttribute('data-dsh-obsidian-chat-dock') !== 'ready') {
    throw new Error('the box never became ready: ' + (host.textContent || '').slice(0, 140))
  }
  // A Session created with only a `cwd` belongs to NO Workspace, and the
  // conversation then opens on the blank "new Session" screen with a workspace
  // picker — which is exactly the complaint. The Workspace must be resolved first.
  if (workspaceCalls.length !== 1) throw new Error('workspaces.create ran ' + workspaceCalls.length + ' time(s)')
  if (workspaceCalls[0].path !== 'D:\\知识库') {
    throw new Error('resolved a Workspace for ' + String(workspaceCalls[0].path) + ' instead of the vault')
  }
  if (createdSessions.length !== 1) throw new Error('sessions.create ran ' + createdSessions.length + ' time(s)')
  if (createdSessions[0].workspaceId !== 'ws-vault') {
    throw new Error('the Session was not created inside the vault Workspace: ' + JSON.stringify(createdSessions[0]))
  }
  if (createdSessions[0].cwd !== 'D:\\知识库') throw new Error('the Session got the wrong cwd')
  if (retained.length !== 1) throw new Error('the box retained ' + retained.length + ' Session(s)')
  if (!host.textContent.includes('CONVERSATION_SEAT')) throw new Error('the conversation seat did not render')
  if (!host.textContent.includes('只服务这个知识库')) throw new Error('the box lost its scope label')
  // The conversation surface must be a ROW flex, like the shipped sidebar chat's
  // root: that is what stretches the conversation to the box's full height and puts
  // its composer at the BOTTOM. A column sizes it to its content and parks the
  // composer at the top of the box, which reads as "the dialog is at the top".
  const surface = host.querySelector('[data-dsh-obsidian-chat-surface]')
  if (surface === null) throw new Error('the conversation box has no surface element')
  if (surface.style.display !== 'flex') throw new Error('the conversation surface is not a flex box')
  if (surface.style.flexDirection === 'column') {
    throw new Error('the conversation surface is a column, which parks the composer at the top')
  }
  if (surface.style.height === '' && surface.style.flex === '') {
    throw new Error('the conversation surface cannot fill the box')
  }
})

step('the conversation box height is draggable and remembered', async () => {
  const grip = host.querySelector('[data-dsh-obsidian-chat-grip]')
  if (grip === null) throw new Error('the conversation box has no drag handle')
  const dock = host.querySelector('[data-dsh-obsidian-chat-dock]')
  const before = Number(String(dock.style.height).replace('px', ''))
  if (!(before > 0)) throw new Error('the box has no height to drag: ' + dock.style.height)

  // Drag the grip upward: the box must grow.
  const pointer = (type, clientY) => new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY })
  grip.dispatchEvent(pointer('pointerdown', 300))
  grip.dispatchEvent(pointer('pointermove', 240))
  grip.dispatchEvent(pointer('pointerup', 240))
  await flush()

  const after = Number(String(dock.style.height).replace('px', ''))
  if (!(after > before)) throw new Error('dragging up did not grow the box: ' + before + ' -> ' + dock.style.height)
  const stored = window.localStorage.getItem('dsh-obsidian/chat-height')
  if (stored !== String(Math.round(after))) {
    throw new Error('the dragged height was not remembered: stored ' + String(stored) + ', box ' + after)
  }
})

step('the first run asks which folder is the vault, and remembers the answer', async () => {
  if (!host.textContent.includes('先选择知识库文件夹')) throw new Error('the first run did not ask for the vault')
  // Before the reader agrees, the panel must not read any folder.
  if (requests.some((url) => url.startsWith('/dsh-obsidian/tree'))) {
    throw new Error('the panel listed a folder before the reader agreed to one')
  }
  clickText('使用这个库')
  await flush()
  if (vaultPosts.length !== 1) throw new Error('the chosen vault was not recorded')
  if (vaultPosts[0] !== 'D:\\知识库') throw new Error('recorded the wrong vault: ' + String(vaultPosts[0]))
  if (host.textContent.includes('先选择知识库文件夹')) throw new Error('the chooser stayed after a vault was chosen')
  if (!host.textContent.includes('笔记')) throw new Error('the tree did not load after choosing the vault')
})

step('the vault is read exactly once when it is agreed to', async () => {
  // `adoptVault` and the agreement effect both used to call loadDir(''): the first
  // choice fetched the root tree twice. One selection, one request.
  const rootReads = requests.filter((url) => url === '/dsh-obsidian/tree').length
  if (rootReads !== 1) throw new Error('the vault root was read ' + rootReads + ' time(s) on first agreement')
})

step('the vault tree arrives and renders', async () => {
  if (host.textContent.includes('笔记') === false) throw new Error('tree entries did not render')
  // Obsidian's explorer shows a note without its extension.
  if (host.textContent.includes('README') === false) throw new Error('root file did not render')
  if (host.textContent.includes('README.md')) throw new Error('the .md extension should not be shown')
})

step('expanding a folder', async () => {
  clickText('笔记')
  await flush()
  if (host.textContent.includes('知识索引') === false) throw new Error('expanded folder did not render its children')
})

step('opening a note opens its own page, leaving the tree', async () => {
  clickText('知识索引')
  await flush()
  const expected = api.__internals.noteAddress('笔记/知识索引.md')
  if (openedResources.length === 0 || openedResources[openedResources.length - 1] !== expected) {
    throw new Error('the note did not open its own page: ' + JSON.stringify(openedResources))
  }
  // The tree must still be visible — the note did not replace it.
  if (host.querySelector('input') === null) throw new Error('the tree vanished')
  // The selected row now carries the attach button.
  if (host.textContent.includes('发送') === false) throw new Error('the selected note has no attach button')
})

step('attaching the selected note drops its mention into the main conversation', async () => {
  const attach = [...host.querySelectorAll('button')]
    .find((button) => (button.textContent || '').includes('发送'))
  if (attach === undefined) throw new Error('no attach button rendered')
  attach.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  if (inserted.length !== 1) throw new Error('insertText ran ' + inserted.length + ' time(s)')
  // ABSOLUTE, so the main conversation resolves it whatever its own workspace is.
  if (inserted[0] !== ' @D:/知识库/笔记/知识索引.md ') {
    throw new Error('wrong mention inserted: ' + JSON.stringify(inserted[0]))
  }
})

step('searching the vault', async () => {
  const input = host.querySelector('input')
  if (input === null) throw new Error('no search input')
  // Simulate goes through React's own event plumbing; a hand-rolled `input`
  // event does not reach its value tracker under jsdom.
  Simulate.change(input, { target: { value: '命中' } })
  // The panel debounces searches by 250ms.
  await new Promise((resolve) => setTimeout(resolve, 400))
  await flush()
  if (requests.some((url) => url.startsWith('/dsh-obsidian/search')) === false) {
    throw new Error('no search request was issued')
  }
  if (host.textContent.includes('命中一行') === false) throw new Error('search results did not render')
})

step('the note page renders the note and resolves its wikilinks', async () => {
  const noteBody = registered.find((entry) => entry.metadata.key === api.__internals.NOTE_TAB_ID)
  if (noteBody === undefined) throw new Error('the note tab body was not registered')

  const container = document.createElement('div')
  document.body.appendChild(container)
  const noteRoot = ReactDOMClient.createRoot(container)
  noteRoot.render(React.createElement(noteBody.component, {
    useTabInfo: () => ({ tab: { contentId: api.__internals.noteAddress('README.md') } }),
    inputActions: seatProps.inputActions,
  }))
  await flush()

  if (!container.textContent.includes('标题')) throw new Error('the note did not render')
  if (!container.textContent.includes('加粗')) throw new Error('the markdown body did not render')
  // The `[[双向链接|别名]]` wikilink became a clickable control labeled by its alias.
  const link = [...container.querySelectorAll('button')]
    .find((button) => (button.textContent || '').includes('别名'))
  if (link === undefined) throw new Error('the wikilink is not clickable')

  openedResources.length = 0
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush(20)
  if (requests.some((url) => url.startsWith('/dsh-obsidian/resolve-link')) === false) {
    throw new Error('the wikilink was not resolved')
  }
  // Following a link opens the target as its OWN page: it must not lose the page
  // you were reading.
  const target = api.__internals.noteAddress('笔记/知识索引.md')
  if (openedResources.length !== 1 || openedResources[0] !== target) {
    throw new Error('the link did not open its own page: ' + JSON.stringify(openedResources))
  }

  noteRoot.unmount()
  container.remove()
})

step('the note page outlines its headings and jumps to the one you pick', async () => {
  const noteBody = registered.find((entry) => entry.metadata.key === api.__internals.NOTE_TAB_ID)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const outlineRoot = ReactDOMClient.createRoot(container)
  outlineRoot.render(React.createElement(noteBody.component, {
    useTabInfo: () => ({ tab: { contentId: api.__internals.noteAddress(OUTLINE_NOTE_PATH) } }),
    inputActions: seatProps.inputActions,
  }))
  await flush()

  // Every rendered heading carries the anchor the outline scrolls to and its depth.
  const headings = [...container.querySelectorAll('[data-outline]')]
  const depths = headings.map((node) => node.getAttribute('data-outline')).join(',')
  if (headings.length !== 4 || depths !== '1,2,3,2') {
    throw new Error('heading anchors carry the wrong depth: ' + headings.length + ' -> ' + depths)
  }
  if (headings.some((node) => node.id === '')) throw new Error('a heading has no anchor id')

  // jsdom does not implement scrollIntoView; stand in for it and record the call.
  const scrolled = []
  window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolled.push({ node: this, options })
  }

  const outlineButton = [...container.querySelectorAll('button')]
    .find((button) => (button.textContent || '').trim() === '大纲')
  if (outlineButton === undefined) throw new Error('the note page has no outline control')
  outlineButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()

  const rows = [...container.querySelectorAll('button')]
    .filter((button) => OUTLINE_TEXTS.includes((button.textContent || '').trim()))
  if (rows.length !== 4) throw new Error('the outline listed ' + rows.length + ' of 4 headings')
  // Depth is shown as indentation, or a nested heading is indistinguishable.
  const pads = rows.map((row) => parseFloat(row.style.paddingLeft))
  if (!(pads[0] < pads[1] && pads[1] < pads[2])) {
    throw new Error('the outline does not indent by depth: ' + pads.join(' / '))
  }

  rows[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  if (scrolled.length !== 1) throw new Error('picking a heading scrolled ' + scrolled.length + ' time(s)')
  if (scrolled[0].node !== headings[2]) throw new Error('the outline jumped to the wrong heading')

  // The same control puts the panel away again.
  outlineButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  const stillListed = [...container.querySelectorAll('button')]
    .some((button) => OUTLINE_TEXTS.includes((button.textContent || '').trim()))
  if (stillListed) throw new Error('the outline stayed open after toggling it off')

  // Entering edit mode swaps the rendered page for a textarea: no stale outline.
  delete window.Element.prototype.scrollIntoView
  outlineRoot.unmount()
  container.remove()
})

step('the note page edits the file and saves it back', async () => {
  const noteBody = registered.find((entry) => entry.metadata.key === api.__internals.NOTE_TAB_ID)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const editRoot = ReactDOMClient.createRoot(container)
  editRoot.render(React.createElement(noteBody.component, {
    useTabInfo: () => ({ tab: { contentId: api.__internals.noteAddress('README.md') } }),
    inputActions: seatProps.inputActions,
  }))
  await flush()

  const editButton = [...container.querySelectorAll('button')]
    .find((button) => (button.textContent || '').includes('编辑'))
  if (editButton === undefined) throw new Error('the note page has no edit control')
  editButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()

  const textarea = container.querySelector('textarea')
  if (textarea === null) throw new Error('edit mode did not open an editor')
  if (textarea.value !== NOTE) throw new Error('the editor did not start from the file content')

  const edited = '# 改过\n\n新内容\n'
  Simulate.change(textarea, { target: { value: edited } })
  await flush()

  const saveButton = [...container.querySelectorAll('button')]
    .find((button) => (button.textContent || '').includes('保存'))
  if (saveButton === undefined) throw new Error('edit mode has no save control')
  saveButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush(20)

  const write = posts.find((entry) => entry.url === '/dsh-obsidian/note')
  if (write === undefined) throw new Error('nothing was posted to the note route')
  if (write.body.path !== 'README.md') throw new Error('saved the wrong path: ' + String(write.body.path))
  if (write.body.text !== edited) throw new Error('saved the wrong text: ' + JSON.stringify(write.body.text))
  if (!container.textContent.includes('已保存')) throw new Error('saving gave no feedback')
  if (container.querySelector('textarea') !== null) throw new Error('the editor did not close after saving')

  editRoot.unmount()
  container.remove()
})

step('the conversation seat renders a real conversation, never the fallback', async () => {
  const seat = registered.find((entry) => entry.metadata.name === api.__internals.PANEL_CHAT_SLOT)
  if (seat === undefined) throw new Error('nothing occupies ' + api.__internals.PANEL_CHAT_SLOT)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const seatRoot = ReactDOMClient.createRoot(container)

  // The phase decides which empty state the conversation shows. It is NEVER the
  // Hero: the Hero is the "start a new Session" screen with a workspace picker,
  // which is exactly what made the box read as a fresh conversation.
  const cases = [
    {
      label: 'blank Session whose summary is known blank',
      session: { blank: true, awaitingFirstTurn: true, running: false, openState: 'loading' },
      conversation: { activeTargets: new Set() },
      sessions: { byId: { 'session-vault-chat': { blank: true } } },
      expected: 'active',
    },
    {
      label: 'blank Session still loading its summary',
      session: { blank: true, awaitingFirstTurn: true, running: false, openState: 'loading' },
      conversation: { activeTargets: new Set() },
      sessions: { byId: {} },
      expected: 'settling',
    },
    {
      label: 'Session with a live target',
      session: { blank: false, awaitingFirstTurn: false, running: false, openState: 'open' },
      conversation: { activeTargets: new Set(['chat']) },
      sessions: { byId: {} },
      expected: 'active',
    },
  ]

  for (const testCase of cases) {
    const calls = []
    seatRoot.render(React.createElement(seat.component, {
      sessionId: 'session-vault-chat',
      useSession: (select) => select(testCase.session),
      useConversation: (select) => select(testCase.conversation),
      useSessions: (select) => select(testCase.sessions),
      renderFactorySlot: (name, props, options) => {
        calls.push({ name, props, options })
        return React.createElement('div', null, 'real conversation')
      },
    }))
    await flush()

    if (calls.length !== 1) throw new Error(testCase.label + ': renderFactorySlot ran ' + calls.length + ' time(s)')
    if (calls[0].name !== 'conversation.content') throw new Error(testCase.label + ': wrong factory ' + calls[0].name)
    if (calls[0].props.variant !== 'embedded') throw new Error(testCase.label + ': not rendered embedded')
    if (calls[0].props.hero !== false) throw new Error(testCase.label + ': the Hero was not suppressed')
    if (calls[0].props.phase !== testCase.expected) {
      throw new Error(testCase.label + ': expected phase ' + testCase.expected + ', got ' + calls[0].props.phase)
    }
    if (typeof calls[0].options?.slots?.views !== 'function') {
      throw new Error(testCase.label + ': no views override')
    }
    if (!container.textContent.includes('real conversation')) {
      throw new Error(testCase.label + ': the factory output never mounted')
    }
  }

  // A throw inside this seat retires the whole tab body, so an unfamiliar
  // snapshot must degrade instead of throwing. The stubs CALL the selector with a
  // missing value (`() => undefined` never ran the selector, so the real throw path
  // in `state.byId` went untested), and the factory is COUNTED: "degraded" in the
  // text alone would also pass if the factory were rendered twice or the old text
  // simply never left the DOM.
  const broken = [
    { useSession: (select) => select(undefined), useConversation: (select) => select(undefined), useSessions: (select) => select(undefined) },
    { useSession: (select) => select({}), useConversation: (select) => select({}), useSessions: (select) => select({}) },
    { useSession: (select) => select({ subagent: {} }), useConversation: (select) => select({ activeTargets: null }), useSessions: (select) => select({}) },
  ]
  for (const props of broken) {
    let factoryRuns = 0
    seatRoot.render(React.createElement(seat.component, {
      ...props,
      sessionId: 'session-vault-chat',
      renderFactorySlot: () => {
        factoryRuns += 1
        return React.createElement('div', null, 'degraded')
      },
    }))
    await flush()
    if (!container.textContent.includes('degraded')) throw new Error('a broken snapshot did not reach the factory')
    if (factoryRuns !== 1) throw new Error('a broken snapshot ran the factory ' + factoryRuns + ' time(s)')
  }

  seatRoot.unmount()
  container.remove()
})

step('a remembered Session is reused, so history survives a restart', async () => {
  // The resolver memoises one promise per page load; drop it so this exercises a
  // second resolution the way a fresh page would.
  api.__internals.resetVaultChatSession()
  createdSessions.length = 0
  workspaceCalls.length = 0
  rememberedChatSession = 'session-with-history'

  const resolved = await api.__internals.resolveVaultChatSession(ctx)
  if (resolved !== 'session-with-history') {
    throw new Error('the remembered Session was not reused: ' + String(resolved))
  }
  if (createdSessions.length !== 0) {
    throw new Error('a brand-new Session was created despite one being remembered')
  }
  if (workspaceCalls.length !== 0) {
    throw new Error('the Workspace was re-resolved despite a remembered Session')
  }
})

step('a remembered Session that no longer exists is replaced, not obeyed', async () => {
  // A stale id — a deleted Session, a state file copied between machines — used to
  // be returned as-is: `sessions.retain` then threw `unknown session` on every
  // mount and the box was bricked for good. `binding` is the sessions service's own
  // lookup, so `undefined` means "no such Session" and the id must be forgotten.
  api.__internals.resetVaultChatSession()
  createdSessions.length = 0
  workspaceCalls.length = 0
  rememberedChatSession = 'session-deleted'
  missingSessionIds.add('session-deleted')
  const chatPostsBefore = posts.filter((entry) => entry.url === '/dsh-obsidian/chat').length

  let resolved
  try {
    resolved = await api.__internals.resolveVaultChatSession(ctx)
  } finally {
    missingSessionIds.delete('session-deleted')
  }

  if (resolved === 'session-deleted') {
    throw new Error('the resolver obeyed a remembered Session id that does not exist')
  }
  if (resolved !== chatSessionId) {
    throw new Error('the replacement Session id was not returned: ' + String(resolved))
  }
  if (createdSessions.length !== 1) {
    throw new Error('sessions.create ran ' + createdSessions.length + ' time(s) after a stale remembered id')
  }
  const chatPosts = posts.filter((entry) => entry.url === '/dsh-obsidian/chat')
  if (chatPosts.length !== chatPostsBefore + 1) {
    throw new Error('the replacement id was not remembered (' + (chatPosts.length - chatPostsBefore) + ' POST(s) to /chat)')
  }
  if (chatPosts[chatPosts.length - 1].body.sessionId !== chatSessionId) {
    throw new Error('wrote back the wrong Session id: ' + JSON.stringify(chatPosts[chatPosts.length - 1].body))
  }

  // The other half of the same rule: when the service cannot answer the question at
  // all (no `binding` to consult), the remembered id is trusted as before rather
  // than thrown away — "cannot verify" must not mean "history is gone".
  api.__internals.resetVaultChatSession()
  createdSessions.length = 0
  rememberedChatSession = 'session-with-history'
  const postsBefore = posts.filter((entry) => entry.url === '/dsh-obsidian/chat').length
  sessionsService.binding = undefined
  let trusted
  try {
    trusted = await api.__internals.resolveVaultChatSession(ctx)
  } finally {
    sessionsService.binding = sessionBinding
  }
  if (trusted !== 'session-with-history') {
    throw new Error('a service without `binding` made the resolver drop a remembered id: ' + String(trusted))
  }
  if (createdSessions.length !== 0) {
    throw new Error('a new Session was created although `binding` could not prove the remembered one gone')
  }
  if (posts.filter((entry) => entry.url === '/dsh-obsidian/chat').length !== postsBefore) {
    throw new Error('a Session id was written back although `binding` could not prove the remembered one gone')
  }

  // Leave the memo where the reuse step above left it: later steps resolve against
  // the remembered Session, not against this step's stale id.
  api.__internals.resetVaultChatSession()
})

step('the note page hosts the conversation and can send the note into it', async () => {
  const noteBody = registered.find((entry) => entry.metadata.key === api.__internals.NOTE_TAB_ID)
  const dockInserts = []
  const dockActions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: (text) => { dockInserts.push(text); return true },
  }

  // The box's own composer belongs to the VAULT Session, so its actions can only
  // be read from the seat's occupant. Render one to publish them.
  const seat = registered.find((entry) => entry.metadata.name === api.__internals.PANEL_CHAT_SLOT)
  const seatHost = document.createElement('div')
  document.body.appendChild(seatHost)
  const seatRoot = ReactDOMClient.createRoot(seatHost)
  seatRoot.render(React.createElement(seat.component, {
    sessionId: 'session-vault-chat',
    useSession: (select) => select({ blank: false, awaitingFirstTurn: false, running: false, openState: 'open' }),
    useConversation: (select) => select({ activeTargets: new Set(['chat']) }),
    useSessions: (select) => select({ byId: {} }),
    renderFactorySlot: () => React.createElement('div', null, 'seat'),
    inputActions: dockActions,
  }))
  await flush()
  if (api.__internals.getVaultChatInputActions() !== dockActions) {
    throw new Error('the seat never published its composer actions')
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const noteRoot = ReactDOMClient.createRoot(container)
  // The note page declares its OWN seat — it may not reuse the shell's, which the
  // notes panel owns — and draws the conversation through it.
  const seatCalls = []
  noteRoot.render(React.createElement(noteBody.component, {
    useTabInfo: () => ({ tab: { contentId: api.__internals.noteAddress('README.md') } }),
    inputActions: seatProps.inputActions,
    SessionProvider: (props) => props.children,
    renderSlot: (name) => {
      seatCalls.push(name)
      return React.createElement('div', null, 'NOTE_PAGE_CONVERSATION')
    },
  }))
  await flush()

  // The conversation exists on the note page too.
  const dock = container.querySelector('[data-dsh-obsidian-chat-dock]')
  if (dock === null) throw new Error('the note page has no conversation box')
  if (dock.getAttribute('data-dsh-obsidian-chat-dock') !== 'ready') {
    throw new Error('the note page conversation box never became ready')
  }
  if (seatCalls.length !== 1) throw new Error('the note page drew its seat ' + seatCalls.length + ' time(s)')
  if (seatCalls[0] !== 'dsh-obsidian/note.conversation') {
    throw new Error('the note page drew the wrong seat: ' + String(seatCalls[0]))
  }
  if (!container.textContent.includes('NOTE_PAGE_CONVERSATION')) {
    throw new Error('the note page conversation never reached the DOM')
  }

  // "Send to this conversation" targets the box, NOT the main conversation.
  const dockButton = [...container.querySelectorAll('button')]
    .find((button) => (button.textContent || '').includes('发到本栏'))
  if (dockButton === undefined) throw new Error('no control for sending to this conversation')
  dockInserts.length = 0
  inserted.length = 0
  dockButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  if (dockInserts.length !== 1) throw new Error('the mention did not reach the panel conversation')
  if (inserted.length !== 0) throw new Error('it went to the main conversation instead')
  if (dockInserts[0] !== ' @D:/知识库/README.md ') {
    throw new Error('wrong mention for the panel conversation: ' + JSON.stringify(dockInserts[0]))
  }

  // And the main-conversation control still targets the other one.
  const mainButton = [...container.querySelectorAll('button')]
    .find((button) => (button.textContent || '').includes('发到主对话'))
  if (mainButton === undefined) throw new Error('no control for sending to the main conversation')
  dockInserts.length = 0
  inserted.length = 0
  mainButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  if (inserted.length !== 1) throw new Error('the main conversation never received the mention')
  if (dockInserts.length !== 0) throw new Error('the main control wrote into the panel conversation')

  noteRoot.unmount()
  seatRoot.unmount()
  container.remove()
  seatHost.remove()
})

step('the notes launcher opens the notes tab', async () => {
  const opened = []
  const captured = []
  const scoped = {
    effect: (callback) => { callback(); return () => {} },
    get: (name) => (name === 'sessions' ? { create: () => Promise.resolve(chatSessionId), retain: () => ({ release: () => {} }) } : (name === 'workspaces' ? { create: (input) => Promise.resolve({ workspaceId: 'ws-vault', path: input.path, sessionIds: [] }) } : undefined)),
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: (kind) => { opened.push(kind) }, openResource: (address) => { opened.push(address) } },
    slots: {
      inject(slot, register) { register() },
      register: (metadata, component) => { captured.push({ metadata, component }); return () => {} },
    },
  }
  api.apply(scoped)
  const launcher = captured.find((entry) => entry.metadata.name === 'sidebar.footer.action'
    && entry.metadata.id === 'dsh-obsidian')
  if (launcher === undefined) throw new Error('the notes launcher is not registered')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const launcherRoot = ReactDOMClient.createRoot(container)
  launcherRoot.render(React.createElement(launcher.component, { wide: true }))
  await flush()
  const button = container.querySelector('button')
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  if (opened[0] !== api.__internals.TAB_KIND) throw new Error('launcher opened ' + String(opened[0]))
  launcherRoot.unmount()
  container.remove()
})

step('the notes launcher is the only footer row', async () => {
  const captured = []
  const scoped = {
    effect: (callback) => { callback(); return () => {} },
    get: (name) => (name === 'sessions' ? { create: () => Promise.resolve(chatSessionId), retain: () => ({ release: () => {} }) } : (name === 'workspaces' ? { create: (input) => Promise.resolve({ workspaceId: 'ws-vault', path: input.path, sessionIds: [] }) } : undefined)),
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => {}, openResource: () => {} },
    slots: {
      inject(slot, register) { register() },
      register: (metadata, component) => { captured.push({ metadata, component }); return () => {} },
    },
  }
  api.apply(scoped)
  const rows = captured.filter((entry) => entry.metadata.name === 'sidebar.footer.action')
  if (rows.length !== 1) throw new Error('expected one footer row, got ' + rows.length)
  if (rows[0].metadata.id !== 'dsh-obsidian') throw new Error('the footer row is not the notes launcher')
  // The conversation must not have a launcher or a tab of its own any more.
  if (captured.some((entry) => entry.metadata.id === 'dsh-obsidian-chat')) {
    throw new Error('the conversation still registers its own footer row')
  }
})

step('a profile without Sessions still gets the tree, only not the box', async () => {
  const captured = []
  const bare = {
    effect: (callback) => { callback(); return () => {} },
    get: () => undefined,
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => {}, openResource: () => {} },
    slots: {
      inject(slot, register) { register() },
      register: (metadata, component) => { captured.push({ metadata, component }); return () => {} },
    },
  }
  api.apply(bare)
  const panel = captured.find((entry) => entry.metadata.key === api.__internals.TAB_ID)
  if (panel === undefined) throw new Error('the notes panel vanished when Sessions were missing')
  if (!captured.some((entry) => entry.metadata.name === 'sidebar.footer.action')) {
    throw new Error('the way into the panel vanished when Sessions were missing')
  }
  if (captured.some((entry) => entry.metadata.name === api.__internals.PANEL_CHAT_SLOT)) {
    throw new Error('a conversation seat was occupied with no Sessions to bind it')
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const bareRoot = ReactDOMClient.createRoot(container)
  bareRoot.render(React.createElement(panel.component, seatProps))
  await flush()
  if (container.querySelector('input') === null) throw new Error('the tree panel did not mount without Sessions')
  if (container.querySelector('[data-dsh-obsidian-chat-dock]') !== null) {
    throw new Error('the conversation box mounted without Sessions to bind it')
  }
  bareRoot.unmount()
  container.remove()
})

step('a failed chat read is visible and never overwrites the remembered Session', async () => {
  // `GET /chat` failing is NOT "nothing was remembered". Treating it that way made
  // the box create a fresh Session and POST its id over the remembered one: one
  // transient read error and the history was gone.
  api.__internals.resetVaultChatSession()
  const createdBefore = createdSessions.length
  const workspaceBefore = workspaceCalls.length
  const chatPostsBefore = posts.filter((entry) => entry.url === '/dsh-obsidian/chat').length
  chatReadFails = true
  let failure = ''
  try {
    await api.__internals.resolveVaultChatSession(ctx)
  } catch (error) {
    failure = String(error && error.message ? error.message : error)
  } finally {
    chatReadFails = false
  }
  if (!failure.includes('无法读取')) throw new Error('a failed chat read was treated as "no record": ' + failure)
  if (createdSessions.length !== createdBefore) throw new Error('a new Session was created after a failed read')
  if (workspaceCalls.length !== workspaceBefore) throw new Error('the Workspace was re-resolved after a failed read')
  if (posts.filter((entry) => entry.url === '/dsh-obsidian/chat').length !== chatPostsBefore) {
    throw new Error('a Session id was written after a failed read')
  }
  api.__internals.resetVaultChatSession()
})

step('a slow search response cannot overwrite a newer query', async () => {
  const input = host.querySelector('input')
  if (input === null) throw new Error('no search input')
  deferSearchQuery = SLOW_SEARCH_QUERY
  Simulate.change(input, { target: { value: SLOW_SEARCH_QUERY } })
  await new Promise((resolve) => setTimeout(resolve, 400))
  await flush()
  if (deferredSearchReleases.length !== 1) throw new Error('the slow search request was never issued')
  deferSearchQuery = ''
  Simulate.change(input, { target: { value: '命中' } })
  await new Promise((resolve) => setTimeout(resolve, 400))
  await flush()
  if (!host.textContent.includes(FAST_SEARCH_TEXT)) throw new Error('the newer search results did not render')
  // Now let the STALE answer land.
  deferredSearchReleases.forEach((release) => release())
  await flush(12)
  if (host.textContent.includes(SLOW_SEARCH_TEXT)) throw new Error('a stale search response overwrote the newer results')
  if (!host.textContent.includes(FAST_SEARCH_TEXT)) throw new Error('the newer search results were lost')
})

step('a truncated search result list says so', async () => {
  const input = host.querySelector('input')
  if (input === null) throw new Error('no search input')
  searchTruncated = true
  Simulate.change(input, { target: { value: '命中截断' } })
  await new Promise((resolve) => setTimeout(resolve, 400))
  await flush()
  if (!host.textContent.includes('仅显示前 1 项')) {
    throw new Error('a truncated search result list was silent: ' + (host.textContent || '').slice(0, 200))
  }
  searchTruncated = false
})

step('a truncated directory level says so', async () => {
  // Back to the tree.
  const input = host.querySelector('input')
  Simulate.change(input, { target: { value: '' } })
  await flush()
  treeTruncated = true
  const refresh = host.querySelector('button[title="重新读取目录"]')
  if (refresh === null) throw new Error('the panel has no refresh control')
  refresh.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  if (!host.textContent.includes('仅显示前 2 项')) {
    throw new Error('a truncated directory level was silent: ' + (host.textContent || '').slice(0, 200))
  }
  treeTruncated = false
})

step('a failed subdirectory is not cached as empty, and can be retried', async () => {
  const treeReadsBefore = requests.filter((url) => url === '/dsh-obsidian/tree?path=%E7%AC%94%E8%AE%B0').length
  failTreePath = '笔记'
  const refresh = host.querySelector('button[title="重新读取目录"]')
  refresh.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await flush()
  clickText('笔记')
  await flush()
  if (!host.textContent.includes('boom-dir')) {
    throw new Error('a failed level was shown as empty instead of as an error: ' + (host.textContent || '').slice(0, 200))
  }
  if (host.textContent.includes('（空）')) throw new Error('a failed level was cached as an empty directory')
  failTreePath = ''
  clickText('重试')
  await flush()
  if (host.textContent.includes('boom-dir')) throw new Error('the error survived a successful retry')
  if (!host.textContent.includes('知识索引')) throw new Error('the retried level never loaded')
  const treeReadsAfter = requests.filter((url) => url === '/dsh-obsidian/tree?path=%E7%AC%94%E8%AE%B0').length
  if (treeReadsAfter <= treeReadsBefore) throw new Error('the failed level was never re-requested')
})

step('a slow note response cannot overwrite a newer note', async () => {
  const noteBody = registered.find((entry) => entry.metadata.key === api.__internals.NOTE_TAB_ID)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const noteRoot = ReactDOMClient.createRoot(container)
  const render = (contentId) => noteRoot.render(React.createElement(noteBody.component, {
    useTabInfo: () => ({ tab: { contentId } }),
    inputActions: seatProps.inputActions,
    SessionProvider: (props) => props.children,
    renderSlot: () => null,
  }))

  deferNotePath = SLOW_NOTE_PATH
  render(api.__internals.noteAddress(SLOW_NOTE_PATH))
  await flush()
  if (deferredNoteReleases.length !== 1) throw new Error('the slow note request was never issued')
  deferNotePath = ''
  render(api.__internals.noteAddress(FAST_NOTE_PATH))
  await flush()
  if (!container.textContent.includes(FAST_NOTE_TEXT)) throw new Error('the newer note did not render')
  // Now let the STALE answer land.
  deferredNoteReleases.forEach((release) => release())
  await flush(12)
  if (container.textContent.includes(SLOW_NOTE_TEXT)) throw new Error('a stale note response overwrote the newer note')
  if (!container.textContent.includes(FAST_NOTE_TEXT)) throw new Error('the newer note was lost')

  noteRoot.unmount()
  container.remove()
})

;(async () => {
  let failed = 0
  for (const entry of steps) {
    try {
      await entry.run()
      console.log('  ok   ' + entry.label)
    } catch (error) {
      failed += 1
      console.log('  FAIL ' + entry.label + '  [' + (error && error.message) + ']')
    }
  }

  if (failures.length > 0) {
    failed += 1
    console.log('\n  captured ' + failures.length + ' error(s) from React:')
    for (const text of failures.slice(0, 3)) {
      console.log('    ' + text.split('\n').slice(0, 8).join('\n    '))
    }
  }

  console.log('')
  console.log('  requests: ' + [...new Set(requests)].join(', '))
  console.log(failed === 0 ? '\nmount-check OK (' + steps.length + ' steps)' : '\nmount-check FAILED (' + failed + ')')
  console.error = originalError
  process.exit(failed === 0 ? 0 : 1)
})()
