// Headless harness for the dsh-obsidian host half.
//
// Not shipped. Imports index.mjs, applies it against a fake Cordis context that
// captures the web routes and the tool definition, then drives every route with
// fake request/response objects against the real vault.
//
// The subprocess service is faked, so this never launches Obsidian.
//
// Run: node test/host-check.mjs

import { pathToFileURL } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
// The host half under test. `DSH_OBSIDIAN_MODULE` points this at an INSTALLED copy (a
// disposable profile's node_modules); see test/profile-lifecycle.mjs.
const modulePath = process.env.DSH_OBSIDIAN_MODULE ?? join(here, '..', 'index.mjs')

const routes = new Map()
const tools = []
const spawned = []

const fakeSubprocess = {
  async resolveExecutable(command) { return command },
  spawn(spec) {
    spawned.push(spec)
    return { done: Promise.resolve({ exitCode: 0, signal: null }) }
  },
}

const ctx = {
  get: (name) => (name === 'subprocess' ? fakeSubprocess : undefined),
  inject: (deps, callback) => {
    if (deps.includes('webServer')) {
      callback({
        webServer: {
          register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) },
        },
      })
    }
    if (deps.includes('tools')) {
      callback({ tools: { register: (definition) => { tools.push(definition); return () => {} } } })
    }
  },
}

const plugin = await import(pathToFileURL(modulePath).href)
if (plugin.name !== 'dsh-obsidian-panel') throw new Error('unexpected plugin name: ' + String(plugin.name))
plugin.apply(ctx)

const EXPECTED_ROUTES = [
  '/dsh-obsidian/open',
  '/dsh-obsidian/status',
  '/dsh-obsidian/tree',
  '/dsh-obsidian/note',
  '/dsh-obsidian/search',
  '/dsh-obsidian/chat',
  '/dsh-obsidian/resolve-link',
  // The client half's self-report, and the vault choice. Missing from this list is
  // how `/diag` went unexercised.
  '/dsh-obsidian/diag',
  '/dsh-obsidian/vault',
]
for (const path of EXPECTED_ROUTES) {
  if (!routes.has(path)) throw new Error('route not registered: ' + path)
}

/** Drive one captured route with a fake exchange. */
function call(method, url, body) {
  const path = url.split('?')[0]
  const route = routes.get(path)
  if (route === undefined) throw new Error('no route for ' + path)
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk },
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(text) {
        try { resolve({ status: this.statusCode, body: JSON.parse(text) }) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const checks = []
/**
 * Checks that could not be run at all, with the reason.
 *
 * A probe that cannot be set up — a junction this process is not allowed to
 * create, a folder that does not exist on this machine — must be visible as a
 * SKIP. Counting it as a pass would turn "not tested" into "tested and safe".
 */
const skipped = []
function expect(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail: detail === undefined ? '' : String(detail) })
}
function skip(label, reason) {
  skipped.push({ label, reason: String(reason) })
}

/**
 * Drive one captured route with a request whose body arrives in chunks.
 *
 * `call` hands the handler one finished buffer; the body cap has to be observed
 * WHILE reading, so this variant reports how many chunks the handler actually
 * pulled and whether it tore the request down.
 */
