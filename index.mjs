// dsh-obsidian — host half.
//
// Responsibility: resolve where Obsidian and its vault live on this machine,
// launch (or focus) it, and serve a read-through view of the vault to the
// in-app notes panel.
//
// Read-only with respect to note content: nothing here writes into the vault.
// Every path that arrives from the browser is resolved against the vault root
// and rejected when it escapes.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-obsidian-panel'

const ROUTE_OPEN = '/dsh-obsidian/open'
const ROUTE_STATUS = '/dsh-obsidian/status'
const ROUTE_TREE = '/dsh-obsidian/tree'
const ROUTE_NOTE = '/dsh-obsidian/note'
const ROUTE_SEARCH = '/dsh-obsidian/search'
const ROUTE_CHAT = '/dsh-obsidian/chat'
const ROUTE_RESOLVE = '/dsh-obsidian/resolve-link'
const ROUTE_DIAG = '/dsh-obsidian/diag'
const ROUTE_VAULT = '/dsh-obsidian/vault'

/** Directories that are never part of the note surface. */
const SKIP_DIRS = new Set([
  '.obsidian', '.git', '.claude', '.claudian', '.superpowers', '.dsh-build',
  '.trash', '.smart-env', '.makemd', 'node_modules',
])

/** Files the notes panel is willing to show. */
const NOTE_FILE = /\.(md|markdown|canvas|txt)$/i

const MAX_DIR_ENTRIES = 800
const MAX_NOTE_BYTES = 512 * 1024
const MAX_SEARCH_FILES = 3000
const MAX_SEARCH_BYTES = 1024 * 1024
/**
 * How many directories one search may enter, and how deep it may recurse.
 *
 * A vault is not a bounded tree: it can hold a deep checkout, and a directory
 * symlink or junction can point anywhere. Without these the walk is an unbounded
 * recursion, and the reader is told nothing when it stops.
 */
const MAX_SEARCH_DIRS = 5000
const MAX_SEARCH_DEPTH = 24
const MAX_SEARCH_LIMIT = 200
const MAX_HITS_PER_FILE = 5
/** Largest note this plugin will accept for saving back to disk. */
const MAX_WRITE_BYTES = 4 * 1024 * 1024
/**
 * Largest request body any route will buffer.
 *
 * `MAX_WRITE_BYTES` bounds the note that may be SAVED, but it only ever ran once
 * the whole body was already in memory: a caller could make this process buffer
 * an arbitrarily large upload before any check applied. This is the bound that is
 * enforced while the body is being read.
 */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024
/** How far below a chosen folder `/vault` looks for evidence of a knowledge base. */
const VAULT_LOOK_DEPTH = 2
/**
 * The only keys `/diag` accepts from the client half.
 *
 * This file is written to disk and served back, so an unfiltered body let any
 * caller put any key into the plugin's own state file — and `{ at: …, ...body }`
 * let it overwrite the timestamp that says WHEN the record was made.
 */
const DIAG_KEYS = ['inject', 'report', 'renderError']

/** Absolute paths worth trying when the config does not name an executable. */
function candidateApps() {
  const local = process.env.LOCALAPPDATA
  const pf = process.env.ProgramFiles
  const pf86 = process.env['ProgramFiles(x86)']
  return [
    process.env.DSH_OBSIDIAN_APP,
    local ? join(local, 'Obsidian', 'Obsidian.exe') : undefined,
    local ? join(local, 'Programs', 'Obsidian', 'Obsidian.exe') : undefined,
    pf ? join(pf, 'Obsidian', 'Obsidian.exe') : undefined,
    pf86 ? join(pf86, 'Obsidian', 'Obsidian.exe') : undefined,
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
}

/** `%APPDATA%\obsidian\obsidian.json` — Obsidian's own vault registry. */
function configPath() {
  const appdata = process.env.APPDATA
  return appdata ? join(appdata, 'obsidian', 'obsidian.json') : undefined
}

/**
 * Registered vaults, most-recently-opened first. Obsidian stores the path only;
 * the vault name Obsidian's URI handler expects is the folder basename.
 */
function readVaults() {
  const path = configPath()
  if (path === undefined || !existsSync(path)) return []
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'))
    const vaults = config !== null && typeof config === 'object' && config.vaults !== null
      && typeof config.vaults === 'object' ? Object.values(config.vaults) : []
    return vaults
      .filter(vault => vault !== null && typeof vault === 'object' && typeof vault.path === 'string')
      .sort((left, right) => Number(Boolean(right.open)) - Number(Boolean(left.open))
        || Number(right.ts ?? 0) - Number(left.ts ?? 0))
  } catch {
    return []
  }
}

