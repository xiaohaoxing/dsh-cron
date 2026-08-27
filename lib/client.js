/**
 * @walltech/dsh-cron — browser half (P1 scheduled-task UI).
 *
 * Authored directly in the client-modules bundle format (the same
 * `window.__ModuleLoader__.load` wrapper the framework's built bundles use),
 * so no build step is required: this file is served verbatim at
 * `/plugins/@walltech/dsh-cron/client.js`.
 *
 * Registers a "已安排" (Scheduled) list into three official framework slots:
 *   - `conversation.session.header.actions` — header button opening the page
 *   - `sidebar.footer.action`                — footer button (wide + rail) opening the page
 *   - `shell.overlay`                        — the standalone page itself (full job list)
 *
 * Data comes from the host half's REST bridge (`/cron-api/jobs`) with a live
 * SSE channel (`/cron-api/events`) plus a 30s polling fallback.
 */
window.__ModuleLoader__.load({
	id: "@walltech/dsh-cron",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const {
			IconCloseOutline16,
			IconListPenOutline16,
			IconLoadingOutline16,
			IconPauseOutline16,
			IconPlayOutline16,
			IconPlusOutline16,
			IconRefreshOutline14,
			IconTrashOutline16,
			IconWarningOutline16
		} = primitives;

		//#region styles
		const CSS = [
			".dshc-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:4px;padding:3px 6px;font-size:12px;line-height:18px;display:inline-flex}",
			".dshc-trigger:hover,.dshc-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}",
			".dshc-triggerLabel{white-space:nowrap}",
			".dshc-count{margin:0 2px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
			".dshc-countOverdue{color:var(--dsw-alias-warning-strong)}",
			".dshc-overlay{position:fixed;inset:0;z-index:1000;pointer-events:auto;align-items:center;justify-content:center;padding:24px;display:flex}",
			".dshc-overlayMask{position:absolute;inset:0;background:rgba(0,0,0,.32)}",
			".dshc-overlayPanel{position:relative;box-sizing:border-box;width:min(680px,100%);max-height:min(720px,100%);background:var(--dsw-specific-menu);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);border-radius:16px;flex-direction:column;overflow:hidden;display:flex}",
			".dshc-overlayHeader{flex:none;display:flex;align-items:center;gap:8px;padding:14px 16px 10px;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}",
			".dshc-overlayTitle{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			// Stack the sidebar footer actions vertically in wide mode (each
			// plugin's footer entry — e.g. Remote, 已安排 — becomes its own row;
			// Settings sits below in its own seat). Framework minified class
			// (`@deepseek-ai/dsh-client-ui-sidebar`); re-check on framework upgrade.
			".hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions{align-items:stretch;flex-direction:column}",
			".dshc-spacer{flex:1}",
			".dshc-iconButton{min-width:24px;min-height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;justify-content:center;padding:0;display:inline-flex}",
			".dshc-iconButton:hover,.dshc-iconButton:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-hover)}",
			".dshc-scroll{flex:1;overflow:auto;padding:2px}",
			".dshc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}",
			".dshc-row{box-sizing:border-box;width:100%;border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:4px}",
			".dshc-row:hover{background:var(--dsw-alias-fill-hover)}",
			".dshc-rowLine{display:flex;align-items:center;gap:8px;min-width:0}",
			".dshc-title{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:18px;white-space:nowrap;text-overflow:ellipsis;flex:1;overflow:hidden}",
			".dshc-label{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono);font-size:11px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;flex:1;overflow:hidden}",
			".dshc-chip{flex:none;border-radius:5px;padding:0 6px;font-size:11px;line-height:18px}",
			".dshc-chipScheduled{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary)}",
			".dshc-chipOverdue{background:var(--dsw-alias-warning-bg);color:var(--dsw-alias-warning-strong)}",
			".dshc-chipDisabled{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-tertiary)}",
			".dshc-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;display:flex;align-items:center;gap:10px;min-width:0}",
			".dshc-metaItem{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			".dshc-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".dshc-empty{padding:18px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;text-align:center}",
			".dshc-error{padding:12px;color:var(--dsw-alias-error-strong);font-size:12px;line-height:18px;display:flex;align-items:center;gap:6px}",
			".dshc-foot{padding:6px 8px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;text-align:center}"
		].join("");
		const tagId = "@walltech/dsh-cron/cronlist.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@walltech/dsh-cron";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region data
		/** Fetch one JSON payload, throwing on transport or non-2xx responses. */
		async function apiJson(path, options) {
			const res = await fetch(path, {
				headers: { accept: "application/json", ...(options && options.body ? { "content-type": "application/json" } : {}) },
				...options
			});
			let payload = null;
			try {
				payload = await res.json();
			} catch {}
			if (!res.ok) throw new Error((payload && typeof payload.message === "string" ? payload.message : "HTTP " + res.status));
			return payload;
		}

		/** Live job list: initial fetch + SSE + 30s polling + focus refetch. */
		function useCron() {
			const [state, setState] = react.useState({ jobs: null, timezone: null, error: null });
			const reload = react.useCallback(async () => {
				try {
					const body = await apiJson("/cron-api/jobs");
					if (!body || !Array.isArray(body.jobs)) throw new Error("bad payload");
					setState({ jobs: body.jobs, timezone: typeof body.timezone === "string" ? body.timezone : null, error: null });
				} catch (error) {
					setState((s) => ({ ...s, error: String((error && error.message) || error) }));
				}
			}, []);
			react.useEffect(() => {
				reload();
				const interval = setInterval(reload, 30000);
				const onFocus = () => reload();
				window.addEventListener("focus", onFocus);
				let es = null;
				try {
					es = new EventSource("/cron-api/events");
					es.addEventListener("change", reload);
					es.addEventListener("run", reload);
				} catch {}
				return () => {
					clearInterval(interval);
					window.removeEventListener("focus", onFocus);
					if (es !== null) es.close();
				};
			}, [reload]);
			return { ...state, reload };
		}

		async function mutate(path, method, body) {
			const payload = await apiJson(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
			return payload;
		}
		//#endregion

		//#region formatting
		const MINUTE_MS = 60000;
		const HOUR_MS = 3600000;
		const DAY_MS = 86400000;

		/** Relative wall-clock label; null when no timestamp is present. */
		function relative(iso, now, t) {
			if (typeof iso !== "string" || iso.length === 0) return null;
			const ms = Date.parse(iso) - now;
			const abs = Math.abs(ms);
			let key;
			let params = {};
			if (abs < MINUTE_MS) key = "time.now";
			else if (abs < HOUR_MS) {
				key = ms >= 0 ? "time.inMinutes" : "time.minutesAgo";
				params = { n: Math.round(abs / MINUTE_MS) };
			} else if (abs < DAY_MS) {
				key = ms >= 0 ? "time.inHours" : "time.hoursAgo";
				params = { n: Math.round(abs / HOUR_MS) };
			} else {
				key = ms >= 0 ? "time.inDays" : "time.daysAgo";
				params = { n: Math.round(abs / DAY_MS) };
			}
			return t(key, params);
		}
		//#endregion

		//#region components
		/**
		 * Shared job mutations (pause/resume toggle, delete) used by the
		 * popover list.
		 */
		function useJobActions(reload, t) {
			const [busy, setBusy] = react.useState(null);
			const [mutError, setMutError] = react.useState(null);
			const stateError = (e) => setMutError(String((e && e.message) || e));
			const toggle = async (job) => {
				if (busy !== null) return;
				setBusy(job.id);
				try {
					await mutate("/cron-api/jobs/" + encodeURIComponent(job.id), "PATCH", { enabled: !job.enabled });
					await reload();
				} catch (e) {
					stateError(e);
				} finally {
					setBusy(null);
				}
			};
			const remove = async (job) => {
				if (busy !== null) return;
				if (!window.confirm(t("delete.confirm", { title: job.title }))) return;
				setBusy(job.id);
				try {
					await mutate("/cron-api/jobs/" + encodeURIComponent(job.id), "DELETE");
					await reload();
				} catch (e) {
					stateError(e);
				} finally {
					setBusy(null);
				}
			};
			return { busy, mutError, toggle, remove };
		}

		/**
		 * Shared list body: loading spinner, error rows, empty state and the job
		 * rows themselves. Rendered inside the popover's scroll region.
		 */
		function JobListContent({ jobs, jobsList, timezone, error, mutError, busy, now, toggle, remove, t }) {
			return react_jsx_runtime.jsx("div", {
				className: "dshc-scroll",
				children: [
					error !== null && react_jsx_runtime.jsx("div", {
						className: "dshc-error",
						children: [react_jsx_runtime.jsx(IconWarningOutline16, { size: 14 }), react_jsx_runtime.jsx("span", { children: t("error") })]
					}),
					mutError !== null && react_jsx_runtime.jsx("div", {
						className: "dshc-error",
						children: [react_jsx_runtime.jsx(IconWarningOutline16, { size: 14 }), react_jsx_runtime.jsx("span", { children: mutError })]
					}),
					jobs === null && error === null && react_jsx_runtime.jsx("div", {
						className: "dshc-empty",
						children: react_jsx_runtime.jsx(IconLoadingOutline16, { size: 16 })
					}),
					jobs !== null && jobsList.length === 0 && react_jsx_runtime.jsx("div", {
						className: "dshc-empty",
						children: [react_jsx_runtime.jsx("div", { children: t("empty") }), react_jsx_runtime.jsx("div", { children: t("empty.hint") })]
					}),
					jobs !== null && jobsList.length > 0 && react_jsx_runtime.jsx("ul", {
						className: "dshc-list",
						children: jobsList.map((job) => react_jsx_runtime.jsx("li", {
							className: "dshc-row",
							children: [
								react_jsx_runtime.jsx("div", {
									className: "dshc-rowLine",
									children: [
										react_jsx_runtime.jsx("span", { className: "dshc-title", title: job.title, children: job.title }),
										react_jsx_runtime.jsx("span", {
											className: "dshc-chip dshc-chip" + (job.state === "overdue" ? "Overdue" : job.state === "disabled" ? "Disabled" : "Scheduled"),
											children: t("state." + job.state)
										})
									]
								}),
								react_jsx_runtime.jsx("div", {
									className: "dshc-rowLine",
									children: [
										react_jsx_runtime.jsx("span", { className: "dshc-label", title: job.schedule.expression, children: job.label }),
										react_jsx_runtime.jsx("span", {
											className: "dshc-label",
											children: timezone !== null && timezone !== job.schedule.timezone ? job.schedule.timezone : ""
										}),
										react_jsx_runtime.jsx("span", { className: "dshc-actions", children: [
											react_jsx_runtime.jsx("button", {
												type: "button",
												className: "dshc-iconButton",
												"aria-label": t(job.enabled ? "pause.aria" : "resume.aria"),
												title: t(job.enabled ? "pause.aria" : "resume.aria"),
												disabled: busy === job.id,
												onClick: () => toggle(job),
												children: react_jsx_runtime.jsx(job.enabled ? IconPauseOutline16 : IconPlayOutline16, { size: 14 })
											}),
											react_jsx_runtime.jsx("button", {
												type: "button",
												className: "dshc-iconButton",
												"aria-label": t("delete.aria"),
												title: t("delete.aria"),
												disabled: busy === job.id,
												onClick: () => remove(job),
												children: react_jsx_runtime.jsx(IconTrashOutline16, { size: 14 })
											})
										] })
									]
								}),
								react_jsx_runtime.jsx("div", {
									className: "dshc-meta",
									children: [
										react_jsx_runtime.jsx("span", {
											className: "dshc-metaItem",
											children: job.nextRunAt !== null ? t("next", { when: relative(job.nextRunAt, now, t) ?? "" }) : t("next.none")
										}),
										react_jsx_runtime.jsx("span", {
											className: "dshc-metaItem",
											children: job.lastRunAt !== null ? t("last", { when: relative(job.lastRunAt, now, t) ?? "" }) : t("last.never")
										})
									]
								})
							]
						}, job.id))
					})
				]
			});
		}
		//#region overlay store
		/**
		 * Module-scoped open state shared by the header/footer triggers and the
		 * `shell.overlay` page (all three registrations live in this bundle).
		 * Closure state (no `this`): React calls `subscribe`/`getSnapshot` as
		 * plain functions, where `this` would be undefined under strict mode.
		 */
		const overlayStore = (() => {
			let open = false;
			const listeners = new Set();
			return {
				setOpen(value) {
					if (open === value) return;
					open = value;
					for (const listener of listeners) listener();
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot() {
					return open;
				}
			};
		})();
		//#endregion

		/**
		 * "已安排" trigger button (header actions + sidebar footer). Shows the
		 * icon (+ label in wide columns) and the enabled/overdue count; clicking
		 * opens the standalone page (`shell.overlay`).
		 */
		function CronTrigger({ t, wide }) {
			const open = react.useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot);
			const { jobs, timezone, error, reload } = useCron();
			const jobsList = jobs === null ? [] : jobs;
			const enabledCount = jobsList.filter((job) => job.enabled).length;
			const overdueCount = jobsList.filter((job) => job.state === "overdue").length;
			return react_jsx_runtime.jsx("button", {
				type: "button",
				className: "dshc-trigger",
				"aria-label": t("trigger.aria"),
				"aria-expanded": open,
				onClick: () => overlayStore.setOpen(true),
				children: [
					react_jsx_runtime.jsx(IconListPenOutline16, { size: 16 }),
					wide === true && react_jsx_runtime.jsx("span", { className: "dshc-triggerLabel", children: t("trigger.label") }),
					enabledCount > 0 && react_jsx_runtime.jsx("span", {
						className: "dshc-count" + (overdueCount > 0 ? " dshc-countOverdue" : ""),
						children: String(enabledCount)
					})
				]
			});
		}

		/**
		 * Standalone "已安排" page: a frame-wide surface (official `shell.overlay`
		 * list slot) listing every scheduled job with pause/resume/delete. Renders
		 * null while closed; the header/footer triggers open it via the store.
		 */
		function CronOverlay({ t }) {
			const open = react.useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot);
			const { jobs, timezone, error, reload } = useCron();
			const { busy, mutError, toggle, remove } = useJobActions(reload, t);
			const jobsList = jobs === null ? [] : jobs;
			const enabledCount = jobsList.filter((job) => job.enabled).length;
			const overdueCount = jobsList.filter((job) => job.state === "overdue").length;
			const now = Date.now();

			react.useEffect(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key === "Escape") overlayStore.setOpen(false);
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open]);

			if (!open) return null;
			return react_jsx_runtime.jsx("div", {
				className: "dshc-overlay",
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dshc-overlayMask",
						onClick: () => overlayStore.setOpen(false)
					}),
					react_jsx_runtime.jsx("div", {
						className: "dshc-overlayPanel",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": t("menu.title"),
						children: [
							react_jsx_runtime.jsx("div", {
								className: "dshc-overlayHeader",
								children: [
									react_jsx_runtime.jsx("span", { className: "dshc-overlayTitle", children: t("menu.title") }),
									enabledCount > 0 && react_jsx_runtime.jsx("span", {
										className: "dshc-count" + (overdueCount > 0 ? " dshc-countOverdue" : ""),
										children: String(enabledCount)
									}),
									react_jsx_runtime.jsx("span", { className: "dshc-spacer" }),
									react_jsx_runtime.jsx("button", {
										type: "button",
										className: "dshc-iconButton",
										"aria-label": t("refresh.aria"),
										title: t("refresh.aria"),
										onClick: reload,
										children: react_jsx_runtime.jsx(IconRefreshOutline14, { size: 14 })
									}),
									react_jsx_runtime.jsx("button", {
										type: "button",
										className: "dshc-iconButton",
										"aria-label": t("close.aria"),
										title: t("close.aria"),
										onClick: () => overlayStore.setOpen(false),
										children: react_jsx_runtime.jsx(IconCloseOutline16, { size: 14 })
									})
								]
							}),
							react_jsx_runtime.jsx(JobListContent, {
								jobs,
								jobsList,
								timezone,
								error,
								mutError,
								busy,
								now,
								toggle,
								remove,
								t
							}),
							react_jsx_runtime.jsx("div", {
								className: "dshc-foot",
								children: [react_jsx_runtime.jsx(IconPlusOutline16, { size: 12 }), " ", t("empty.hint")]
							})
						]
					})
				]
			});
		}
		//#endregion

		//#region locales
		const zh = {
			"trigger.aria": "已安排",
			"trigger.label": "已安排",
			"menu.title": "已安排",
			"refresh.aria": "刷新",
			"close.aria": "关闭",
			"pause.aria": "暂停",
			"resume.aria": "恢复",
			"delete.aria": "删除",
			"delete.confirm": "删除定时任务「{title}」？",
			"empty": "暂无定时任务",
			"empty.hint": "在对话中描述任务即可创建，例如：每天早上 9 点跑回归测试",
			"error": "加载失败",
			"state.scheduled": "运行中",
			"state.overdue": "已过期",
			"state.disabled": "已暂停",
			"next": "下次 {when}",
			"next.none": "无下次运行",
			"last": "上次 {when}",
			"last.never": "尚未运行",
			"time.now": "刚刚",
			"time.inMinutes": "{n} 分钟后",
			"time.minutesAgo": "{n} 分钟前",
			"time.inHours": "{n} 小时后",
			"time.hoursAgo": "{n} 小时前",
			"time.inDays": "{n} 天后",
			"time.daysAgo": "{n} 天前"
		};
		const en = {
			"trigger.aria": "Scheduled",
			"trigger.label": "Scheduled",
			"menu.title": "Scheduled",
			"refresh.aria": "Refresh",
			"close.aria": "Close",
			"pause.aria": "Pause",
			"resume.aria": "Resume",
			"delete.aria": "Delete",
			"delete.confirm": "Delete scheduled task “{title}”?",
			"empty": "No scheduled tasks",
			"empty.hint": "Describe a task in chat to create it, e.g. “run the regression test at 9am daily”",
			"error": "Failed to load",
			"state.scheduled": "Active",
			"state.overdue": "Overdue",
			"state.disabled": "Paused",
			"next": "Next {when}",
			"next.none": "No next run",
			"last": "Last {when}",
			"last.never": "Never run",
			"time.now": "just now",
			"time.inMinutes": "in {n} min",
			"time.minutesAgo": "{n} min ago",
			"time.inHours": "in {n} h",
			"time.hoursAgo": "{n} h ago",
			"time.inDays": "in {n} d",
			"time.daysAgo": "{n} d ago"
		};
		//#endregion

		/** Dictionary namespace owned by this plugin. */
		const NS = "cron";

		/** Required client services (informational module-graph edges). */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register the dictionaries and the slot entries.
		 * - conversation.session.header.actions — trigger button (header)
		 * - sidebar.footer.action               — trigger button beside Settings (wide + rail)
		 * - shell.overlay                       — the standalone "已安排" page
		 * All three are official framework slots; no sidebar fork is required.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-cron: dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "cron-scheduled",
				order: 30,
				locale: NS
			}, CronTrigger));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "cron-scheduled",
				order: 20,
				locale: NS
			}, CronTrigger));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "cron-scheduled-page",
				order: 10,
				locale: NS
			}, CronOverlay));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