function callStream(method, url, chunks) {
  const path = url.split('?')[0]
  const route = routes.get(path)
  if (route === undefined) throw new Error('no route for ' + path)
  const state = { yielded: 0, destroyed: false }
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      destroy() { state.destroyed = true },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          state.yielded += 1
          yield chunk
        }
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(text) {
        try { resolve({ status: this.statusCode, body: JSON.parse(text), ...state }) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

/** Whether `child` is `parent` itself or nested inside it. */
function isInside(parent, child) {
  const base = resolve(parent).toLowerCase()
  const target = resolve(child).toLowerCase()
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

// ── status ─────────────────────────────────────────────────────────────────
const status = await call('GET', '/dsh-obsidian/status')
expect('status resolves a vault', typeof status.body.vault === 'string' && status.body.vault !== '', status.body.vault)
// Whether Obsidian is installed, and where, is a property of the MACHINE — not of
// this plugin. The plugin deliberately hard-codes no install path (it reads
// DSH_OBSIDIAN_APP and the standard Windows locations), so a missing app means the
// three app-dependent checks below SKIP rather than fail. To run them anyway, set
// DSH_OBSIDIAN_APP to your Obsidian executable before running this harness.
const appFound = status.body.appFound === true
const appSkipReason = 'no Obsidian at the standard locations; set DSH_OBSIDIAN_APP to test the app path'
if (appFound) expect('status resolves the app', true, status.body.app)
else skip('status resolves the app', appSkipReason)

// ── tree (one level per request) ───────────────────────────────────────────
const tree = await call('GET', '/dsh-obsidian/tree')
const entries = Array.isArray(tree.body.entries) ? tree.body.entries : []
expect('tree returns top-level entries', tree.status === 200 && entries.length > 0, entries.length + ' entries')
expect('tree skips dot-directories', !entries.some((entry) => entry.name.startsWith('.')))
expect('tree returns one level only', entries.every((entry) => entry.children === undefined))
const dirNames = entries.filter((entry) => entry.type === 'dir').map((entry) => entry.name)
expect('tree exposes the whole root breadth', dirNames.length >= 5, dirNames.join(', '))
expect('tree contains note files', entries.some((entry) => entry.type === 'file' && /\.md$/i.test(entry.name)), entries.filter((e) => e.type === 'file').length + ' files')

const firstDir = entries.find((entry) => entry.type === 'dir')
const sub = await call('GET', '/dsh-obsidian/tree?path=' + encodeURIComponent(firstDir.path))
expect('tree?path lists a subdirectory', sub.status === 200 && Array.isArray(sub.body.entries) && sub.body.path === firstDir.path, firstDir.path + ' -> ' + (sub.body.entries || []).length + ' entries')

const treeTraversal = await call('GET', '/dsh-obsidian/tree?path=' + encodeURIComponent('../../../Windows'))
expect('tree traversal is refused', treeTraversal.status === 400, JSON.stringify(treeTraversal.body))

const treeOnFile = await call('GET', '/dsh-obsidian/tree?path=' + encodeURIComponent('README.md'))
expect('tree rejects a file path', treeOnFile.status === 400, JSON.stringify(treeOnFile.body))

// ── note ───────────────────────────────────────────────────────────────────
const note = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent('README.md'))
expect('note reads a real file', note.status === 200 && typeof note.body.text === 'string' && note.body.text.length > 0, note.body.text ? note.body.text.length + ' chars' : note.body.error)

const missing = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent('no/such/note.md'))
expect('missing note is a 404', missing.status === 404, JSON.stringify(missing.body))

const traversal = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent('../../../Windows/win.ini'))
expect('path traversal is refused', traversal.status === 404 && /escape/i.test(String(traversal.body.error)), JSON.stringify(traversal.body))

const traversalEncoded = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent('..\\..\\Windows\\win.ini'))
expect('windows-style traversal is refused', traversalEncoded.status === 404, JSON.stringify(traversalEncoded.body))

// Hidden paths are NOT part of the note surface. `readNote` lacked the guard
// `writeNote` has had all along, so a "note read" could return `.git/config`,
// `.mcp.json` and `.obsidian/*` — the user's private configuration. The guard runs
// BEFORE the existence check, so these are deterministic on any machine.
for (const hidden of ['.git/config', '.mcp.json', '.obsidian/app.json']) {
  const hiddenRead = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent(hidden))
  expect('reading a hidden path is refused (' + hidden + ')',
    hiddenRead.status === 404 && /hidden/i.test(String(hiddenRead.body.error)),
    JSON.stringify(hiddenRead.body))
}
const treeHidden = await call('GET', '/dsh-obsidian/tree?path=' + encodeURIComponent('.git'))
expect('the tree refuses to enter a dot-directory',
  treeHidden.status === 400 && /hidden/i.test(String(treeHidden.body.error)),
  JSON.stringify(treeHidden.body))

// ── search ─────────────────────────────────────────────────────────────────
const search = await call('GET', '/dsh-obsidian/search?q=' + encodeURIComponent('知识库') + '&limit=10')
expect('search scans the vault', search.status === 200 && search.body.filesScanned > 0, search.body.filesScanned + ' files')
expect('search finds the obvious term', Array.isArray(search.body.results) && search.body.results.length > 0, (search.body.results || []).length + ' hits')
expect('search respects the limit', (search.body.results || []).length <= 10)
const perFile = new Map()
for (const hit of search.body.results || []) perFile.set(hit.path, (perFile.get(hit.path) || 0) + 1)
expect('search caps hits per file', [...perFile.values()].every((count) => count <= 5), [...perFile.entries()].map(([p, c]) => c + '/' + p).join(', '))

const empty = await call('GET', '/dsh-obsidian/search?q=')
expect('empty query short-circuits', empty.status === 200 && empty.body.results.length === 0)

// ── wikilink resolution ────────────────────────────────────────────────────
const readme = await call('GET', '/dsh-obsidian/resolve-link?name=' + encodeURIComponent('README'))
expect('wikilink resolves a note by basename', readme.status === 200 && Array.isArray(readme.body.matches) && readme.body.matches.length >= 1, JSON.stringify(readme.body.matches))
expect('wikilink match carries a vault-relative path', typeof readme.body.matches[0].path === 'string' && readme.body.matches[0].path.length > 0, readme.body.matches[0].path)

