[English](INSTALL.md) · **中文**

# 安装到另一台电脑

这个插件**不需要构建**:`index.mjs` 和 `client.js` 就是直接运行的源码,拷过去即可。

## 1. 拿到代码

从本仓库 clone 或下载,把整个文件夹放到一个固定的位置,例如:

- Windows:`D:\skill\dsh-obsidian`
- macOS / Linux:`~/dsh-obsidian`

文件夹叫什么无所谓 —— 插件的身份来自 `package.json`,而它的**包名是 `dsh-obsidian-panel`**
(项目本身叫 `dsh-obsidian`,**没有发布到 npm**,原因见 README 里的命名说明)。路径里
**尽量避免中文和空格**,能省掉一类麻烦。

## 2. 挂进 DSH 的 profile

DSH 的插件挂在某个 **profile** 下,不是丢进目录就生效。编辑:

```
~/.dsh/profiles/<你的 profile>/package.json
```

**a)** 在 `dependencies` 里加一行(路径换成**你自己的**):

```json
"dsh-obsidian-panel": "link:D:/skill/dsh-obsidian"
```

**b)** 在顶层的 `bundles` 数组里加上包名(没有这个字段就新建):

```json
"bundles": ["dsh-obsidian-panel"]
```

**c)** 在该 profile 目录下执行:

```
pnpm install
```

> 也可以直接让 DSH 里的 AI 代劳:告诉它「用 `plugin_manager` 把 `link:<你的路径>` 装成 bundle」。
> 安装日志在 `~/.dsh/profiles/<profile>/.plugin-manager/logs/`。

## 3. 重启 DSH

- 改了 `index.mjs`(**宿主半**)→ 必须**重启进程**
- 只改了 `client.js`(**客户端半**)→ 刷新页面即可

装好后左侧栏底部会出现 `知识库`。

## 4. 第一次使用

点开 `知识库`,它会先让你**选知识库文件夹**(会先自动探测 Obsidian 已注册的库)。
选完才会有目录树 —— 在你确认之前它**不读任何文件夹**。

## 环境要求(缺了会怎样)

| 需要的东西 | 缺了会怎样 |
|---|---|
| 客户端服务 `slots`、`sidebarRightTabs`、`sidebarRight` | **插件整个不激活**(左侧栏没有任何入口) |
| `sessions` + `workspaces` | 只是**没有对话**:目录树/笔记页/大纲照常,点 `对话` 会明说不行 |
| `uiWorkspace` | 文件夹选择器打不开,`对话` 也无法导航,改成手动设置路径 |
| 宿主服务 `webServer` | 所有 HTTP 路由注册不上,面板没数据 |
| 本机装有 Obsidian | 只有「在 Obsidian 中打开」不可用,其余功能不受影响 |

前两项是历史踩过的坑:`inject` 里声明了拿不到的服务,会让**整个条目**不激活,`apply` 根本不会被调用。

## 不需要 node_modules

`node_modules` 只被 `test/` 下的三个 harness 需要。**跑测试才需要 `pnpm install`。**

```
cd dsh-obsidian
pnpm install
node test/render-check.cjs     # 客户端半:注册/渲染 + 各类护栏
node test/mount-check.cjs      # 真实 jsdom 挂载:树、笔记页、大纲、对话、首次引导
node test/host-check.mjs       # 宿主半:全部 HTTP 路由 + 安全边界
node test/profile-lifecycle.mjs  # 一次性 profile 里的 安装 → 启动 → 卸载(见 docs/LIFECYCLE.md)
```

> `host-check` 会读写**真实状态文件** `~/.dsh/dsh-obsidian/{chat,vault,diag}.json`。
> 它自带备份/恢复,跑完会原样还原 —— **请勿手动删除这些文件**。

### 为什么 CI 只跑前两个 harness

- `render-check.cjs` 与 `mount-check.cjs`:完全自足,宿主用假 `fetch` 顶掉,不需要真库 → **在 CI 跑**。
- `host-check.mjs`:打的是真实 HTTP 路由,并且断言**某个具体知识库里的内容**(某个 `README.md` 存在、某个双向链接能解析、超上限的笔记被截断)→ **只在本地跑**;在 CI 里跑等于在测夹具,而不是测插件。
- 设 `DSH_OBSIDIAN_APP` 可以让它跑满(102 条);不设的话,依赖 Obsidian 安装位置的那 3 条会**明确标为 skip**,不会假装通过。

`.github/workflows/ci.yml` 就是这个分工,本节与它保持一致。

## 状态文件

```
Windows:     C:\Users\<你>\.dsh\dsh-obsidian\
macOS/Linux: ~/.dsh/dsh-obsidian/
```

| 文件 | 内容 |
|---|---|
| `vault.json` | 你选的知识库路径(优先于 Obsidian 注册表) |
| `chat.json` | 知识库对话的 Session id(历史靠它续上;`对话` 会因此问「继续还是新开」) |
| `diag.json` | 客户端自检报告(注册了哪些、有没有渲染报错) |

**拷到新电脑后这些文件不存在完全没关系** —— 第一次打开会重新问你选哪个知识库。