/**
 * The vault folder the user explicitly chose, or undefined.
 *
 * Obsidian's own registry is a good guess but it is a guess: it may name a vault
 * the user does not want here, or none at all. An explicit choice, once made, wins
 * over it — and its absence is what the client shows a first-run chooser for.
 */
function chosenVaultPath() {
  const path = vaultStorePath()
  if (path === undefined || !existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const chosen = parsed !== null && typeof parsed === 'object' && typeof parsed.path === 'string'
      ? parsed.path
      : ''
    return chosen !== '' && existsSync(chosen) ? chosen : undefined
  } catch {
    return undefined
  }
}

/**
 * Remember one vault folder.
 *
 * @returns undefined on success, or a message saying WHICH path failed and why.
 * A bare "it did not work" is what made this take two rounds to find: the write
 * was failing because the state path did not resolve, and the message said nothing.
 */
function writeChosenVault(folder) {
  const path = vaultStorePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ path: folder, at: Date.now() }, null, 2), 'utf8')
    return undefined
  } catch (error) {
    return '无法写入 ' + path + '：' + String(error?.message ?? error)
  }
}

/** Resolve the app path + vault this plugin will act on. */
function resolveTarget(vaults = readVaults()) {
  const app = candidateApps().find(candidate => existsSync(candidate))
  const vault = vaults[0]
  const detected = typeof vault?.path === 'string' ? vault.path : undefined
  // An explicit choice outranks Obsidian's registry for every read this plugin does.
  const chosen = chosenVaultPath()
  const vaultPath = chosen ?? detected
  return {
    app,
    vaultPath,
    // Obsidian's own URI handler only knows vaults it registered, so the NAME stays
    // the detected basename whenever there is one.
    vaultName: typeof vault?.path === 'string' ? basename(vault.path) : (vaultPath === undefined ? undefined : basename(vaultPath)),
    detectedPath: detected,
    chosenPath: chosen,
  }
}

/** The vault root, or undefined when no vault resolves. */
function vaultRoot() {
  const path = resolveTarget().vaultPath
  return path !== undefined && existsSync(path) ? path : undefined
}

/**
 * Resolve a browser-supplied vault-relative path.
 *
 * A prefix test on the STRING is not a containment test. A symlink or NTFS
 * junction inside the vault resolves somewhere else, and every path that merely
 * *starts with* the root then reads and writes outside it — the vault could
 * serve, and overwrite, a file on another drive entirely.
 *
 * So the anchor is the root's REAL path, and an existing target is resolved a
 * second time and required to land back inside that anchor. `realpathSync` is
 * allowed to fail (EPERM, a dangling or corrupt link): a path whose real location
 * cannot be established is refused rather than assumed safe.
 * @returns the absolute path, or undefined when it is empty or escapes the root.
 */
function safeResolve(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '') return undefined
  let anchor
  try {
    anchor = realpathSync(resolve(root))
  } catch {
    // No root, or a root that cannot be resolved: nothing under it is reachable.
    return undefined
  }
  const absolute = resolve(anchor, relativePath)
  if (absolute === anchor) return undefined
  if (!absolute.startsWith(anchor + sep)) return undefined
  // The string is inside the root; the FILE may not be. Only an existing target
  // can be resolved, so an ordinary path — including one that does not exist yet
  // — stays as cheap as it was.
  if (!existsSync(absolute)) return absolute
  let real
  try {
    real = realpathSync(absolute)
  } catch {
    return undefined
  }
  return real === anchor || real.startsWith(anchor + sep) ? absolute : undefined
}

/** Vault-relative, forward-slashed path for the wire. */
function toVaultPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

/**
 * Whether any path segment starts with `.` — `.git/config`, `.mcp.json`,
 * `.obsidian/app.json`.
 *
 * Hidden paths are not part of the note surface: the tree never lists them, and a
 * read that can reach one is a read of the user's private configuration rather
 * than of a note. Both separators are accepted because the browser can send either.
 */