const nothing = await call('GET', '/dsh-obsidian/resolve-link?name=' + encodeURIComponent('no-such-note-xyzzy'))
expect('a dangling wikilink yields no matches', nothing.status === 200 && Array.isArray(nothing.body.matches) && nothing.body.matches.length === 0, JSON.stringify(nothing.body.matches))

// ── saving an edited note ──────────────────────────────────────────────────
// The one write path. It is exercised on a probe file this harness creates and
// removes, so no existing note is touched.
const probeVaultPath = typeof status.body.vaultPath === 'string' ? status.body.vaultPath : undefined
if (probeVaultPath !== undefined) {
  const probeRel = 'dsh-obsidian-write-probe.md'
  const probeAbs = join(probeVaultPath, probeRel)
  // A non-note file this harness creates, so the NOTE_FILE refusal is exercised
  // against something that really exists — otherwise it would only hit the
  // "note does not exist" branch.
  const readProbeRel = 'dsh-obsidian-read-probe.bin'
  const readProbeAbs = join(probeVaultPath, readProbeRel)
  try {
    writeFileSync(probeAbs, '# 原始\n\n第一版\n', 'utf8')
    writeFileSync(readProbeAbs, 'not a note', 'utf8')

    const nonNoteRead = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent(readProbeRel))
    expect('reading a non-note file is refused',
      nonNoteRead.status === 404 && /not a note/i.test(String(nonNoteRead.body.error)),
      JSON.stringify(nonNoteRead.body))

    const saved = await call('POST', '/dsh-obsidian/note', { path: probeRel, text: '# 修改后\n\n第二版\n' })
    expect('a note saves', saved.status === 200 && saved.body.written === true, JSON.stringify(saved.body))
    expect('the saved bytes are exactly what was sent', readFileSync(probeAbs, 'utf8') === '# 修改后\n\n第二版\n', readFileSync(probeAbs, 'utf8'))

    const reread = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent(probeRel))
    expect('the page reads back what was saved', reread.body.text === '# 修改后\n\n第二版\n', JSON.stringify(reread.body.text))

    // Refusals. None of these may touch the filesystem.
    const outside = await call('POST', '/dsh-obsidian/note', { path: '../../../Windows/win.ini', text: 'x' })
    expect('saving outside the vault is refused', outside.status === 400 && /escape/i.test(String(outside.body.error)), JSON.stringify(outside.body))

    const missing = await call('POST', '/dsh-obsidian/note', { path: 'no/such/note.md', text: 'x' })
    expect('saving a missing note is refused', missing.status === 400, JSON.stringify(missing.body))

    const wrongType = await call('POST', '/dsh-obsidian/note', { path: readProbeRel, text: 'x' })
    // The probe file EXISTS, so this reaches the NOTE_FILE refusal rather than
    // stopping at "note does not exist" the way a `.exe` that is not there did.
    expect('saving an existing non-note is refused',
      wrongType.status === 400 && /not an editable note/i.test(String(wrongType.body.error)),
      JSON.stringify(wrongType.body))

    const hiddenWrite = await call('POST', '/dsh-obsidian/note', { path: '.obsidian/app.json', text: 'x' })
    expect('saving a hidden path is refused',
      hiddenWrite.status === 400 && /hidden/i.test(String(hiddenWrite.body.error)),
      JSON.stringify(hiddenWrite.body))

    const noText = await call('POST', '/dsh-obsidian/note', { path: probeRel })
    expect('saving without text is refused', noText.status === 400 && /text/i.test(String(noText.body.error)), JSON.stringify(noText.body))
  } finally {
    rmSync(probeAbs, { force: true })
    rmSync(readProbeAbs, { force: true })
  }
  expect('the write probe was cleaned up', !existsSync(probeAbs), probeAbs)
  expect('the non-note read probe was cleaned up', !existsSync(readProbeAbs), readProbeAbs)
}

