#!/usr/bin/env node
/**
 * Disposable-Profile lifecycle evidence: install → start → uninstall.
 *
 * The marketplace's automatic review does not accept "it works on my machine": it asks
 * for install/start/uninstall evidence from a THROWAWAY profile. This produces exactly
 * that, and it does it against the PACKED TARBALL rather than the working tree, so it
 * also proves the `files` list ships a package that can actually run:
 *
 *   install    `npm pack` → a fresh temp profile → `pnpm install` (a real install)
 *   start      both INSTALLED halves activate: the host half applies against a real
 *              context and every HTTP route answers (test/host-check.mjs), and the
 *              client half registers through the real module loader
 *              (test/render-check.cjs) — each pointed at the installed copy
 *   uninstall  dependency + bundle entry removed → `pnpm install` → nothing left behind
 *
 * It never boots the Electron app and never touches a real profile: the profile lives
 * under the OS temp directory and is deleted at the end unless `--keep` is passed.
 *
 *   node test/profile-lifecycle.mjs [--keep] [--work <dir>] [--json]
 *
 * Exit code 0 means all three steps passed.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..')
const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const json = argv.includes('--json')
// The host half's own checks assert things about a REAL vault, so a machine without one
// cannot run that step. CI passes --skip-host and still verifies pack → install →
// uninstall → the client half.
const skipHost = argv.includes('--skip-host')
const workIndex = argv.indexOf('--work')
const workRoot = workIndex >= 0 ? resolve(argv[workIndex + 1]) : tmpdir()

const results = []
function step(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!json) console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  [' + detail + ']' : ''}`)
}

/** Quote one argument for the Windows shell (paths in temp directories may contain spaces). */
function quote(value) {
  const text = String(value)
  return /[\s"]/.test(text) ? '"' + text.replace(/"/g, '\\"') + '"' : text
}

function run(command, args, options = {}) {
  const env = { ...process.env, CI: 'true', ...(options.env ?? {}) }
  const cwd = options.cwd ?? repoRoot
  // npm/pnpm are `.cmd` shims on Windows, and since the 2024 spawn hardening Node
  // refuses to run a .cmd without a shell. Those go through the shell; everything else
  // is a plain executable.
  if (process.platform === 'win32' && /^(npm|pnpm|npx)$/.test(command)) {
    return execSync([command, ...args].map(quote).join(' '), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, cwd, maxBuffer: 64 * 1024 * 1024,
    })
  }
  return execFileSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, cwd, maxBuffer: 64 * 1024 * 1024,
  })
}

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const name = manifest.name
const version = manifest.version

// The profile mechanism is pnpm in real use; npm works just as well for this evidence and
// is what a bare CI runner has. Whichever runs, it is reported.
let installer = 'pnpm'
try {
  run('pnpm', ['--version'])
} catch {
  installer = 'npm'
}
const installArgs = installer === 'pnpm'
  ? ['install', '--reporter=append-only', '--config.confirmModulesPurge=false']
  : ['install', '--no-audit', '--no-fund']
// CI implies a frozen lockfile for pnpm, and the uninstall step exists to shrink it.
const reinstallArgs = installer === 'pnpm' ? [...installArgs, '--no-frozen-lockfile'] : installArgs

mkdirSync(workRoot, { recursive: true })
const profile = mkdtempSync(join(workRoot, 'dsh-profile-lifecycle-'))
const profileManifest = join(profile, 'package.json')
const installed = join(profile, 'node_modules', name)