function hasDotSegment(relativePath) {
  return String(relativePath).replace(/\\/g, '/').split('/').some(segment => segment.startsWith('.'))
}

/**
 * Whether any note-like file sits at or under `directory`, `VAULT_LOOK_DEPTH` at
 * most, counted from `depth`.
 */
function hasNoteWithin(directory, depth) {
  let dirents
  try {
    dirents = readdirSync(directory, { withFileTypes: true })
  } catch {
    return false
  }
  const subdirs = []
  for (const dirent of dirents) {
    if (dirent.isFile() && NOTE_FILE.test(dirent.name)) return true
    if (dirent.isDirectory() && !dirent.name.startsWith('.') && !SKIP_DIRS.has(dirent.name)
      && depth < VAULT_LOOK_DEPTH) {
      subdirs.push(join(directory, dirent.name))
    }
  }
  return subdirs.some(subdir => hasNoteWithin(subdir, depth + 1))
}

/**
 * Whether a folder looks like a knowledge base.
 *
 * "Exists and is a directory" accepts EVERY directory on the machine — pointing
 * the panel at `C:\Windows` would then serve, and offer to overwrite, whatever
 * happens to end in `.txt`. A vault either carries Obsidian's own `.obsidian`
 * marker or has at least one note-like file within two levels of its root.
 */
function looksLikeVault(folder) {
  if (existsSync(join(folder, '.obsidian'))) return true
  return hasNoteWithin(folder, 0)
}

/** Directory-first, then name, with numeric awareness. */
function compareEntries(left, right) {
  if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
  return left.name.localeCompare(right.name, 'zh', { numeric: true, sensitivity: 'base' })
}

/**
 * One directory's entries, one level deep.
 *
 * The vault is walked lazily rather than materialised: a vault may contain a
 * full source checkout next to its notes, and a whole-tree response would let
 * one deep, wide directory consume the budget and silently starve the rest of
 * the tree. One level per request keeps every level complete.
 * @param root - vault root.
 * @param relativePath - vault-relative directory, or '' for the root.
 */
function listDirectory(root, relativePath) {
  // The tree does not ENTER a hidden directory either: listing `.git` would expose
  // the same private surface a hidden note read would, one level at a time.
  if (hasDotSegment(relativePath)) throw new Error('hidden paths are not listed')
  const anchor = resolve(root)
  const absolute = relativePath === '' ? anchor : safeResolve(root, relativePath)
  if (absolute === undefined) throw new Error('path escapes the vault')
  if (!existsSync(absolute)) throw new Error('directory does not exist')
  if (!statSync(absolute).isDirectory()) throw new Error('not a directory')

  let dirents
  try {
    dirents = readdirSync(absolute, { withFileTypes: true })
  } catch {
    return { entries: [], truncated: false }
  }

  const dirs = []
  const files = []
  let truncated = false
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.') || SKIP_DIRS.has(dirent.name)) continue
    if (dirs.length + files.length >= MAX_DIR_ENTRIES) {
      truncated = true
      break
    }
    const child = join(absolute, dirent.name)
    if (dirent.isDirectory()) {
      dirs.push({ type: 'dir', name: dirent.name, path: toVaultPath(root, child) })
    } else if (dirent.isFile() && NOTE_FILE.test(dirent.name)) {
      files.push({ type: 'file', name: dirent.name, path: toVaultPath(root, child) })
    }
  }
  dirs.sort(compareEntries)
  files.sort(compareEntries)
  return { entries: [...dirs, ...files], truncated }
}

/**
 * Overwrite one note inside the vault.
 *
 * This is the ONLY place this package writes to the user's knowledge, so it is
 * deliberately narrow: the path must resolve inside the vault, the target must
 * already exist and be a file this plugin is willing to show as a note, its
 * current content must fit the read cap (so a truncated view can never be saved
 * back over the whole file), and the bytes are written as UTF-8 untransformed.
 * @param root - vault root.
 * @param relativePath - vault-relative path of an existing note.
 * @param text - the complete new content.
 * @returns the written path and its fresh stat facts.
 */