// ── the vault conversation's Session id ────────────────────────────────────
// Remembered under DSH_HOME so the plugin stays read-only with respect to the
// vault: a Session id is DSH's bookkeeping, not the user's knowledge.
//
// This file is LIVE STATE, not a fixture: it is how the running plugin remembers
// which Session the conversation box talks to. The probe below therefore restores
// whatever was there when it finishes — deleting it would silently orphan the
// user's conversation and make the next open create a fresh Session instead.
// DSH_HOME is ABSENT in this desktop profile. Treating that as "there is no path"
// made every assertion below silently SKIP — which is how a store path that could
// not write at all (the vault choice failed, and the conversation id was never
// remembered) passed this harness. It now resolves exactly the way the plugin does.
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const probePath = join(home, 'dsh-obsidian', 'chat.json')
const probeBackup = existsSync(probePath) ? readFileSync(probePath, 'utf8') : undefined
// Same duty for the vault choice: it is LIVE STATE — it is the folder the reader
// agreed to — so the probe restores it rather than leaving the harness's guess
// behind as the user's answer.
const vaultProbePath = join(home, 'dsh-obsidian', 'vault.json')
const vaultProbeBackup = existsSync(vaultProbePath) ? readFileSync(vaultProbePath, 'utf8') : undefined
// Same duty for the client half's self-report: the /diag probe below overwrites it.
const diagProbePath = join(home, 'dsh-obsidian', 'diag.json')
const diagProbeBackup = existsSync(diagProbePath) ? readFileSync(diagProbePath, 'utf8') : undefined

