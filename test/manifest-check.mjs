#!/usr/bin/env node
/**
 * DSH marketplace contract self-check.
 *
 * The marketplace's automatic review rejected this package for two things it could not
 * see in the manifest — "DSH compatibility is not explicitly declared" and "Node.js
 * compatibility is not explicitly declared" — and it decides those from exactly the
 * fields asserted here (`scripts/check-plugin-submission.mjs` in AI-Scarlett/DSH-Store:
 * `dsh.compatibility.dsh` and `engines.node`). It also pins the rest of what that review
 * gates on, so none of it can quietly disappear:
 *
 *   identity      package name, repository URL, license, an explicit `files` list
 *   compatibility DSH range + Node range + per-release matrix + lifecycle operations
 *   hygiene       no install/prepare scripts, no runtime dependencies
 *   bundle        the patch exists and names this package, and both halves carry it
 *
 *   node test/manifest-check.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..')
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))

const checks = []
function expect(label, ok, detail) {
  checks.push({ label, ok: Boolean(ok), detail: detail ?? '' })
}

const RELEASE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/
const OPERATION = new Set(['passed', 'failed', 'unknown'])
const RELEASE_STATUS = new Set(['compatible', 'incompatible', 'unknown'])

expect('name is declared', manifest.name === 'dsh-obsidian-panel', String(manifest.name))
expect('version is semver', RELEASE.test(manifest.version ?? ''), String(manifest.version))
expect('repository is the canonical GitHub repository',
  manifest.repository?.url === 'git+https://github.com/DedsecLemon/dsh-obsidian.git',
  String(manifest.repository?.url))
expect('license is declared', manifest.license === 'MIT', String(manifest.license))
expect('an explicit distributable files list is declared',
  Array.isArray(manifest.files) && manifest.files.length > 0, (manifest.files ?? []).join(', '))

// The two declarations the automatic review asked for.
const compatibility = manifest.dsh?.compatibility ?? {}
expect('DSH compatibility is explicitly declared', typeof compatibility.dsh === 'string' && compatibility.dsh !== '',
  String(compatibility.dsh))
expect('Node.js compatibility is explicitly declared', typeof manifest.engines?.node === 'string' && manifest.engines.node !== '',
  String(manifest.engines?.node))
expect('the two Node declarations agree', compatibility.node === manifest.engines?.node,
  compatibility.node + ' vs ' + manifest.engines?.node)
expect('the client profile is declared', Array.isArray(compatibility.profiles) && compatibility.profiles.includes('web'),
  (compatibility.profiles ?? []).join(', '))

// `systems` in the marketplace listing comes from `manifest.os` (the review maps
// win32/darwin/linux to Windows/macOS/Linux), so the claim is only as good as
// test/platform-check.mjs, which asserts every platform's Obsidian paths.
const systems = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
expect('the supported systems are declared', Array.isArray(manifest.os) && manifest.os.length > 0,
  (manifest.os ?? []).map(entry => systems[entry] ?? entry).join(', '))
expect('every declared system is one the review knows',
  Array.isArray(manifest.os) && manifest.os.every(entry => Object.hasOwn(systems, entry)),
  (manifest.os ?? []).join(', '))

// Per-release evidence: range-only claims are not installable evidence, so at least one
// official release must be marked exactly, and every status must be a legal one.
const releases = compatibility.dshReleases ?? {}
const releaseEntries = Object.entries(releases)
expect('a per-release compatibility matrix is declared', releaseEntries.length > 0, releaseEntries.length + ' release(s)')
expect('every release key is a full version', releaseEntries.every(([release]) => RELEASE.test(release)),
  releaseEntries.map(([release]) => release).join(', '))
expect('every release status is legal', releaseEntries.every(([, status]) => RELEASE_STATUS.has(status)),
  releaseEntries.map(([release, status]) => release + '=' + status).join(', '))
expect('at least one release is verified compatible', releaseEntries.some(([, status]) => status === 'compatible'),
  releaseEntries.filter(([, status]) => status === 'compatible').map(([release]) => release).join(', ') || 'none')

const operations = compatibility.dshOperations ?? {}
const operationEntries = Object.entries(operations)
expect('lifecycle operations are declared per release', operationEntries.length > 0, operationEntries.length + ' release(s)')
expect('every operation status is legal', operationEntries.every(([, entry]) =>
  entry && typeof entry === 'object'
  && ['install', 'start', 'uninstall', 'rollback'].every(key => OPERATION.has(entry[key]))),
  JSON.stringify(operations))
expect('the verified release has install/start/uninstall evidence', Object.entries(operations).some(([release, entry]) =>
  releases[release] === 'compatible' && entry.install === 'passed' && entry.start === 'passed' && entry.uninstall === 'passed'),
  JSON.stringify(operations))

// Hygiene the review also gates on.
const scripts = manifest.scripts ?? {}
const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare'].filter(key => scripts[key] !== undefined)
expect('no install lifecycle scripts are declared', lifecycle.length === 0, lifecycle.join(', ') || 'none')
const runtimeDependencies = Object.keys(manifest.dependencies ?? {})
expect('no runtime dependencies are declared', runtimeDependencies.length === 0, runtimeDependencies.join(', ') || 'none')

// The bundle is how the package is reached at boot, by name.
const patchPath = resolve(repoRoot, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
expect('the bundle patch exists', existsSync(patchPath), patchPath.replace(repoRoot, '.'))
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  expect('the bundle patch mounts this package by name',
    patch.includes('id: ' + manifest.name) && patch.includes('name: ' + manifest.name), manifest.name)
}
for (const [half, file] of [['host', 'index.mjs'], ['client', 'client.js']]) {
  const source = existsSync(resolve(repoRoot, file)) ? readFileSync(resolve(repoRoot, file), 'utf8') : ''
  const declares = half === 'host' ? source.includes("export const name = '" + manifest.name + "'") : source.includes("id: '" + manifest.name + "'")
  expect('the ' + half + ' half declares this package name', declares, file)
}

const failed = checks.filter(check => !check.ok)
for (const check of checks) console.log((check.ok ? '  ok   ' : '  FAIL ') + check.label + (check.detail === '' ? '' : '  [' + check.detail + ']'))
console.log('\nmanifest contract ' + (failed.length === 0 ? 'OK' : 'FAILED') + ' (' + (checks.length - failed.length) + '/' + checks.length + ')')
process.exit(failed.length === 0 ? 0 : 1)