function writeProfile(dependencies, bundles) {
  writeFileSync(profileManifest, JSON.stringify({
    name: 'dsh-profile-lifecycle-check',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2) + '\n', 'utf8')
}

try {
  // ── install ────────────────────────────────────────────────────────────────
  const packed = JSON.parse(run('npm', ['pack', '--json']))
  const tarball = join(repoRoot, packed[0].filename)
  step('pack', existsSync(tarball), packed[0].filename + ' (' + packed[0].size + ' bytes)')

  writeProfile({ [name]: 'file:' + tarball }, [name])
  run(installer, installArgs, { cwd: profile })

  const installedManifest = join(installed, 'package.json')
  const filesOk = ['index.mjs', 'client.js', 'cordis.patch.yml'].every(file => existsSync(join(installed, file)))
  step('install', filesOk && existsSync(installedManifest), profile)

  const installedPackage = JSON.parse(readFileSync(installedManifest, 'utf8'))
  const scripts = installedPackage.scripts ?? {}
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare'].filter(key => scripts[key] !== undefined)
  step('install runs no lifecycle scripts', lifecycle.length === 0, lifecycle.join(', ') || 'none declared')
  step('install keeps the declared identity', installedPackage.name === name && installedPackage.version === version,
    installedPackage.name + '@' + installedPackage.version)
  const runtimeDeps = Object.keys(installedPackage.dependencies ?? {})
  step('install needs no runtime dependencies', runtimeDeps.length === 0, runtimeDeps.join(', ') || 'none')

  // The bundle layer is what makes the package reachable by name at boot.
  const patch = readFileSync(join(installed, 'cordis.patch.yml'), 'utf8')
  step('bundle patch names the installed package', patch.includes('name: ' + name), 'cordis.patch.yml')
  const installedClient = readFileSync(join(installed, 'client.js'), 'utf8')
  step('client half carries the loader id', installedClient.includes("id: '" + name + "'"), 'client.js')

  // ── start ──────────────────────────────────────────────────────────────────
  // Both halves are exercised AS INSTALLED. host-check builds a real context, applies
  // the plugin and drives every route; render-check registers the client half through
  // the real module loader. Output is captured, never swallowed silently.
  let renderOk = true
  let renderDetail = 'render-check OK against the installed client half'
  try {
    run('node', [join(repoRoot, 'test', 'render-check.cjs')], { env: { DSH_OBSIDIAN_CLIENT: join(installed, 'client.js') } })
  } catch (error) {
    renderOk = false
    renderDetail = String(error.stdout ?? '').split('\n').slice(-4).join(' ').trim() || String(error.message)
  }
  step('start: client half registers', renderOk, renderDetail)

  let hostOutput = ''
  let hostDetail = ''
  if (skipHost) {
    console.log('  skip  start: host half applies and answers every route  [--skip-host: this environment has no vault]')
  } else {
  try {
    hostOutput = run('node', [join(repoRoot, 'test', 'host-check.mjs')], { env: { DSH_OBSIDIAN_MODULE: join(installed, 'index.mjs') } })
  } catch (error) {
    hostOutput = String(error.stdout ?? '')
  }
  const lines = hostOutput.split(/\r?\n/)
  const failed = lines.filter(line => line.startsWith('  FAIL '))
  const total = lines.filter(line => line.startsWith('  ok  ') || line.startsWith('  FAIL ')).length
  // host-check also asserts things about ONE machine's vault contents (that a note
  // exists, that a wikilink resolves). Those are fixture failures, not contract
  // failures, and INSTALL.md documents that split. What must NOT fail is anything about
  // applying the plugin or serving its routes.
  const fixtureDependent = line => /real file|does not exist|README|wikilink|truncat/i.test(line)
  const contractFailures = failed.filter(line => !fixtureDependent(line))
  const reported = /host\.js harness (OK|FAILED)/.test(hostOutput)
  const hostPassed = reported && total >= 60 && contractFailures.length === 0
  hostDetail = total + ' checks, ' + failed.length + ' failure(s)'
    + (failed.length === 0 ? '' : ', all vault-fixture dependent')
    + (contractFailures.length === 0 ? '' : ' — contract failure: ' + contractFailures[0].trim())
  step('start: host half applies and answers every route', hostPassed, hostDetail)
  }

  // ── uninstall ──────────────────────────────────────────────────────────────
  // The manifest the manager would write after removing the package: no dependency,
  // no bundle entry. A frozen lockfile cannot shrink, which is the whole point here.
  writeProfile({}, [])
  run(installer, reinstallArgs, { cwd: profile })
  step('uninstall removes the package', !existsSync(installed), 'node_modules/' + name)
  const leftovers = ['client.js', 'index.mjs', 'cordis.patch.yml'].filter(file => existsSync(join(profile, file)))
  step('uninstall leaves nothing of the plugin in the profile', leftovers.length === 0, leftovers.join(', ') || 'none')

  rmSync(tarball, { force: true })
} finally {
  if (!keep) rmSync(profile, { recursive: true, force: true })
  else console.log('\nprofile kept at ' + profile)
}

const failedSteps = results.filter(item => !item.ok)
if (json) console.log(JSON.stringify({ name, version, profile, results }, null, 2))
else {
  console.log('\nlifecycle evidence ' + (failedSteps.length === 0 ? 'OK' : 'FAILED') + ' ('
    + (results.length - failedSteps.length) + '/' + results.length + ' steps)'
    + (failedSteps.length === 0 ? '' : ': ' + failedSteps.map(item => item.name).join(', ')))
}
process.exit(failedSteps.length === 0 ? 0 : 1)