try {
  const chatBefore = await call('GET', '/dsh-obsidian/chat')
  expect('chat read answers with a sessionId field', chatBefore.status === 200 && typeof chatBefore.body.sessionId === 'string', JSON.stringify(chatBefore.body))

  // The probe must NEVER invent an id. This used to POST 'session-harness-probe',
  // which the RUNNING client then read back and tried to retain — and since no such
  // Session exists, the user's conversation box reported
  // "sessions.retain: unknown session session-harness-probe". A store probe has no
  // business writing state the app will act on. It round-trips whatever is already
  // remembered instead, and the client now self-heals from an unknown id anyway.
  const remembered = chatBefore.body.sessionId
  if (remembered === '') {
    skip('chat write round-trips', 'nothing is remembered yet, so there is no id to round-trip')
  } else {
    const chatWritten = await call('POST', '/dsh-obsidian/chat', { sessionId: remembered })
    expect('chat write round-trips', chatWritten.status === 200 && chatWritten.body.sessionId === remembered, JSON.stringify(chatWritten.body))

    const chatRead = await call('GET', '/dsh-obsidian/chat')
    expect('chat read returns what was written', chatRead.body.sessionId === remembered, JSON.stringify(chatRead.body))

    expect('the Session id is stored under DSH_HOME',
      existsSync(probePath) && readFileSync(probePath, 'utf8').includes(remembered),
      probePath)
  }

  const chatBad = await call('POST', '/dsh-obsidian/chat', {})
  expect('an empty sessionId is refused', chatBad.status === 400 && /required/i.test(String(chatBad.body.error)), JSON.stringify(chatBad.body))
  const vaultPath = typeof status.body.vaultPath === 'string' ? status.body.vaultPath : undefined
  if (vaultPath !== undefined) {
    expect('the chat state is not stored inside the vault', !isInside(vaultPath, probePath), probePath)
  }

  // ── the vault-folder route ───────────────────────────────────────────────
  const vaultRead = await call('GET', '/dsh-obsidian/vault')
  expect('vault read answers with a path field', vaultRead.status === 200 && 'path' in vaultRead.body, JSON.stringify(vaultRead.body))
  expect('vault read reports its source', ['chosen', 'detected', 'none'].includes(vaultRead.body.source), JSON.stringify(vaultRead.body))
  expect('vault read reports what Obsidian registered', 'detected' in vaultRead.body, JSON.stringify(vaultRead.body))

  const vaultBad = await call('POST', '/dsh-obsidian/vault', { path: 'D:\\definitely-not-a-real-folder-xyz' })
  expect('a folder that does not exist is refused', vaultBad.status === 400 && /exist/i.test(String(vaultBad.body.error)), JSON.stringify(vaultBad.body))

  const vaultEmpty = await call('POST', '/dsh-obsidian/vault', {})
  expect('an empty path is refused', vaultEmpty.status === 400 && /required/i.test(String(vaultEmpty.body.error)), JSON.stringify(vaultEmpty.body))

  // A folder that merely EXISTS is not a knowledge base. `/vault` used to accept
  // any directory on the machine, so aiming the panel at one served that directory
  // as if it held notes. The probe is an empty folder under os.tmpdir(), and it is
  // removed whether or not the assertions pass.
  {
    const notVaultDir = mkdtempSync(join(tmpdir(), 'dsh-obsidian-not-a-vault-'))
    try {
      const notVault = await call('POST', '/dsh-obsidian/vault', { path: notVaultDir })
      expect('a folder that exists but is not a knowledge base is refused',
        notVault.status === 400 && String(notVault.body.error).includes(notVaultDir),
        JSON.stringify(notVault.body))
      expect('the refusal says what a knowledge base needs',
        /obsidian|note/i.test(String(notVault.body.error)),
        JSON.stringify(notVault.body))
    } finally {
      rmSync(notVaultDir, { recursive: true, force: true })
    }
    expect('the not-a-vault probe was cleaned up', !existsSync(notVaultDir), notVaultDir)
  }

  // The user's own knowledge base must stay acceptable: a rule that refuses the
  // folder the panel actually reads breaks the plugin instead of protecting it.
  if (existsSync('D:\\知识库')) {
    const realVault = await call('POST', '/dsh-obsidian/vault', { path: 'D:\\知识库' })
    expect('the real knowledge base D:\\知识库 is still accepted',
      realVault.status === 200 && realVault.body.chosen === 'D:\\知识库',
      JSON.stringify(realVault.body))
  } else {
    skip('the real knowledge base D:\\知识库 is still accepted',
      'D:\\知识库 does not exist on this machine')
  }

  if (vaultPath !== undefined) {
    const vaultPicked = await call('POST', '/dsh-obsidian/vault', { path: vaultPath })
    expect('choosing an existing folder is accepted', vaultPicked.status === 200 && vaultPicked.body.chosen === vaultPath, JSON.stringify(vaultPicked.body))
    expect('the choice becomes the vault in force', vaultPicked.body.path === vaultPath && vaultPicked.body.source === 'chosen', JSON.stringify(vaultPicked.body))
    const vaultAfter = await call('GET', '/dsh-obsidian/vault')
    expect('the choice survives a re-read', vaultAfter.body.path === vaultPath && vaultAfter.body.source === 'chosen', JSON.stringify(vaultAfter.body))
    // `vaultProbePath` always resolves, so the old `!== undefined` guard was a
    // fossil that could only ever be true, and the assertion it hid was checked
    // against a name the plugin does not use.
    expect('the choice is stored under DSH_HOME', existsSync(vaultProbePath), vaultProbePath)
    expect('the vault choice is not stored inside the vault', !isInside(vaultPath, vaultProbePath), vaultProbePath)
  }

  // ── the client half's self-report ─────────────────────────────────────────
  // `client.js` posts what it managed to register here; a client failure is
  // otherwise invisible. The route was registered but never driven.
  const diagRead = await call('GET', '/dsh-obsidian/diag')
  expect('diag read answers with an object',
    diagRead.status === 200 && diagRead.body !== null && typeof diagRead.body === 'object',
    JSON.stringify(diagRead.body).slice(0, 80))
  const diagWritten = await call('POST', '/dsh-obsidian/diag', { inject: ['slots'], report: { ok: ['harness'], failed: [] } })
  expect('diag write round-trips',
    diagWritten.status === 200 && diagWritten.body.report?.ok?.[0] === 'harness',
    JSON.stringify(diagWritten.body).slice(0, 120))
  expect('diag write stamps a time', typeof diagWritten.body.at === 'number', JSON.stringify(diagWritten.body).slice(0, 80))
  const diagReread = await call('GET', '/dsh-obsidian/diag')
  expect('diag read returns what was written',
    Array.isArray(diagReread.body.inject) && diagReread.body.report?.failed?.length === 0,
    JSON.stringify(diagReread.body).slice(0, 120))

  // `{ at: Date.now(), ...body }` let the CALLER's `at` win, and every other key
  // was written into this plugin's own state file verbatim.
  const diagSpoofed = await call('POST', '/dsh-obsidian/diag', {
    at: 1,
    inject: ['slots'],
    report: { ok: ['spoof'], failed: [] },
    renderError: { label: 'probe', detail: 'kept', stack: '' },
    evil: 'must not be stored',
  })
  expect('diag stamps its own time and a supplied at cannot override it',
    typeof diagSpoofed.body.at === 'number' && diagSpoofed.body.at !== 1
      && diagSpoofed.body.at > Date.now() - 60000,
    JSON.stringify(diagSpoofed.body).slice(0, 120))
  expect('diag keeps the whitelisted keys',
    diagSpoofed.body.renderError?.detail === 'kept' && diagSpoofed.body.inject?.[0] === 'slots',
    JSON.stringify(diagSpoofed.body).slice(0, 160))
  expect('diag drops keys outside the whitelist',
    !('evil' in diagSpoofed.body),
    JSON.stringify(diagSpoofed.body).slice(0, 160))

  // ── the request-body cap ──────────────────────────────────────────────────
  // `MAX_WRITE_BYTES` bounded what could be SAVED, but it only ran once the whole
  // body was already in memory. The cap is now enforced while reading: 10 MiB in
  // 1 MiB chunks must stop before the last chunk, tear the request down, and be
  // answered as a 413 rather than a 400 or a 500.
  {
    const chunk = Buffer.alloc(1024 * 1024, 0x78)
    const tenChunks = Array.from({ length: 10 }, () => chunk)

    const over = await callStream('POST', '/dsh-obsidian/diag', tenChunks)
    expect('an oversized body is refused with 413 (not 400 or 500)',
      over.status === 413 && /exceed/i.test(String(over.body.error)),
      over.status + ' ' + JSON.stringify(over.body))
    expect('reading stops as soon as the cap is passed',
      over.yielded < 10, over.yielded + '/10 chunks were read')
    expect('the oversized request is torn down', over.destroyed === true, String(over.destroyed))

    const overNote = await callStream('POST', '/dsh-obsidian/note', tenChunks)
    expect('the note write route refuses an oversized body with 413',
      overNote.status === 413 && /exceed/i.test(String(overNote.body.error)),
      overNote.status + ' ' + JSON.stringify(overNote.body))

    const normal = await call('POST', '/dsh-obsidian/diag', { inject: ['slots'], report: { ok: ['normal-body'], failed: [] } })
    expect('a body under the cap is still a 200',
      normal.status === 200 && normal.body.report?.ok?.[0] === 'normal-body',
      JSON.stringify(normal.body).slice(0, 120))
  }

  // Every route speaks GET and POST; anything else is a 405 rather than a silent
  // GET that answers a DELETE with the current state.
  const methodRejected = await call('PUT', '/dsh-obsidian/diag')
  expect('a method other than GET/POST is a 405',
    methodRejected.status === 405 && /not allowed/i.test(String(methodRejected.body.error)),
    JSON.stringify(methodRejected.body))
  const chatMethodRejected = await call('DELETE', '/dsh-obsidian/chat')
  expect('the chat route also answers 405 for other methods',
    chatMethodRejected.status === 405,
    JSON.stringify(chatMethodRejected.body))

  // ── a chat write that cannot reach disk is a 400, not a silent 200 ────────
  // `writeChatSession`'s result used to be discarded, so a store that could not be
  // written still answered 200 — which is exactly why "the conversation is not
  // remembered" looked like success. DSH_HOME is pointed at a path UNDER A FILE, so
  // the mkdir cannot succeed. It is a temp path, never the real store.
  {
    const blocker = join(tmpdir(), 'dsh-obsidian-write-blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const previousHome = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = join(blocker, 'home')
      const refused = await call('POST', '/dsh-obsidian/chat', { sessionId: 'session-harness-refused' })
      expect('a chat write that cannot reach disk is a 400', refused.status === 400, JSON.stringify(refused.body))
      expect('the refusal names the failing path',
        typeof refused.body.error === 'string' && refused.body.error.includes('chat.json'),
        JSON.stringify(refused.body))
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(blocker, { force: true })
    }
  }

  // ── temporary probe vaults ────────────────────────────────────────────────
  //
  // Everything below runs against a vault created under os.tmpdir() and switched
  // in through the real `/vault` route. The user's own vault is never entered, and
  // vault.json is put back from the same backup the report restores at the end.
  {
    const probeDirs = []
    const makeProbe = (prefix) => {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      probeDirs.push(dir)
      return dir
    }
    /** Switch the vault in force to one probe directory. */
    const useVault = async (dir) => {
      const response = await call('POST', '/dsh-obsidian/vault', { path: dir })
      expect('the probe vault is accepted (' + dir.replace(/\\/g, '/').split('/').pop() + ')',
        response.status === 200, JSON.stringify(response.body))
      return response.status === 200
    }
    /** Search whichever vault is in force. */
    const searchProbe = (query, limit) => call('GET', '/dsh-obsidian/search?q='
      + encodeURIComponent(query) + '&limit=' + String(limit))

    try {
      // 1. A junction INSIDE the vault pointing out of it. The string starts with
      //    the root and the target exists, so only the REAL path says it is outside.
      const linkVault = makeProbe('dsh-obsidian-probe-link-')
      const outside = makeProbe('dsh-obsidian-probe-outside-')
      const secret = join(outside, 'secret.md')
      const link = join(linkVault, 'escape')
      writeFileSync(join(linkVault, 'note.md'), '# probe\n', 'utf8')
      writeFileSync(secret, 'OUTSIDE-SECRET\n', 'utf8')
      let linkMade = false
      let linkReason = ''
      try {
        symlinkSync(outside, link, 'junction')
        linkMade = true
      } catch (error) {
        linkReason = String(error && error.message ? error.message : error)
      }
      if (!linkMade) {
        // A junction that cannot be created is NOT a pass: say so instead.
        skip('a junction out of the vault is refused by /note, /tree and /note POST',
          'junction could not be created: ' + linkReason)
      } else {
        await useVault(linkVault)
        const escaped = await call('GET', '/dsh-obsidian/note?path=' + encodeURIComponent('escape/secret.md'))
        expect('a note read through a junction out of the vault is refused',
          escaped.status === 404 && /escape/i.test(String(escaped.body.error)),
          JSON.stringify(escaped.body))
        const escapedTree = await call('GET', '/dsh-obsidian/tree?path=' + encodeURIComponent('escape'))
        expect('a tree listing through a junction out of the vault is refused',
          escapedTree.status === 400 && /escape/i.test(String(escapedTree.body.error)),
          JSON.stringify(escapedTree.body))
        const escapedWrite = await call('POST', '/dsh-obsidian/note', { path: 'escape/secret.md', text: 'HACKED' })
        expect('a note write through a junction out of the vault is refused',
          escapedWrite.status === 400 && /escape/i.test(String(escapedWrite.body.error)),
          JSON.stringify(escapedWrite.body))
        expect('the refused write did not reach the file outside the vault',
          readFileSync(secret, 'utf8') === 'OUTSIDE-SECRET\n', readFileSync(secret, 'utf8'))
        // Use-and-delete: `rmdir` removes the reparse point itself, never what it
        // points at. The finally below also removes the whole temp tree.
        try { rmdirSync(link) } catch (error) { /* the finally removes the tree */ }
        expect('the junction probe was deleted immediately', !existsSync(link), link)
      }

      // 2. The result-count limit — and the other half of the semantics: a search
      //    that read everything must NOT claim truncation.
      const limitVault = makeProbe('dsh-obsidian-probe-limit-')
      writeFileSync(join(limitVault, 'one.md'), 'probe-needle 一\n', 'utf8')
      writeFileSync(join(limitVault, 'two.md'), 'probe-needle 二\n', 'utf8')
      writeFileSync(join(limitVault, 'three.md'), 'probe-needle 三\n', 'utf8')
      await useVault(limitVault)
      const whole = await searchProbe('probe-needle', 50)
      expect('a complete search does not claim truncation',
        whole.status === 200 && whole.body.results.length === 3 && whole.body.truncated === false,
        JSON.stringify({ hits: whole.body.results?.length, truncated: whole.body.truncated }))
      const capped = await searchProbe('probe-needle', 1)
      expect('a search stopped by the result limit reports truncation',
        capped.status === 200 && capped.body.results.length === 1 && capped.body.truncated === true,
        JSON.stringify({ hits: capped.body.results?.length, truncated: capped.body.truncated }))

      // 3. A note above the per-file cap is a HOLE in the answer, not an absence of
      //    matches: it is counted, and the answer says it is incomplete.
      const largeVault = makeProbe('dsh-obsidian-probe-large-')
      writeFileSync(join(largeVault, 'huge.md'), 'probe-needle\n' + 'x'.repeat(1024 * 1024 + 4096), 'utf8')
      await useVault(largeVault)
      const large = await searchProbe('probe-needle', 50)
      expect('a search that skipped an oversized note does not look like a complete "no results"',
        large.status === 200 && large.body.results.length === 0
          && large.body.truncated === true && large.body.skippedLarge === 1,
        JSON.stringify({ hits: large.body.results?.length, truncated: large.body.truncated, skippedLarge: large.body.skippedLarge }))

      // 4. Depth: a note above the cap is found, the walk stops AT the cap, and the
      //    stop is reported instead of an infinitely deep recursion.
      const depthVault = makeProbe('dsh-obsidian-probe-depth-')
      writeFileSync(join(depthVault, 'shallow.md'), 'probe-needle 浅\n', 'utf8')
      let deep = depthVault
      for (let level = 1; level <= 26; level += 1) deep = join(deep, 'd' + level)
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, 'too-deep.md'), 'probe-needle 深\n', 'utf8')
      await useVault(depthVault)
      const depth = await searchProbe('probe-needle', 50)
      const depthPaths = (depth.body.results || []).map((hit) => hit.path)
      expect('a note above the depth cap is still searched',
        depth.status === 200 && depthPaths.includes('shallow.md'), depthPaths.join(', '))
      expect('the walk stops at the depth cap and reports truncation',
        depth.body.truncated === true && !depthPaths.some((path) => path.includes('too-deep')),
        JSON.stringify({ truncated: depth.body.truncated, paths: depthPaths }))

      // 5. Directory count: 5001 sibling directories, so the cap has to bite. This
      //    is the slowest probe in the harness (a few seconds of mkdir on Windows).
      const dirsVault = makeProbe('dsh-obsidian-probe-dirs-')
      writeFileSync(join(dirsVault, 'shallow.md'), 'probe-needle 浅\n', 'utf8')
      for (let index = 0; index < 5001; index += 1) mkdirSync(join(dirsVault, 'd' + index))
      await useVault(dirsVault)
      const dirs = await searchProbe('probe-needle', 50)
      expect('the walk stops at the directory cap and reports truncation',
        dirs.status === 200 && dirs.body.truncated === true,
        JSON.stringify({ dirsScanned: dirs.body.dirsScanned, truncated: dirs.body.truncated }))
      expect('the directory cap is exactly where the walk stopped',
        dirs.body.dirsScanned === 5000, String(dirs.body.dirsScanned))
    } finally {
      for (const dir of probeDirs) rmSync(dir, { recursive: true, force: true })
      // The vault choice is live state: put it back the way the report's own
      // restore does, so the /open assertions after this block read the user's
      // real vault again.
      if (vaultProbeBackup === undefined) {
        rmSync(vaultProbePath, { force: true })
      } else {
        mkdirSync(dirname(vaultProbePath), { recursive: true })
        writeFileSync(vaultProbePath, vaultProbeBackup, 'utf8')
      }
      expect('every probe vault under os.tmpdir() was cleaned up',
        probeDirs.every((dir) => !existsSync(dir)),
        probeDirs.filter((dir) => existsSync(dir)).join(', '))
      if (vaultPath !== undefined) {
        const leftovers = readdirSync(vaultPath).filter((name) => /^dsh-obsidian/i.test(name))
        expect("the probes left nothing in the user's vault", leftovers.length === 0, leftovers.join(', '))
      }
    }
  }
} finally {
  // Put the live state back exactly as it was found — including the client's own
  // diag record, which this harness overwrites.
  for (const [path, backup] of [[probePath, probeBackup], [vaultProbePath, vaultProbeBackup], [diagProbePath, diagProbeBackup]]) {
    if (path === undefined) continue
    if (backup === undefined) {
      if (existsSync(path)) rmSync(path)
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, backup, 'utf8')
    }
  }
}

