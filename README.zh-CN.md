[English](README.md) · **中文**

# dsh-obsidian

[![CI](https://github.com/DedsecLemon/dsh-obsidian/actions/workflows/ci.yml/badge.svg)](https://github.com/DedsecLemon/dsh-obsidian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

把 Obsidian 知识库放进 DSH 右侧栏。**安装步骤见 [INSTALL.zh-CN.md](INSTALL.zh-CN.md)。**
不需要构建 —— `index.mjs` 和 `client.js` 就是直接运行的源码。

```sh
git clone https://github.com/DedsecLemon/dsh-obsidian.git D:/skill/dsh-obsidian
# 然后写在 ~/.dsh/profiles/<你的 profile>/package.json 里
"dsh-obsidian-panel": "link:D:/skill/dsh-obsidian"   # dependencies
"bundles": ["dsh-obsidian-panel"]                    # dsh.profile.bundles
```

## 命名

项目叫 **dsh-obsidian**,**包名是 `dsh-obsidian-panel`,并且没有发布到 npm** —— 从本仓库安装即可。
这个名字没得选:npm 上的 `dsh-obsidian` 属于
[另一个作者的 DSH + Obsidian 插件](https://www.npmjs.com/package/dsh-obsidian),
用那个名字既发不上去,装下来也会变成它。插件运行期的身份不受影响:路由是 `/dsh-obsidian/*`,
slot 键是 `dsh-obsidian/*`,界面上的名字是 `知识库`。

## 兼容范围

| | |
|---|---|
| DSH | `^0.2.0-rc.2` —— 已在 **0.2.0-rc.2** 上验证 |
| Node.js | `>=22.12.0` —— 只用稳定的 `node:` API,实测 22.12.0 |
| Profile | `web`(`dsh.client.platform`),即任何带客户端半的 profile |
| 逐版本声明 | `package.json` 里的 `dsh.compatibility.dshReleases`。只有 `0.2.0-rc.2` 是 `compatible`,其余是 `unknown` —— 直到有人真的跑过,这个字段就是这个意思 |
| 安装/启动/卸载 | 已用**打包产物**在**一次性 profile** 里验证:[docs/LIFECYCLE.md](docs/LIFECYCLE.md) |

发布新版本前,重跑一遍兼容矩阵与生命周期证据:

```sh
node test/profile-lifecycle.mjs    # 安装 → 启动 → 卸载,全部在临时 profile 里
node test/mount-check.cjs          # 客户端半,真实挂载
node test/render-check.cjs         # 注册 + 各类护栏
node test/host-check.mjs           # 全部 HTTP 路由 + 安全边界
```

## 它碰了什么、碰不到时会发生什么

知识库面板不是玩具:它读你的笔记、写你正在编辑的那一篇,还需要一个地方放三个小状态文件。所以这个
插件把它的能力面**声明出来**,而不是等人去发现:

| 信号 | 实际情况 |
|---|---|
| **files** | 读**你选定**的知识库文件夹(以及只为首次猜测而读 Obsidian 自己的注册表 `%APPDATA%\obsidian\obsidian.json`)。写:三个状态文件 `DSH_HOME/dsh-obsidian/`(`vault.json`、`chat.json`、`diag.json`,共约 0.3 KB),以及**你按下 `保存` 的那一篇笔记**。所有读取都限制在知识库根目录内 —— 通过符号链接/junction 的逃逸会被拒绝(host harness 有断言) |
| **network** | **没有任何对外请求。** 面板访问的是宿主自己的回环路由(`/dsh-obsidian/*`),这也是客户端半里有 `fetch` 的原因。没有遥测,没有第三方端点 |
| **commands** | 打开 Obsidian 走的是**宿主自己的 subprocess 服务** —— 插件从不 import `node:child_process`,也不拼 shell 字符串。只在你点「在 Obsidian 中打开」时发生 |
| **credentials** | **没有。** 商城的扫描器把**任何** `process.env` 读取都算作 credentials 信号;本插件读的是 `APPDATA`、`LOCALAPPDATA`、`ProgramFiles`、`ProgramFiles(x86)`、`DSH_HOME`、`DSH_OBSIDIAN_APP` —— 这些都是**环境路径**。没有 token、没有 API key、没有 cookie、没有 OAuth |
| **依赖** | 无运行时依赖(`dependencies` 为空)。`jsdom`/`react`/`react-dom` 只给 harness 用 |
| **外部服务** | Obsidian 桌面应用(可选,只影响「在 Obsidian 中打开」)+ 它所运行的 DSH 宿主 |

失败边界 —— 缺东西时是**成块地退化**,而不是注册到一半:

| 缺什么 | 读者看到什么 |
|---|---|
| `slots`、`sidebarRightTabs`、`sidebarRight` | 插件**完全不激活** —— 左侧栏没有入口,也不会留下半截注册 |
| `sessions`、`workspaces` | 目录树、笔记页、大纲照常;点 `对话` 会说明为什么打不开 |
| `uiWorkspace` | 没有文件夹选择器、也无法导航到对话;知识库路径仍可在面板里手动设置 |
| 宿主的 `webServer` | 路由注册不上,面板没有数据 |
| 本机没装 Obsidian | 只有「在 Obsidian 中打开」不可用(仍会尝试 `obsidian://` 协议处理器) |
| 知识库被移动或删除 | 目录树显示错误并重新询问文件夹 —— 读失败**绝不会**被缓存成「空目录」 |

因为确实用到了 `files` 和 `network`,只给「无能力」插件自动放行的商城会把本插件保持在
**user-reviewed**。这是诚实的结果,不是需要绕开的缺陷 —— 另一种做法是做一个读不了笔记的笔记浏览器。

## 哪个文件夹才是知识库

Obsidian 的注册表只是一个**猜测**,不是答案。第一次运行时,面板显示的不是目录树,而是选择器:它给出探测到的知识库,外加一个文件夹选择器;在读者确认某个文件夹之前,什么都**不读**。这个选择存在 `DSH_HOME` 下(`dsh-obsidian/vault.json`),此后每一次读取都由它说了算,优先于注册表。标题栏保留了一个文件夹按钮,所以之后想换只需一次点击。

`GET/POST /dsh-obsidian/vault` 表达的就是这个状态。`POST` 会校验:文件夹存在、是一个目录,而且**看起来像一个知识库** —— 它要么带着 Obsidian 自己的 `.obsidian` 文件夹,要么在两层之内至少有一个 `.md`/`.markdown`/`.canvas`/`.txt` 文件。机器上每一个文件夹都满足「存在且是目录」,所以把面板指向任意一个,都会被当成装着笔记的库来提供服务;拒绝时会指明是哪个路径、缺了什么。host-check 的探针会**先把这个文件备份、跑完再还原** ——
和聊天的 Session id 一样,它是活状态而不是夹具,一个覆盖它的 harness 会悄悄改变用户的插件读的是哪个文件夹。

一个 DeepSeek Harness **bundle**,把 Obsidian 知识库放进应用的**右侧栏**:一个 `知识库` 标签页,带知识库目录树和全库搜索;一个笔记页,按 Obsidian 阅读视图的方式渲染 Markdown,并且可以就地编辑文件;还有一段与 Agent 的对话 —— 它的 Session 就在知识库自己的 Workspace 里,用应用自己的对话面板打开,所以侧栏的空间一点不占。

**它会写入知识库,而且恰好只有一条很窄的路径。** `POST /dsh-obsidian/note` 覆盖一篇*已存在*的笔记,并且仅当:路径解析后仍落在知识库内、目标是这个插件已经作为笔记展示的文件、且它当前的大小没有超过读取上限 —— 所以被截断过的视图永远不可能被回写、覆盖整个文件。这个包里没有别的东西会写进知识库;对话的 Session id 是 DSH 自己的记账数据,存在 `DSH_HOME` 下。

## 它贡献了什么

| 表面 | 类型 | 位置 |
|---|---|---|
| 面板主体 | 客户端 slot | `sidebar.right.pane.tab`,key 为 `dsh-obsidian/notes` |
| 对话 | shell 面板 | 用 `uiWorkspace.openSession(知识库 Session)` 打开 —— 目录树面板和笔记页上的 `对话` |
| 对话座位的占用者 | 客户端 slot | `dsh-obsidian/panel.conversation`,笔记页上则是 `dsh-obsidian/note.conversation` |
| 笔记页主体 | 客户端 slot | `sidebar.right.pane.tab`,key 为 `dsh-obsidian/note` —— 同时声明它自己的对话子节点 |
| 笔记大纲 | 客户端 UI | 笔记页的 `大纲` 面板,锚点是 `renderMarkdown` 写在标题上的 `dsh-obsidian-outline-*` id |
| 启动行 | 客户端 slot | `sidebar.footer.action`(id `dsh-obsidian`) |
| 标签页类型 | 客户端服务 | `sidebarRightTabs.register({ id, kind, patterns, canOpen, title })` |
| `GET /dsh-obsidian/status` | 宿主路由 | 插件解析出的结果(app、知识库、配置) |
| `POST /dsh-obsidian/open` | 宿主路由 | 打开/聚焦 Obsidian,可选 `{ "file": "笔记/x.md" }` |
| `GET /dsh-obsidian/tree` | 宿主路由 | **一个**目录层级,`?path=<dir>`(`''` = 知识库根) |
| `GET /dsh-obsidian/note` | 宿主路由 | `?path=<note>` → 有上限的文本 + stat(外加 `root`) |
| `GET /dsh-obsidian/search` | 宿主路由 | `?q=<term>&limit=<n>` → 命中的行 |
| `GET /dsh-obsidian/resolve-link` | 宿主路由 | `?name=<wikilink>` → 匹配的笔记路径 |
| `GET/POST /dsh-obsidian/chat` | 宿主路由 | 记住的那个对话 Session id |
| `GET/POST /dsh-obsidian/vault` | 宿主路由 | 读者确认过的那个文件夹 |
| `GET/POST /dsh-obsidian/diag` | 宿主路由 | 客户端半对自己注册情况的报告 |
| `obsidian_open` | Agent 工具 | 打开/聚焦 Obsidian,可选打开某一篇笔记 |

每个路由都同时应答 GET 和 POST;其它方法一律 `405`,而不是悄无声息地退化成 GET。这里刻意没有 `sidebar.panellist` 或 `main` 注册:这个插件曾经在左侧栏多加一个标着 知识库 的入口,如今唯一的入口就是那行 footer。

有三个标识必须彼此一致,而且各自出错的方式都不同:标签页类型的 `title` 是那枚小标签上的文字,它的 `kind` 是 `openTab` 使用的名字,它的 `id` 则是主体在 `sidebar.right.pane.tab` 里注册所用的 key。

## 它刻意*不*做什么

它不嵌入 Obsidian 窗口。Obsidian 是原生 Electron 应用,没有可寻址的 Web 界面,所以 `iframe`、`<webview>` 或浏览器标签页都装不下它 —— shell 自带的浏览器标签页加载的是 URL,而 Obsidian 不是 URL。

这个不对称值得写下来,因为反方向*确实*成立:`dsh-harness` 这个 Obsidian 插件把本应用嵌进了 Obsidian。它能成立,只因为 DSH **本身**就是一个网页。镜像方向没有对应物。

所以这个插件把知识库的**内容**带进右侧栏,而真正的 Obsidian 只隔着一次点击 —— 通过 `obsidian_open` 路由/工具。

## 知识库里的对话

`知识库` 面板旁边开着一段真正的 Agent 对话 —— 它开在中间区域,是一个普通 Session,只不过 Workspace 是知识库;它不在官方侧栏聊天的标签页里,也不在「新建 Session」界面上。它就是一个 Session:第一次使用时创建、之后复用,所以一份计划能扛过一次刷新,也能跨天继续打磨。

**它必须属于知识库的 Workspace,而不只是属于它的目录。** 这一点最容易搞错,而且错了看得出来:只用 `cwd` 创建的 Session 不属于*任何* Workspace,于是对话会打开在空白的「新建 Session」界面上、还带着一个 Workspace 选择器,整体读起来就是「又开了一个新对话」。所以 `resolveVaultChatSession` **先**调用 `ctx.workspaces.create({ path })` —— 文档说它是幂等地解析一个已存在的路径,因此知识库的 Workspace 不会被重复注册 —— 再把得到的 `workspaceId`(加上 `cwd`)交给 `ctx.sessions.create`。

**对话 UI 没有任何一部分被重新实现,也没有占用任何座位。** 应用本来就有唯一合适的地方放对话、唯一的面板渲染它:中间区域的 `main` 键 `conversation`。所以 `对话` 不挂载本插件的任何东西 —— 它通过 `uiWorkspace.openSession(sessionId)` 选中知识库那个 Session,由 shell 自己画:

```js
navigator.openSession(sessionId)   // ctx.get('uiWorkspace')
```

这也是本插件现在**不声明任何子 slot** 的原因:早先的版本在自己两个界面上声明过对话座位(再早还试图占住 `sidebar.chat.conversation`,而那个座位属于 ui-subagent —— 第二次声明会在 `apply` 里抛错,shell 随即回滚本插件做过的**全部**注册)。什么都不声明,既不花钱也不会撞车。

**交接的是文件,不是 AI 的计划。** 把一篇笔记「丢进」对话,做法是在光标处插入它的 `@path` 提及 —— `inputActions.captureInsertion()` + `inputActions.insertText(' @… ', span)`,和拖拽会产生的是同一套机制。这个提及是**绝对路径**(`@D:/知识库/笔记/foo.md`),因为接收对话的 Workspace 不是知识库:相对提及会在错误的根上解析。两个控件分别位于目录树中选中笔记的旁边,以及笔记页的标题栏里。

## 笔记页

笔记在自己的标签页里打开,而不是内联:整高渲染的 Markdown,里面的 `[[双向链接]]` 可点击。每个链接都通过 `/dsh-obsidian/resolve-link` 在知识库里解析,并把目标打开成**它自己的一页** —— 顺着链接走永远不会丢掉你正在读的那一页。目录树仍然待在 `知识库` 面板里;笔记不会取代它。

**排版是 Obsidian 的,照抄过来的。** `READ` 里的数字就是默认主题阅读视图自己的值 —— 16px、行高 1.5;标题阶梯(`1.618em`/`1.462em`/`1.318em`/`1.188em`/`1.076em`/`1em`)及其字重(h1 为 700,其余为 600)与行高;块与块之间 `1rem`;标题紧跟在另一个块之后时上方 `2.5rem`;列表缩进 `2.25em`;引用块有 `2px` 的强调竖线和 `24px` 内边距;代码块不加装饰。`render-check` 把其中好几项钉住了,因为正是这里的漂移让页面不再像 Obsidian。

GFM 表格会渲染成表格。在这之前,它渲染成一段由竖线组成的段落,而一篇带表格的笔记大部分时间看起来就是这样。

**大纲。** 笔记标题栏里的 `大纲` 会在窗格右缘浮出一个标题清单:点其中一条,阅读区就滚到那个标题;你当前正在读的标题那一行会被标出来。层级用缩进表示,所以 `##` 下面的 `###` 一眼就能看出是嵌套的。

它刻意只是**对已渲染页面的一层视图**,而不是把笔记再解析一遍。`renderMarkdown` 在渲染时就把每个标题的锚点(`id`)和层级(`data-outline`)写成 DOM 属性,面板再用 `querySelectorAll` 读回来 —— 只解析一次,清单就不可能描述出与屏幕上不同的另一页。这也包括被截断的情况:超过 `MAX_RENDER_LINES` 的笔记只渲染开头,大纲列出的正是真实存在的那些标题,不会出现指向根本没画出来的标题的条目。锚点按页面实例编号,同时开两个笔记页也不会撞。

面板可以用它自己的控件、`×`,或进入编辑模式来收起 —— 渲染出来的页面已经没了,也就没什么可大纲的了。`mount-check` 用一篇标题阶梯为 一/二/三/二 的笔记跑完 打开 → 选择 → 跳转 → 收起,并断言锚点、缩进和滚动目标。

**编辑。** `编辑` 把渲染视图换成同一文件的纯文本编辑器;`保存` 把整段文本 POST 到 `/dsh-obsidian/note`。读取时被截断的笔记会直接被拒绝编辑 —— 局部视图不是覆盖该文件的安全基础。

**把笔记引用进对话。** 只有一个控件,因为提及只有一个落点:`引用到对话` 把这篇笔记的绝对 `@path` 插到**当前中间区域那个对话**的输入区里 —— 和把文件拖进去是同一件事。路径必须是绝对的,因为接收方的 Workspace 未必是知识库:相对提及会解析到错误的位置。知识库根未知时是**拒绝**(`no-path`),而不是插一个 `@undefined`。

已经不存在「第二个输入区」可以够,所以这是一个控件而不是两个:知识库对话就是读者从 `对话` 打开的那个 Session。`mount-check` 断言这次点击把该 Session 交给了 shell,并且引用落进了页面拿到的那个输入区。

## 对话:开在中间,由 shell 承载

对话本身就是一个普通的 DSH Session —— 只不过它的 Workspace 是知识库 —— `对话` 把它交给应用:`uiWorkspace.openSession(sessionId)` 选中它,中间区域用 shell 自己的对话面板显示它。本插件不渲染它的任何一部分,它也完全不碰右侧栏的布局:目录树和笔记还留在旁边,而插件自己的界面只有一个按钮。

这就是全部设计,也是对「这个插件连错三次的问题」的答案。右侧栏的一个窗格只有几百像素的工具空间,把对话塞进去只有两种形状,而两种都是错的:要么吃掉目录树的高度(最早的页脚、后来的浮动弹出框),要么把它顶掉(独立标签页)。两种形态都得替一个「一阵一阵用」的东西编一个尺寸,而这一列的本职是展示知识库。中间区域才是应用放对话的地方:整宽、已经自带输入区/记录/停止按钮等等,而且 Session 在宿主侧 —— 所以打开和关掉这个视图对对话毫无损失。

两个值得说明的后果:

- **本插件现在不声明任何子 slot。** 它曾经在两个界面上各自声明一个对话座位,等于自己养一份对话状态并一直喂着。现在没有属于我们的东西会和 `sidebar.chat.conversation`(在这个 profile 里归 ui-subagent)撞车,也没有东西需要维持。
- **笔记页上的 `引用到对话` 写进的是屏幕上那个对话。** 标签页主体拿到的 `inputActions` 属于**拥有这个侧栏的**那个 Session —— 也就是中间区域正在显示的那个 —— 所以引用一篇笔记,就是把它的绝对 `@path` 放进当前打开的对话;只要读者是从 `对话` 进去的,那就是知识库对话。模块级句柄已经没有了,因为不存在第二个输入区可以够。

### 继续上次,还是新开一个

记住的 Session 就是握着历史的那个,所以「打开知识库对话」本来就应该指它 —— 按钮原先就是这么做的,而且是**默默**做的。这让另一种意图(从空白开始)变成必须去工作区里翻找才能实现,而反过来(永远新建)又会把历史丢掉。所以 `对话` 先解析,发现有可回去的历史时**先问**:

```
继续上次对话   回到知识库里的那段历史
新开一个对话   同一工作区，从空白开始
```

没有记住的 Session 就不弹菜单:第一次使用直接建一个并打开。「新开」是在知识库 Workspace 里真建一个新 Session,而且**只在它建好之后**才替换记住的 id —— 失败时历史依然找得到。

### 选好文件夹,工作区就出现

知识库的 Workspace 在读者**确认文件夹的那一刻**就注册,而不是等到第一次点 `对话`。Workspace 是这个文件夹「能作为 Agent 的目的地」的凭证,也是侧栏列出来的东西,所以惰性解析意味着在读你去点对话之前什么都不会出现。`workspaces.create` 按契约是幂等的,所以 `resolveVaultChatTarget` 里那条惰性路径照常可用,且在工作区已存在时不花任何代价。

### 侧栏会被放回去

右侧栏的标签页是 **session 作用域**的:选中另一个 Session 会给窗格一套全新的、空的标签页 —— 目录树,或者读者正在看的笔记页,会跟着它所属的那个 Session 一起消失。打开一个对话不等于关掉目录树,所以插件记住自己当时在显示哪个界面(`rememberSurface`),在 `openSession` 之后把它放回去(`restoreSurface`);因为窗格会为新 Session 重新挂载,这里有几次短暂重试。目录树自己的浏览状态 —— 展开、选中、搜索词、已经取回的层级 —— 也会穿过这次重挂载保留下来,因为知识库还是同一个;但若发现换成了另一个知识库,就整个丢弃。

### 编辑态和阅读态是同一个盒子

`编辑` 把渲染好的一页换成同一文件的 `textarea`,两者必须是同一个盒子:16px、行高 1.5、同样的 `18px 22px 96px` 内边距、同样的字体。编辑器原先用的是 13px 等宽字体加自己的内边距,于是按一下按钮、还没输入一个字,页面就重排了 —— 模式切换成了这个功能里最显眼的东西。`mount-check` 会把编辑器的这些度量跟阅读视图对一遍。

## 一个 slot,一个声明者 —— 以及它为什么能让整个插件倒下

`sidebar.chat.conversation` 是 `single` slot,而 slots 核心拒绝第二次声明它(`dsh-client-ui-slots`):

```js
if (options.children) for (const childKey of Object.keys(options.children)) {
  const childRec = this.records.get(childKey);
  if (childRec?.spec) throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy})`);
}
```

这个抛错发生在 `apply` 里面,而 shell 对 `apply` 失败的处理是**回滚这个插件做过的每一次注册**。所以从笔记面板和笔记页两处都声明这个座位,代价不是少一个标签页 —— 而是整个插件,侧栏里什么都看不到。

因此笔记页声明**自己的**座位 `dsh-obsidian/note.conversation`,并占住它。不同的名字不会撞车 —— 而且声明一个 session 作用域的子节点,恰恰也是让那个主体**挣到**对话所需那两样东西的原因:渲染器只把 `renderSlot` 和 `SessionProvider` 发给声明了子节点的条目:

```js
if (entry.children !== void 0) {
  kit["renderSlot"] = boundRenderSlot(host, entry);
  if (Object.values(entry.children).some((spec) => spec.scope !== "root")) {
    kit["SessionProvider"] = scopeAreaProvider(adapter);
  }
}
```

相比之下,`renderFactorySlot` 是发给每个条目的 —— 但它自己不够:没有 `SessionProvider`,工厂就没有可渲染的 session 作用域,这就是为什么只有工厂的笔记页显示的是「没有座位也没有工厂」,而不是一段对话。

这是早先版本用来承载自己那个对话的机制。现在的插件不声明任何子 slot,所以它根本拿不到 `renderSlot`/`SessionProvider` —— 也不需要:知识库对话由 shell 的 Conversation 面板绘制,本插件只是按 Session id 把它选中。

两个客户端 harness 现在都照搬 slots 核心的规则,**遇到第二次声明就抛错**;`render-check` 通过声明两次同一个座位来证明这道护栏是活的,并断言本插件一个子 slot 都没声明。一道不出声的护栏比没有更糟:这正是它们第一次没抓到的那次故障。

## 为什么记住的 Session 永远优先

`resolveVaultChatSession` **无条件**复用记住的 Session id,根本不去问 Workspace。记住的 Session 就是握着对话历史的那个;如果靠重新推导 Workspace 归属来决定要不要复用它,那么只要推导结果不一致,历史立刻就没了 —— 「重启后我的历史不见了」就是这个样子。Workspace 只在*创建* Session 时被问到,这样新建的会话会归到 知识库 下,而不是变成孤儿。

**读取失败不等于「什么都没记住」。** 对失败的 `GET /chat` 回答 `''`,会让插件新建一个 Session,并把它的 id POST 覆盖掉记住的那个:一次瞬时读取错误,历史就没了。现在读取失败会进入一个可见的失败状态,并且**绝不写入**。*写*失败同样是可见的 —— 宿主返回 `400` 并带上出错的路径,而不是一个让「这个 id 从来没被记住」看起来像成功的 `200`。

**Sessions 和 Workspaces 是惰性查找的**(`ctx.get`),从不写在 `exports.inject` 里。要求一个 profile 并不发放的服务,会让整个条目卡住不激活 —— `apply` 根本不会跑,侧栏也就丢掉了这个插件,连目录树一起。惰性查找才让「对话不可用,但目录树照常工作」成为一个真能到达的状态,而不是死代码。`uiWorkspace` 同理:少了它,`对话` 只是报一句「没有会话导航」,目录树毫发无损。

显示会话的 retain/release 现在归 shell —— 它显示哪个 Session,就由它持有。本插件不再 retain 任何东西,因为不再有任何界面承载对话。

## 为什么面板是纵向堆叠的

右侧栏的一个窗格只有几百像素宽,所以面板保持单列:主体显示目录树(或实时搜索结果)。笔记永远不霸占这一列 —— 它打开成自己的一页;对话也完全不在这列里:由 shell 显示在中间。没有任何东西来抢这个窗格的高度。harness 断言这个纵向堆叠,所以将来某次改动若重新引入并排两列,失败的是测试而不是布局。

## 为什么目录树是一层一层取的

一个知识库里可能既有笔记,也躺着一份完整的源码检出。让宿主在一次响应里返回整棵树,会让某一个又深又宽的目录花光整个节点预算,知识库剩下的部分就**悄无声息地**消失了 —— 这个插件早期的一个版本正因为如此,只返回了 17 个根条目中的 4 个。

所以 `/tree` 只回答恰好一个目录层级,面板在这个文件夹第一次展开时才去取这一层。每一层都是完整的,再大的知识库也保持响应,而且没有任何东西会在读者不知情的情况下被丢掉:当宿主的每层上限真的咬到时,面板会显示 **仅显示前 N 项**,而不是悄悄把列表结束掉。

取某一层失败时,**不会**把它缓存成空目录。`[]` 会宣称这个文件夹是空的,并让它再也不会被重试;现在改成丢掉这个失败的 key、把提示显示出来,再由一个 重试 控件重新去取。搜索结果带同样的截断提示,而且对更早一次查询(或更早一篇笔记)的回答,绝不会覆盖更新的那个 —— 每个请求都带一个序号,过期的回答会被丢弃。

## 它怎么认出你这台机器

没有任何东西硬编码到某一次安装。调用的时候,宿主半会:

1. 读取 `%APPDATA%\obsidian\obsidian.json` —— Obsidian 自己的知识库注册表 ——
   并挑出最近打开过的那个知识库(Obsidian 的 URI 处理器期望的知识库名,就是文件夹的基本名);
2. 依次从 `DSH_OBSIDIAN_APP`、常见安装位置定位 `Obsidian.exe`;
3. 用它启动:`obsidian://open?vault=<vault>[&file=<file>]`。

已经在运行的 Obsidian 会被*聚焦*,而不是再开一个,因为 Obsidian 自己就强制单实例。如果找不到可执行文件,启动会退回 Windows 注册的 `obsidian://` 协议处理器。

`GET /dsh-obsidian/status` 会如实报告解析出了什么。

## 安全

- 来自浏览器的每一条路径都会对着知识库根解析,一旦逃逸就被拒绝;`..` 和 Windows 风格的 `..\` 都会失败。
- **字符串前缀不等于包含。** 锚点是根目录的 `realpathSync`,已存在的目标会再解析一次并且必须落回它内部,所以知识库*里面*的符号链接或 NTFS junction,再也不能经由 `/note`、`/tree` 或写入路径去读、去覆盖外面的文件。`realpathSync` 失败(EPERM、悬空或损坏的链接)一律是拒绝,绝不是放行。
- 点目录和构建/VCS 目录(`.obsidian`、`.git`、`node_modules`,…)永远不会被列出 —— 而且任何带 `.` 前缀段的路径,目录树、笔记读取和笔记写入都一样拒绝,所以 `.git/config`、`.mcp.json` 和 `.obsidian/*` 都到不了。笔记读取还必须指名一个真正的笔记文件(`NOTE_FILE`),和写入路径一直以来的那道护栏相同。
- 笔记读取上限 512 KB。一次搜索有四重边界 —— 200 条结果、读 3000 个文件、进 5000 个目录、深度 24 —— 并跳过大于 1 MB 的文件。
- **`truncated` 表示这个回答不完整,原因可能是上面任意一种。** 撞到上限的搜索、或跳过了超大笔记的搜索,都会置 `truncated: true`,而被跳过的超大笔记数量会单独以 `skippedLarge` 报告。这两者刻意不是同一件事:`truncated` 是面板据以行动的信号,`skippedLarge` 则告诉它这是*哪一种*不完整。跳过一篇大笔记以前是无声的,于是一个装满大笔记的知识库会回答「搜过了,什么也没找到」,却从来没读过其中任何一篇 —— 现在面板会说这篇笔记没有被搜索,而且即使没有别的结果也会说。读完了一切的搜索仍然回答 `truncated: false`。
- 撞到深度上限的分支是被剪掉,而不是致命错误:遍历不再往下走,仍然搜索知识库的其余部分,并报告截断。在那里直接中止,会让一个很深的文件夹把它旁边所有笔记都藏起来。
- **请求体在读取过程中就被限制在 8 MB**,不是读完之后:超限时读取停止、请求被拆掉,路由回答 `413`。以前 4 MB 的笔记上限是唯一的边界,而且它是在整个 body 已经进了内存之后才跑,所以一次上传在任何检查生效之前就已经被完整缓冲了。
- **写入。** 只有一条:`POST /dsh-obsidian/note` 覆盖一篇笔记。它会拒绝逃出知识库的路径、隐藏路径、不存在的目标、不是文件的目标、不是这个插件已经展示为笔记的目标、当前大小超过读取上限的笔记(被截断的视图不是覆盖的安全基础),以及超过 4 MB 的内容。字节按原样写入,UTF-8。
- **`/diag` 只存客户端半报告的内容。** 它接受 `inject`、`report` 和 `renderError`,其它一切丢掉;而它的 `at` 时间戳是在这些 key 复制**之后**由服务端赋的 —— `{ at: Date.now(), ...body }` 会让调用方既覆盖时间,又把任意 key 塞进这个插件写到磁盘的文件里。
- 对话的 Session id 写到 `<DSH_HOME>/dsh-obsidian/chat.json`。那是 DSH 自己的记账数据,不是知识库内容。写不到磁盘会返回 `400` 并指明路径,所以「没被记住」从来不是无声的。
- `host-check` 用它自己创建、随后删除的探针文件来演练写入路径,所以不会碰到任何已有笔记,并断言上面每一条拒绝。它会读取并还原 `chat.json`、`vault.json` 和 `diag.json`:这三个都是活状态,不是夹具。协议探针 —— junction 逃逸、各种上限、文件夹校验 —— 跑在 `os.tmpdir()` 下创建的知识库上,并通过真实的 `/vault` 路由切换进去,所以用户自己的知识库永远不会被进入。

## 目录结构

```
package.json        # dsh.bundle.patch + dsh.client
cordis.patch.yml    # bundle layer: mounts this package by name
index.mjs           # host half: resolution, routes, obsidian_open tool
client.js           # client half: the right-Sidebar tab type + its launcher
test/               # headless harnesses, not shipped
```

## 测试

两半都能在没有浏览器、也没有活的 DSH 的情况下运行 —— 宿主 harness 把子进程服务造假,所以它从不启动 Obsidian。

```sh
npm install                  # once: the client harnesses need react/jsdom
node test/mount-check.cjs    # mounts the panel into jsdom with a stubbed fetch
                             # and drives every state the shell can put it in
node test/render-check.cjs   # executes client.js as the module table does,
                             # then server-renders every seat with real React
node test/host-check.mjs     # drives every route against the real vault
```

两个客户端 harness 从**这个包自己的** `devDependencies` 解析 `react`、`react-dom` 和 `jsdom`,React 钉在 shell 打包的那个 `18.2.0` 上。它们以前是从 DSH 源码检出里借这些依赖的,这让它们被一个和本插件毫无关系的目录挟持 —— 而那个目录后来还被删了,直接从它们脚下抽走。

`mount-check.cjs` 之所以存在,是因为服务端渲染不够。它带着面板走一遍 挂载 → 目录树 → 展开 → 笔记 → 大纲 → 对话 → 返回 → 搜索 → 启动行,而且 effect 是真的在跑。这个插件的第一个版本在自己声明之前用了 `const`:抛错发生在 passive mount effect 里,而 SSR 从不执行它,slot 框架的条目边界则以**把这个标签页主体 retire 掉**作为回应 —— 于是右侧栏打开是空的,产品里没有任何东西指向原因。这一类 bug 只有真实挂载才看得见。

它也是用回归测试抓住那两个流到用户手上的缺陷的地方:这个框在**每一次**渲染时都 retain 它的 Session(resolver 每次都是新标识,于是 acquire effect 在循环里重跑),以及抑制 Hero 之后随之而来的那些阶段期望。

`render-check.cjs` 覆盖那些肉眼看不见的接线:标签页类型的 `id` 等于它主体座位的 key;面板主体声明了自己的对话座位并占住它;对话从不渲染 Hero;footer 行恰好只有一行、且没有对话标签页;`sessions`、`workspaces` 和 `uiWorkspace` **不在** `inject` 里(并且以属性方式读它们任意一个都会抛错);无法识别的 Session 快照会带着真正被调用的 selector 交给工厂;一个没有 Sessions 的 profile 仍然能注册并渲染目录树面板;未知的知识库根是 `no-path` 拒绝,而不是一个 `@undefined` 提及。它还钉住了 Obsidian 阅读视图的排版和 GFM 表格。

`host-check.mjs` 对着真实的知识库跑全部九个路由,并断言对话的 Session id 落在 `DSH_HOME` 下、而不是知识库内部 —— 而且是对着**真实的**存储路径,因为旧断言指的那个文件这个插件从不写。它还断言 `.git/config`、`.mcp.json` 和 `.obsidian/*` 既读不到也列不出,非笔记文件读不到,`PUT`/`DELETE` 是 `405`,`/diag` 能往返,写不到磁盘的 chat 写入是带路径的 `400`,以及 8 MB 的 body 是 `413`、且它的读取提前停止了。

那些需要自己一块知识库的探针 —— 指向外面的 junction、超过单文件上限的笔记、26 层深的链、5001 个同级目录、被当作知识库提供的空文件夹 —— 用的是 **`os.tmpdir()` 下的临时知识库**,通过真实的 `/vault` 路由切进去,跑完再还原。用户的知识库从不被写入;junction 探针在临时树里创建、也在那里删除。进程建不出来的 junction 会以**带原因的 skip** 报告,绝不是通过。`host-check` 会在最后一行打印检查数量和任何 skip。

## 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-obsidian
```

该 profile 的 `dsh.profile.bundles` 会多出 `dsh-obsidian`,这一行从 `cordis.patch.yml` 加载。卸载:

```sh
dsh plugin --profile <name> remove dsh-obsidian
```

新装上的宿主半在启动时被 import,而 Node 按解析后的 URL 缓存 ESM —— 所以让改动过的宿主半生效靠的是**重启**。改动过的 `client.js` 还额外需要刷新页面,除非 shell 正跑着它的客户端 watcher。

## 开发笔记

`client.js` 是手写的 loader 产物,不是 tsdown 的输出,所以这个包不需要构建步骤:

```js
window.__ModuleLoader__.load({
  id: '<package name>',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    // `require` answers only from the shell's frozen table:
    // react, react/jsx-runtime, react-dom, @deepseek-ai/cordis,
    // @deepseek-ai/dsh-client-store, -ui-slots, -ui-primitives, -ui-dockkit.
    exports.apply = (ctx) => { /* ctx.slots.inject(...) */ };
    exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
    return module.exports;
  },
});
```

超出这条基线的任何东西都必须走 `dsh.client.external` 和真正的构建;禁止跨插件做值导入 —— 请改用 Cordis 服务协作。面板的配色来自 shell 发布的主题 token(`--dsw-alias-*`),所以不用样式表就能跟随明暗。

**`inject` 是承诺,不是许愿单。** 一个条目如果要求了 profile 不发放的服务,就永远不会激活 —— 没有报错,没有窗格,整个插件就是不在。所以 `inject` 只写这个插件离开它就活不了的东西,而 profile 可能合理地缺的一切(Sessions、Workspaces、文件夹选择器)都在需要的那一刻用 `ctx.get('name')` 去取。把这样的服务当**属性**读会在 shell 内部抛错(`cannot get property "X" without inject`),这也是为什么 harness 用 Proxy 把这条规则明确排除掉。

`openTab` 写入**当前挂载的** Session 的右侧栏,并且在没有任何 session 界面挂载时抛错,所以启动行会接住它并把情况说出来,而不是无声失败。
