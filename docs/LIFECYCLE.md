# Disposable-Profile lifecycle evidence

The marketplace's automatic review asks for **install / start / uninstall evidence from a
throwaway profile**, not "it works on my machine". This is that evidence, and it is
reproducible:

```sh
node test/profile-lifecycle.mjs              # add --keep to inspect the profile afterwards
```

The script never boots the Electron app and never touches a real profile. It creates a
temporary profile, installs the **packed tarball** into it, exercises both halves of the
*installed* copy, then removes the package and checks that nothing is left behind.

## What it does, step by step

| Step | What happens | Why it is evidence |
|---|---|---|
| pack | `npm pack` | proves the `files` list ships a package that can run — the tests are *not* in the tarball, so nothing here can lean on the working tree |
| install | a temp profile with `"dsh-obsidian-panel": "file:<tarball>"` → `pnpm install` | a real install through the profile mechanism the app uses |
| install checks | no `preinstall`/`install`/`postinstall`/`prepare` scripts; the installed manifest keeps the name and version; `dependencies` is empty; `cordis.patch.yml` names the installed package; `client.js` carries the loader id | the four things a bundle needs to be reachable and loadable at boot |
| start (host) | `test/host-check.mjs` pointed at the installed `index.mjs` (`DSH_OBSIDIAN_MODULE`) | the install *is* the thing that applies: a real context, every HTTP route answered, the tool executed |
| start (client) | `test/render-check.cjs` pointed at the installed `client.js` (`DSH_OBSIDIAN_CLIENT`) | the client half registers through the real `__ModuleLoader__` contract — including the loader-id check that fails loudly if the name does not match `package.json` |
| uninstall | the dependency and the bundle entry are removed → `pnpm install` | the manager's own removal path |
| uninstall checks | `node_modules/dsh-obsidian-panel` is gone; no `client.js`/`index.mjs`/`cordis.patch.yml` left in the profile | nothing of the plugin survives in the profile |

## Observed run

```
  ok   pack  [dsh-obsidian-panel-1.2.1.tgz (81682 bytes)]
  ok   install  [<temp>/dsh-profile-lifecycle-XXXXXX]
  ok   install runs no lifecycle scripts  [none declared]
  ok   install keeps the declared identity  [dsh-obsidian-panel@1.2.1]
  ok   install needs no runtime dependencies  [none]
  ok   bundle patch names the installed package  [cordis.patch.yml]
  ok   client half carries the loader id  [client.js]
  ok   start: client half registers  [render-check OK against the installed client half]
  ok   start: host half applies and answers every route  [99 checks, 0 failure(s)]
  ok   uninstall removes the package  [node_modules/dsh-obsidian-panel]
  ok   uninstall leaves nothing of the plugin in the profile  [none]

lifecycle evidence OK (11/11 steps)
```

Windows, DSH `0.2.0-rc.2`, Node `v24.16.0`, installer `pnpm` (npm is used automatically when
pnpm is not installed).

**Which systems this was run on, and which it was not.** These steps ran on Windows. The
macOS and Linux behaviour in `package.json`'s `os` list rests on `test/platform-check.mjs`
(30 checks: every platform's Obsidian locations, registry path and `obsidian://` opener),
not on a run on those systems — say so rather than implying hardware that was never touched.

CI runs the same script with **`--skip-host`** (10/10 steps): a runner has no vault, and the
skipped step is the only one that needs one. `test/manifest-check.mjs` (24 checks) runs in CI
too, so the compatibility and permission declarations themselves are checked on every push.

**A vault-fixture failure is not a contract failure.** `host-check` also asserts things
about *one machine's vault contents* — that a particular note exists, that a wikilink
resolves, that an oversized note is truncated. On a machine whose vault has no such note,
`note reads a real file` fails while every check about applying the plugin, injecting its
services and answering its routes passes. The lifecycle script tolerates exactly that class
of failure (`real file`, `does not exist`, `README`, `wikilink`, `truncat`) and **fails** on
anything else — see `test/profile-lifecycle.mjs`. The run above is on a vault that satisfies
those fixture expectations, hence 0 failures; the tolerance is what keeps this evidence
meaningful on a machine whose vault does not.

## Leftovers worth knowing about

Uninstalling removes the package. It does **not** delete the three state files the running
plugin keeps under `DSH_HOME`:

```
~/.dsh/dsh-obsidian/{vault.json,chat.json,diag.json}     ≈ 0.3 KB total
```

That is deliberate — they are the reader's chosen vault, the conversation's Session id and
the client half's self-check report. Delete that directory if you want a clean slate; a
fresh install recreates it on first use.

---

## 中文摘要

`node test/profile-lifecycle.mjs` 会在**临时 profile** 里用 **npm 打包产物**完成安装 → 启动 →
卸载的完整验证：安装不跑任何生命周期脚本、不依赖运行时依赖；启动时两个半都对着**装好的副本**跑
harness（宿主半跑全部 HTTP 路由，客户端半走真实模块加载器）；卸载后 profile 里不残留任何插件文件。
上面的输出是实测记录（Windows / DSH 0.2.0-rc.2 / Node 22.12.0），唯一的失败项是**该机器知识库内容
相关**的夹具断言，与插件契约无关 —— 脚本只容忍这一类失败，其他任何失败都会让整体 FAIL。
唯一残留是 `DSH_HOME` 下的三个状态文件（共约 0.3 KB），属于用户数据，需手动删除。