// ── open (faked subprocess) ────────────────────────────────────────────────
const opened = await call('POST', '/dsh-obsidian/open', {})
expect('open reports success', opened.status === 200 && opened.body.opened === true, JSON.stringify(opened.body))
if (appFound) {
  expect('open passed a vault URI to the app', spawned.length === 1 && /^obsidian:\/\/open\?vault=/.test(spawned[0].argv[1]), spawned[0] ? spawned[0].argv[1] : 'nothing spawned')
  expect('open used an absolute executable', spawned.length === 1 && /Obsidian\.exe$/i.test(spawned[0].argv[0]), spawned[0] ? spawned[0].argv[0] : '')
} else {
  // Without an app, `open` falls back to handing the URI to the shell — correct
  // behaviour, not a failure. The two checks above are about WHICH executable was
  // spawned, so they only mean something when one is.
  skip('open passed a vault URI to the app', appSkipReason)
  skip('open used an absolute executable', appSkipReason)
}
expect('open never inherits stdio', spawned.length === 1 && spawned[0].stdio.stdout === 'ignore' && spawned[0].stdio.stdin === 'ignore')

const openedFile = await call('POST', '/dsh-obsidian/open', { file: '参考.md' })
expect('open accepts a file argument', openedFile.body.opened === true && decodeURIComponent(String(openedFile.body.uri)).includes('file=参考.md'), openedFile.body.uri)

