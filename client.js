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
		 * nothing when the service is absent, so a missing Sessions/Workspaces costs
		 * the conversation box and nothing else.
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

		const MAX_RENDER_LINES = 3000;
		const SEARCH_DEBOUNCE_MS = 250;
		/** The DOM id every rendered heading carries, and the outline scrolls to. */
		const OUTLINE_ID_PREFIX = 'dsh-obsidian-outline-';
		/** Two note pages can be open at once, so each one numbers its own anchors. */
		let notePageSeq = 0;

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

		const INLINE = /(\[\[[^\]\n|]{1,200}(?:\|[^\]\n]{1,200})?\]\])|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\s]+\))/g;

		/** Inline spans: wikilinks, code, bold, strike, italic, links. */
		function renderInline(text, prefix, onLink) {
			const nodes = [];
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
					const target = bar >= 0 ? inner.slice(0, bar) : inner;
					const label = bar >= 0 ? inner.slice(bar + 1) : inner;
					if (typeof onLink === 'function') {
						// A link to another note, if a navigator is supplied: this is what
						// makes the note page's `[[wikilink]]`s clickable.
						nodes.push(h('button', {
							key,
							type: 'button',
							title: '打开 ' + target.trim(),
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								onLink(target.trim());
							},
							style: {
								color: T.brand,
								background: 'transparent',
								border: 'none',
								padding: 0,
								cursor: 'pointer',
								textDecoration: 'underline',
								font: 'inherit',
							},
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
					nodes.push(h('a', {
						key,
						href: link ? link[2] : '#',
						target: '_blank',
						rel: 'noopener noreferrer',
						// Obsidian underlines links by default.
						style: { color: T.brand, textDecoration: 'underline' },
					}, link ? link[1] : token));
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

		function isBlockStart(line) {
			return /^\s*$/.test(line)
				|| /^\s*```/.test(line)
				|| /^#{1,6}\s/.test(line)
				|| /^\s*>/.test(line)
				|| RE_UL_ITEM.test(line)
				|| RE_OL_ITEM.test(line)
				|| RE_RULE.test(line);
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
		 * @param idPrefix - anchor prefix for headings. Every heading carries its anchor
		 *   and its depth as DOM attributes, so the outline panel reads what was
		 *   actually rendered instead of parsing the note a second time.
		 */
		function renderMarkdown(text, onLink, idPrefix) {
			let lines = String(text).split(/\r?\n/);
			// Drop YAML frontmatter: it is metadata, not prose.
			if (lines[0] === '---') {
				const end = lines.indexOf('---', 1);
				if (end > 0) lines = lines.slice(end + 1);
			}
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
						}, renderInline(cell, 'th' + key + '-' + cellIndex, onLink))))),
						rows.length === 0 ? null : h('tbody', { key: 't' }, rows.map((row, rowIndex) => h('tr', { key: rowIndex },
							row.map((cell, cellIndex) => h('td', {
								key: cellIndex,
								style: cellStyle,
							}, renderInline(cell, 'td' + key + '-' + rowIndex + '-' + cellIndex, onLink)))))),
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
					}, renderInline(heading[2], 'h' + key, onLink)));
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
					blocks.push(h('blockquote', {
						key: 'b' + (key += 1),
						style: {
							margin: READ.block + ' 0',
							padding: '0 0 0 ' + READ.quotePad + 'px',
							borderLeft: READ.quoteRule + 'px solid ' + T.brand,
							color: 'inherit',
							fontStyle: 'normal',
						},
					}, renderInline(quoted.join(' '), 'q' + key, onLink)));
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
					}, items.map((item, itemIndex) => h('li', {
						key: itemIndex,
						style: { padding: READ.listPad + ' 0', lineHeight: READ.lineHeight },
					}, renderInline(item, 'li' + key + '-' + itemIndex, onLink)))));
					continue;
				}

				const paragraph = [];
				while (i < lines.length && !isBlockStart(lines[i]) && !tableStartsAt(i)) {
					paragraph.push(lines[i]);
					i += 1;
				}
				blocks.push(h('p', {
					key: 'b' + (key += 1),
					style: { margin: READ.block + ' 0', lineHeight: READ.lineHeight },
				}, renderInline(paragraph.join(' '), 'p' + key, onLink)));
			}

			return blocks;
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

		// Memoised: a pointermove on the conversation grip re-renders the panel, and
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
				const navigate = React.useCallback((target) => {
					getJson(API.resolve + '?name=' + encodeURIComponent(target)).then((data) => {
						const found = Array.isArray(data.matches) && data.matches.length > 0
							? data.matches[0].path
							: (typeof data.path === 'string' ? data.path : undefined);
						if (found === undefined) {
							keepFeedback('找不到笔记：' + target, 3200);
							return;
						}
						ctx.sidebarRight.openResource(noteAddress(found));
					}).catch(() => { keepFeedback('无法解析链接：' + target, 3200); });
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

				// Memoised: dragging the conversation grip re-renders this page on every
				// pointermove, and re-parsing the whole note each time is the one
				// expensive thing here. Only the note (or the link navigator) can change
				// what the Markdown becomes.
				const renderedMarkdown = React.useMemo(
					() => (note === null ? null : renderMarkdown(note.text, navigate, outlineAnchors)),
					[note, navigate, outlineAnchors],
				);

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

				const body = error !== ''
					? h('div', { style: { padding: 16, color: T.error, fontSize: 12.5 } }, error)
					: note === null
						? h('div', {
							style: { padding: 16, fontSize: 12, color: T.labelSecondary },
						}, loading ? '读取笔记中…' : '')
						: editing
							? h('textarea', {
								key: 'edit',
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
									// The SAME box as the reading view: entering edit mode must not
									// reflow the page the reader was just looking at. A monospace
									// 13px editor against a 16px proportional reading view made the
									// text jump, the line breaks move, and the page read as a
									// different document — the mode change was visible before a
									// single character was typed.
									padding: '18px 22px 96px',
									background: 'transparent',
									color: 'inherit',
									fontFamily: 'inherit',
									fontSize: READ.size,
									lineHeight: READ.lineHeight,
								},
							})
							: h('div', {
								key: 'read',
								// Obsidian's reading-view metrics: the base size and line height
								// every ratio inside `renderMarkdown` is expressed against.
								style: {
									padding: '18px 22px 96px',
									fontSize: READ.size,
									lineHeight: READ.lineHeight,
								},
							}, [
								h('div', {
									key: 'meta',
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
								]),
								h('div', { key: 'md' }, renderedMarkdown),
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
		// conversation box's degradation branch unreachable: a profile without them
		// held the entire entry back ("1 entry did not activate"), so `apply` never
		// ran and the sidebar lost the plugin — tree included. Both are now looked up
		// lazily through `ctx.get`.
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
		};
		return module.exports;
	},
});
