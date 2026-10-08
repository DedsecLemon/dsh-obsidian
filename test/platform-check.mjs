#!/usr/bin/env node
/**
 * Cross-platform path checks.
 *
 * `index.mjs` finds Obsidian's executable and Obsidian's own vault registry with a
 * per-platform path list. Only one of those lists can ever be exercised by running this
 * on one machine, so they are pure functions of `(platform, env, home)` and this asserts
 * all three — otherwise the macOS and Linux branches would rot silently while the
 * manifest claims `os: [win32, darwin, linux]`.
 *
 *   node test/platform-check.mjs
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const { __internals } = await import(pathToFileURL(resolve(here, '..', 'index.mjs')).href)
const { candidateApps, configPath, uriDelivery } = __internals

const checks = []
function expect(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok), detail: detail ?? '' })
}

const HOME = process.platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester'
const WINDOWS_ENV = {
  DSH_OBSIDIAN_APP: 'D:\\tools\\Obsidian.exe',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
}

// ── Windows ──────────────────────────────────────────────────────────────────
const win = candidateApps('win32', WINDOWS_ENV, HOME)
expect('win32: DSH_OBSIDIAN_APP is tried first', win[0] === WINDOWS_ENV.DSH_OBSIDIAN_APP, win[0])
expect('win32: per-user install is tried',
  win.includes(join(WINDOWS_ENV.LOCALAPPDATA, 'Obsidian', 'Obsidian.exe')), String(win.length) + ' candidates')
expect('win32: per-user "Programs" install is tried',
  win.includes(join(WINDOWS_ENV.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe')))
expect('win32: machine-wide installs are tried',
  win.includes(join(WINDOWS_ENV.ProgramFiles, 'Obsidian', 'Obsidian.exe'))
  && win.includes(join(WINDOWS_ENV['ProgramFiles(x86)'], 'Obsidian', 'Obsidian.exe')))
expect('win32: no macOS or Linux path leaks in',
  !win.some(path => path.includes('Applications/Obsidian.app') || path === '/usr/bin/obsidian'))

// ── macOS ────────────────────────────────────────────────────────────────────
const macEnv = { DSH_OBSIDIAN_APP: '/opt/obsidian/Obsidian' }
const mac = candidateApps('darwin', macEnv, '/Users/tester')
expect('darwin: DSH_OBSIDIAN_APP is tried first', mac[0] === macEnv.DSH_OBSIDIAN_APP, mac[0])
expect('darwin: /Applications is tried',
  mac.includes('/Applications/Obsidian.app/Contents/MacOS/Obsidian'))
expect('darwin: ~/Applications is tried',
  mac.includes('/Users/tester/Applications/Obsidian.app/Contents/MacOS/Obsidian'))
expect('darwin: no Windows or Linux path leaks in',
  !mac.some(path => path.includes('.exe') || path.startsWith('/usr/')))

// ── Linux ────────────────────────────────────────────────────────────────────
const linux = candidateApps('linux', { DSH_OBSIDIAN_APP: '/opt/Obsidian.AppImage' }, '/home/tester')
expect('linux: DSH_OBSIDIAN_APP is tried first', linux[0] === '/opt/Obsidian.AppImage', linux[0])
expect('linux: AppImage locations are tried',
  linux.includes('/home/tester/.local/bin/Obsidian.AppImage') && linux.includes('/home/tester/Applications/Obsidian.AppImage'))
expect('linux: distro package locations are tried',
  ['/usr/bin/obsidian', '/usr/local/bin/obsidian', '/snap/bin/obsidian', '/var/lib/flatpak/exports/bin/md.obsidian.Obsidian']
    .every(path => linux.includes(path)))
expect('linux: the per-user flatpak export is tried',
  linux.includes('/home/tester/.local/share/flatpak/exports/bin/md.obsidian.Obsidian'))
expect('linux: no Windows or macOS path leaks in',
  !linux.some(path => path.includes('.exe') || path.includes('Obsidian.app')))

// ── Degenerate inputs must not produce junk to stat ──────────────────────────
const bare = candidateApps('linux', {}, '')
expect('an empty environment still yields absolute candidates only',
  bare.every(path => path.startsWith('/')), bare.join(' '))
expect('a missing home does not leak into a path',
  !candidateApps('darwin', {}, '').some(path => path.includes('undefined') || path.includes('null')),
  candidateApps('darwin', {}, '').join(' '))
expect('an unknown platform falls back to the Linux list',
  candidateApps('freebsd', {}, '/home/tester').includes('/usr/bin/obsidian'))

// ── Obsidian's own registry ──────────────────────────────────────────────────
expect('win32 registry is %APPDATA%\\obsidian\\obsidian.json',
  configPath('win32', WINDOWS_ENV, HOME) === join(WINDOWS_ENV.APPDATA, 'obsidian', 'obsidian.json'),
  String(configPath('win32', WINDOWS_ENV, HOME)))
expect('darwin registry is ~/Library/Application Support/obsidian/obsidian.json',
  configPath('darwin', {}, '/Users/tester') === '/Users/tester/Library/Application Support/obsidian/obsidian.json',
  String(configPath('darwin', {}, '/Users/tester')))
expect('linux registry honours XDG_CONFIG_HOME',
  configPath('linux', { XDG_CONFIG_HOME: '/home/tester/.config-custom' }, '/home/tester')
  === '/home/tester/.config-custom/obsidian/obsidian.json')
expect('linux registry defaults to ~/.config',
  configPath('linux', {}, '/home/tester') === '/home/tester/.config/obsidian/obsidian.json',
  String(configPath('linux', {}, '/home/tester')))
expect('a platform without a home or an environment returns nothing, rather than a broken path',
  configPath('darwin', {}, '') === undefined && configPath('linux', {}, '') === undefined)

// ── How the `obsidian://` URI is delivered ───────────────────────────────────
// macOS: `open` is the registered handler for the scheme, and the app binary is NOT a
// substitute — it is always present, so "run the executable" made the `open` branch
// unreachable. Asserted here because this machine cannot run the macOS branch.
expect('darwin: the URI goes through open even though the app binary exists',
  uriDelivery('darwin', { open: true, app: true }) === 'open',
  String(uriDelivery('darwin', { open: true, app: true })))
expect('darwin: the app binary is only the fallback when open is missing',
  uriDelivery('darwin', { open: false, app: true }) === 'executable')
expect('darwin: nothing resolvable is reported, not guessed',
  uriDelivery('darwin', { open: false, app: false }) === undefined)
expect('win32: a known executable still wins, as it always did',
  uriDelivery('win32', { app: true, cmd: true }) === 'executable')
expect('win32: without an executable the URI goes to the shell',
  uriDelivery('win32', { app: false, cmd: true }) === 'cmd')
expect('linux: a known executable still wins, as it always did',
  uriDelivery('linux', { app: true, xdgOpen: true }) === 'executable')
expect('linux: without one the URI goes to xdg-open',
  uriDelivery('linux', { app: false, xdgOpen: true }) === 'xdg-open')
expect('an unknown platform uses the POSIX opener, matching the path list',
  uriDelivery('freebsd', { app: false, xdgOpen: true }) === 'xdg-open')

const failed = checks.filter(check => !check.ok)
for (const check of checks) console.log((check.ok ? '  ok   ' : '  FAIL ') + check.label + (check.detail === '' ? '' : '  [' + check.detail + ']'))
console.log('\nplatform paths ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' (' + (checks.length - failed.length) + '/' + checks.length + ')')
process.exit(failed.length === 0 ? 0 : 1)