function writeNote(root, relativePath, text) {
  const absolute = safeResolve(root, relativePath)
  if (absolute === undefined) throw new Error('path escapes the vault')
  if (hasDotSegment(relativePath)) throw new Error('hidden paths are not editable notes')
  if (!existsSync(absolute)) throw new Error('note does not exist')
  const stats = statSync(absolute)
  if (!stats.isFile()) throw new Error('not a file')
  if (!NOTE_FILE.test(basename(absolute))) throw new Error('not an editable note')
  // A truncated read is a partial view; saving it would delete the rest.
  if (stats.size > MAX_NOTE_BYTES) throw new Error('note is too large to edit safely')
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) throw new Error('content is too large to save')
  writeFileSync(absolute, text, 'utf8')
  const after = statSync(absolute)
  return { path: toVaultPath(root, absolute), size: after.size, mtimeMs: after.mtimeMs }
}

/** Read one note, capped, with its stat facts. */
function readNote(root, relativePath) {
  const absolute = safeResolve(root, relativePath)
  if (absolute === undefined) throw new Error('path escapes the vault')
  // The SAME guard `writeNote` has had all along. Without it a "read a note" call
  // could read `.git/config`, `.mcp.json` or `.obsidian/*` — private configuration
  // that the tree never shows, and the one hole that made "read-only" untrue.
  if (hasDotSegment(relativePath)) throw new Error('hidden paths are not readable notes')
  if (!existsSync(absolute)) throw new Error('note does not exist')
  const stats = statSync(absolute)
  if (!stats.isFile()) throw new Error('not a file')
  if (!NOTE_FILE.test(basename(absolute))) throw new Error('not a note')
  const bytes = readFileSync(absolute)
  const truncated = bytes.length > MAX_NOTE_BYTES
  return {
    path: toVaultPath(root, absolute),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    truncated,
    text: bytes.subarray(0, MAX_NOTE_BYTES).toString('utf8'),
  }
}

/**
 * Case-insensitive substring search across note files.
 *
 * Bounded four ways, and every bound is REPORTED through `truncated`: the result
 * count, the number of files read, the number of directories entered and the
 * recursion depth. A search that silently stopped looked exactly like a vault
 * with nothing in it, and a note too large to read was skipped without leaving a
 * trace, so a vault full of large notes answered "searched, nothing found" while
 * never having looked at any of them.
 */
