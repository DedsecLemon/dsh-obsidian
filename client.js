// dsh-obsidian — client half (prebuilt browser artifact).
//
// Loader contract: one `window.__ModuleLoader__.load({ id, factory })` call.
// The factory body is CommonJS; `require` answers from the shell's frozen module
// table, so only baseline specifiers (react, ui-slots, ...) are importable here.
//
// Contributes a right-Sidebar tab type plus the launcher that opens it:
//   sidebar.right.pane.tab   the notes panel body, keyed by the type's `id`
//   sidebar.footer.action    the row that opens that tab
//
// The layout is deliberately vertical: a right-Sidebar pane is a few hundred
// pixels wide, so the tree and the preview take turns in one column instead of
// sitting side by side.
//
// The palette comes from the shell's published theme tokens, so it follows the
// active light/dark theme without a stylesheet.

window.__ModuleLoader__.load({
	id: 'dsh-obsidian-panel',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const h = React.createElement;

		/** This implementation's identity in the tab system: also its body seat key. */
		const TAB_ID = 'dsh-obsidian/notes';
		/** What `openTab` names. */
		const TAB_KIND = 'obsidianNotes';
		const TAB_TITLE = '知识库';

		const FOOTER_SLOT = 'sidebar.footer.action';
		const TAB_SLOT = 'sidebar.right.pane.tab';

		const API = {
			open: '/dsh-obsidian/open',
			tree: '/dsh-obsidian/tree',
			note: '/dsh-obsidian/note',
			search: '/dsh-obsidian/search',
			chat: '/dsh-obsidian/chat',
			status: '/dsh-obsidian/status',
			resolve: '/dsh-obsidian/resolve-link',
			vault: '/dsh-obsidian/vault',
			diag: '/dsh-obsidian/diag',
			links: '/dsh-obsidian/links',
		};

		// ── the vault conversation ───────────────────────────────────────────
		//
		// One extra DSH Session whose Workspace is the vault, so the agent works with
		// vault-relative paths and this plugin's tools. It is SHOWN by the shell, in
		// the centre, as an ordinary Session — see `ConversationButton`. Nothing
		// about the conversation is reimplemented, and nothing about it is in this
		// plugin's layout.

		/** How long a feedback line stays before it clears itself. */
		const FEEDBACK_MS = 2600;

		/**
		 * One self-clearing feedback line per surface.
		 *
		 * Four separate `setTimeout(() => setFeedback(''), …)` calls had no cleanup
		 * and no memory of each other: an earlier timer fired into a newer message and
		 * wiped it, and a timer outlived an unmounted component. Here there is exactly
		 * one live timer, a new message cancels the previous one, and unmounting
		 * clears it.
		 * @returns `[text, show]`; `show(message)` clears itself after
		 * `FEEDBACK_MS`, `show(message, customMs)` after that, and `show(message, 0)`
		 * never (for "working…" lines that stay until they are replaced).
		 */
		function useFeedback() {
			const [text, setText] = React.useState('');
			const timer = React.useRef(null);

			const clear = React.useCallback(() => {
				if (timer.current !== null) {
					clearTimeout(timer.current);
					timer.current = null;
				}
			}, []);

			React.useEffect(() => clear, [clear]);

			const show = React.useCallback((message, ms) => {
				clear();
				setText(message);
				if (message === '' || ms === 0) return;
				timer.current = setTimeout(() => {
					timer.current = null;
					setText('');
				}, ms === undefined ? FEEDBACK_MS : ms);
			}, [clear]);

			return [text, show];
		}

		/** What each `mentionInto` outcome should say to the reader. */
		const ATTACH_MESSAGE = {
			ok: '已引用进对话',
			'no-actions': '打不开这个对话的输入框',
			'no-path': '无法引用这个路径',
			refused: '未能插入，输入框正忙',
		};

		/**
		 * Insert one note's `@path` mention into a conversation's composer — the same
		 * thing a drag-and-drop does.
		 * @param actions - that conversation's `inputActions`.
		 * @param absolutePath - the note's absolute host path, or undefined when the
		 * vault root is not known yet (`absoluteVaultPath` refuses to invent one).
		 * @returns a key into `ATTACH_MESSAGE`.
		 */
		function mentionInto(actions, absolutePath) {
			// An unknown root is a REFUSAL, not a mention: `fileMention(undefined)`
			// would stringify to `@undefined` and insert a path that resolves nowhere.
			if (typeof absolutePath !== 'string' || absolutePath === '') return 'no-path';
			const mention = fileMention(absolutePath);
			if (mention === undefined) return 'no-path';
			if (actions === undefined
				|| typeof actions.captureInsertion !== 'function'
				|| typeof actions.insertText !== 'function') return 'no-actions';
			try {
				// The span carries the draft revision; capturing and inserting in the
				// same tick is what keeps that CAS satisfied.
				const applied = actions.insertText(' ' + mention + ' ', actions.captureInsertion());
				return applied === false ? 'refused' : 'ok';
			} catch (error) {
				return 'refused';
			}
		}

		/**
		 * Reach a service LAZILY, by name.
		 *
		 * Reading a service property that is not declared in `exports.inject` throws
		 * (`cannot get property "X" without inject`), and declaring a service the
		 * profile does not hand out holds the whole entry back from activating — the
		 * sidebar then loses the plugin entirely. `ctx.get` is the door that costs
		 * nothing when the service is absent, so missing Sessions/Workspaces costs
		 * only the conversation, never the tree.
		 */
		function serviceOf(ctx, name) {
			try {
				return ctx !== null && ctx !== undefined && typeof ctx.get === 'function'
					? ctx.get(name)
					: undefined;
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * Which Session this plugin talks to the vault in, and whether it already existed.
		 *
		 * Two things have to be true for the conversation to behave like "the knowledge
		 * base's own chat" rather than a generic new conversation:
		 *
		 * 1. it must belong to the vault's **Workspace** — a Session created with only
		 *    a `cwd` is a Session in no Workspace, and the conversation then opens on
		 *    the blank "new Session" screen, workspace picker and all;
		 * 2. it must be the *same* Session every time, so a plan survives a reload.
		 *
		 * `resumed` is what tells the reader "there is something to come back to": true
		 * when the id came from the remembered state, false when this call created one.
		 * The caller uses it to offer "continue, or start over" instead of silently
		 * deciding for them.
		 *
		 * `workspaces.create` is documented as idempotently resolving an existing
		 * path, so this never duplicates the 知识库 workspace.
		 * @param ctx - plugin context carrying Sessions, Workspaces and fetch.
		 * @returns `{ sessionId, resumed }`; sessionId is undefined when the vault cannot be resolved.
		 */
		function resolveVaultChatTarget(ctx) {
			if (vaultChatTarget !== undefined) return vaultChatTarget;
			vaultChatTarget = (async () => {
				const status = await getJson(API.status);
				const vaultPath = typeof status.vaultPath === 'string' ? status.vaultPath : undefined;
				if (vaultPath === undefined) return undefined;

				// The remembered Session comes FIRST and wins unconditionally. It is the
				// one holding the conversation history, so deciding whether to reuse it
				// by re-deriving Workspace membership loses that history the moment the
				// derivation disagrees — which is exactly what "my history is gone after
				// restart" looks like. The Workspace is only consulted to CREATE one.
				//
				// A FAILED read is not "nothing was remembered". Answering '' here (as
				// this did) made the box create a fresh Session and POST its id over the
				// remembered one: one transient read error and the history was gone. A
				// read failure is therefore fatal and visible, and it never writes.
				let remembered = '';
				try {
					const data = await getJson(API.chat);
					remembered = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
				} catch (error) {
					throw new Error('无法读取已记住的对话（为避免覆盖历史，不会新建）：'
						+ String(error && error.message ? error.message : error));
				}
				// A remembered id that names NO Session must be forgotten, not obeyed.
				// Obeying it makes `sessions.retain` throw on every mount, and the box is
				// bricked for good — which is what a stale id from a deleted Session, a
				// state file copied between machines, or a test probe did. Validating
				// needs `binding`, which is the sessions service's own lookup; when it is
				// unavailable the id is trusted as before rather than thrown away.
				if (remembered !== '') {
					const probe = serviceOf(ctx, 'sessions');
					if (probe === undefined || typeof probe.binding !== 'function' || probe.binding(remembered) !== undefined) {
						return { sessionId: remembered, resumed: true };
					}
					console.warn('[dsh-obsidian] the remembered conversation Session no longer exists; creating a new one', remembered);
				}

				// No remembered Session: attach a new one to the vault's Workspace, so
				// it is grouped under the knowledge base rather than orphaned. Both
				// services are reached through `ctx.get`; neither is in `inject`.
				const workspaces = serviceOf(ctx, 'workspaces');
				if (workspaces === undefined || typeof workspaces.create !== 'function') {
					throw new Error('对话服务不可用：Workspaces 未加载');
				}
				const sessions = serviceOf(ctx, 'sessions');
				if (sessions === undefined || typeof sessions.create !== 'function') {
					throw new Error('对话服务不可用：Sessions 未加载');
				}
				const workspace = await workspaces.create({ path: vaultPath }).catch(() => undefined);
				const workspaceId = workspace === null || workspace === undefined
					? undefined
					: workspace.workspaceId;

				const created = await sessions.create(
					workspaceId === undefined ? { cwd: vaultPath } : { workspaceId, cwd: vaultPath },
				);
				// A write that cannot reach disk is visible too: silently swallowing it
				// made "the id was never remembered" look exactly like success, so the
				// next page load started a brand-new conversation with no explanation.
				try {
					await postJson(API.chat, { sessionId: created });
				} catch (error) {
					throw new Error('无法记住这个对话的 Session id（下次打开会新建一个）：'
						+ String(error && error.message ? error.message : error));
				}
				return { sessionId: created, resumed: false };
			})().catch((error) => {
				// Let a later mount try again rather than caching the failure.
				vaultChatTarget = undefined;
				throw error;
			});
			return vaultChatTarget;
		}

		/** Memoised `resolveVaultChatTarget`, shared by every surface. */
		let vaultChatTarget;

		/** The Session id alone, for callers that do not care whether it was resumed. */
		function resolveVaultChatSession(ctx) {
			return resolveVaultChatTarget(ctx).then((target) => target.sessionId);
		}

		/**
		 * Start a NEW conversation in the vault's Workspace, and remember it.
		 *
		 * Only the reader can decide this: "continue where we left off" and "start over"
		 * are different intentions, and the remembered Session cannot express the second
		 * one. The old id is replaced only AFTER the new Session exists, so a failure
		 * here leaves the history addressable.
		 * @param ctx - plugin context.
		 * @returns the new Session id.
		 */
		function startFreshVaultConversation(ctx) {
			return getJson(API.status).then((status) => {
				const vaultPath = typeof status.vaultPath === 'string' ? status.vaultPath : undefined;
				if (vaultPath === undefined || vaultPath === '') throw new Error('还没有知识库路径');
				const workspaces = serviceOf(ctx, 'workspaces');
				if (workspaces === undefined || typeof workspaces.create !== 'function') {
					throw new Error('对话服务不可用：Workspaces 未加载');
				}
				const sessions = serviceOf(ctx, 'sessions');
				if (sessions === undefined || typeof sessions.create !== 'function') {
					throw new Error('对话服务不可用：Sessions 未加载');
				}
				return Promise.resolve(workspaces.create({ path: vaultPath })).catch(() => undefined)
					.then((workspace) => {
						const workspaceId = workspace === null || workspace === undefined ? undefined : workspace.workspaceId;
						return sessions.create(workspaceId === undefined
							? { cwd: vaultPath }
							: { workspaceId, cwd: vaultPath });
					})
					.then((created) => postJson(API.chat, { sessionId: created }).then(() => {
						// The memo now names the new Session, and it counts as one to come
						// back to: the next 对话 must offer it rather than create another.
						vaultChatTarget = Promise.resolve({ sessionId: created, resumed: true });
						return created;
					}));
			});
		}

		/**
		 * Register the vault's Workspace as soon as the reader agrees to a folder.
		 *
		 * The Workspace is what makes the folder a place the agent can be sent to, and
		 * what the sidebar lists; resolving it lazily on the first conversation meant
		 * nothing appeared until the reader went looking for the conversation. It is
		 * idempotent by contract, and a failure here costs nothing — the next
		 * conversation resolves it anyway.
		 * @param ctx - plugin context.
		 * @param path - the folder the reader agreed to.
		 */
		function ensureVaultWorkspace(ctx, path) {
			if (typeof path !== 'string' || path === '') return;
			const workspaces = serviceOf(ctx, 'workspaces');
			if (workspaces === undefined || workspaces === null || typeof workspaces.create !== 'function') return;
			try {
				Promise.resolve(workspaces.create({ path })).catch(() => {});
			} catch (error) {
				/* a workspace that cannot be registered now is registered on first use */
			}
		}

		/**
		 * What this plugin last had on screen in the right Sidebar, and its browse state.
		 *
		 * The right Sidebar's tabs are SESSION-scoped, so switching the centre to another
		 * Session hands the pane a different tab set: our panel and our note pages vanish
		 * along with the Session they belonged to. The reader asked to open a
		 * conversation — not to lose the tree — so the surface is put back on the far
		 * side, with the expansion and selection it had. It is the SAME vault either way,
		 * which is what makes the browsing state still true after the switch.
		 */
		let lastSurface = null;
		let panelBrowseState = null;

		/** Record which surface is on screen, so a Session switch can restore it. */
		function rememberSurface(surface) {
			lastSurface = surface;
		}

		/**
		 * Put the last surface back after the centre switched Sessions.
		 *
		 * The switch is asynchronous and the pane remounts for the new Session, so a
		 * single call can land before there is a pane to land in. A few attempts over
		 * about a second is enough, and an extra `openTab` for an already-open tab is
		 * harmless.
		 * @param ctx - plugin context owning the right-Sidebar navigator.
		 */
		function restoreSurface(ctx) {
			const surface = lastSurface;
			if (surface === null || ctx === null || ctx === undefined) return;
			let attempt = 0;
			const put = () => {
				attempt += 1;
				try {
					if (surface.kind === 'note' && typeof surface.path === 'string' && surface.path !== '') {
						ctx.sidebarRight.openResource(noteAddress(surface.path));
					} else {
						ctx.sidebarRight.openTab(TAB_KIND);
					}
				} catch (error) {
					/* no Session surface mounted yet: the next attempt is the retry */
				}
				if (attempt < 4) setTimeout(put, attempt * 250);
			};
			put();
		}

		/**
		 * Show one vault Session the way the app shows any conversation: in the centre,
		 * through the shell's own panel.
		 *
		 * Nothing about this plugin's layout is involved, and that is the point. A
		 * right-Sidebar pane is a few hundred pixels of tool space, so a conversation
		 * put there either eats the tree's height or replaces it; the centre is where
		 * the app puts conversations, it is full width, and the tree and the note stay
		 * visible beside it. The Session is host-side, so opening and closing this view
		 * costs the conversation nothing.
		 * @param ctx - plugin context.
		 * @param report - the calling surface's feedback line.
		 * @param sessionId - the vault Session to select.
		 * @returns whether the shell was asked.
		 */
		function showVaultChatSession(ctx, report, sessionId) {
			const navigator = serviceOf(ctx, 'uiWorkspace');
			if (navigator === undefined || navigator === null || typeof navigator.openSession !== 'function') {
				report('这个环境没有会话导航，打不开对话', 4200);
				return false;
			}
			if (typeof sessionId !== 'string' || sessionId === '') {
				report('打不开对话：拿不到会话', 4200);
				return false;
			}
			navigator.openSession(sessionId);
			// Selecting a Session gives the right Sidebar a new, empty tab set: put the
			// reader's tree (or note) back, because they did not close it.
			restoreSurface(ctx);
			report('');
			return true;
		}

		/**
		 * `对话`: open the vault conversation — or, when the reader has been there
		 * before, ask whether to continue it or start a fresh one.
		 *
		 * The remembered Session is the one holding the history, so it is what "open the
		 * conversation" should mean. But "continue" and "start over" are different
		 * intentions, and silently choosing the first made the second impossible without
		 * going hunting through the workspace — while silently choosing the second
		 * threw the history away. So the choice is the reader's, and the menu only
		 * appears when there is something to continue.
		 * @param props - `ctx`, the surface's `report`, and an optional icon size.
		 */
		function ConversationButton(props) {
			const { ctx, report } = props;
			const [menu, setMenu] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const wrapRef = React.useRef(null);

			const begin = React.useCallback(() => {
				setBusy(true);
				report('正在打开对话…', 0);
				return resolveVaultChatTarget(ctx).then((target) => {
					setBusy(false);
					if (target.resumed === true) {
						// There is history: let the reader say whether they want it.
						setMenu(true);
						report('');
						return;
					}
					showVaultChatSession(ctx, report, target.sessionId);
				}).catch((error) => {
					setBusy(false);
					report('打不开对话：' + String(error && error.message ? error.message : error), 4200);
				});
			}, [ctx, report]);

			const continueLast = React.useCallback(() => {
				setMenu(false);
				resolveVaultChatTarget(ctx).then((target) => {
					showVaultChatSession(ctx, report, target.sessionId);
				}).catch((error) => {
					report('打不开对话：' + String(error && error.message ? error.message : error), 4200);
				});
			}, [ctx, report]);

			const startFresh = React.useCallback(() => {
				setMenu(false);
				setBusy(true);
				report('正在新建对话…', 0);
				startFreshVaultConversation(ctx).then((sessionId) => {
					setBusy(false);
					showVaultChatSession(ctx, report, sessionId);
				}).catch((error) => {
					setBusy(false);
					report('新建对话失败：' + String(error && error.message ? error.message : error), 4200);
				});
			}, [ctx, report]);

			// Dismiss on anything outside: a menu that only its own button can close is a
			// menu that stays open while the reader works somewhere else.
			React.useEffect(() => {
				if (!menu) return undefined;
				const onDown = (event) => {
					const node = wrapRef.current;
					if (node !== null && node !== undefined && typeof node.contains === 'function'
						&& event.target !== null && node.contains(event.target)) return;
					setMenu(false);
				};
				document.addEventListener('mousedown', onDown);
				return () => document.removeEventListener('mousedown', onDown);
			}, [menu]);

			const item = (key, label, hint, onClick) => h('button', {
				key,
				type: 'button',
				onClick,
				style: {
					display: 'block',
					width: '100%',
					textAlign: 'left',
					border: 'none',
					borderRadius: 6,
					background: 'transparent',
					color: 'inherit',
					font: 'inherit',
					fontSize: 13,
					lineHeight: 1.4,
					padding: '7px 9px',
					cursor: 'pointer',
				},
			}, [
				h('div', { key: 'l' }, label),
				h('div', { key: 'h', style: { fontSize: 11.5, color: T.labelSecondary, marginTop: 1 } }, hint),
			]);

			return h('span', {
				ref: wrapRef,
				'data-dsh-obsidian-chat-menu': menu ? 'open' : 'closed',
				style: { position: 'relative', display: 'inline-flex' },
			}, [
				h(IconButton, {
					key: 'button',
					title: '在中间打开知识库对话（不占右侧栏）',
					text: '对话',
					icon: ChatIcon,
					disabled: busy,
					onClick: begin,
				}),
				menu ? h('div', {
					key: 'menu',
					role: 'menu',
					style: {
						position: 'absolute',
						top: '100%',
						right: 0,
						marginTop: 4,
						width: 190,
						padding: 4,
						background: T.bgOverlay,
						border: '1px solid ' + T.borderL2,
						borderRadius: 8,
						boxShadow: T.shadow,
						zIndex: 9,
					},
				}, [
					item('continue', '继续上次对话', '回到知识库里的那段历史', continueLast),
					item('fresh', '新开一个对话', '同一工作区，从空白开始', startFresh),
				]) : null,
			]);
		}

		// ── the note page ───────────────────────────────────────────────────
		//
		// A note opens in its OWN tab rather than swapping the tree inline: a
		// full-height page for the rendered Markdown, with `[[wikilink]]`s that turn
		// the page to other notes. The tree stays put in the 知识库 panel.

		const NOTE_ADDRESS_PREFIX = 'dsh-resource://obsidiannote/note/';
		const NOTE_TAB_ID = 'dsh-obsidian/note';
		const NOTE_TAB_KIND = 'obsidianNote';

		/** Address for one note, keyed by its vault-relative path. */
		function noteAddress(vaultPath) {
			return NOTE_ADDRESS_PREFIX + encodeURIComponent(String(vaultPath).replace(/\\/g, '/'));
		}

		/** The vault-relative path inside a note address, or undefined. */
		function parseNoteAddress(value) {
			if (typeof value !== 'string' || !value.startsWith(NOTE_ADDRESS_PREFIX)) return undefined;
			const rest = value.slice(NOTE_ADDRESS_PREFIX.length);
			if (rest === '') return undefined;
			try {
				return decodeURIComponent(rest);
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * The `@path` mention for one file — the "drag a file into the box" grammar,
		 * reproduced from the shell's own `formatFileMention`. The path is ABSOLUTE
		 * because the receiving conversation's Workspace is not the vault: a relative
		 * mention would resolve against the wrong root.
		 */
		function fileMention(absolutePath) {
			const path = String(absolutePath).replace(/\\/g, '/');
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
			if (!/\s/u.test(path)) return '@' + path;
			return '@"' + path + '"';
		}

		/**
		 * `D:\root` + `笔记/foo.md` → `D:/root/笔记/foo.md`.
		 * @returns undefined when the root is empty: with no root there is no absolute
		 * path, and `'/' + rel` or `rel` alone would address a file that does not
		 * exist (`@/笔记/x.md`). The caller reports `ATTACH_MESSAGE['no-path']`.
		 */
		function absoluteVaultPath(root, vaultRelativePath) {
			const base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
			if (base === '') return undefined;
			const rel = String(vaultRelativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
			return rel === '' ? base : base + '/' + rel;
		}

		/**
		 * Hard bound on how many lines are turned into DOM.
		 *
		 * The HOST is what bounds a read (`MAX_NOTE_BYTES`, 4 MB) and reports it through
		 * `truncated`; this only exists so a newline-per-character file cannot build a
		 * block per line. It is deliberately far above what the byte cap admits: at 3,000
		 * it silently cut the compiled guide at its 7th chapter, so its own table of
		 * contents pointed at headings the page had never drawn. The whole 11,738-line
		 * guide renders in ~130 ms / 2.3 MB of HTML, so the honest bound is the byte cap.
		 */
		const MAX_RENDER_LINES = 40000;
		const SEARCH_DEBOUNCE_MS = 250;
		/** The DOM id every rendered heading carries, and the outline scrolls to. */
		const OUTLINE_ID_PREFIX = 'dsh-obsidian-outline-';
		/** Two note pages can be open at once, so each one numbers its own anchors. */
		let notePageSeq = 0;
		/**
		 * A heading/block to scroll to once its note page has rendered, keyed by vault path.
		 *
		 * `[[笔记#标题]]` opens the target as its own tab, so the scroll cannot happen in the
		 * click: the page that receives the anchor is a different component instance. The
		 * map is the hand-off — the opener records `path -> anchor`, the opened page takes it
		 * once the note is drawn. Keyed by path so two pages cannot steal each other's jump.
		 */
		const pendingAnchors = new Map();

		/** Theme tokens with fallbacks, so the panel also survives a bare shell. */
		const T = {
			bgLayer1: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
			bgLayer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
			bgOverlay: 'var(--dsw-alias-bg-overlay, rgba(127,127,127,0.16))',
			shadow: '0 10px 30px rgba(0,0,0,0.22)',
			borderL1: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.20))',
			borderL2: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.32))',
			brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
			labelPrimary: 'var(--dsw-alias-label-primary, inherit)',
			labelSecondary: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.95))',
			error: 'var(--dsw-alias-state-error-primary, #e5484d)',
			hover: 'rgba(127,127,127,0.13)',
			mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
		};

		// ── data access ──────────────────────────────────────────────────────

		function getJson(url) {
			return fetch(url).then((response) => {
				if (!response.ok) throw new Error('HTTP ' + response.status);
				return response.json();
			}).then((data) => {
				if (data && typeof data === 'object' && typeof data.error === 'string') throw new Error(data.error);
				return data;
			});
		}

		function postJson(url, body) {
			return fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {}),
			}).then((response) => response.json().catch(() => ({})).then((data) => {
				// Surface the host's own message: a refused write should say why.
				if (!response.ok) {
					throw new Error(data && typeof data.error === 'string' ? data.error : 'HTTP ' + response.status);
				}
				if (data && typeof data === 'object' && typeof data.error === 'string') throw new Error(data.error);
				return data;
			}));
		}

		/** Ask the host to open Obsidian; fall back to the OS protocol handler. */
		function openInObsidian(file) {
			return postJson(API.open, file ? { file } : {}).catch(() => {
				try {
					const uri = file
						? 'obsidian://open?file=' + encodeURIComponent(file)
						: 'obsidian://open';
					window.open(uri, '_blank', 'noopener,noreferrer');
					return { opened: true, via: 'protocol-handler' };
				} catch (error) {
					throw new Error('cannot reach the host or the protocol handler');
				}
			});
		}

		// ── formatting ───────────────────────────────────────────────────────

		function formatBytes(bytes) {
			if (typeof bytes !== 'number' || !isFinite(bytes)) return '';
			if (bytes < 1024) return bytes + ' B';
			if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
			return (bytes / 1048576).toFixed(1) + ' MB';
		}

		function formatTime(ms) {
			if (typeof ms !== 'number' || !isFinite(ms)) return '';
			try {
				return new Date(ms).toLocaleString('zh-CN', { hour12: false });
			} catch (error) {
				return '';
			}
		}

		// ── icons ────────────────────────────────────────────────────────────

		function svg(size, weight, children) {
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: weight || 1.6,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
				focusable: 'false',
				style: { flex: '0 0 auto', display: 'block' },
			}, children);
		}

		function CrystalIcon(props) {
			return svg(props.size, props.weight, [
				h('path', { key: 'a', d: 'M12 2.4 20.4 7.6v8.8L12 21.6 3.6 16.4V7.6z' }),
				h('path', { key: 'b', d: 'M12 2.4v19.2M3.6 7.6 12 12.6l8.4-5' }),
			]);
		}

		function SearchIcon(props) {
			return svg(props.size, null, [
				h('circle', { key: 'a', cx: 11, cy: 11, r: 6.4 }),
				h('path', { key: 'b', d: 'm20 20-4.3-4.3' }),
			]);
		}

		/** A pencil, for entering edit mode on a note. */
		function EditIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M4 20h4l10-10-4-4L4 16z' }),
				h('path', { key: 'b', d: 'm14 6 4 4' }),
			]);
		}

		/** A floppy, for committing an edited note to disk. */
		function SaveIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M5 3h11l3 3v15H5z' }),
				h('path', { key: 'b', d: 'M8 3v6h7V3M8 21v-7h8v7' }),
			]);
		}

		function ChevronIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: props.open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6' }),
			]);
		}

		function FolderIcon(props) {
			return svg(props.size, null, [
				h('path', {
					key: 'a',
					d: 'M3.5 6.6A1.6 1.6 0 0 1 5.1 5h3.6l1.8 2.1h8.4a1.6 1.6 0 0 1 1.6 1.6v8.7a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z',
				}),
			]);
		}

		function FileIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M6 3.4h7.2L18.5 8.6v12H6z' }),
				h('path', { key: 'b', d: 'M13.2 3.4v5.2h5.3' }),
			]);
		}

		function RefreshIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.6-5.9' }),
				h('path', { key: 'b', d: 'M20.4 3.6v5h-5' }),
			]);
		}

		function ExternalIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M14 4.5h5.5V10' }),
				h('path', { key: 'b', d: 'M19.2 4.8 11 13' }),
				h('path', { key: 'c', d: 'M18 14.4v4.1a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4.1' }),
			]);
		}

		function BackIcon(props) {
			return svg(props.size, null, [h('path', { key: 'a', d: 'm14 6-6 6 6 6' })]);
		}

		/** An outline: one short bar per heading level. */
		function OutlineIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M4 6h16' }),
				h('path', { key: 'b', d: 'M8 12h12' }),
				h('path', { key: 'c', d: 'M11 18h9' }),
			]);
		}

		/** A speech bubble, for the conversation dialog. */
		function ChatIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M4.5 5.5h15v9.6h-8.3L6.6 19v-3.9H4.5z' }),
			]);
		}

		// ── markdown-lite ────────────────────────────────────────────────────

		// `==高亮==` is Obsidian's highlight mark. Two bounds are load-bearing:
		// `[^=`]` stops a `====` run (and an empty mark) matching, and `[^`]` stops a
		// single comparison marker (`a == b`) from pairing with a LATER `==` and
		// swallowing the code span between them. Spaces are allowed inside because this
		// vault writes `== 标题 ==` as well as `==句子==`.
		const INLINE = /(\[\[[^\]\n|]{1,200}(?:\|[^\]\n]{1,200})?\]\])|(`[^`\n]+`)|(==[^=`\n]{1,400}==)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\s]+\))/g;

		/**
		 * GitHub-flavoured heading slug — how some converted notes spell `[x](#锚点)`.
		 *
		 * Obsidian links to a heading by its TEXT; a handful of notes in this vault were
		 * converted with slug anchors (`#一概述与定义` for `## 一、概述与定义`), so a jump
		 * tries the exact text first and this form as the fallback.
		 */
		function obsidianSlug(text) {
			return String(text)
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s-]/gu, '')
				.replace(/\s+/g, '-')
				.replace(/^-+|-+$/g, '');
		}

		/** A `[x](#fragment)` fragment, URL-decoded (Obsidian writes raw text, tools slugs). */
		function decodeFragment(fragment) {
			try {
				return decodeURIComponent(fragment).replace(/\s+/g, ' ').trim();
			} catch (error) {
				return String(fragment).replace(/\s+/g, ' ').trim();
			}
		}

		/**
		 * Scroll one rendered heading to the top of the reading area.
		 * The rendered headings already carry Obsidian's `scroll-margin-top`, so this is
		 * the whole jump. Guarded because the mount harness runs on jsdom, which has no
		 * `scrollIntoView`.
		 */
		function scrollHeadingIntoView(node) {
			if (node === null || node === undefined) return;
			if (typeof node.scrollIntoView !== 'function') return;
			node.scrollIntoView({ block: 'start', behavior: 'smooth' });
		}

		/**
		 * Resolve an Obsidian anchor against the rendered heading texts.
		 *
		 * Exact text is Obsidian's own rule. A converted note often writes an abbreviated
		 * anchor — this vault has `[[笔记#整合性]]` for a heading `5.1 整合性 (Integration)`
		 * — so a slug match and then a UNIQUE containment match are allowed. Unique only:
		 * jumping to a guess is worse than saying the heading was found nowhere.
		 *
		 * @returns the matched heading text, or null.
		 */
		function matchHeading(texts, anchor) {
			const wanted = String(anchor === undefined || anchor === null ? '' : anchor)
				.replace(/\s+/g, ' ')
				.trim();
			if (wanted === '') return null;
			for (const text of texts) {
				if (String(text).replace(/\s+/g, ' ').trim() === wanted) return text;
			}
			const wantedSlug = obsidianSlug(wanted);
			if (wantedSlug !== '') {
				for (const text of texts) {
					if (obsidianSlug(text) === wantedSlug) return text;
				}
			}
			const loose = texts.filter((text) => {
				const normalized = String(text).replace(/\s+/g, ' ').trim();
				return normalized.includes(wanted) || wanted.includes(normalized);
			});
			return loose.length === 1 ? loose[0] : null;
		}

		/** `^block-id` at the end of a block marks it for `[[笔记#^block-id]]`. */
		const RE_BLOCK_ID = /\s\^([A-Za-z0-9-]{2,})\s*$/;

		/**
		 * Split a trailing `^block-id` off a block's text.
		 * @returns `{ text, blockId }`, `blockId` empty when the block is not marked.
		 */
		function splitBlockId(text) {
			const match = RE_BLOCK_ID.exec(String(text));
			if (match === null) return { text: String(text), blockId: '' };
			return { text: String(text).slice(0, match.index), blockId: match[1] };
		}

		// ── the vault index: backlinks, link status, hover previews ──────────
		//
		// One request carries the whole graph: every note's title, excerpt, tags, and
		// where its `[[links]]` land. Backlinks are edges the open note never writes,
		// so they can only come from a vault-wide read. ~700 notes / ~290 KB is one
		// round trip that beats a request per link, and the host caches it as well.

		/** Shared by every note page: the index is vault-wide, not per page. */
		const vaultIndex = { at: 0, data: null, pending: null, error: '' };

		/**
		 * Fetch (or reuse) the vault index.
		 * @param force - bypass the cache; used by the backlinks refresh button.
		 * @returns a promise of the index, resolving to null when it could not be read.
		 */
		function loadVaultIndex(force) {
			const now = Date.now();
			if (!force && vaultIndex.data !== null && now - vaultIndex.at < 15000) {
				return Promise.resolve(vaultIndex.data);
			}
			if (!force && vaultIndex.pending !== null) return vaultIndex.pending;
			vaultIndex.pending = getJson(API.links + (force === true ? '?refresh=1' : ''))
				.then((data) => {
					vaultIndex.data = data;
					vaultIndex.at = Date.now();
					vaultIndex.error = '';
					vaultIndex.pending = null;
					return data;
				})
				.catch((error) => {
					vaultIndex.pending = null;
					// The page still works without backlinks; the panel says why they are empty.
					vaultIndex.error = String(error && error.message ? error.message : error);
					return vaultIndex.data;
				});
			return vaultIndex.pending;
		}

		/** The notes that link here, with the line that did it. Derived, not stored. */
		function backlinksOf(index, path) {
			const rows = [];
			if (index === null || index === undefined || index.notes === undefined || path === undefined) return rows;
			for (const source of Object.keys(index.notes)) {
				if (source === path) continue;
				const entry = index.notes[source];
				for (const link of entry.links) {
					if (link.resolved !== path) continue;
					rows.push({
						path: source,
						title: entry.title,
						line: link.line === '' ? entry.excerpt : link.line,
						anchor: link.anchor,
					});
					break;
				}
			}
			rows.sort((a, b) => a.path.localeCompare(b.path));
			return rows;
		}

		/** The open note's own links, with the target's title for the panel. */
		function outlinksOf(index, path) {
			const entry = index === null || index === undefined || index.notes === undefined ? undefined : index.notes[path];
			if (entry === undefined) return [];
			return entry.links.map((link) => ({
				target: link.target,
				anchor: link.anchor,
				line: link.line,
				resolved: link.resolved,
				title: link.resolved !== null && index.notes[link.resolved] !== undefined
					? index.notes[link.resolved].title
					: link.target,
			}));
		}

		/**
		 * Whether one of this note's links points at something that exists.
		 * `known: false` means the index has no opinion (a link in a part of the note
		 * it did not index), so the renderer must not mark it broken.
		 */
		function linkStatus(index, path, target) {
			const entry = index === null || index === undefined || index.notes === undefined ? undefined : index.notes[path];
			if (entry === undefined) return { known: false, missing: false };
			const wanted = String(target).toLowerCase();
			for (const link of entry.links) {
				if (link.target.toLowerCase() === wanted) return { known: true, missing: link.resolved === null };
			}
			return { known: false, missing: false };
		}

		/** The hover card's content for a link target: where it lands and how it starts. */
		function previewOf(index, target) {
			if (index === null || index === undefined || index.notes === undefined) return null;
			const wanted = String(target).toLowerCase().replace(/\.md$/, '');
			for (const path of Object.keys(index.notes)) {
				const entry = index.notes[path];
				const bare = path.toLowerCase().replace(/\.md$/, '');
				if (bare === wanted || bare.split('/').pop() === wanted || String(entry.title).toLowerCase() === wanted) {
					return { path, title: entry.title, excerpt: entry.excerpt, tags: entry.tags };
				}
			}
			return null;
		}

		// ── note properties (YAML frontmatter) ───────────────────────────────
		//
		// The renderer drops frontmatter on purpose — "metadata, not prose". In a
		// sidebar reader the opposite is true: title, aliases, tags and dates are the
		// first thing worth seeing. Obsidian shows them as a properties table, and so
		// does this: same rows, same order, one collapsible card.

		/**
		 * Parse a note's frontmatter into property rows.
		 * @returns `{ rows, body }` — rows are `{ key, kind, value }` in file order;
		 *   `body` is the note without the block.
		 */
		function parseProperties(text) {
			const source = String(text === undefined || text === null ? '' : text);
			const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
			if (match === null) return { rows: [], body: source };
			const rows = [];
			let current = null;
			for (const line of match[1].split(/\r?\n/)) {
				if (line.trim() === '' || /^\s*#/.test(line)) continue;
				const item = /^\s*-\s+(.*)$/.exec(line);
				if (item !== null && current !== null) {
					if (!Array.isArray(current.value)) {
						// A scalar followed by a block list: keep both readings.
						current.value = current.value === '' ? [] : [String(current.value)];
					}
					current.value.push(item[1].trim().replace(/^["']|["']$/g, ''));
					current.kind = 'list';
					continue;
				}
				const pair = /^([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*:\s*(.*)$/.exec(line);
				if (pair === null) continue;
				const raw = pair[2].trim();
				const inline = /^\[(.*)\]$/.exec(raw);
				// `key:` with nothing after it starts a block list; `key: []` is an empty one.
				const value = raw === '' || (inline !== null && inline[1].trim() === '')
					? []
					: (inline !== null
						? inline[1].split(',').map((part) => part.trim().replace(/^["']|["']$/g, '')).filter((part) => part !== '')
						: raw.replace(/^["']|["']$/g, ''));
				current = { key: pair[1], kind: raw === '' || inline !== null ? 'list' : 'text', value };
				rows.push(current);
			}
			for (const row of rows) {
				if (row.kind === 'list') continue;
				const value = String(row.value).trim();
				if (value === 'true' || value === 'false') row.kind = 'boolean';
				else if (/^-?\d+(\.\d+)?$/.test(value)) row.kind = 'number';
				else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) row.kind = 'date';
			}
			return { rows, body: source.slice(match[0].length) };
		}

		/**
		 * Render one line of inline Markdown.
		 *
		 * @param text - the line.
		 * @param prefix - key prefix, so two lines cannot collide.
		 * @param onLink - navigator for `[[wikilinks]]` (opens another note).
		 * @param onAnchor - navigator for a heading in THIS note: `[[#标题]]`, `[x](#锚点)`.
		 *   Without it, an anchor renders as a dashed span rather than a dead button.
		 * @param hints - optional link intelligence: `statusOf(target)` says whether a
		 *   target exists, `preview(target, event)` / `hidePreview()` drive the hover card.
		 *   Without it every link renders as it did before — neutral, no preview.
		 */
		function renderInline(text, prefix, onLink, onAnchor, hints) {
			const nodes = [];
			const statusOf = hints !== undefined && typeof hints.statusOf === 'function'
				? hints.statusOf
				: () => ({ known: false, missing: false });
			const hoverable = hints !== undefined && typeof hints.preview === 'function'
				? (target) => ({
					onMouseEnter: (event) => hints.preview(target, event),
					onMouseLeave: () => { if (typeof hints.hidePreview === 'function') hints.hidePreview(); },
				})
				: () => ({});
			const linkButtonStyle = {
				color: T.brand,
				background: 'transparent',
				border: 'none',
				padding: 0,
				cursor: 'pointer',
				textDecoration: 'underline',
				font: 'inherit',
			};
			INLINE.lastIndex = 0;
			let last = 0;
			let index = 0;
			let match;
			while ((match = INLINE.exec(text)) !== null) {
				if (match.index > last) nodes.push(text.slice(last, match.index));
				const token = match[0];
				const key = prefix + '-' + (index += 1);
				if (token.slice(0, 2) === '[[') {
					const inner = token.slice(2, -2);
					const bar = inner.indexOf('|');
					// A `|` inside a table cell is written `\|` so the table parser keeps the
					// row intact. Obsidian still reads it as the alias separator, and the
					// escape must not survive into the target (`[[#标题\|别名]]`).
					const target = (bar >= 0 ? inner.slice(0, bar) : inner).replace(/\\$/, '').trim();
					const label = bar >= 0 ? inner.slice(bar + 1) : inner;
					const anchor = target.charAt(0) === '#' ? target.slice(1).trim() : null;
					const hashAt = target.indexOf('#');
					// `[[#标题]]` keeps you on this page — the compiled guide's entire table
					// of contents is 45 of these, and routing them through the note resolver
					// was why clicking a chapter did nothing.
					const sameNote = anchor !== null && typeof onAnchor === 'function';
					// `[[笔记#标题]]` opens the note: the heading is not part of its name, and
					// the heading travels with the call so the opened page can scroll to it.
					const noteTarget = anchor !== null ? '' : (hashAt > 0 ? target.slice(0, hashAt).trim() : target);
					const noteAnchor = anchor === null && hashAt > 0 ? target.slice(hashAt + 1).trim() : '';
					if (sameNote) {
						nodes.push(h('button', {
							key,
							type: 'button',
							title: '跳到 ' + anchor,
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								onAnchor(anchor);
							},
							style: linkButtonStyle,
						}, label.trim()));
					} else if (anchor === null && typeof onLink === 'function' && noteTarget !== '') {
						// A link to another note, if a navigator is supplied: this is what
						// makes the note page's `[[wikilink]]`s clickable.
						const status = statusOf(noteTarget);
						nodes.push(h('button', {
							key,
							type: 'button',
							title: status.missing === true
								? '笔记不存在：' + noteTarget
								: (noteAnchor === '' ? '打开 ' + noteTarget : '打开 ' + noteTarget + ' 并跳到 ' + noteAnchor),
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								onLink(noteTarget, noteAnchor === '' ? undefined : noteAnchor);
							},
							// Obsidian fades a link it cannot resolve. Without that, a table of
							// contents is all one colour whether or not half of it is broken.
							style: status.missing === true
								? {
									...linkButtonStyle,
									color: T.labelSecondary,
									textDecorationLine: 'underline',
									textDecorationStyle: 'dashed',
								}
								: linkButtonStyle,
							...hoverable(noteTarget),
						}, label.trim()));
					} else {
						nodes.push(h('span', {
							key,
							title: target,
							style: { color: T.brand, borderBottom: '1px dashed ' + T.brand, cursor: 'help' },
						}, label));
					}
				} else if (token.charAt(0) === '`') {
					// Obsidian's inline code: the monospace face at 0.875em on the code
					// surface, with no border.
					nodes.push(h('code', {
						key,
						style: {
							fontFamily: T.mono,
							fontSize: READ.codeSize,
							background: T.bgLayer2,
							borderRadius: READ.codeRadius,
							padding: '0.15em 0.3em',
						},
					}, token.slice(1, -1)));
				} else if (token.slice(0, 2) === '==') {
					// Obsidian's highlight is a `<mark>`: same element, same default
					// `--text-highlight-bg` (a 40% amber), so it reads the same here.
					nodes.push(h('mark', {
						key,
						'data-dsh-obsidian-highlight': '',
						style: {
							background: 'rgba(255, 208, 0, 0.4)',
							color: 'inherit',
							borderRadius: 2,
							padding: '0.05em 0.1em',
						},
					}, token.slice(2, -2)));
				} else if (token.slice(0, 2) === '**') {
					nodes.push(h('strong', { key, style: { fontWeight: 600 } }, token.slice(2, -2)));
				} else if (token.slice(0, 2) === '~~') {
					nodes.push(h('span', {
						key,
						style: { textDecoration: 'line-through', opacity: 0.65 },
					}, token.slice(2, -2)));
				} else if (token.charAt(0) === '*') {
					nodes.push(h('em', { key }, token.slice(1, -1)));
				} else {
					const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
					const href = link === null ? null : link[2];
					const label = link === null ? token : link[1];
					// `[文字](#标题)`: same note, so scroll instead of opening a new tab —
					// `target="_blank"` on a fragment both leaves the page and goes nowhere.
					if (href !== null && href.charAt(0) === '#' && typeof onAnchor === 'function') {
						const fragment = decodeFragment(href.slice(1));
						nodes.push(h('button', {
							key,
							type: 'button',
							title: '跳到 ' + fragment,
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								onAnchor(fragment);
							},
							style: linkButtonStyle,
						}, label));
					} else {
						nodes.push(h('a', {
							key,
							href: href === null ? '#' : href,
							target: '_blank',
							rel: 'noopener noreferrer',
							// Obsidian underlines links by default.
							style: { color: T.brand, textDecoration: 'underline' },
						}, label));
					}
				}
				last = INLINE.lastIndex;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		}

		/** The two list markers, and the thematic break. One definition each. */
		const RE_UL_ITEM = /^\s*[-*+]\s+/;
		const RE_OL_ITEM = /^\s*\d+[.)]\s+/;
		const RE_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

		/**
		 * Obsidian callout head, applied to the ALREADY de-quoted first line
		 * (`> [!cite]- 来源（点开展开）` arrives here as `[!cite]- 来源（点开展开）`):
		 * the type, the fold marker, and the title.
		 */
		const RE_CALLOUT_HEAD = /^\[!([^\];\s]+)\]([+-]?)\s*(.*)$/;

		/** Raw HTML disclosure: `<details>` … `<summary>` … `</details>`. */
		const RE_DETAILS_OPEN = /^\s*<details\b([^>]*)>/i;
		const RE_DETAILS_ANY = /<details\b/i;
		const RE_DETAILS_CLOSE = /<\/details>/i;
		const RE_SUMMARY_OPEN = /^\s*<summary\b[^>]*>(.*)$/i;
		const RE_SUMMARY_CLOSE = /^(.*?)<\/summary>\s*$/i;

		/**
		 * Obsidian's callout palette: the rule/title colour plus a 10%-alpha tint of it.
		 *
		 * `cite` is not a built-in type — the knowledge base's compile script writes it
		 * for a source block — so it gets a neutral slate of its own instead of the grey
		 * fallback, which keeps it distinguishable from `quote`. `details` is the raw
		 * `<details>` disclosure, which Obsidian draws with no tint at all.
		 */
		const CALLOUT_STYLES = {
			note: { rule: '#086ddd', tint: 'rgba(8, 109, 221, 0.10)' },
			info: { rule: '#086ddd', tint: 'rgba(8, 109, 221, 0.10)' },
			todo: { rule: '#086ddd', tint: 'rgba(8, 109, 221, 0.10)' },
			abstract: { rule: '#00bfbc', tint: 'rgba(0, 191, 188, 0.10)' },
			summary: { rule: '#00bfbc', tint: 'rgba(0, 191, 188, 0.10)' },
			tip: { rule: '#00bfbc', tint: 'rgba(0, 191, 188, 0.10)' },
			hint: { rule: '#00bfbc', tint: 'rgba(0, 191, 188, 0.10)' },
			success: { rule: '#08b94e', tint: 'rgba(8, 185, 78, 0.10)' },
			question: { rule: '#e0ac00', tint: 'rgba(224, 172, 0, 0.10)' },
			warning: { rule: '#ec7500', tint: 'rgba(236, 117, 0, 0.10)' },
			failure: { rule: '#e93147', tint: 'rgba(233, 49, 71, 0.10)' },
			danger: { rule: '#e93147', tint: 'rgba(233, 49, 71, 0.10)' },
			error: { rule: '#e93147', tint: 'rgba(233, 49, 71, 0.10)' },
			bug: { rule: '#e93147', tint: 'rgba(233, 49, 71, 0.10)' },
			example: { rule: '#7852ee', tint: 'rgba(120, 82, 238, 0.10)' },
			quote: { rule: '#9e9e9e', tint: 'rgba(158, 158, 158, 0.10)' },
			cite: { rule: '#5f6b7a', tint: 'rgba(95, 107, 122, 0.10)' },
			details: { rule: '#8a8f98', tint: 'transparent', titleColor: 'inherit' },
		};
		/** An unknown callout type falls back the way Obsidian's own theme does. */
		const CALLOUT_FALLBACK = CALLOUT_STYLES.note;

		/**
		 * Obsidian's English default titles, used when a callout carries none.
		 * `details` has no default: a `<details>` with no `<summary>` shows only the
		 * disclosure triangle, so the header falls back to the caret alone.
		 */
		const CALLOUT_TITLES = {
			note: 'Note', info: 'Info', todo: 'Todo', abstract: 'Abstract', summary: 'Summary',
			tip: 'Tip', hint: 'Hint', success: 'Success', question: 'Question', warning: 'Warning',
			failure: 'Failure', danger: 'Danger', error: 'Error', bug: 'Bug', example: 'Example',
			quote: 'Quote', cite: '来源', details: '',
		};

		function isBlockStart(line) {
			return /^\s*$/.test(line)
				|| /^\s*```/.test(line)
				|| /^#{1,6}\s/.test(line)
				|| /^\s*>/.test(line)
				|| RE_DETAILS_OPEN.test(line)
				|| RE_UL_ITEM.test(line)
				|| RE_OL_ITEM.test(line)
				|| RE_RULE.test(line);
		}

		/**
		 * Read one de-quoted block as an Obsidian callout.
		 * @returns the callout shape, or null when the block is an ordinary quote.
		 */
		function parseCallout(quoted) {
			if (quoted.length === 0) return null;
			const match = RE_CALLOUT_HEAD.exec(quoted[0]);
			if (match === null) return null;
			const type = match[1].toLowerCase();
			const fold = match[2];
			const explicit = match[3].trim();
			return {
				type,
				// A bare `[!type]` renders open and cannot be folded; `+` is open and
				// foldable; `-` starts folded — exactly Obsidian's three states.
				foldable: fold === '-' || fold === '+',
				defaultOpen: fold !== '-',
				title: explicit !== '' ? explicit : (CALLOUT_TITLES[type] ?? type),
				body: quoted.slice(1),
			};
		}

		/**
		 * Pull the `<summary>` out of a raw `<details>` body; the rest is content.
		 * @param bodyLines - lines between `<details>` and `</details>` (mutated).
		 * @returns the summary text, empty when the block has no `<summary>`.
		 */
		function takeSummary(bodyLines) {
			for (let index = 0; index < Math.min(bodyLines.length, 4); index += 1) {
				const match = RE_SUMMARY_OPEN.exec(bodyLines[index]);
				if (match === null) continue;
				const single = RE_SUMMARY_CLOSE.exec(match[1]);
				if (single !== null) {
					bodyLines.splice(0, index + 1);
					return single[1].trim();
				}
				// A summary that wraps: keep the lines until `</summary>`.
				const parts = [match[1]];
				for (let cursor = index + 1; cursor < bodyLines.length; cursor += 1) {
					const end = RE_SUMMARY_CLOSE.exec(bodyLines[cursor]);
					if (end === null) {
						parts.push(bodyLines[cursor]);
						continue;
					}
					parts.push(end[1]);
					bodyLines.splice(0, cursor + 1);
					return parts.join(' ').trim();
				}
				return match[1].trim();
			}
			return '';
		}

		// ── reading typography ───────────────────────────────────────────────
		//
		// Transcribed from Obsidian's own default theme (`app.css`, reading view) so a
		// note reads here the way it reads there: a 16px/1.5 base, Obsidian's heading
		// ladder and weights, 1rem between blocks, 2.5rem above a heading that follows
		// another block, an unadorned code surface, and a 2px accent rule on quotes.
		const READ = {
			size: 16,
			lineHeight: 1.5,
			block: '1rem',
			headingTop: '2.5rem',
			listIndent: '2.25em',
			listPad: '0.075em',
			codeSize: '0.875em',
			codeRadius: 4,
			codePadBlock: '12px 16px',
			quoteRule: 2,
			quotePad: 24,
			// `--h1..--h6-size` / `-weight` / `-line-height` from the default theme.
			heading: [
				null,
				{ size: '1.618em', weight: 700, lineHeight: 1.2 },
				{ size: '1.462em', weight: 600, lineHeight: 1.2 },
				{ size: '1.318em', weight: 600, lineHeight: 1.3 },
				{ size: '1.188em', weight: 600, lineHeight: 1.5 },
				{ size: '1.076em', weight: 600, lineHeight: 1.5 },
				{ size: '1em', weight: 600, lineHeight: 1.5 },
			],
		};

		/** Split one table row on unescaped `|`, honouring `\|` inside a cell. */
		function tableCells(line) {
			const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
			const cells = [];
			let current = '';
			for (let index = 0; index < trimmed.length; index += 1) {
				const char = trimmed.charAt(index);
				if (char === '\\' && trimmed.charAt(index + 1) === '|') {
					current += '|';
					index += 1;
					continue;
				}
				if (char === '|') {
					cells.push(current.trim());
					current = '';
					continue;
				}
				current += char;
			}
			cells.push(current.trim());
			return cells;
		}

		/** The `|---|:--:|` divider row under a GFM table header. */
		function isTableDivider(line) {
			const text = String(line);
			if (text.indexOf('-') < 0) return false;
			return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(text);
		}

		/**
		 * Block-level markdown, capped by the caller's line budget.
		 * @param text - the note's source.
		 * @param onLink - navigator for `[[wikilinks]]`.
		 * @param onAnchor - navigator for a heading in THIS note (`[[#标题]]`, `[x](#锚点)`).
		 * @param hints - link status + hover preview, passed straight to `renderInline`.
		 * @param idPrefix - anchor prefix for headings. Every heading carries its anchor
		 *   and its depth as DOM attributes, so the outline panel reads what was
		 *   actually rendered instead of parsing the note a second time.
		 */
		function renderMarkdown(text, onLink, idPrefix, onAnchor, hints) {
			// Frontmatter is metadata, not prose — but it is not DISCARDED here: the
			// note page renders it as a properties card above the body, and both sides
			// read it through `parseProperties` so the two can never disagree.
			let lines = parseProperties(text).body.replace(/\r\n?/g, '\n').split('\n');
			if (lines.length > MAX_RENDER_LINES) lines = lines.slice(0, MAX_RENDER_LINES);

			const blocks = [];
			let i = 0;
			let key = 0;
			let headingIndex = 0;
			const anchors = idPrefix || OUTLINE_ID_PREFIX;

			/** A table starts when a row is immediately followed by its divider. */
			const tableStartsAt = (index) => lines[index].indexOf('|') >= 0
				&& index + 1 < lines.length
				&& isTableDivider(lines[index + 1]);

			while (i < lines.length) {
				const line = lines[i];
				if (/^\s*$/.test(line)) { i += 1; continue; }

				const fence = /^\s*```(\S*)\s*$/.exec(line);
				if (fence) {
					const body = [];
					i += 1;
					while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
					i += 1;
					// Obsidian's pre: a plain surface, no border, wrapping source.
					blocks.push(h('pre', {
						key: 'b' + (key += 1),
						style: {
							fontFamily: T.mono,
							fontSize: READ.codeSize,
							lineHeight: READ.lineHeight,
							background: T.bgLayer2,
							border: 'none',
							borderRadius: READ.codeRadius,
							padding: READ.codePadBlock,
							minHeight: 38,
							margin: READ.block + ' 0',
							overflowX: 'auto',
							whiteSpace: 'pre-wrap',
						},
					}, h('code', null, body.join('\n'))));
					continue;
				}

				// A raw HTML disclosure, exactly as Obsidian's reading view treats it
				// (the compiled guide folds its 41-term glossary this way). It has to run
				// before the table scan, because the content inside is often a table.
				const detailsHead = RE_DETAILS_OPEN.exec(line);
				if (detailsHead) {
					const inner = [];
					let depth = 1;
					i += 1;
					while (i < lines.length) {
						const current = lines[i];
						const opens = RE_DETAILS_ANY.test(current) ? 1 : 0;
						const closes = RE_DETAILS_CLOSE.test(current) ? 1 : 0;
						if (opens > 0 && closes > 0) {
							// Opening and closing on one line nets out; keep the line as content.
							inner.push(current);
							i += 1;
							continue;
						}
						if (opens > 0) depth += 1;
						if (closes > 0) {
							depth -= 1;
							if (depth === 0) { i += 1; break; }
						}
						inner.push(current);
						i += 1;
					}
					const summary = takeSummary(inner);
					const bodyText = inner.join('\n');
					blocks.push(h(Callout, {
						key: 'b' + (key += 1),
						type: 'details',
						foldable: true,
						// `<details open>` starts expanded; everything else starts folded.
						defaultOpen: /\bopen\b/i.test(detailsHead[1]),
						title: summary,
						titleNodes: summary === '' ? null : renderInline(summary, 'dt' + key, onLink, onAnchor, hints),
						body: bodyText.trim() === '' ? null : renderMarkdown(bodyText, onLink, anchors + 'dt' + key + '-', onAnchor, hints),
					}));
					continue;
				}

				// GFM table. Without this a table renders as a wall of pipes, which is
				// most of what "排版乱" looks like on a note that has one.
				if (tableStartsAt(i)) {
					const header = tableCells(line);
					i += 2;
					const rows = [];
					while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0
						&& !isBlockStart(lines[i]) && !tableStartsAt(i)) {
						rows.push(tableCells(lines[i]));
						i += 1;
					}
					const cellStyle = {
						padding: '4px 8px',
						border: '1px solid ' + T.borderL2,
						verticalAlign: 'top',
					};
					blocks.push(h('div', {
						key: 'b' + (key += 1),
						style: { margin: READ.block + ' 0', overflowX: 'auto' },
					}, h('table', {
						style: { borderCollapse: 'collapse', lineHeight: 1.3, fontSize: READ.codeSize, width: '100%' },
					}, [
						h('thead', { key: 'h' }, h('tr', null, header.map((cell, cellIndex) => h('th', {
							key: cellIndex,
							style: { ...cellStyle, textAlign: 'left', fontWeight: 600, background: T.bgLayer1 },
						}, renderInline(cell, 'th' + key + '-' + cellIndex, onLink, onAnchor, hints))))),
						rows.length === 0 ? null : h('tbody', { key: 't' }, rows.map((row, rowIndex) => h('tr', { key: rowIndex },
							row.map((cell, cellIndex) => h('td', {
								key: cellIndex,
								style: cellStyle,
							}, renderInline(cell, 'td' + key + '-' + rowIndex + '-' + cellIndex, onLink, onAnchor, hints)))))),
					])));
					continue;
				}

				const heading = /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading) {
					const level = heading[1].length;
					const spec = READ.heading[level];
					headingIndex += 1;
					blocks.push(h('div', {
						key: 'b' + (key += 1),
						// What the outline anchors to and how deep it indents.
						id: anchors + headingIndex,
						'data-outline': level,
						style: {
							fontSize: spec.size,
							fontWeight: spec.weight,
							lineHeight: spec.lineHeight,
							// No bottom margin: the following block's own top margin is the
							// space, exactly as Obsidian's `--heading-spacing` works.
							margin: READ.headingTop + ' 0 0',
							// Leave breathing room above the heading when the outline jumps here.
							scrollMarginTop: 14,
						},
					}, renderInline(heading[2], 'h' + key, onLink, onAnchor, hints)));
					i += 1;
					continue;
				}

				if (RE_RULE.test(line)) {
					blocks.push(h('hr', {
						key: 'b' + (key += 1),
						style: {
							border: 'none',
							borderTop: '2px solid ' + T.borderL2,
							margin: READ.block + ' 0',
						},
					}));
					i += 1;
					continue;
				}

				if (/^\s*>/.test(line)) {
					const quoted = [];
					while (i < lines.length && /^\s*>/.test(lines[i])) {
						quoted.push(lines[i].replace(/^\s*>\s?/, ''));
						i += 1;
					}
					// `> [!cite]- 来源（点开展开）` is an Obsidian callout, not a quote: the
					// compiled guide ends every one of its 767 items with one, and rendering
					// it as prose put hundreds of DOIs in the middle of the page.
					const callout = parseCallout(quoted);
					if (callout !== null) {
						const bodyText = callout.body.join('\n');
						blocks.push(h(Callout, {
							key: 'b' + (key += 1),
							type: callout.type,
							foldable: callout.foldable,
							defaultOpen: callout.defaultOpen,
							title: callout.title,
							titleNodes: renderInline(callout.title, 'ct' + key, onLink, onAnchor, hints),
							// Its own anchor prefix keeps ids unique against the outer note.
							body: bodyText.trim() === '' ? null : renderMarkdown(bodyText, onLink, anchors + 'c' + key + '-', onAnchor, hints),
						}));
						continue;
					}
					blocks.push(h('blockquote', {
						key: 'b' + (key += 1),
						style: {
							margin: READ.block + ' 0',
							padding: '0 0 0 ' + READ.quotePad + 'px',
							borderLeft: READ.quoteRule + 'px solid ' + T.brand,
							color: 'inherit',
							fontStyle: 'normal',
						},
					}, renderInline(quoted.join(' '), 'q' + key, onLink, onAnchor, hints)));
					continue;
				}

				if (RE_UL_ITEM.test(line) || RE_OL_ITEM.test(line)) {
					const ordered = RE_OL_ITEM.test(line);
					const items = [];
					while (i < lines.length
						&& (RE_UL_ITEM.test(lines[i]) || RE_OL_ITEM.test(lines[i]))) {
						items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
						i += 1;
					}
					blocks.push(h(ordered ? 'ol' : 'ul', {
						key: 'b' + (key += 1),
						style: { margin: READ.block + ' 0', paddingLeft: READ.listIndent },
					}, items.map((item, itemIndex) => {
						const marked = splitBlockId(item);
						return h('li', {
							key: itemIndex,
							...(marked.blockId === '' ? {} : { 'data-block-id': marked.blockId }),
							style: { padding: READ.listPad + ' 0', lineHeight: READ.lineHeight },
						}, renderInline(marked.text, 'li' + key + '-' + itemIndex, onLink, onAnchor, hints));
					})));
					continue;
				}

				const paragraph = [];
				while (i < lines.length && !isBlockStart(lines[i]) && !tableStartsAt(i)) {
					paragraph.push(lines[i]);
					i += 1;
				}
				const blockMarked = splitBlockId(paragraph.join(' '));
				blocks.push(h('p', {
					key: 'b' + (key += 1),
					// `^block-id` marks a block for `[[笔记#^block-id]]`; the marker itself is
					// not content, so it never reaches the page.
					...(blockMarked.blockId === '' ? {} : { 'data-block-id': blockMarked.blockId }),
					style: { margin: READ.block + ' 0', lineHeight: READ.lineHeight },
				}, renderInline(blockMarked.text, 'p' + key, onLink, onAnchor, hints)));
			}

			return blocks;
		}

		/**
		 * One Obsidian callout, or one raw `<details>` disclosure, with the fold the
		 * source asked for.
		 *
		 * `[!cite]-` starts folded, `[!cite]+` starts open, and a bare `[!cite]` is not
		 * foldable at all — Obsidian's three states. Hidden bodies stay mounted and are
		 * hidden with CSS, so the outline (which reads rendered `[data-outline]` nodes)
		 * does not change shape just because a block was folded.
		 *
		 * @param props - `type`, `title`, `titleNodes`, `body`, `foldable`, `defaultOpen`.
		 */
		function Callout(props) {
			const [open, setOpen] = React.useState(props.defaultOpen === true);
			const [hovered, hover] = useHover();
			const palette = CALLOUT_STYLES[props.type] ?? CALLOUT_FALLBACK;
			const interactive = props.foldable === true;
			const titleColor = palette.titleColor ?? palette.rule;
			const headerStyle = {
				display: 'flex',
				alignItems: 'baseline',
				width: '100%',
				margin: 0,
				padding: 0,
				border: 'none',
				borderRadius: 4,
				background: interactive && hovered ? 'rgba(127, 127, 127, 0.12)' : 'transparent',
				color: 'inherit',
				font: 'inherit',
				fontSize: '0.95em',
				fontWeight: 600,
				lineHeight: 1.5,
				textAlign: 'left',
				cursor: interactive ? 'pointer' : 'default',
			};
			const titleText = props.titleNodes === undefined || props.titleNodes === null
				? (props.title === '' ? null : props.title)
				: props.titleNodes;
			const head = [
				h('span', {
					key: 'caret',
					'aria-hidden': 'true',
					style: {
						display: 'inline-block',
						flex: 'none',
						width: 12,
						fontSize: 10,
						lineHeight: '1.5',
						color: palette.rule,
						textAlign: 'center',
						transform: open ? 'rotate(90deg)' : 'none',
						transition: 'transform 120ms ease',
						// Reserve the cell so every title starts at the same x.
						visibility: interactive ? 'visible' : 'hidden',
					},
				}, '▶'),
				titleText === null ? null : h('span', {
					key: 'title',
					style: { marginLeft: 4, minWidth: 0, color: titleColor, overflowWrap: 'anywhere' },
				}, titleText),
			];
			return h('div', {
				style: {
					margin: READ.block + ' 0',
					padding: '4px 10px',
					borderLeft: '2px solid ' + palette.rule,
					borderRadius: 4,
					background: palette.tint,
				},
			}, [
				interactive
					? h('button', {
						key: 'head',
						type: 'button',
						'aria-expanded': open ? 'true' : 'false',
						onClick: () => setOpen((value) => !value),
						style: headerStyle,
						...hover,
					}, head)
					: h('div', { key: 'head', style: headerStyle }, head),
				h('div', {
					key: 'body',
					style: {
						display: open ? 'block' : 'none',
						// The first child's own top margin would double the header gap.
						paddingTop: 2,
					},
				}, props.body),
			]);
		}

		/**
		 * The note's properties, the way Obsidian's reading view shows them.
		 *
		 * Frontmatter was dropped as "metadata, not prose" — true of a document, false
		 * in a sidebar reader, where what a note IS (type, status, parent) and how it is
		 * filed (tags) is the first thing worth seeing. Collapsible, because a reader who
		 * came for the prose should not have to scroll past ten rows of filing.
		 *
		 * @param props - `rows` from `parseProperties`, `onLink` for `[[...]]` values,
		 *   and the same `hints` the body uses (a property link can be broken too).
		 */
		function PropertiesCard(props) {
			const [open, setOpen] = React.useState(true);
			const rows = props.rows;
			if (rows === undefined || rows.length === 0) return null;
			const valueOf = (row) => {
				if (row.kind === 'list') {
					return row.value.map((item, index) => h('span', {
						key: index,
						style: {
							display: 'inline-block',
							margin: '0 4px 2px 0',
							padding: '0 6px',
							borderRadius: 4,
							background: T.bgLayer2,
							fontSize: 11.5,
							lineHeight: '18px',
						},
					}, item));
				}
				if (row.kind === 'boolean') return row.value === 'true' ? '✓' : '✗';
				// Text values keep their `[[links]]` clickable: `parent` is a link here.
				return renderInline(String(row.value), 'prop-' + row.key, props.onLink, undefined, props.hints);
			};
			return h('div', {
				'data-dsh-obsidian-properties': rows.length,
				style: {
					margin: '0 22px 10px',
					padding: '6px 10px',
					border: '1px solid ' + T.borderL1,
					borderRadius: 6,
					background: T.bgLayer1,
					fontSize: 12,
					lineHeight: 1.55,
				},
			}, [
				h('button', {
					key: 'head',
					type: 'button',
					onClick: () => setOpen((value) => !value),
					style: {
						display: 'block',
						width: '100%',
						textAlign: 'left',
						border: 'none',
						background: 'transparent',
						color: T.labelSecondary,
						font: 'inherit',
						fontSize: 11.5,
						letterSpacing: '0.02em',
						padding: 0,
						cursor: 'pointer',
					},
				}, (open ? '▾ ' : '▸ ') + '属性 · ' + rows.length),
				open ? h('div', { key: 'rows', style: { marginTop: 4 } }, rows.map((row) => h('div', {
					key: 'r-' + row.key,
					style: { display: 'flex', gap: 10, padding: '1px 0', alignItems: 'baseline' },
				}, [
					h('span', {
						key: 'k',
						style: { flex: '0 0 32%', minWidth: 0, color: T.labelSecondary, overflowWrap: 'anywhere' },
					}, row.key),
					h('span', {
						key: 'v',
						style: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' },
					}, valueOf(row)),
				]))) : null,
			]);
		}

		/**
		 * The graph, locally: which notes link here, and what this note links to.
		 *
		 * A whole-vault graph was rejected in this plugin's design — a hairball in a
		 * narrow sidebar tells nobody anything. The useful part is the edges touching
		 * the note on screen, each with the line that makes it, which is exactly what
		 * a backlinks pane is.
		 *
		 * @param props - `backlinks`, `outlinks`, `onOpen(path)`, `onRefresh()`.
		 */
		function RelatedPanel(props) {
			const [open, setOpen] = React.useState(true);
			const backlinks = props.backlinks;
			const outlinks = props.outlinks;
			if (backlinks.length === 0 && outlinks.length === 0) return null;
			const row = (key, title, line, broken, onClick) => h('button', {
				key,
				type: 'button',
				title: line,
				onClick,
				style: {
					display: 'block',
					width: '100%',
					overflow: 'hidden',
					textAlign: 'left',
					border: 'none',
					borderRadius: 4,
					background: 'transparent',
					color: 'inherit',
					font: 'inherit',
					fontSize: 12,
					lineHeight: 1.45,
					padding: '3px 6px',
					cursor: 'pointer',
				},
			}, [
				h('span', {
					key: 't',
					style: broken ? { color: T.labelSecondary } : { color: T.brand },
				}, title),
				line === '' ? null : h('span', {
					key: 'l',
					style: {
						display: 'block',
						color: T.labelSecondary,
						fontSize: 11.5,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					},
				}, line),
			]);
			const section = (key, label, rows, render) => (rows.length === 0 ? null : h('div', { key, style: { marginTop: 6 } }, [
				h('div', {
					key: 'h',
					style: { color: T.labelSecondary, fontSize: 11.5, padding: '2px 6px' },
				}, label + ' · ' + rows.length),
				...rows.map(render),
			]));
			return h('div', {
				'data-dsh-obsidian-related': backlinks.length + ':' + outlinks.length,
				style: {
					margin: '4px 22px 24px',
					borderTop: '1px solid ' + T.borderL1,
					paddingTop: 6,
					fontSize: 12,
				},
			}, [
				h('div', {
					key: 'head',
					style: { display: 'flex', alignItems: 'baseline', gap: 8 },
				}, [
					h('button', {
						key: 't',
						type: 'button',
						onClick: () => setOpen((value) => !value),
						style: {
							textAlign: 'left',
							border: 'none',
							background: 'transparent',
							color: T.labelSecondary,
							font: 'inherit',
							fontSize: 11.5,
							padding: 0,
							cursor: 'pointer',
						},
					}, (open ? '▾ ' : '▸ ') + '关联 · ' + (backlinks.length + outlinks.length)),
					h('button', {
						key: 'r',
						type: 'button',
						title: '重新扫描整个知识库',
						onClick: () => { if (typeof props.onRefresh === 'function') props.onRefresh(); },
						style: {
							marginLeft: 'auto',
							border: 'none',
							background: 'transparent',
							color: T.labelSecondary,
							font: 'inherit',
							fontSize: 11.5,
							padding: 0,
							cursor: 'pointer',
							textDecoration: 'underline',
						},
					}, '刷新'),
				]),
				props.error === '' || props.error === undefined || props.error === null
					? null
					: h('div', {
						key: 'err',
						style: { color: T.error, fontSize: 11.5, padding: '2px 6px' },
					}, '索引读取失败：' + props.error),
				open ? section('back', '引用本文', backlinks, (item) => row(
					'back-' + item.path,
					item.title,
					item.line,
					false,
					() => props.onOpen(item.path),
				)) : null,
				open ? section('out', '本文引用', outlinks, (item) => row(
					'out-' + item.target,
					item.title + (item.resolved === null ? '（不存在）' : ''),
					item.line,
					item.resolved === null,
					() => { if (item.resolved !== null) props.onOpen(item.resolved); },
				)) : null,
			]);
		}

		/**
		 * The hover card for a link: where it goes, and how the target starts.
		 *
		 * Positioned `fixed` at the pointer because the note body is its own scroll
		 * container — an absolutely-positioned card would be clipped by it. Coordinates
		 * are clamped so a link near the right edge still shows a whole card.
		 *
		 * @param props - `preview`: `{ title, excerpt, tags, missing, x, y }`, or null.
		 */
		function LinkPreview(props) {
			const preview = props.preview;
			if (preview === null || preview === undefined) return null;
			const width = 280;
			const viewWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
			const viewHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
			const left = Math.max(8, Math.min(preview.x + 14, viewWidth === 0 ? preview.x + 14 : viewWidth - width - 12));
			const top = Math.max(8, Math.min(preview.y + 16, viewHeight === 0 ? preview.y + 16 : viewHeight - 150));
			return h('div', {
				'data-dsh-obsidian-preview': preview.missing === true ? 'missing' : 'note',
				style: {
					position: 'fixed',
					left,
					top,
					width,
					zIndex: 40,
					padding: '8px 10px',
					borderRadius: 6,
					border: '1px solid ' + T.borderL2,
					background: T.bgOverlay,
					boxShadow: T.shadow,
					fontSize: 12,
					lineHeight: 1.5,
					pointerEvents: 'none',
				},
			}, [
				h('div', {
					key: 't',
					style: { fontWeight: 600, marginBottom: 4, overflowWrap: 'anywhere' },
				}, preview.title),
				h('div', {
					key: 'x',
					style: { color: preview.missing === true ? T.error : T.labelSecondary },
				}, preview.missing === true ? '这篇笔记不存在' : preview.excerpt),
			]);
		}

		// ── shared bits ──────────────────────────────────────────────────────

		function useHover() {
			const [hovered, setHovered] = React.useState(false);
			return [hovered, {
				onMouseEnter: () => setHovered(true),
				onMouseLeave: () => setHovered(false),
			}];
		}

		/** A plain labelled button, for prose-sized choices rather than toolbar icons. */
		function TextButton(props) {
			const [hovered, hover] = useHover();
			return h('button', {
				type: 'button',
				disabled: props.disabled === true,
				onClick: props.onClick,
				style: {
					display: 'inline-flex',
					alignItems: 'center',
					gap: 6,
					padding: '6px 12px',
					border: '1px solid ' + T.borderL2,
					borderRadius: 7,
					background: hovered ? T.hover : T.bgLayer1,
					color: 'inherit',
					font: 'inherit',
					fontSize: 12.5,
					cursor: 'pointer',
					opacity: props.disabled === true ? 0.6 : 1,
				},
				...hover,
			}, props.icon === undefined ? null : props.icon, props.label);
		}

		function IconButton(props) {
			const [hovered, hover] = useHover();
			return h('button', {
				type: 'button',
				title: props.title,
				'aria-label': props.title,
				disabled: props.disabled === true,
				onClick: props.onClick,
				style: {
					display: 'flex',
					alignItems: 'center',
					gap: 5,
					height: 25,
					padding: props.text ? '0 8px' : '0 5px',
					border: '1px solid ' + (hovered ? T.borderL2 : T.borderL1),
					borderRadius: 6,
					background: hovered ? T.hover : 'transparent',
					color: 'inherit',
					font: 'inherit',
					fontSize: 12,
					cursor: props.disabled === true ? 'default' : 'pointer',
					opacity: props.disabled === true ? 0.45 : 1,
					whiteSpace: 'nowrap',
				},
				...hover,
			}, [
				props.icon ? h(props.icon, { key: 'i', size: props.iconSize || 13 }) : null,
				props.text ? h('span', { key: 't' }, props.text) : null,
			]);
		}

		/**
		 * One row of the outline: a heading's text, indented by its depth.
		 * @param props - `text`, `level`, `active`, `onClick`.
		 */
		function OutlineRow(props) {
			const [hovered, hover] = useHover();
			return h('button', {
				type: 'button',
				title: props.text,
				'aria-current': props.active === true ? 'true' : undefined,
				onClick: props.onClick,
				style: {
					display: 'block',
					width: '100%',
					boxSizing: 'border-box',
					textAlign: 'left',
					border: 'none',
					borderRadius: 5,
					background: props.active === true || hovered ? T.hover : 'transparent',
					color: props.active === true ? T.brand : 'inherit',
					font: 'inherit',
					fontSize: 13.5,
					lineHeight: 1.4,
					fontWeight: props.level <= 1 ? 600 : 400,
					opacity: props.level >= 5 ? 0.85 : 1,
					cursor: 'pointer',
					padding: '5px 8px',
					paddingLeft: 8 + (props.level - 1) * 12,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				},
				...hover,
			}, props.text);
		}

		// ── tree ─────────────────────────────────────────────────────────────

		/**
		 * The host answers one directory level at a time and caps it. Say so rather
		 * than dropping the rest silently: an early build returned 4 of 17 root
		 * entries and nothing on screen said a single one was missing.
		 * @param key - React key.
		 * @param count - how many entries the host did return.
		 */
		function truncatedNotice(key, count) {
			return h('div', {
				key,
				style: {
					padding: '4px 8px',
					fontSize: 11.5,
					color: T.error,
					lineHeight: 1.5,
				},
			}, '仅显示前 ' + count + ' 项（目录过大，已截断）');
		}

		/**
		 * A search that skipped oversized notes says so.
		 *
		 * The host skips a note above its per-file cap, and it CANNOT know whether
		 * that note matched. Reporting "没有匹配" over a vault of large notes is
		 * therefore a claim the search never earned, so the skip is shown even when
		 * nothing else was found.
		 * @param key - React key.
		 * @param count - how many notes were too large to read.
		 */
		function skippedLargeNotice(key, count) {
			return h('div', {
				key,
				style: {
					padding: '4px 8px',
					fontSize: 11.5,
					color: T.error,
					lineHeight: 1.5,
				},
			}, '有 ' + count + ' 篇笔记超过 1 MB，未搜索（结果可能不完整）');
		}

		/** The retry control a failed level shows; the failure is not cached. */
		function retryButton(key, onRetry) {
			return h('button', {
				key,
				type: 'button',
				onClick: (event) => {
					event.preventDefault();
					event.stopPropagation();
					onRetry();
				},
				style: {
					marginTop: 4,
					padding: '2px 8px',
					border: '1px solid ' + T.borderL2,
					borderRadius: 5,
					background: 'transparent',
					color: 'inherit',
					font: 'inherit',
					fontSize: 11.5,
					cursor: 'pointer',
				},
			}, '重试');
		}

		// Memoised: typing in the search box re-renders the panel on every keystroke, and
		// without this every visible tree row re-renders with it.
		const TreeNode = React.memo(function TreeNode(props) {
			const node = props.node;
			const isDir = node.type === 'dir';
			const open = props.expanded.has(node.path);
			const active = !isDir && props.selected === node.path;
			const [hovered, hover] = useHover();

			const row = h('div', {
				onClick: () => { if (isDir) props.onToggle(node.path); else props.onSelect(node.path); },
				title: node.path,
				style: {
					display: 'flex',
					alignItems: 'center',
					gap: 5,
					height: 28,
					paddingRight: 6,
					paddingLeft: 4 + props.depth * 13,
					borderRadius: 5,
					cursor: 'pointer',
					background: active ? T.bgLayer2 : (hovered ? T.hover : 'transparent'),
					color: active ? T.labelPrimary : 'inherit',
					fontWeight: active ? 600 : 400,
					overflow: 'hidden',
				},
				...hover,
			}, [
				h('span', {
					key: 'chev',
					style: { display: 'flex', width: 14, justifyContent: 'center', opacity: 0.7 },
				}, isDir ? h(ChevronIcon, { size: 13, open }) : null),
				h('span', {
					key: 'icon',
					style: { display: 'flex', opacity: 0.62 },
				}, isDir ? h(FolderIcon, { size: 13.5 }) : h(FileIcon, { size: 13.5 })),
				h('span', {
					key: 'name',
					style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 },
					// Obsidian's explorer labels a note without its extension.
				}, isDir ? node.name : node.name.replace(/\.[^./]+$/, '')),
				// The selected note gains its handoff: "drop this document into the
				// main conversation", exactly as if it had been dragged there.
				!isDir && active && typeof props.onAttach === 'function'
					? h('button', {
						key: 'attach',
						type: 'button',
						title: '把这篇文章引用进对话（等价于拖入）',
						'aria-label': '引用到对话',
						onClick: (event) => {
							event.preventDefault();
							event.stopPropagation();
							props.onAttach(node.path);
						},
						style: {
							display: 'flex',
							alignItems: 'center',
							gap: 3,
							padding: '0 5px',
							border: 'none',
							borderRadius: 4,
							background: 'transparent',
							color: T.brand,
							font: 'inherit',
							fontSize: 12.5,
							cursor: 'pointer',
							whiteSpace: 'nowrap',
						},
					}, h(HandoffIcon, { key: 'i', size: 13 }), '发送')
					: null,
			]);

			// Children arrive lazily: `undefined` means "not fetched yet", which is
			// what separates an unopened folder from an empty one. A FAILED level is
			// removed from the map rather than cached as `[]`, so "（）" never lies
			// about a directory the host could not read — and the row offers a retry.
			const children = isDir ? props.childrenMap.get(node.path) : undefined;
			const levelError = isDir ? props.dirErrors.get(node.path) : undefined;
			const levelTruncated = isDir ? props.truncatedPaths.get(node.path) : undefined;
			const kids = isDir && open
				? h('div', { key: 'kids' },
					levelError !== undefined
						? h('div', {
							key: 'err',
							style: {
								padding: '3px 8px',
								paddingLeft: 21 + props.depth * 13,
								fontSize: 12.5,
								color: T.error,
								lineHeight: 1.6,
							},
						}, [levelError, retryButton('retry', () => props.onRetry(node.path))])
						: children === undefined
							? h('div', {
								key: 'pending',
								style: {
									padding: '3px 8px',
									paddingLeft: 21 + props.depth * 13,
									fontSize: 12.5,
									color: T.labelSecondary,
								},
							}, props.loadingPaths.has(node.path) ? '读取中…' : '…')
							: [
								children.length === 0
									? h('div', {
										key: 'empty',
										style: {
											padding: '3px 8px',
											paddingLeft: 21 + props.depth * 13,
											fontSize: 12.5,
											color: T.labelSecondary,
										},
									}, '（空）')
									: children.map((child) => h(TreeNode, {
										key: child.path,
										node: child,
										depth: props.depth + 1,
										expanded: props.expanded,
										childrenMap: props.childrenMap,
										loadingPaths: props.loadingPaths,
										dirErrors: props.dirErrors,
										truncatedPaths: props.truncatedPaths,
										selected: props.selected,
										onToggle: props.onToggle,
										onSelect: props.onSelect,
										onAttach: props.onAttach,
										onRetry: props.onRetry,
									})),
								levelTruncated === undefined ? null : truncatedNotice('trunc', levelTruncated),
							])
				: null;

			return h('div', { key: node.path }, [h('div', { key: 'row' }, row), kids]);
		});

		// ── notes panel (right-Sidebar tab body) ─────────────────────────────

		/**
		 * Build the vault panel.
		 *
		 * A factory rather than a bare component because the panel opens the vault
		 * conversation in the centre, and that needs the plugin context (the right-Sidebar
		 * navigator) which only `apply` holds.
		 *
		 * @param ctx - plugin context.
		 */
		function makeNotesPanel(ctx) {
			return function NotesPanel(props) {
			// The reader's browsing state survives the remount a Session switch costs it:
			// the vault is the same vault, so the expansion, the selection and the levels
			// already fetched are still true. Page-level memory, not a durable preference,
			// and it is dropped outright when the vault itself turns out to be another one.
			const cached = panelBrowseState;
			const [vault, setVault] = React.useState('');
			const [vaultRoot, setVaultRoot] = React.useState('');
			const [treeError, setTreeError] = React.useState('');
			const [childrenMap, setChildrenMap] = React.useState(() => (cached === null ? new Map() : cached.childrenMap));
			const [dirErrors, setDirErrors] = React.useState(() => new Map());
			const [truncatedPaths, setTruncatedPaths] = React.useState(() => new Map());
			const [loadingPaths, setLoadingPaths] = React.useState(() => new Set());
			const [expanded, setExpanded] = React.useState(() => (cached === null ? new Set() : cached.expanded));
			const [selected, setSelected] = React.useState(() => (cached === null ? '' : cached.selected));
			const [query, setQuery] = React.useState(() => (cached === null ? '' : cached.query));
			const [results, setResults] = React.useState(null);
			const [resultsTruncated, setResultsTruncated] = React.useState(false);
			// How many notes the search could not read at all, kept apart from the
			// truncation flag so the message can say WHICH incompleteness it was.
			const [resultsSkippedLarge, setResultsSkippedLarge] = React.useState(0);
			const [searching, setSearching] = React.useState(false);
			// One self-clearing line: a new message cancels the previous timer, so an
			// older message can never wipe a newer one.
			const [feedback, showFeedback] = useFeedback();
			// Monotonic request id for searches: a slow first answer must not land on
			// top of a newer query's results.
			const searchSeq = React.useRef(0);
			const panelRef = React.useRef(null);

			// The reader is looking at the tree panel, so it is what a Session switch has
			// to put back (see `rememberSurface` / `restoreSurface`).
			React.useEffect(() => { rememberSurface({ kind: 'notes' }); }, []);

			/** Fetch one directory level. '' is the vault root. */
			const loadDir = React.useCallback((path) => {
				setLoadingPaths((current) => {
					const next = new Set(current);
					next.add(path);
					return next;
				});
				return getJson(API.tree + (path === '' ? '' : '?path=' + encodeURIComponent(path)))
					.then((data) => {
						if (typeof data.vault === 'string' && data.vault !== '') setVault(data.vault);
						if (typeof data.root === 'string' && data.root !== '') setVaultRoot(data.root);
						const entries = Array.isArray(data.entries) ? data.entries : [];
						setChildrenMap((current) => {
							const next = new Map(current);
							next.set(path, entries);
							return next;
						});
						setDirErrors((current) => {
							if (!current.has(path)) return current;
							const next = new Map(current);
							next.delete(path);
							return next;
						});
						setTruncatedPaths((current) => {
							const next = new Map(current);
							if (data.truncated === true) next.set(path, entries.length);
							else next.delete(path);
							return next;
						});
						if (path === '') setTreeError('');
					})
					.catch((error) => {
						const message = String(error && error.message ? error.message : error);
						// A failure is NOT cached as an empty directory: `[]` claimed the
						// folder was empty and `childrenMap.has(path)` then stopped the
						// reader from ever retrying it. Dropping the key restores both the
						// pending state and re-expansion as a retry, with the message shown.
						setChildrenMap((current) => {
							if (!current.has(path)) return current;
							const next = new Map(current);
							next.delete(path);
							return next;
						});
						if (path === '') {
							setTreeError(message);
						} else {
							setDirErrors((current) => {
								const next = new Map(current);
								next.set(path, message);
								return next;
							});
						}
					})
					.then(() => {
						setLoadingPaths((current) => {
							const next = new Set(current);
							next.delete(path);
							return next;
						});
					});
			}, []);

			const reloadAll = React.useCallback(() => {
				setChildrenMap(new Map());
				setDirErrors(new Map());
				setTruncatedPaths(new Map());
				setTreeError('');
				setExpanded(new Set());
				loadDir('');
			}, [loadDir]);

			// ── which folder is the vault ──────────────────────────────────────
			//
			// Obsidian's registry is only a guess. On first run the reader is asked,
			// and the choice is remembered host-side so it outranks the guess from then
			// on. Until there is an explicit choice the tree is not shown: the panel
			// must not silently read a folder the reader never agreed to.
			const [vaultInfo, setVaultInfo] = React.useState(null);

			const readVault = React.useCallback(() => getJson(API.vault)
				.then((info) => { setVaultInfo(info); return info; })
				.catch(() => {
					const none = { path: null, chosen: null, detected: null, source: 'none' };
					setVaultInfo(none);
					return none;
				}), []);

			React.useEffect(() => { readVault(); }, [readVault]);

			/**
			 * Re-read everything after the root changes; nothing from the old vault
			 * survives.
			 *
			 * This deliberately does NOT call `loadDir('')` itself. The first selection
			 * used to fetch the root TWICE — once here and once from the agreement
			 * effect below — and the effect is keyed on the vault PATH, not on a
			 * boolean, so switching vaults still reloads while the first selection
			 * loads exactly once.
			 */
			const adoptVault = React.useCallback(() => readVault().then(() => {
				setSelected('');
				setQuery('');
				setResults(null);
				setResultsTruncated(false);
				setResultsSkippedLarge(0);
				setChildrenMap(new Map());
				setDirErrors(new Map());
				setTruncatedPaths(new Map());
				setTreeError('');
				setExpanded(new Set());
			}), [readVault]);

			const chooseVault = React.useCallback(() => {
				// Reached through `ctx.get`, NEVER through `ctx.uiWorkspace`. A Cordis
				// service PROPERTY throws when the service is not in `inject` —
				// "cannot get property \"uiWorkspace\" without inject" — and this
				// callback's dependency array is read during render, so the throw took
				// the whole panel down and left the pane blank.
				const picker = serviceOf(ctx, 'uiWorkspace');
				if (picker === undefined || picker === null || typeof picker.pickDirectory !== 'function') {
					showFeedback('这个环境没有文件夹选择器，请手动设置', 0);
					return;
				}
				showFeedback('正在打开文件夹选择器…', 0);
				picker.pickDirectory()
					.then((folder) => {
						if (typeof folder !== 'string' || folder === '') { showFeedback(''); return undefined; }
						return postJson(API.vault, { path: folder })
							.then(() => { showFeedback(''); return adoptVault(); });
					})
					.catch((error) => {
						showFeedback('选择失败：' + String(error && error.message ? error.message : error), 0);
					});
			}, [ctx, adoptVault, showFeedback]);

			const acceptDetectedVault = React.useCallback(() => {
				const detected = vaultInfo === null ? null : vaultInfo.detected;
				if (typeof detected !== 'string' || detected === '') return;
				showFeedback('');
				postJson(API.vault, { path: detected })
					.then(() => adoptVault())
					.catch((error) => {
						showFeedback('使用失败：' + String(error && error.message ? error.message : error), 0);
					});
			}, [vaultInfo, adoptVault, showFeedback]);

			// The tree loads only once a folder is both in force AND agreed to. Reading a
			// folder the reader has never confirmed is exactly what the chooser prevents.
			// Keyed on the PATH: a first selection and a later change both reload it, and
			// neither loads it twice.
			const agreedVaultPath = vaultInfo !== null
				&& vaultInfo.chosen !== null && vaultInfo.chosen !== undefined
				&& typeof vaultInfo.path === 'string' && vaultInfo.path !== ''
				? vaultInfo.path
				: '';
			React.useEffect(() => {
				if (agreedVaultPath === '') return;
				loadDir('');
				// The folder is the reader's answer to "which vault": the Workspace is what
				// makes it a place the agent can be sent to, and what the sidebar lists.
				// Resolving it here — rather than on the first 对话 — means the workspace
				// exists from the moment the reader has chosen, instead of appearing only
				// after they went looking for the conversation. Idempotent by contract.
				ensureVaultWorkspace(ctx, agreedVaultPath);
			}, [agreedVaultPath, loadDir, ctx]);

			// A remount (a Session switch) restores the expansion and the levels it had —
			// unless the vault itself turned out to be another one, in which case nothing
			// from the old tree survives.
			React.useEffect(() => {
				if (agreedVaultPath === '') return;
				if (panelBrowseState !== null && panelBrowseState.vaultPath !== agreedVaultPath) {
					panelBrowseState = null;
					setChildrenMap(new Map());
					setExpanded(new Set());
					setSelected('');
					setQuery('');
				}
			}, [agreedVaultPath]);

			React.useEffect(() => {
				if (agreedVaultPath === '') return;
				panelBrowseState = {
					vaultPath: agreedVaultPath,
					childrenMap,
					expanded,
					selected,
					query,
				};
			}, [agreedVaultPath, childrenMap, expanded, selected, query]);

			// A note opens in its OWN tab: the tree stays put, and the note renders
			// full-height on a page of its own.
			const openNote = React.useCallback((path) => {
				setSelected(path);
				ctx.sidebarRight.openResource(noteAddress(path));
			}, []);

			// "Drop this document into the main conversation": insert its absolute
			// @path mention at the caret — exactly what dragging the file would do.
			// With no known root `absoluteVaultPath` answers undefined, which
			// `mentionInto` reports as `no-path` rather than inventing `@/笔记/x.md`.
			const attachToConversation = React.useCallback((path) => {
				showFeedback(ATTACH_MESSAGE[mentionInto(props.inputActions, absoluteVaultPath(vaultRoot, path))]);
			}, [vaultRoot, props.inputActions, showFeedback]);

			// Debounced vault search. A live query shows its results in place of the
			// tree; clearing it restores the tree. Every request carries a sequence
			// number: a slow answer to an earlier query must never overwrite a newer
			// one's results, and clearing the box invalidates everything in flight.
			React.useEffect(() => {
				const trimmed = query.trim();
				const seq = (searchSeq.current += 1);
				if (trimmed === '') { setResults(null); setResultsTruncated(false); setResultsSkippedLarge(0); setSearching(false); return undefined; }
				setSearching(true);
				const timer = setTimeout(() => {
					getJson(API.search + '?q=' + encodeURIComponent(trimmed) + '&limit=80').then((data) => {
						if (seq !== searchSeq.current) return;
						const hits = Array.isArray(data.results) ? data.results : [];
						setResults(hits);
						setResultsTruncated(data.truncated === true);
						// The host's count of notes it could not read; absent from an
						// older answer, where 0 is the only safe reading.
						setResultsSkippedLarge(typeof data.skippedLarge === 'number' && data.skippedLarge > 0
							? data.skippedLarge
							: 0);
						setSearching(false);
					}).catch(() => {
						if (seq !== searchSeq.current) return;
						setResults([]);
						setResultsTruncated(false);
						setResultsSkippedLarge(0);
						setSearching(false);
					});
				}, SEARCH_DEBOUNCE_MS);
				return () => clearTimeout(timer);
			}, [query]);

			// Opening a folder fetches its level the first time it is expanded. A level
			// dropped after a failure is absent from the map, so re-expanding retries.
			const toggleDir = React.useCallback((path) => {
				const alreadyOpen = expanded.has(path);
				setExpanded((current) => {
					const next = new Set(current);
					if (next.has(path)) next.delete(path); else next.add(path);
					return next;
				});
				if (!alreadyOpen && !childrenMap.has(path)) loadDir(path);
			}, [expanded, childrenMap, loadDir]);

			/** Retry one failed level — the root's error uses '' like everything else. */
			const retryDir = React.useCallback((path) => {
				if (path === '') setTreeError('');
				loadDir(path);
			}, [loadDir]);

			const jumpToObsidian = React.useCallback((path) => {
				showFeedback('打开中…', 0);
				openInObsidian(path).then(() => {
					showFeedback('已交给 Obsidian', 1800);
				}).catch(() => {
					showFeedback('打开失败');
				});
			}, [showFeedback]);

			// ── browse body: search results, or the tree ─────────────────────
			// `truncated` is read, not ignored: the host caps both the tree level and
			// the result list, and a silently shortened list reads as "that is all".
			const searchResults = results === null ? null : h('div', {
				key: 'results',
				style: { padding: '4px 5px' },
			}, results.length === 0
				? h('div', {
					key: 'none',
					style: { padding: '12px 8px', fontSize: 13, color: T.labelSecondary },
					// "没有匹配" over a search that never read a large note would be a
					// claim it cannot make; an empty result that IS a complete answer
					// still reads exactly as before.
				}, searching ? '搜索中…' : (resultsSkippedLarge > 0
					? '没有匹配，但有 ' + resultsSkippedLarge + ' 篇超过 1 MB 的笔记未搜索'
					: (resultsTruncated ? '没有匹配（搜索提前结束，结果可能不完整）' : '没有匹配')))
				: [
					...results.map((hit, index) => h('div', {
						key: hit.path + ':' + hit.line + ':' + index,
						onClick: () => openNote(hit.path),
						title: hit.path + ' : ' + hit.line,
						style: { padding: '7px 8px', borderRadius: 6, cursor: 'pointer' },
					}, [
						h('div', {
							key: 'p',
							style: {
								fontSize: 12.5,
								color: T.labelSecondary,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							},
						}, hit.path + ' : ' + hit.line),
						h('div', {
							key: 't',
							style: {
								fontSize: 13,
								marginTop: 2,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							},
						}, hit.text),
					])),
					resultsSkippedLarge > 0 ? skippedLargeNotice('skiplarge', resultsSkippedLarge) : null,
					resultsTruncated ? truncatedNotice('trunc', results.length) : null,
				]);

			const rootEntries = childrenMap.get('');
			const treeBody = treeError !== ''
				? h('div', {
					key: 'err',
					style: { padding: '12px 8px', fontSize: 12, color: T.error, lineHeight: 1.6 },
				}, [treeError, retryButton('retry', () => retryDir(''))])
				: rootEntries === undefined
					? h('div', {
						key: 'loading',
						style: { padding: '12px 8px', fontSize: 12, color: T.labelSecondary },
					}, loadingPaths.has('') ? '读取库中…' : '')
					: rootEntries.length === 0
						? h('div', {
							key: 'empty',
							style: { padding: '12px 8px', fontSize: 12, color: T.labelSecondary },
						}, '库里没有可显示的笔记')
						: h('div', { key: 'tree', style: { padding: '4px 5px' } }, [
							truncatedPaths.has('') ? truncatedNotice('trunc', truncatedPaths.get('')) : null,
							...rootEntries.map((node) => h(TreeNode, {
								key: node.path,
								node,
								depth: 0,
								expanded,
								childrenMap,
								loadingPaths,
								dirErrors,
								truncatedPaths,
								selected,
								onToggle: toggleDir,
								onSelect: openNote,
								onAttach: attachToConversation,
								onRetry: retryDir,
							})),
						]);

			const needsVault = vaultInfo !== null
				&& (vaultInfo.chosen === null || vaultInfo.chosen === undefined);

			// The first-run chooser. It does not vanish once a vault is agreed to: the
			// header keeps a folder button, and this is what that button changes.
			const vaultChooser = h('div', {
				key: 'vault',
				style: { padding: '16px 14px', fontSize: 12.5, lineHeight: 1.9, color: T.labelPrimary },
			}, [
				h('div', { key: 't', style: { fontWeight: 600, marginBottom: 6 } }, '先选择知识库文件夹'),
				h('div', {
					key: 'd',
					style: { color: T.labelSecondary, marginBottom: 14 },
				}, typeof vaultInfo?.detected === 'string' && vaultInfo.detected !== ''
					? '检测到 Obsidian 的库：' + vaultInfo.detected
					: '没有检测到 Obsidian 的库，请手动选择这个插件要管理的文件夹。'),
				h('div', { key: 'b', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
					typeof vaultInfo?.detected === 'string' && vaultInfo.detected !== ''
						? h(TextButton, {
							key: 'use',
							label: '使用这个库',
							icon: h(FolderIcon, { size: 13 }),
							onClick: acceptDetectedVault,
						})
						: null,
					h(TextButton, {
						key: 'pick',
						label: '选择文件夹…',
						icon: h(FolderIcon, { size: 13 }),
						onClick: chooseVault,
					}),
				]),
				feedback === '' ? null : h('div', {
					key: 'f',
					style: { marginTop: 12, color: T.labelSecondary },
				}, feedback),
			]);

			const browseBody = needsVault ? vaultChooser : (searchResults !== null ? searchResults : treeBody);

			// ── frame ────────────────────────────────────────────────────────
			const header = h('div', {
				key: 'head',
				style: {
					display: 'flex',
					alignItems: 'center',
					gap: 7,
					padding: '9px 10px',
					borderBottom: '1px solid ' + T.borderL1,
				},
			}, [
				h('span', { key: 'i', style: { display: 'flex', color: T.brand } }, h(CrystalIcon, { size: 15 })),
				h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
					h('div', {
						key: 'n',
						style: {
							fontSize: 13.5,
							fontWeight: 600,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						},
					}, vault === '' ? TAB_TITLE : vault),
					feedback !== '' ? h('div', {
						key: 'f',
						style: { fontSize: 11, color: T.labelSecondary, marginTop: 1 },
					}, feedback) : null,
				]),
				h(IconButton, {
					key: 'r',
					title: '重新读取目录',
					icon: RefreshIcon,
					disabled: loadingPaths.has(''),
					onClick: reloadAll,
				}),
				h(ConversationButton, { key: 'c', ctx, report: showFeedback }),
				h(IconButton, {
					key: 'v',
					title: vaultInfo !== null && typeof vaultInfo.path === 'string' && vaultInfo.path !== ''
						? '更换知识库文件夹（当前：' + vaultInfo.path + '）'
						: '选择知识库文件夹',
					icon: FolderIcon,
					onClick: chooseVault,
				}),
				h(IconButton, {
					key: 'o',
					title: '在 Obsidian 中打开这个库',
					icon: ExternalIcon,
					onClick: () => jumpToObsidian(''),
				}),
			]);

			const searchBar = h('div', {
				key: 'search',
				style: { padding: 8, borderBottom: '1px solid ' + T.borderL1 },
			}, h('div', {
				style: {
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					height: 28,
					padding: '0 7px',
					border: '1px solid ' + T.borderL1,
					borderRadius: 7,
				},
			}, [
				h('span', { key: 'i', style: { display: 'flex', opacity: 0.6 } }, h(SearchIcon, { size: 13 })),
				h('input', {
					key: 'in',
					value: query,
					placeholder: '搜索整个库…',
					onChange: (event) => setQuery(event.target.value),
					style: {
						flex: 1,
						minWidth: 0,
						border: 'none',
						outline: 'none',
						background: 'transparent',
						color: 'inherit',
						font: 'inherit',
						fontSize: 13.5,
					},
				}),
				query !== '' ? h('span', {
					key: 'x',
					onClick: () => setQuery(''),
					title: '清空',
					style: { cursor: 'pointer', opacity: 0.6, fontSize: 14, lineHeight: 1 },
				}, '×') : null,
			]));

			return h('div', {
				ref: panelRef,
				style: {
					flex: '1 1 auto',
					minHeight: 0,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
					color: T.labelPrimary,
				},
			}, [
				header,
				searchBar,
				h('div', {
					key: 'body',
					style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
				}, browseBody),
			]);
			};
		}

		/**
		 * A note's own page: full-height rendered Markdown whose `[[wikilink]]`s turn
		 * the page to other notes, plus a handoff into the main conversation.
		 */
		function makeNoteTab(ctx) {
			return function NoteTab(props) {
				const { useTabInfo, inputActions } = props;
				const { tab } = useTabInfo();
				const initialPath = parseNoteAddress(tab.contentId);
				const [path, setPath] = React.useState(initialPath);
				const [note, setNote] = React.useState(null);
				const [error, setError] = React.useState('');
				const [loading, setLoading] = React.useState(false);
				const [feedback, keepFeedback] = useFeedback();
				// Editing turns this page into a plain-text editor over the same file.
				const [editing, setEditing] = React.useState(false);
				const [draftText, setDraftText] = React.useState('');
				const [saving, setSaving] = React.useState(false);
				// This page's own layout ref; the conversation is not drawn here any more.
				const noteRef = React.useRef(null);

				// The reader is looking at THIS page, so it is what a Session switch has
				// to put back. Kept current as the page turns (a `[[wikilink]]` moves it).
				React.useEffect(() => {
					if (path !== undefined) rememberSurface({ kind: 'note', path });
				}, [path]);

				// Monotonic request id: `load` is called for every path the page turns
				// to, and a slow answer for the previous note must not overwrite the
				// note the reader is actually looking at.
				const loadSeq = React.useRef(0);

				// ── the outline ──────────────────────────────────────────────
				//
				// One view over what is already on screen. Every rendered heading carries
				// its anchor and its depth as DOM attributes, so this list is read back
				// off the page itself instead of parsing the note a second time and
				// drifting from what the reader is looking at.
				const bodyRef = React.useRef(null);
				const [outlineOpen, setOutlineOpen] = React.useState(false);
				const [outlineItems, setOutlineItems] = React.useState([]);
				const [activeHeading, setActiveHeading] = React.useState('');
				const outlineAnchors = React.useMemo(() => OUTLINE_ID_PREFIX + (notePageSeq += 1) + '-', []);

				const load = React.useCallback((target) => {
					const seq = (loadSeq.current += 1);
					setLoading(true);
					setError('');
					getJson(API.note + '?path=' + encodeURIComponent(target)).then((data) => {
						if (seq !== loadSeq.current) return;
						setNote(data);
						setLoading(false);
					}).catch((err) => {
						if (seq !== loadSeq.current) return;
						setNote(null);
						setError(String(err && err.message ? err.message : err));
						setLoading(false);
					});
				}, []);

				// The tab framework reuses one body per kind; a freshly opened address
				// turns the page. This fires ONLY on an address change — wikilink
				// navigation changes `path` locally, and must not be yanked back by this.
				React.useEffect(() => {
					const next = parseNoteAddress(tab.contentId);
					if (next !== undefined) setPath(next);
				}, [tab.contentId]);

				React.useEffect(() => {
					if (path !== undefined) {
						// Opening another note leaves edit mode: the draft belongs to the
						// file that was open when it started.
						setEditing(false);
						load(path);
					}
				}, [path, load]);

				// A `[[wikilink]]` resolves to its note and opens it as its OWN page, so
				// following a link never loses the page you were reading.
				//
				// `[[笔记#标题]]` carries the anchor: the opened page is a different component
				// instance, so the scroll is handed over through `pendingAnchors` and taken
				// once that page has drawn the note.
				const navigate = React.useCallback((target, anchor) => {
					getJson(API.resolve + '?name=' + encodeURIComponent(target)).then((data) => {
						const found = Array.isArray(data.matches) && data.matches.length > 0
							? data.matches[0].path
							: (typeof data.path === 'string' ? data.path : undefined);
						if (found === undefined) {
							keepFeedback('找不到笔记：' + target, 3200);
							return;
						}
						if (typeof anchor === 'string' && anchor !== '') pendingAnchors.set(found, anchor);
						ctx.sidebarRight.openResource(noteAddress(found));
					}).catch(() => { keepFeedback('无法解析链接：' + target, 3200); });
				}, [keepFeedback]);

				/**
				 * Jump to an anchor inside THIS note: `[[#标题]]`, `[x](#锚点)`, `[[#^块id]]`,
				 * and — through the hand-off in `pendingAnchors` — `[[笔记#标题]]` from the
				 * page that opened this one.
				 *
				 * The compiled guide's whole table of contents is written `[[#标题\|别名]]`
				 * in table cells, so before this every chapter link was a dead button.
				 * Headings already carry their text and their anchor id, so the jump reads
				 * the rendered page rather than parsing the note a second time — the same
				 * discipline the outline uses. `matchHeading` owns the matching rules, and a
				 * target that really is absent says so instead of doing nothing.
				 */
				const jumpToAnchor = React.useCallback((anchor) => {
					const host = bodyRef.current;
					if (host === null) return;
					const wanted = String(anchor === undefined || anchor === null ? '' : anchor)
						.replace(/\s+/g, ' ')
						.trim();
					if (wanted === '') return;
					// `#^block-id`: a marked block, not a heading. Blocks carry the id as a
					// data attribute; the marker itself was stripped at render time.
					if (wanted.charAt(0) === '^') {
						const blockId = wanted.slice(1).trim();
						const marked = blockId === ''
							? null
							: host.querySelector('[data-block-id="' + blockId.replace(/["\\]/g, '') + '"]');
						if (marked !== null) {
							scrollHeadingIntoView(marked);
							return;
						}
						keepFeedback('找不到块：' + wanted, 3200);
						return;
					}
					const nodes = host.querySelectorAll('[data-outline]');
					const texts = [];
					for (let index = 0; index < nodes.length; index += 1) {
						const node = nodes[index];
						texts.push(String(node.textContent === undefined || node.textContent === null ? '' : node.textContent));
					}
					const matched = matchHeading(texts, wanted);
					if (matched === null) {
						keepFeedback('找不到标题：' + wanted, 3200);
						return;
					}
					for (let index = 0; index < nodes.length; index += 1) {
						const text = String(nodes[index].textContent === undefined || nodes[index].textContent === null ? '' : nodes[index].textContent)
							.replace(/\s+/g, ' ')
							.trim();
						if (text === String(matched).replace(/\s+/g, ' ').trim()) {
							scrollHeadingIntoView(nodes[index]);
							return;
						}
					}
					keepFeedback('找不到标题：' + wanted, 3200);
				}, [keepFeedback]);

				/**
				 * Quote this note into the conversation on screen.
				 *
				 * The `inputActions` a tab body receives belong to the Session whose
				 * Sidebar this is — the conversation the centre is showing. With the vault
				 * conversation opened there, this is exactly the vault conversation's
				 * composer; with any other Session showing, it is that one's, which is
				 * also what dragging a file into it would do.
				 */
				const attachToConversation = React.useCallback(() => {
					if (path === undefined || note === null) {
						keepFeedback('还没有可发送的内容');
						return;
					}
					// An empty `root` means no absolute path exists; `mentionInto` answers
					// `no-path` and the reader is told, rather than shown `@undefined`.
					keepFeedback(ATTACH_MESSAGE[mentionInto(inputActions, absoluteVaultPath(note.root, path))]);
				}, [path, note, inputActions, keepFeedback]);

				const startEdit = React.useCallback(() => {
					if (note === null) return;
					if (note.truncated === true) {
						keepFeedback('这篇笔记被截断显示，为免覆盖原文，不能编辑', 4200);
						return;
					}
					setDraftText(note.text);
					setEditing(true);
				}, [note, keepFeedback]);

				const save = React.useCallback(() => {
					if (path === undefined || saving) return;
					setSaving(true);
					postJson(API.note, { path, text: draftText }).then(() => {
						setSaving(false);
						setEditing(false);
						keepFeedback('已保存');
						load(path);
					}).catch((err) => {
						setSaving(false);
						keepFeedback('保存失败：' + String(err && err.message ? err.message : err), 4200);
					});
				}, [path, draftText, saving, load, keepFeedback]);

				const name = path === undefined ? '' : String(path).split('/').pop();

				// The vault index: backlinks, broken-link styling and hover previews all
				// read this. It is vault-wide and fetched once per session (the host keeps
				// its own 15 s memo), so navigating between notes costs nothing.
				const [index, setIndex] = React.useState(vaultIndex.data);
				const [indexError, setIndexError] = React.useState(vaultIndex.error);
				const [preview, setPreview] = React.useState(null);
				React.useEffect(() => {
					let live = true;
					loadVaultIndex(false).then((data) => {
						if (!live) return;
						if (data !== null) setIndex(data);
						setIndexError(vaultIndex.error);
					});
					return () => { live = false; };
				}, [path]);
				const refreshIndex = React.useCallback(() => {
					loadVaultIndex(true).then((data) => {
						if (data !== null) setIndex(data);
						setIndexError(vaultIndex.error);
					});
				}, []);

				// The note's outgoing links are the authority on what exists: a link is
				// broken only when THIS note's own entry says it did not resolve, so a
				// partially built index can never paint half a table of contents grey.
				const hints = React.useMemo(() => ({
					statusOf: (target) => linkStatus(index, path, target),
					preview: (target, event) => {
						const found = previewOf(index, target);
						const status = linkStatus(index, path, target);
						const x = typeof event === 'undefined' || event === null ? 0 : Number(event.clientX) || 0;
						const y = typeof event === 'undefined' || event === null ? 0 : Number(event.clientY) || 0;
						if (found === null) {
							setPreview({ title: target, excerpt: '要点开才知道这篇笔记在哪', missing: true, x, y });
							return;
						}
						setPreview({ title: found.title, excerpt: found.excerpt, missing: false, x, y });
					},
					hidePreview: () => setPreview(null),
				}), [index, path]);

				const properties = React.useMemo(
					() => (note === null ? { rows: [], body: '' } : parseProperties(note.text)),
					[note],
				);

				const related = React.useMemo(() => ({
					backlinks: backlinksOf(index, path),
					outlinks: outlinksOf(index, path),
				}), [index, path]);

				// Any note this page sends you to opens as its own page, so following a
				// backlink never loses the note you were reading.
				const openRelated = React.useCallback((target) => {
					if (target === undefined || target === '') return;
					ctx.sidebarRight.openResource(noteAddress(target));
				}, [ctx]);

				// Memoised: editing re-renders this page on every keystroke, and
				// re-parsing the whole note each time is the one expensive thing here.
				// Only the note (or the link navigator) can change what the Markdown
				// becomes.
				const renderedMarkdown = React.useMemo(
					() => (note === null ? null : renderMarkdown(note.text, navigate, outlineAnchors, jumpToAnchor, hints)),
					[note, navigate, outlineAnchors, jumpToAnchor, hints],
				);

				// `[[笔记#标题]]` opened THIS page: the opener left the anchor in
				// `pendingAnchors` keyed by path. Consume it once the note is drawn — one
				// tick later, because the headings appear in the same commit as `note` and
				// the scroll needs them laid out.
				React.useEffect(() => {
					if (note === null || path === undefined) return undefined;
					const pending = pendingAnchors.get(path);
					if (pending === undefined) return undefined;
					pendingAnchors.delete(path);
					const timer = setTimeout(() => jumpToAnchor(pending), 0);
					return () => clearTimeout(timer);
				}, [note, path, jumpToAnchor]);

				/** The headings currently on screen, in document order. */
				const collectOutline = React.useCallback(() => {
					const host = bodyRef.current;
					if (host === null) return [];
					const nodes = host.querySelectorAll('[data-outline]');
					const items = [];
					for (let index = 0; index < nodes.length; index += 1) {
						const node = nodes[index];
						items.push({
							id: node.id,
							level: Number(node.getAttribute('data-outline')) || 1,
							text: String(node.textContent || '').replace(/\s+/g, ' ').trim(),
						});
					}
					return items;
				}, []);

				/** Bring one heading to the top of the reading area. */
				const jumpToHeading = React.useCallback((id) => {
					const host = bodyRef.current;
					if (host === null || id === '') return;
					const target = host.querySelector('[id="' + id + '"]');
					if (target === null) return;
					setActiveHeading(id);
					if (typeof target.scrollIntoView === 'function') {
						try {
							target.scrollIntoView({ block: 'start', behavior: 'smooth' });
						} catch (error) {
							target.scrollIntoView();
						}
						return;
					}
					// A shell without `scrollIntoView`: move the reading area by hand.
					host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top - 14;
				}, []);

				/** Which heading the reader is inside, according to the reading area. */
				const trackHeading = React.useCallback(() => {
					if (!outlineOpen) return;
					const host = bodyRef.current;
					if (host === null) return;
					const nodes = host.querySelectorAll('[data-outline]');
					if (nodes.length === 0) return;
					const limit = host.getBoundingClientRect().top + 30;
					let current = nodes[0].id;
					for (let index = 0; index < nodes.length; index += 1) {
						if (nodes[index].getBoundingClientRect().top <= limit) current = nodes[index].id;
						else break;
					}
					setActiveHeading(current);
				}, [outlineOpen]);

				// The rendered page is the source of truth: rebuild whenever it changes, and
				// pick the heading the reader is at the moment the panel opens.
				React.useEffect(() => {
					if (!outlineOpen) return;
					setOutlineItems(collectOutline());
					trackHeading();
				}, [outlineOpen, renderedMarkdown, collectOutline, trackHeading]);

				// Editing swaps the rendered page for a textarea: nothing left to outline.
				React.useEffect(() => {
					if (editing) setOutlineOpen(false);
				}, [editing]);

				// The metadata line (size / time / truncated) the reading view shows above
				// the body. Edit mode renders the SAME line, so pressing 编辑 does not
				// move the text: with it only on the reading side, the body jumped up by
				// this row's height (~24px) and the two modes were not "the same box"
				// after all. `mode` is what the harness compares the two boxes by.
				const noteMeta = (mode) => h('div', {
					key: 'meta',
					'data-dsh-obsidian-note-meta': mode,
					style: {
						fontSize: 11.5,
						lineHeight: 1.4,
						color: T.labelSecondary,
						marginBottom: 8,
						display: 'flex',
						gap: 9,
						flexWrap: 'wrap',
					},
				}, [
					h('span', { key: 's' }, formatBytes(note.size)),
					h('span', { key: 't' }, formatTime(note.mtimeMs)),
					note.truncated ? h('span', { key: 'tr', style: { color: T.error } }, '已截断') : null,
				]);

				const body = error !== ''
					? h('div', { style: { padding: 16, color: T.error, fontSize: 12.5 } }, error)
					: note === null
						? h('div', {
							style: { padding: 16, fontSize: 12, color: T.labelSecondary },
						}, loading ? '读取笔记中…' : '')
						: editing
							? h('div', {
								key: 'edit',
								'data-dsh-obsidian-note-body': 'edit',
								style: {
									flex: '1 1 auto',
									minHeight: 0,
									boxSizing: 'border-box',
									display: 'flex',
									flexDirection: 'column',
									// The SAME box as the reading view: entering edit mode must not
									// reflow the page the reader was just looking at. A monospace
									// 13px editor against a 16px proportional reading view made the
									// text jump, the line breaks move, and the page read as a
									// different document — the mode change was visible before a
									// single character was typed.
									padding: '18px 22px 96px',
									fontSize: READ.size,
									lineHeight: READ.lineHeight,
								},
							}, [
								noteMeta('edit'),
								h('textarea', {
									key: 'editor',
									value: draftText,
									onChange: (event) => setDraftText(event.target.value),
									spellCheck: false,
									style: {
										flex: '1 1 auto',
										minHeight: 0,
										width: '100%',
										boxSizing: 'border-box',
										border: 'none',
										outline: 'none',
										resize: 'none',
										padding: 0,
										background: 'transparent',
										color: 'inherit',
										fontFamily: 'inherit',
										fontSize: READ.size,
										lineHeight: READ.lineHeight,
									},
								}),
							])
							: h('div', {
								key: 'read',
								'data-dsh-obsidian-note-body': 'read',
								// Obsidian's reading-view metrics: the base size and line height
								// every ratio inside `renderMarkdown` is expressed against.
								style: {
									padding: '18px 22px 96px',
									fontSize: READ.size,
									lineHeight: READ.lineHeight,
								},
							}, [
								noteMeta('read'),
								// Properties first: Obsidian's reading view puts them above the
								// title, and they answer "what is this note" before the prose.
								h(PropertiesCard, {
									key: 'props',
									rows: properties.rows,
									onLink: navigate,
									hints,
								}),
								h('div', { key: 'md' }, renderedMarkdown),
								h(RelatedPanel, {
									key: 'related',
									backlinks: related.backlinks,
									outlinks: related.outlinks,
									onOpen: openRelated,
									onRefresh: refreshIndex,
									error: indexError,
								}),
							]);

				const actions = editing
					? [
						h(IconButton, {
							key: 'save',
							title: '保存到文件',
							text: saving ? '保存中…' : '保存',
							icon: SaveIcon,
							disabled: saving,
							onClick: save,
						}),
						h(IconButton, {
							key: 'cancel',
							title: '放弃修改',
							text: '取消',
							icon: BackIcon,
							onClick: () => setEditing(false),
						}),
					]
					: [
						h(IconButton, {
							key: 'outline',
							title: outlineOpen ? '收起大纲' : '大纲：点标题直接跳过去',
							text: '大纲',
							icon: OutlineIcon,
							onClick: () => setOutlineOpen((open) => !open),
						}),
						h(ConversationButton, { key: 'chat', ctx, report: keepFeedback }),
						h(IconButton, {
							key: 'edit',
							title: '直接编辑这篇笔记的 Markdown',
							text: '编辑',
							icon: EditIcon,
							onClick: startEdit,
						}),
						h(IconButton, {
							key: 'attach',
							title: '把这篇文章引用进对话（等价于拖入）',
							text: '引用到对话',
							icon: HandoffIcon,
							onClick: attachToConversation,
						}),
						h(IconButton, {
							key: 'o',
							title: '在 Obsidian 中打开这篇笔记',
							icon: ExternalIcon,
							onClick: () => { if (path !== undefined) openInObsidian(path); },
						}),
					];

				return h('div', {
					ref: noteRef,
					style: {
						position: 'relative',
						flex: '1 1 auto',
						minHeight: 0,
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
						color: T.labelPrimary,
					},
				}, [
					h('div', {
						key: 'head',
						style: {
							display: 'flex',
							alignItems: 'center',
							gap: 7,
							padding: '9px 10px',
							borderBottom: '1px solid ' + T.borderL1,
						},
					}, [
						h('span', { key: 'i', style: { display: 'flex', opacity: 0.62 } }, h(FileIcon, { size: 14 })),
						h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
							h('div', {
								key: 'n',
								style: {
									fontSize: 12.5,
									fontWeight: 600,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								},
							}, (name === '' ? '笔记' : name) + (editing ? '（编辑中）' : '')),
							feedback !== '' ? h('div', {
								key: 'f',
								style: { fontSize: 11, color: T.labelSecondary, marginTop: 1 },
							}, feedback) : null,
						]),
						...actions,
					]),
					h('div', {
						key: 'body',
						ref: bodyRef,
						onScroll: trackHeading,
						style: {
							flex: '1 1 auto',
							minHeight: 0,
							display: 'flex',
							flexDirection: 'column',
							overflowY: editing ? 'hidden' : 'auto',
						},
					}, body),
					// The hover card lives outside the scrolling body: it is `fixed`, so the
					// body's `overflow: auto` cannot clip it.
					h(LinkPreview, { key: 'preview', preview }),
					outlineOpen ? h('div', {
						key: 'outline',
						style: {
							position: 'absolute',
							top: 40,
							right: 8,
							width: 216,
							maxHeight: 'calc(100% - 96px)',
							display: 'flex',
							flexDirection: 'column',
							background: T.bgOverlay,
							border: '1px solid ' + T.borderL2,
							borderRadius: 8,
							boxShadow: T.shadow,
							zIndex: 6,
							overflow: 'hidden',
						},
					}, [
						h('div', {
							key: 'head',
							style: {
								display: 'flex',
								alignItems: 'center',
								gap: 6,
								padding: '6px 7px 6px 10px',
								borderBottom: '1px solid ' + T.borderL1,
								fontSize: 11.5,
								color: T.labelSecondary,
							},
						}, [
							h('span', { key: 't', style: { flex: 1 } }, outlineItems.length === 0
								? '大纲'
								: '大纲 · ' + outlineItems.length + ' 个标题'),
							h('button', {
								key: 'x',
								type: 'button',
								title: '收起大纲',
								'aria-label': '收起大纲',
								onClick: () => setOutlineOpen(false),
								style: {
									border: 'none',
									background: 'transparent',
									color: 'inherit',
									font: 'inherit',
									fontSize: 14,
									lineHeight: 1,
									padding: '0 2px',
									cursor: 'pointer',
								},
							}, '×'),
						]),
						h('div', {
							key: 'list',
							style: { overflowY: 'auto', padding: '5px 5px 7px' },
						}, outlineItems.length === 0
							? h('div', {
								style: { padding: '8px 6px 6px', fontSize: 11.5, color: T.labelSecondary },
							}, editing ? '编辑状态下没有大纲' : '这篇笔记没有标题')
							: outlineItems.map((item) => h(OutlineRow, {
								key: item.id,
								text: item.text === '' ? '(无标题)' : item.text,
								level: item.level,
								active: activeHeading === item.id,
								onClick: () => jumpToHeading(item.id),
							}))),
					]) : null,
				]);
			};
		}

		// ── sidebar-foot launcher ────────────────────────────────────────────

		/**
		 * The sidebar-foot row that opens the notes tab in the right Sidebar.
		 * @param ctx - plugin context owning the right-Sidebar navigator.
		 */
		function makeOpenNotesAction(ctx) {
			return function OpenNotesAction(props) {
				const wide = !!(props && props.wide);
				const [state, setState] = React.useState('idle');
				const [hovered, hover] = useHover();

				const open = React.useCallback(() => {
					try {
						ctx.sidebarRight.openTab(TAB_KIND);
						setState('ok');
					} catch (error) {
						// Thrown when no Session surface is mounted: there is no right
						// Sidebar to put a tab in yet.
						setState('fail');
					}
				}, []);

				React.useEffect(() => {
					if (state !== 'ok' && state !== 'fail') return undefined;
					const timer = setTimeout(() => setState('idle'), 1800);
					return () => clearTimeout(timer);
				}, [state]);

				const background = hovered ? T.hover : 'transparent';
				const style = wide ? {
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					width: '100%',
					padding: '6px 8px',
					border: 'none',
					borderRadius: 6,
					background,
					color: 'inherit',
					font: 'inherit',
					fontSize: 13,
					lineHeight: '18px',
					textAlign: 'left',
					cursor: 'pointer',
				} : {
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					width: 32,
					height: 32,
					padding: 0,
					border: 'none',
					borderRadius: 6,
					background,
					color: 'inherit',
					cursor: 'pointer',
				};

				const label = state === 'fail' ? '先打开一个会话' : (state === 'ok' ? '已打开' : TAB_TITLE);

				return h('button', {
					type: 'button',
					onClick: open,
					title: '在右侧栏打开知识库',
					'aria-label': '在右侧栏打开知识库',
					'data-dsh-obsidian': state,
					style,
					...hover,
				}, [
					h(CrystalIcon, { key: 'icon', size: wide ? 16 : 18 }),
					wide ? h('span', {
						key: 'label',
						style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
					}, label) : null,
				]);
			};
		}

		// ── the vault conversation tab ───────────────────────────────────────

		/** A transfer mark: the plan leaving this conversation for the other one. */
		function HandoffIcon(props) {
			return svg(props.size, null, [
				h('path', { key: 'a', d: 'M4 12h13' }),
				h('path', { key: 'b', d: 'm13 6 6 6-6 6' }),
				h('path', { key: 'c', d: 'M4 6v12' }),
			]);
		}

		// ── registration ─────────────────────────────────────────────────────

		/**
		 * Report one client-side failure to the host, which stores it.
		 *
		 * A client half has no filesystem and no log the author can read: a pane that
		 * throws simply goes blank. This is the only channel out of the browser.
		 * @param label - what failed.
		 * @param error - the thrown value.
		 */
		function reportClientError(label, error) {
			try {
				const detail = String(error && error.message ? error.message : error);
				console.error('[dsh-obsidian] ' + label + ': ' + detail, error);
				if (typeof fetch !== 'function') return;
				void fetch(API.diag, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						inject: INJECT,
						report: registrationReport,
						renderError: { label, detail, stack: String(error && error.stack ? error.stack : '') },
					}),
				}).catch(() => {});
			} catch (inner) {
				/* reporting must never be the thing that breaks */
			}
		}

		/**
		 * A pane must never go blank.
		 *
		 * The shell answers a throwing slot entry by ABDICATING it, which leaves the
		 * whole pane empty and says nothing anywhere. This boundary turns that into a
		 * visible message plus a report — and because it renders the real component as
		 * its CHILD, it also catches a throw from that component's own body and hooks.
		 */
		class RenderGuard extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error) {
				reportClientError(this.props.label ?? 'render', error);
			}

			render() {
				if (this.state.error !== null) {
					const detail = String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error);
					return h('div', {
						style: { padding: '14px 12px', fontSize: 12, lineHeight: 1.8, color: T.error },
					}, [
						h('div', { key: 't', style: { fontWeight: 600, marginBottom: 6 } }, String(this.props.label ?? '这个面板') + '渲染失败'),
						h('div', { key: 'd', style: { wordBreak: 'break-word' } }, detail),
					]);
				}
				return this.props.children;
			}
		}

		/** Wrap one slot entry so a throw shows up instead of blanking the pane. */
		function guarded(label, Component) {
			return function Guarded(props) {
				return h(RenderGuard, { label }, h(Component, props));
			};
		}

		/**
		 * What the client half managed to register.
		 *
		 * A client failure is otherwise invisible: the shell shows nothing and writes
		 * nothing the author can read. `apply` posts this to the host, which stores it
		 * somewhere it can be inspected without a browser console.
		 */
		const registrationReport = { ok: [], failed: [] };

		function guard(label, run) {
			try {
				const result = run();
				registrationReport.ok.push(label);
				return result;
			} catch (error) {
				console.error('[dsh-obsidian] ' + label + ' failed to register', error);
				registrationReport.failed.push({
					label,
					message: String(error && error.message ? error.message : error),
				});
				return undefined;
			}
		}

		/**
		 * Register everything, but never let one failure erase the rest.
		 *
		 * The shell answers a throwing `apply` by rolling back EVERY registration the
		 * plugin made, so a single bad registration costs the whole feature — the
		 * sidebar simply shows nothing from this plugin at all. Catching here keeps
		 * apply from throwing, which keeps the rollback from happening, and the error
		 * is logged loudly so it can be read in the browser console.
		 * @param ctx - the client context.
		 */
		function apply(ctx) {
			try {
				registerAll(ctx);
			} catch (error) {
				console.error('[dsh-obsidian] apply failed; the rest of the plugin stays registered', error);
				registrationReport.failed.push({
					label: 'apply',
					message: String(error && error.message ? error.message : error),
				});
			}
			// The client half's own account of itself, kept host-side where it can be
			// read. Diagnostics must never be able to break the plugin, hence the guard.
			try {
				if (typeof fetch === 'function') {
					void fetch(API.diag, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ inject: INJECT, report: registrationReport }),
					}).catch(() => {});
				}
			} catch (error) {
				/* diagnostics are best-effort */
			}
		}

		function registerAll(ctx) {
			if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
			if (typeof ctx.sidebarRightTabs.register !== 'function' || typeof ctx.sidebarRight.openTab !== 'function') {
				console.warn('[dsh-obsidian] right Sidebar services are unavailable; the notes tab stays unregistered');
				return;
			}

			// Stage one: what the tab type IS. `id` doubles as the body seat key.
			guard('the notes tab type', () => ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => TAB_TITLE,
			}), 'dsh-obsidian: notes tab type'));

			// Stage two: the body, keyed by that id.
			guard('the notes panel', () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
				name: TAB_SLOT,
				key: TAB_ID,
			}, guarded('知识库', makeNotesPanel(ctx)))));

			// Stage three: the row that opens it. This is the plugin's ONLY way in, so
			// it is registered last of the three stages for the panel to be usable by
			// the time the row exists.
			guard('the sidebar-foot row', () => ctx.slots.inject(FOOTER_SLOT, () => ctx.slots.register({
				name: FOOTER_SLOT,
				id: 'dsh-obsidian',
				order: 40,
				label: TAB_TITLE,
			}, makeOpenNotesAction(ctx))));

			// The note page: one tab type + one body, addressed by the note's
			// vault-relative path. Opening a note is a separate page from the tree.
			guard('the note tab type', () => ctx.effect(() => ctx.sidebarRightTabs.register({
				id: NOTE_TAB_ID,
				kind: NOTE_TAB_KIND,
				patterns: [NOTE_ADDRESS_PREFIX + '**'],
				priority: 'builtin',
				canOpen: (address) => parseNoteAddress(address) !== undefined,
				title: (address) => {
					const path = parseNoteAddress(address);
					return path === undefined ? '笔记' : String(path).split('/').pop();
				},
			}), 'dsh-obsidian: note tab type'));

			// The note page's body, keyed by that id. It declares no child: the
			// conversation is not this plugin's to lay out any more, so no surface here
			// declares a seat, and `ConversationButton` hands the Session to the
			// shell's own conversation panel instead.
			guard('the note page', () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
				name: TAB_SLOT,
				key: NOTE_TAB_ID,
			}, guarded('笔记页', makeNoteTab(ctx)))));

			// There is deliberately no `sidebar.panellist` / `main` registration here.
			// This plugin used to add a global panel icon for a full-width centre view
			// as well, which put a SECOND entry labelled 知识库 in the left sidebar
			// alongside the footer row. One entry per feature: the footer row below is
			// the way in.
		}

		exports.apply = apply;
		// Only services whose ABSENCE may keep the plugin off the page are listed.
		// `sessions` and `workspaces` used to be here, and that is what made the
		// "the conversation is unavailable while the tree still works" branch
		// unreachable: a profile without them held the entire entry back
		// ("1 entry did not activate"), so `apply` never ran and the sidebar lost the
		// plugin — tree included. Both are now looked up lazily through `ctx.get`.
		const INJECT = ['slots', 'sidebarRightTabs', 'sidebarRight'];
		// `uiWorkspace` is deliberately NOT in this list either, for the same reason:
		// it is looked up lazily in `chooseVault`, so a missing picker costs one
		// button instead of the whole plugin.
		exports.inject = INJECT;
		// Testing seam: lets a headless harness exercise the renderer without a
		// browser. The shell reads only `apply` and `inject`, and every member here is
		// READ by test/render-check.cjs or test/mount-check.cjs — nothing else.
		exports.__internals = {
			renderMarkdown,
			obsidianSlug,
			decodeFragment,
			matchHeading,
			splitBlockId,
			// Read by the harness to prove an unknown root is a refusal (`no-path`),
			// not an `@undefined` mention.
			mentionInto,
			ATTACH_MESSAGE,
			resolveVaultChatSession,
			// The resolver memoises one promise for the whole page; a harness that
			// needs to exercise a second resolution has to drop it first.
			resetVaultChatSession: () => { vaultChatTarget = undefined; },
			noteAddress,
			parseNoteAddress,
			fileMention,
			absoluteVaultPath,
			TAB_ID,
			TAB_KIND,
			NOTE_TAB_ID,
			NOTE_TAB_KIND,
			// The graph reader's pieces, asserted by render-check without a mount.
			parseProperties,
			linkStatus,
			backlinksOf,
			outlinksOf,
			previewOf,
			PropertiesCard,
			RelatedPanel,
			LinkPreview,
		};
		return module.exports;
	},
});