// ── tool ───────────────────────────────────────────────────────────────────
expect('exactly one tool is registered', tools.length === 1, tools.length)
const tool = tools[0] || {}
expect('tool is obsidian_open', tool.name === 'obsidian_open')
expect('tool declares a JSON schema', tool.parameters && tool.parameters.type === 'object')
expect('tool declares an output shape', tool.output && tool.output.schema && typeof tool.output.render === 'function')
const toolResult = await tool.execute({ file: '项目.md' })
expect('tool executes', toolResult && toolResult.opened === true, JSON.stringify(toolResult))

// ── report ─────────────────────────────────────────────────────────────────
let failed = 0
for (const check of checks) {
  if (!check.ok) failed += 1
  console.log((check.ok ? '  ok   ' : '  FAIL ') + check.label + (check.detail === '' ? '' : '  [' + check.detail + ']'))
}
for (const item of skipped) console.log('  skip  ' + item.label + '  [' + item.reason + ']')
console.log(failed === 0
  ? '\nhost.js harness OK (' + checks.length + ' checks'
    + (skipped.length === 0 ? '' : ', ' + skipped.length + ' skipped') + ')'
  : '\nhost.js harness FAILED (' + failed + '/' + checks.length + ')')
process.exit(failed === 0 ? 0 : 1)