function searchVault(root, query, limit) {
  const needle = query.toLowerCase()
  const results = []
  let filesScanned = 0
  let dirsScanned = 0
  let skippedLarge = 0
  // `truncated` says the ANSWER is incomplete; `halt` says there is no point
  // going on at all. They are not the same: a branch below the depth cap is
  // pruned and the rest of the vault is still searched, because aborting the
  // whole walk there would let one deep folder hide every note beside it.
  let truncated = false
  let halt = false

  function walk(directory, depth) {
    if (halt || results.length >= limit) return
    if (dirsScanned >= MAX_SEARCH_DIRS) {
      truncated = true
      halt = true
      return
    }
    if (depth > MAX_SEARCH_DEPTH) {
      // This branch only: its notes are not searched, and the answer says so.
      truncated = true
      return
    }
    dirsScanned += 1
    let dirents
    try {
      dirents = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (halt) return
      if (results.length >= limit) {
        truncated = true
        halt = true
        return
      }
      const absolute = join(directory, dirent.name)
      if (dirent.isDirectory()) {
        if (dirent.name.startsWith('.') || SKIP_DIRS.has(dirent.name)) continue
        walk(absolute, depth + 1)
        continue
      }
      if (!dirent.isFile() || !NOTE_FILE.test(dirent.name)) continue
      if (filesScanned >= MAX_SEARCH_FILES) {
        truncated = true
        halt = true
        return
      }
      filesScanned += 1
      let text
      try {
        const bytes = readFileSync(absolute)
        // A skipped file is a HOLE in the answer, not an absence of matches: it
        // is counted, and the answer says it is incomplete.
        if (bytes.length > MAX_SEARCH_BYTES) {
          skippedLarge += 1
          truncated = true
          continue
        }
        text = bytes.toString('utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/)
      let hitsHere = 0
      for (let index = 0; index < lines.length; index += 1) {
        if (results.length >= limit) {
          truncated = true
          halt = true
          return
        }
        if (!lines[index].toLowerCase().includes(needle)) continue
        // Cap per file so one long note cannot fill the whole result list.
        if (hitsHere >= MAX_HITS_PER_FILE) break
        hitsHere += 1
        results.push({
          path: toVaultPath(root, absolute),
          line: index + 1,
          text: lines[index].trim().slice(0, 300),
        })
      }
    }
  }

  walk(root, 0)
  // `truncated` means "this answer is incomplete for at least one reason";
  // `skippedLarge` says how many of those reasons were oversized notes.
  return { results, truncated, filesScanned, dirsScanned, skippedLarge }
}

/**
 * Resolve a `[[wikilink]]` target to note paths.
 *
 * Obsidian resolves `[[foo]]` to any note named `foo` (or `foo.md`) anywhere in
 * the vault, and `[[笔记/foo]]` to a path. This walks the same bounded tree the
 * search uses and returns every match; the client turns the page to the first, or
 * surfaces that the link is ambiguous.
 * @param root - vault root.
 * @param name - the wikilink target (without brackets).
 */
function findNoteByTitle(root, name) {
  const target = String(name).trim()
  if (target === '') return []
  const needle = target.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  const matches = []
  let scanned = 0

  function walk(directory) {
    if (scanned >= MAX_SEARCH_FILES || matches.length >= 8) return
    let dirents
    try {
      dirents = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (scanned >= MAX_SEARCH_FILES || matches.length >= 8) return
      const absolute = join(directory, dirent.name)
      if (dirent.isDirectory()) {
        if (dirent.name.startsWith('.') || SKIP_DIRS.has(dirent.name)) continue
        walk(absolute)
        continue
      }
      if (!dirent.isFile() || !NOTE_FILE.test(dirent.name)) continue
      scanned += 1
      const rel = toVaultPath(root, absolute).replace(/\\/g, '/')
      const withoutExt = rel.replace(/\.[^./]+$/, '')
      const nameWithoutExt = dirent.name.replace(/\.[^./]+$/, '')
      if (withoutExt.toLowerCase() === needle || nameWithoutExt.toLowerCase() === needle || rel.toLowerCase() === needle) {
        matches.push({ path: rel, name: dirent.name })
      }
    }
  }

  walk(root)
  return matches
}

/**
 * The directory this plugin keeps its own state in.
 *
 * `DSH_HOME` is NOT always set — it is absent in this desktop profile — and
 * returning `undefined` from that made every write silently fail. The vault choice
 * answered "could not remember the choice", and the remembered conversation id was
 * never stored at all, which is why history did not survive a restart. `~/.dsh` is
 * where DSH keeps its state when the variable is not set, so it is the fallback.
 */
function stateDir() {
  const home = process.env.DSH_HOME
  const base = home === undefined || home === '' ? join(homedir(), '.dsh') : home
  return join(base, 'dsh-obsidian')
}

/** The full path of one state file. Always defined. */
function statePath(file) {
  return join(stateDir(), file)
}

/** Where the explicitly chosen vault folder is remembered. */
function vaultStorePath() {
  return statePath('vault.json')
}

/**
 * Where the CLIENT half reports its registration state.
 *
 * A client half has no filesystem and nowhere to be seen: when one of its
 * registrations fails, the shell shows nothing and no error is written anywhere
 * the author can read. So the client posts what it managed to register here, and
 * this file is the plugin's own account of itself.
 */
function diagStorePath() {
  return statePath('diag.json')
}

/**
 * Where the vault conversation's Session id is remembered.
 *
 * Deliberately NOT inside the vault: this plugin is read-only with respect to
 * note content, and a Session id is DSH's own bookkeeping rather than the user's
 * knowledge. It lives beside the rest of this plugin's state.
 */
function chatStorePath() {
  return statePath('chat.json')
}

/**
 * In-memory seat for the id. It is no longer load-bearing — `statePath` always
 * resolves, so the id does reach disk — but a read that fails should still answer
 * with the id this process is using rather than forgetting the conversation.
 */
let chatSessionFallback = ''

/** The remembered vault-conversation Session id, or '' when none is recorded. */
function readChatSession() {
  const path = chatStorePath()
  if (!existsSync(path)) return chatSessionFallback
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.sessionId === 'string'
      ? parsed.sessionId
      : chatSessionFallback
  } catch {
    return chatSessionFallback
  }
}

/**
 * Remember one Session id.
 * @returns undefined on success, or a message saying which path failed and why.
 * The in-memory seat is set either way, so a write that cannot reach disk still
 * serves this process; the caller reports the failure instead of discarding it,
 * because "the id was not remembered" is otherwise indistinguishable from success.
 */
function writeChatSession(sessionId) {
  chatSessionFallback = sessionId
  const path = chatStorePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ sessionId, at: Date.now() }, null, 2), 'utf8')
    return undefined
  } catch (error) {
    return '无法写入 ' + path + '：' + String(error?.message ?? error)
  }
}

/** Build the `obsidian://` URI that opens one note (or just the vault). */
function buildUri(vaultName, file) {
  const params = new URLSearchParams()
  if (vaultName !== undefined && vaultName !== '') params.set('vault', vaultName)
  if (file !== undefined && file !== '') params.set('file', file)
  const query = params.toString()
  return query === '' ? 'obsidian://open' : `obsidian://open?${query}`
}

/** Human-readable description of what this plugin currently resolves to. */
function describeTarget(ctx) {
  // Obsidian's registry is read ONCE: `resolveTarget` already needed it, and a
  // second read could disagree with the first on a machine where the file changes
  // between the two calls.
  const vaults = readVaults()
  const target = resolveTarget(vaults)
  return {
    app: target.app ?? null,
    appFound: target.app !== undefined,
    vault: target.vaultName ?? null,
    vaultPath: target.vaultPath ?? null,
    configPath: configPath() ?? null,
    vaultCount: vaults.length,
    // What Obsidian's registry says, what the user chose, and which one is in force.
    detectedVaultPath: target.detectedPath ?? null,
    chosenVaultPath: target.chosenPath ?? null,
    vaultSource: target.chosenPath !== undefined ? 'chosen' : (target.detectedPath !== undefined ? 'detected' : 'none'),
    subprocess: ctx.get('subprocess') !== undefined,
    uri: buildUri(target.vaultName, undefined),
  }
}

/**
 * Launch Obsidian. An already-running instance is focused by Obsidian's own
 * single-instance handling, so this never opens a second window.
 * @param ctx - plugin context owning the subprocess service.
 * @param file - optional vault-relative note path.
 */
async function openObsidian(ctx, file) {
  const target = resolveTarget()
  const uri = buildUri(target.vaultName, file)
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('dsh-obsidian: subprocess service is unavailable')

  const cwd = target.vaultPath !== undefined && existsSync(target.vaultPath)
    ? target.vaultPath
    : process.cwd()

  if (target.app !== undefined) {
    const resolved = await subprocess.resolveExecutable(target.app)
    const handle = subprocess.spawn({
      argv: [resolved, uri],
      cwd,
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 3000,
    })
    // The launcher exits as soon as it hands the URI to the running instance;
    // a rejection here is a spawn failure, not a reason to fail the tool call.
    void handle.done.catch(() => {})
    return { opened: true, uri, vault: target.vaultName ?? '', app: resolved, via: 'executable' }
  }

  // No configured executable: let Windows resolve the registered obsidian:// handler.
  const shell = await subprocess.resolveExecutable('cmd.exe')
  const handle = subprocess.spawn({
    argv: [shell, '/c', 'start', '', uri],
    cwd,
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    graceMs: 3000,
  })
  void handle.done.catch(() => {})
  return { opened: true, uri, vault: target.vaultName ?? '', app: '', via: 'protocol-handler' }
}

/**
 * A request body that exceeded `MAX_REQUEST_BYTES`.
 *
 * A distinct type rather than a message match: the route layer turns exactly this
 * into a 413, so a body that is merely malformed JSON stays a 400 and a genuine
 * fault stays a 500.
 */
class BodyTooLargeError extends Error {
  constructor(limit) {
    super('request body exceeds ' + Math.round(limit / (1024 * 1024)) + ' MB')
    this.name = 'BodyTooLargeError'
    this.code = 'REQUEST_TOO_LARGE'
  }
}

/**
 * Read and parse a JSON request body, tolerating an empty one.
 *
 * The bound is enforced AS THE BODY IS READ, not after it: over the cap the read
 * stops immediately and the connection is torn down, so no caller can make this
 * process buffer an arbitrarily large upload before a limit applies.
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  let tooLarge = false
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) {
      tooLarge = true
      break
    }
    chunks.push(bytes)
  }
  if (tooLarge) {
    req.destroy?.()
    throw new BodyTooLargeError(MAX_REQUEST_BYTES)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Answer a failed route with the right status.
 *
 * An oversized body is a 413 wherever it arrives — never a 400 ("you sent
 * nonsense") and never a 500 ("we broke"), because the request was well formed
 * and the refusal is this plugin's own cap. Every other failure keeps the status
 * its route has always used.
 */
function sendFailure(res, error, status) {
  sendJson(res, error instanceof BodyTooLargeError ? 413 : status, {
    error: String(error?.message ?? error),
  })
}

/**
 * Every route here speaks GET or POST. Any other method is a 405 rather than a
 * silent GET: answering a DELETE with the current state hides a caller's mistake.
 * @returns whether the request may proceed.
 */
function allowMethod(req, res) {
  if (req.method === 'GET' || req.method === 'POST') return true
  res.setHeader('allow', 'GET, POST')
  sendJson(res, 405, { error: 'method not allowed: ' + String(req.method) })
  return false
}

export function apply(ctx) {
  ctx.inject(['webServer'], (http) => {
    http.webServer.register({
      kind: 'exact',
      path: ROUTE_STATUS,
      handler: (req, res) => {
        if (!allowMethod(req, res)) return
        sendJson(res, 200, describeTarget(ctx))
      },
    })

    // The client half's self-report. POST replaces the record with what the client
    // managed to register; GET reads it back so a failure can be diagnosed without
    // a browser console.
    http.webServer.register({
      kind: 'exact',
      path: ROUTE_DIAG,
      handler: async (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          const path = diagStorePath()
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const record = {}
            if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
              // Only the keys the client half actually reports. A body was written
              // to this file verbatim before, so an unfiltered key became part of
              // the plugin's own state on disk.
              for (const key of DIAG_KEYS) {
                if (Object.prototype.hasOwnProperty.call(body, key)) record[key] = body[key]
              }
            }
            // Assigned AFTER the copy, so a caller cannot date a record it did not
            // make: `{ at: Date.now(), ...body }` let `body.at` win.
            record.at = Date.now()
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, JSON.stringify(record, null, 2), 'utf8')
          }
          sendJson(res, 200, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {})
        } catch (error) {
          sendFailure(res, error, 400)
        }
      },
    })

    // Choosing the vault folder. GET reports what is in force; POST records an
    // explicit choice, which then outranks Obsidian's registry for every read.
    http.webServer.register({
      kind: 'exact',
      path: ROUTE_VAULT,
      handler: async (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const folder = typeof body.path === 'string' ? body.path.trim() : ''
            if (folder === '') throw new Error('path is required')
            if (!existsSync(folder)) throw new Error('folder does not exist: ' + folder)
            if (!statSync(folder).isDirectory()) throw new Error('not a folder: ' + folder)
            // A folder that merely EXISTS is not a vault: the panel would serve the
            // directory listing of anywhere on the machine. The message names the
            // path and the two things that would have made it acceptable.
            if (!looksLikeVault(folder)) {
              throw new Error('not an Obsidian vault (no .obsidian folder and no note file within '
                + VAULT_LOOK_DEPTH + ' levels): ' + folder)
            }
            const failure = writeChosenVault(folder)
            if (failure !== undefined) throw new Error(failure)
          }
          const target = resolveTarget()
          sendJson(res, 200, {
            path: target.vaultPath ?? null,
            name: target.vaultName ?? null,
            detected: target.detectedPath ?? null,
            chosen: target.chosenPath ?? null,
            source: target.chosenPath !== undefined ? 'chosen' : (target.detectedPath !== undefined ? 'detected' : 'none'),
          })
        } catch (error) {
          sendFailure(res, error, 400)
        }
      },
    })

    http.webServer.register({
      kind: 'exact',
      path: ROUTE_OPEN,
      handler: async (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          const file = typeof body.file === 'string' && body.file !== '' ? body.file : undefined
          sendJson(res, 200, await openObsidian(ctx, file))
        } catch (error) {
          // Still a 500 shape, but an oversized body is a 413 like everywhere else.
          if (error instanceof BodyTooLargeError) sendFailure(res, error, 500)
          else sendJson(res, 500, { opened: false, error: String(error?.message ?? error) })
        }
      },
    })

    http.webServer.register({
      kind: 'exact',
      path: ROUTE_TREE,
      handler: (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          const root = vaultRoot()
          if (root === undefined) throw new Error('no Obsidian vault resolved')
          const params = new URL(req.url ?? '/', 'http://x').searchParams
          const path = (params.get('path') ?? '').trim()
          if (path !== '' && safeResolve(root, path) === undefined) throw new Error('path escapes the vault')
          const listing = listDirectory(root, path)
          sendJson(res, 200, {
            vault: resolveTarget().vaultName ?? basename(root),
            root,
            path,
            truncated: listing.truncated,
            entries: listing.entries,
          })
        } catch (error) {
          sendFailure(res, error, 400)
        }
      },
    })

    http.webServer.register({
      kind: 'exact',
      path: ROUTE_CHAT,
      handler: async (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            if (sessionId === '') throw new Error('sessionId is required')
            // The write result is NOT discarded: a store that cannot be written is
            // why the conversation's history did not survive a restart, and a 200
            // here made that look like success.
            const failure = writeChatSession(sessionId)
            if (failure !== undefined) throw new Error(failure)
          }
          sendJson(res, 200, { sessionId: readChatSession() })
        } catch (error) {
          sendFailure(res, error, 400)
        }
      },
    })

    http.webServer.register({
      kind: 'exact',
      path: ROUTE_NOTE,
      handler: async (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          const root = vaultRoot()
          if (root === undefined) throw new Error('no Obsidian vault resolved')

          // POST saves an edited note back to disk; GET reads one.
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const path = typeof body.path === 'string' ? body.path : ''
            const text = body.text
            if (path === '') throw new Error('path is required')
            if (typeof text !== 'string') throw new Error('text is required')
            const written = writeNote(root, path, text)
            sendJson(res, 200, { root, written: true, ...written })
            return
          }

          const path = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? ''
          // `root` rides along so the note page can build an absolute mention for
          // the main conversation without a second status round-trip.
          sendJson(res, 200, { root, ...readNote(root, path) })
        } catch (error) {
          sendFailure(res, error, req.method === 'POST' ? 400 : 404)
        }
      },
    })

    http.webServer.register({
      kind: 'exact',
      path: ROUTE_RESOLVE,
      handler: (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          const root = vaultRoot()
          if (root === undefined) throw new Error('no Obsidian vault resolved')
          const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? ''
          const matches = findNoteByTitle(root, name)
          sendJson(res, 200, { name, matches, ambiguous: matches.length > 1 })
        } catch (error) {
          sendFailure(res, error, 400)
        }
      },
    })

    http.webServer.register({
      kind: 'exact',
      path: ROUTE_SEARCH,
      handler: (req, res) => {
        try {
          if (!allowMethod(req, res)) return
          const root = vaultRoot()
          if (root === undefined) throw new Error('no Obsidian vault resolved')
          const params = new URL(req.url ?? '/', 'http://x').searchParams
          const query = (params.get('q') ?? '').trim()
          if (query === '') {
            sendJson(res, 200, {
              query,
              results: [],
              truncated: false,
              filesScanned: 0,
              dirsScanned: 0,
              skippedLarge: 0,
            })
            return
          }
          const parsed = Number(params.get('limit') ?? '80')
          const limit = Number.isFinite(parsed) && parsed > 0
            ? Math.min(Math.floor(parsed), MAX_SEARCH_LIMIT)
            : 80
          sendJson(res, 200, { query, ...searchVault(root, query, limit) })
        } catch (error) {
          sendFailure(res, error, 500)
        }
      },
    })
  })

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register({
      name: 'obsidian_open',
      description: 'Open or focus the Obsidian desktop app on this machine, optionally jumping to one note. '
        + 'Read-only: it never modifies note content. Use it when the user wants to see or edit a note in Obsidian.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Optional vault-relative note path, e.g. "笔记/示例.md". Omit to just focus Obsidian.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            opened: { type: 'boolean' },
            uri: { type: 'string' },
            vault: { type: 'string' },
            app: { type: 'string' },
            via: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Obsidian: ${JSON.stringify(value)}`,
        }],
      },
      async execute(args) {
        const file = args !== null && typeof args === 'object' && typeof args.file === 'string' && args.file !== ''
          ? args.file
          : undefined
        return await openObsidian(ctx, file)
      },
    })
  })
}
