/**
 * @walltech/dsh-cron — browser half (P1 scheduled-task UI).
 *
 * Authored directly in the client-modules bundle format (the same
 * `window.__ModuleLoader__.load` wrapper the framework's built bundles use),
 * so no build step is required: this file is served verbatim at
 * `/plugins/@walltech/dsh-cron/client.js`.
 *
 * Registers a "已安排" (Scheduled) surface into three official framework slots:
 *   - `conversation.session.header.actions` — header button opening the page
 *   - `sidebar.footer.action`                — footer button (wide + rail) opening the page
 *   - `shell.overlay`                        — the standalone page itself
 *
 * Page (aligned with Codex's Scheduled UX):
 *   - full job list with 全部 / 已开启 / 已暂停 filter tabs
 *   - two common-schedule suggestions under the list (one-click prefill)
 *   - per-row pause/resume + delete, row click opens a detail drawer
 *   - detail drawer: editable prompt, run target (new/existing chat),
 *     project, model, reasoning, frequency (cron + presets), notification,
 *     run history (last 5), delete
 *   - top-right create button opening the same form in create mode
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
			// Full-screen standalone page (the `shell.overlay` layer is a
			// frame-wide overlay already; we fill it completely instead of a
			// centered modal, mirroring Codex's Scheduled page).
			".dshc-page{position:fixed;inset:0;z-index:1000;box-sizing:border-box;background:var(--dsw-alias-bg-base);flex-direction:column;display:flex}",
			".dshc-pageHeader{flex:none;display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}",
			".dshc-pageHeader .dshc-overlayTitle,.dshc-drawerHeader .dshc-overlayTitle{min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			".dshc-pageBody{flex:1;min-height:0;display:flex;align-items:stretch}",
			".dshc-pageList{flex:1;min-width:0;display:flex;flex-direction:column}",
			// Drawer is a flex sibling column of the list (right side), not an
			// overlay, so the page scrolls and resizes naturally. Slide-in on
			// mount (animation), slide-out before unmount (closing class +
			// transition driven by useDrawerClose).
			".dshc-pageDrawer{flex:none;width:min(540px,44%);box-sizing:border-box;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);flex-direction:column;display:flex;transform:translateX(0);transition:transform .16s ease-out}",
			"@keyframes dshcDrawerIn{from{transform:translateX(100%)}to{transform:translateX(0)}}",
			".dshc-pageDrawer:not(.dshc-pageDrawerClosing){animation:dshcDrawerIn .16s ease-out}",
			".dshc-pageDrawerClosing{transform:translateX(100%)}",
			// Stack the sidebar footer actions vertically in wide mode (each
			// plugin's footer entry — e.g. Remote, 已安排 — becomes its own row;
			// Settings sits below in its own seat). Framework minified class
			// (`@deepseek-ai/dsh-client-ui-sidebar`); re-check on framework upgrade.
			".hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions{align-items:stretch;flex-direction:column}",
			".dshc-spacer{flex:1}",
			".dshc-iconButton{min-width:24px;min-height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;justify-content:center;padding:0;display:inline-flex}",
			".dshc-iconButton:hover,.dshc-iconButton:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-hover)}",
			".dshc-textButton{flex:none;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 12px;font-size:12px;line-height:26px;color:var(--dsw-alias-label-primary);cursor:pointer;background:var(--dsw-alias-fill-l2);display:inline-flex;align-items:center;justify-content:center;gap:6px}",
			".dshc-textButton:hover{background:var(--dsw-alias-fill-hover)}",
			".dshc-textButtonPrimary{color:#fff;background:var(--dsw-alias-accent);border-color:transparent}",
			".dshc-textButtonPrimary:hover:not(:disabled){background:var(--dsw-alias-accent-hover)}",
			".dshc-textButtonDanger{color:var(--dsw-alias-error-strong);border-color:var(--dsw-alias-error-strong)}",
			".dshc-textButton:disabled{opacity:.55;cursor:default}",
			".dshc-tabs{flex:none;display:flex;gap:4px;padding:0 16px 6px}",
			".dshc-tab{border:0;background:0 0;border-radius:6px;padding:3px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
			".dshc-tab:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-hover)}",
			".dshc-tabActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2)}",
			".dshc-scroll{flex:1;overflow:auto;padding:2px}",
			".dshc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}",
			".dshc-row{box-sizing:border-box;width:100%;border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:4px;cursor:pointer}",
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
			".dshc-foot{padding:6px 8px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;text-align:center}",
			".dshc-suggests{flex:none;display:flex;gap:8px;padding:4px 16px 10px}",
			".dshc-suggest{flex:1;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;cursor:pointer;background:0 0;display:flex;flex-direction:column;gap:2px;text-align:left;min-width:0}",
			".dshc-suggest:hover{border-color:var(--dsw-alias-accent);background:var(--dsw-alias-fill-hover)}",
			".dshc-suggestTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			".dshc-suggestDesc{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
			".dshc-drawerHeader{flex:none;display:flex;align-items:center;gap:8px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}",
			".dshc-drawerBody{flex:1;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:14px}",
			".dshc-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".dshc-fieldLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
			".dshc-fieldHint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}",
			".dshc-input,.dshc-sel{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;padding:5px 8px;min-width:0}",
			".dshc-input:focus,.dshc-sel:focus{outline:none;border-color:var(--dsw-alias-accent)}",
			".dshc-textarea{width:100%;box-sizing:border-box;min-height:110px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);font-size:12px;line-height:18px;padding:6px 8px}",
			".dshc-textarea:focus{outline:none;border-color:var(--dsw-alias-accent)}",
			".dshc-chips{display:flex;flex-wrap:wrap;gap:6px}",
			".dshc-chipBtn{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0}",
			".dshc-chipBtn:hover{border-color:var(--dsw-alias-accent);color:var(--dsw-alias-label-primary)}",
			".dshc-history{display:flex;flex-direction:column;gap:4px}",
			".dshc-historyItem{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-size:11px;line-height:16px;min-width:0}",
			".dshc-historyMeta{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary)}",
			".dshc-historyOk{color:var(--dsw-alias-success-strong)}",
			".dshc-historyFail{color:var(--dsw-alias-error-strong)}",
			".dshc-historySub{color:var(--dsw-alias-label-tertiary);word-break:break-all}",
			".dshc-saveRow{flex:none;display:flex;align-items:center;gap:8px;justify-content:flex-end;padding-top:2px}",
			".dshc-staticRow{display:flex;align-items:center;gap:8px;min-width:0}",
			".dshc-staticValue{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}"
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

		/**
		 * Host workspaces service (`workspaces` client service, provided by
		 * dsh-client-runtime). Filled in `apply` once the fiber injects it; the
		 * job form uses it to pick an existing workspace or adopt a new one.
		 * @type {{ list: { getSnapshot: () => { items: Array<{ workspaceId: string, title: string, path: string, sessionIds: string[], createdAt: string }> }, subscribe: (fn: () => void) => () => void }, refresh?: () => void, create: (input: { path: string }) => Promise<{ ok: boolean, value?: { workspace: object }, error?: object }> } | null}
		 */
		let workspacesSvc = null;
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

		function absoluteTime(iso) {
			if (typeof iso !== "string" || iso.length === 0) return "";
			const d = new Date(iso);
			const pad = (v) => String(v).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		/**
		 * Minimal human-readable description of a 5-field cron expression,
		 * good enough for live frequency preview in the drawer. Falls back to
		 * the raw expression for anything unusual.
		 */
		function describeSimple(expression, locale) {
			const parts = String(expression).trim().split(/\s+/);
			if (parts.length !== 5) return expression;
			const [min, hour, dom, mon, dow] = parts;
			const star = (v) => v === "*";
			const plain = (v) => /^\d+$/.test(v);
			const stepOf = (v) => (v.startsWith("*/") ? parseInt(v.slice(2), 10) : null);
			const pad = (v) => String(v).padStart(2, "0");
			const days = ["日", "一", "二", "三", "四", "五", "六"];
			const zh = locale !== "en";
			if (star(min) && star(hour)) return zh ? "每分钟" : "every minute";
			if (plain(min) && star(hour) && star(dom) && star(mon) && star(dow)) return zh ? `每小时 ${pad(min)} 分` : `every hour at minute ${min}`;
			if (plain(min) && plain(hour) && star(dom) && star(mon) && star(dow)) return zh ? `每天 ${pad(hour)}:${pad(min)}` : `daily at ${pad(hour)}:${pad(min)}`;
			if (plain(min) && plain(hour) && star(dom) && star(mon) && plain(dow)) return zh ? `每周${days[Number(dow)]} ${pad(hour)}:${pad(min)}` : `weekly on ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(dow)]} at ${pad(hour)}:${pad(min)}`;
			if (plain(min) && plain(hour) && plain(dom) && star(mon) && star(dow)) return zh ? `每月 ${dom} 日 ${pad(hour)}:${pad(min)}` : `monthly on day ${dom} at ${pad(hour)}:${pad(min)}`;
			const mstep = stepOf(min);
			const hstep = stepOf(hour);
			if (mstep !== null && star(hour) && star(dom) && star(mon) && star(dow)) return zh ? `每 ${mstep} 分钟` : `every ${mstep} minutes`;
			if (hstep !== null && star(min) && star(dom) && star(mon) && star(dow)) return zh ? `每 ${hstep} 小时` : `every ${hstep} hours`;
			return expression;
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
		 * rows themselves. Rows are clickable (open the detail drawer); the
		 * inline action buttons stop propagation.
		 */
		function JobListContent({ jobs, jobsList, timezone, error, mutError, busy, now, toggle, remove, onOpen, t }) {
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
							onClick: () => onOpen(job),
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
												onClick: (e) => { e.stopPropagation(); toggle(job); },
												children: react_jsx_runtime.jsx(job.enabled ? IconPauseOutline16 : IconPlayOutline16, { size: 14 })
											}),
											react_jsx_runtime.jsx("button", {
												type: "button",
												className: "dshc-iconButton",
												"aria-label": t("delete.aria"),
												title: t("delete.aria"),
												disabled: busy === job.id,
												onClick: (e) => { e.stopPropagation(); remove(job); },
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

		/** Filter tabs: 全部 / 已开启 / 已暂停. */
		function CronTabs({ active, counts, onChange, t }) {
			const tabs = [
				{ key: "all", label: t("tab.all") },
				{ key: "enabled", label: t("tab.enabled") },
				{ key: "disabled", label: t("tab.disabled") }
			];
			return react_jsx_runtime.jsx("div", {
				className: "dshc-tabs",
				children: tabs.map((tab) => react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dshc-tab" + (active === tab.key ? " dshc-tabActive" : ""),
					onClick: () => onChange(tab.key),
					children: `${tab.label}${counts[tab.key] > 0 ? ` (${counts[tab.key]})` : ""}`
				}, tab.key))
			});
		}

		/** Two common-schedule suggestions; clicking prefills the create form. */
		function CronSuggestions({ onPick, t }) {
			const items = [
				{ key: "morning", title: t("sugg.morning"), expression: "0 9 * * *" },
				{ key: "evening", title: t("sugg.evening"), expression: "0 21 * * *" }
			];
			return react_jsx_runtime.jsx("div", {
				className: "dshc-suggests",
				children: items.map((item) => react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dshc-suggest",
					onClick: () => onPick(item.expression),
					children: [
						react_jsx_runtime.jsx("span", { className: "dshc-suggestTitle", children: item.title }),
						react_jsx_runtime.jsx("span", { className: "dshc-suggestDesc", children: item.expression })
					]
				}, item.key))
			});
		}

		/** Small labelled form field. */
		function Field({ label, hint, children }) {
			return react_jsx_runtime.jsx("label", {
				className: "dshc-field",
				children: [
					label !== undefined && label !== null && react_jsx_runtime.jsx("span", { className: "dshc-fieldLabel", children: label }),
					children,
					hint !== undefined && hint !== null && react_jsx_runtime.jsx("span", { className: "dshc-fieldHint", children: hint })
				]
			});
		}

		/** Frequency preset chips row. */
		function FrequencyPresets({ onPick, t }) {
			const presets = [
				{ key: "hourly", label: t("preset.hourly"), expression: "0 * * * *" },
				{ key: "daily9", label: t("preset.daily9"), expression: "0 9 * * *" },
				{ key: "daily21", label: t("preset.daily21"), expression: "0 21 * * *" },
				{ key: "monday", label: t("preset.monday"), expression: "0 9 * * 1" },
				{ key: "monthly", label: t("preset.monthly"), expression: "0 9 1 * *" }
			];
			return react_jsx_runtime.jsx("div", {
				className: "dshc-chips",
				children: presets.map((preset) => react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dshc-chipBtn",
					onClick: () => onPick(preset.expression),
					children: preset.label
				}, preset.key))
			});
		}

		/** Run history list (latest 5 runs). */
		function RunHistory({ history, t }) {
			if (history === undefined || history.length === 0) {
				return react_jsx_runtime.jsx("div", { className: "dshc-fieldHint", children: t("history.empty") });
			}
			return react_jsx_runtime.jsx("div", {
				className: "dshc-history",
				children: history.map((run) => react_jsx_runtime.jsx("div", {
					className: "dshc-historyItem",
					children: [
						react_jsx_runtime.jsx("div", {
							className: "dshc-historyMeta",
							children: [
								react_jsx_runtime.jsx("span", { className: run.status === "ok" ? "dshc-historyOk" : "dshc-historyFail", children: run.status === "ok" ? t("history.ok") : t("history.failed") }),
								react_jsx_runtime.jsx("span", { children: absoluteTime(run.runAt) })
							]
						}),
						typeof run.sessionId === "string" && run.sessionId.length > 0 && react_jsx_runtime.jsx("span", { className: "dshc-historySub", children: run.sessionId }),
						typeof run.error === "string" && run.error.length > 0 && react_jsx_runtime.jsx("span", { className: "dshc-historySub", children: run.error })
					]
				}, run.runAt + (run.sessionId ?? "")))
			});
		}

		/**
		 * Shared edit/create form body. `initial` seeds the fields; `mode` is
		 * "edit" or "create"; `onSubmit(payload)` receives the patch/body.
		 */
		function JobForm({ initial, mode, timezone, t, onSubmit, onCancel, onDelete, submitting }) {
			const [prompt, setPrompt] = react.useState(initial.prompt);
			const [title, setTitle] = react.useState(initial.title ?? "");
			const [kind, setKind] = react.useState(initial.target && initial.target.kind ? initial.target.kind : "new-chat");
			const [sessionId, setSessionId] = react.useState((initial.target && initial.target.sessionId) || "");
			const [project, setProject] = react.useState((initial.target && initial.target.project) || "");
			const [provider, setProvider] = react.useState((initial.target && initial.target.provider) || "");
			const [model, setModel] = react.useState((initial.target && initial.target.model) || "");
			const [effort, setEffort] = react.useState((initial.target && initial.target.reasoningEffort) || "");
			const [expr, setExpr] = react.useState(initial.schedule && initial.schedule.expression ? initial.schedule.expression : "");
			const [tz, setTz] = react.useState((initial.schedule && initial.schedule.timezone) || timezone || "Asia/Shanghai");
			const [error, setError] = react.useState(null);
			const [locale, setLocale] = react.useState(typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? "zh" : "en");
			const [workspaceItems, setWorkspaceItems] = react.useState([]);
			const [adding, setAdding] = react.useState(false);
			const [addPath, setAddPath] = react.useState("");
			const [addBusy, setAddBusy] = react.useState(false);
			const [addError, setAddError] = react.useState(null);

			react.useEffect(() => {
				const svc = workspacesSvc;
				if (svc === null) return;
				const sync = () => {
					try {
						setWorkspaceItems(svc.list.getSnapshot().items);
					} catch {}
				};
				sync();
				if (typeof svc.refresh === "function") {
					try {
						svc.refresh();
					} catch {}
				}
				return svc.list.subscribe(sync);
			}, []);

			const currentWsId = workspaceItems.find((w) => w.path === project)?.workspaceId ?? "";
			const selectValue = adding ? "__add__" : currentWsId !== "" ? currentWsId : project !== "" ? "__current__" : "";
			const pickWorkspace = (id) => {
				if (id === "__add__") {
					setAdding(true);
					return;
				}
				setAdding(false);
				const ws = workspaceItems.find((w) => w.workspaceId === id);
				if (ws !== undefined) setProject(ws.path);
			};
			const addWorkspace = async () => {
				const path = addPath.trim();
				if (path.length === 0 || addBusy || workspacesSvc === null) return;
				setAddBusy(true);
				setAddError(null);
				try {
					const result = await workspacesSvc.create({ path });
					if (result && result.ok) {
						setProject(path);
						setAdding(false);
						setAddPath("");
					} else {
						setAddError(String((result && result.error && result.error.message) || "failed"));
					}
				} catch (e) {
					setAddError(String((e && e.message) || e));
				} finally {
					setAddBusy(false);
				}
			};

			const preview = react.useMemo(() => describeSimple(expr, locale), [expr, locale]);

			const submit = async () => {
				if (prompt.trim().length === 0) {
					setError(t("error.required"));
					return;
				}
				const target = { kind };
				if (kind === "existing-chat") {
					if (sessionId.trim().length === 0) {
						setError(t("error.session"));
						return;
					}
					target.sessionId = sessionId.trim();
				}
				if (project.trim().length > 0) target.project = project.trim();
				if (provider.trim().length > 0) target.provider = provider.trim();
				if (model.trim().length > 0) target.model = model.trim();
				if (effort.length > 0) target.reasoningEffort = effort;
				const payload = {
					prompt: prompt.trim(),
					schedule: { expression: expr.trim(), timezone: tz.trim() },
					target
				};
				if (mode === "create" && title.trim().length > 0) payload.title = title.trim();
				try {
					await onSubmit(payload);
				} catch (e) {
					setError(String((e && e.message) || e));
				}
			};

			return react_jsx_runtime.jsx(react.Fragment, {
				children: [
					error !== null && react_jsx_runtime.jsx("div", {
						className: "dshc-error",
						children: [react_jsx_runtime.jsx(IconWarningOutline16, { size: 14 }), react_jsx_runtime.jsx("span", { children: error })]
					}),
					mode === "create" && react_jsx_runtime.jsx(Field, {
						label: t("field.title"),
						children: react_jsx_runtime.jsx("input", {
							className: "dshc-input",
							value: title,
							onChange: (e) => setTitle(e.target.value),
							placeholder: t("field.title.placeholder")
						})
					}),
					react_jsx_runtime.jsx(Field, {
						label: t("field.prompt"),
						children: react_jsx_runtime.jsx("textarea", {
							className: "dshc-textarea",
							value: prompt,
							onChange: (e) => setPrompt(e.target.value),
							placeholder: t("field.prompt.placeholder")
						})
					}),
					react_jsx_runtime.jsx(Field, {
						label: t("field.target"),
						children: react_jsx_runtime.jsx("select", {
							className: "dshc-sel",
							value: kind,
							onChange: (e) => setKind(e.target.value),
							children: [
								react_jsx_runtime.jsx("option", { value: "new-chat", children: t("target.new-chat") }),
								react_jsx_runtime.jsx("option", { value: "existing-chat", children: t("target.existing-chat") })
							]
						})
					}),
					kind === "existing-chat" && react_jsx_runtime.jsx(Field, {
						label: t("field.session"),
						hint: t("field.session.hint"),
						children: react_jsx_runtime.jsx("input", {
							className: "dshc-input",
							value: sessionId,
							onChange: (e) => setSessionId(e.target.value),
							placeholder: "session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
						})
					}),
					react_jsx_runtime.jsx(Field, {
						label: t("field.project"),
						hint: adding ? undefined : t("field.project.hint"),
						children: [
							react_jsx_runtime.jsx("select", {
								className: "dshc-sel",
								value: selectValue,
								onChange: (e) => pickWorkspace(e.target.value),
								children: [
									react_jsx_runtime.jsx("option", { value: "", disabled: true, children: t("field.project.none") }),
									workspaceItems.map((workspace) => react_jsx_runtime.jsx("option", {
										value: workspace.workspaceId,
										title: workspace.path,
										children: `${workspace.title} · ${workspace.path}`
									}, workspace.workspaceId)),
									selectValue === "__current__" && react_jsx_runtime.jsx("option", {
										value: "__current__",
										disabled: true,
										title: project,
										children: `${t("field.project.custom")}：${project}`
									}),
									react_jsx_runtime.jsx("option", { value: "__add__", children: t("field.project.add") })
								]
							}),
							adding && react_jsx_runtime.jsx("div", {
								className: "dshc-staticRow",
								children: [
									react_jsx_runtime.jsx("input", {
										className: "dshc-input",
										value: addPath,
										onChange: (e) => setAddPath(e.target.value),
										placeholder: t("field.project.add.placeholder")
									}),
									react_jsx_runtime.jsx("button", {
										type: "button",
										className: "dshc-textButton dshc-textButtonPrimary",
										disabled: addBusy,
										onClick: addWorkspace,
										children: addBusy ? t("saving") : t("field.project.add.submit")
									})
								]
							}),
							addError !== null && react_jsx_runtime.jsx("span", { className: "dshc-fieldHint", children: addError })
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "dshc-field",
						children: [
							react_jsx_runtime.jsx("span", { className: "dshc-fieldLabel", children: t("field.model") }),
							react_jsx_runtime.jsx("div", {
								className: "dshc-staticRow",
								children: [
									react_jsx_runtime.jsx("input", {
										className: "dshc-input",
										value: model,
										onChange: (e) => setModel(e.target.value),
										placeholder: "deepseek-v4-flash"
									}),
									react_jsx_runtime.jsx("select", {
										className: "dshc-sel",
										style: { width: "110px", flex: "none" },
										value: effort,
										onChange: (e) => setEffort(e.target.value),
										children: [
											react_jsx_runtime.jsx("option", { value: "", children: t("effort.none") }),
											react_jsx_runtime.jsx("option", { value: "off", children: "off" }),
											react_jsx_runtime.jsx("option", { value: "high", children: "high" }),
											react_jsx_runtime.jsx("option", { value: "max", children: "max" })
										]
									})
								]
							}),
							react_jsx_runtime.jsx("span", { className: "dshc-fieldHint", children: t("field.model.hint") })
						]
					}),
					react_jsx_runtime.jsx(Field, {
						label: t("field.frequency"),
						hint: `${expr.trim().length > 0 ? preview + " · " : ""}${t("field.frequency.hint")}`,
						children: [
							react_jsx_runtime.jsx("input", {
								className: "dshc-input",
								value: expr,
								onChange: (e) => setExpr(e.target.value),
								placeholder: "0 21 * * *"
							}),
							react_jsx_runtime.jsx(FrequencyPresets, { onPick: setExpr, t })
						]
					}),
					react_jsx_runtime.jsx(Field, {
						label: t("field.timezone"),
						children: react_jsx_runtime.jsx("input", {
							className: "dshc-input",
							value: tz,
							onChange: (e) => setTz(e.target.value),
							placeholder: "Asia/Shanghai"
						})
					}),
					react_jsx_runtime.jsx("div", {
						className: "dshc-field",
						children: [
							react_jsx_runtime.jsx("span", { className: "dshc-fieldLabel", children: t("field.notification") }),
							react_jsx_runtime.jsx("div", { className: "dshc-staticRow", children: react_jsx_runtime.jsx("span", { className: "dshc-staticValue", children: t("notification.session") }) })
						]
					}),
					onDelete !== undefined && react_jsx_runtime.jsx("div", {
						className: "dshc-field",
						children: [
							react_jsx_runtime.jsx("span", { className: "dshc-fieldLabel", children: t("field.history") }),
							react_jsx_runtime.jsx(RunHistory, { history: initial.history, t })
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "dshc-saveRow",
						children: [
							onDelete !== undefined && react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dshc-textButton dshc-textButtonDanger",
								disabled: submitting,
								onClick: onDelete,
								children: react_jsx_runtime.jsx(IconTrashOutline16, { size: 14 })
							}),
							react_jsx_runtime.jsx("span", { className: "dshc-spacer" }),
							onCancel !== undefined && react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dshc-textButton",
								disabled: submitting,
								onClick: onCancel,
								children: t("cancel")
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dshc-textButton dshc-textButtonPrimary",
								disabled: submitting,
								onClick: submit,
								children: submitting ? t("saving") : mode === "create" ? t("create.submit") : t("save")
							})
						]
					})
				]
			});
		}

		/** Drawer close state: animate the exit (slide right) before unmount. */
		function useDrawerClose(onClose) {
			const [closing, setClosing] = react.useState(false);
			const close = react.useCallback(() => {
				if (closing) return;
				setClosing(true);
				window.setTimeout(onClose, 160);
			}, [closing, onClose]);
			react.useEffect(() => {
				const onKey = (event) => {
					if (event.key === "Escape") close();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [close]);
			return { closing, close };
		}

		/** Detail drawer: edit an existing job. */
		function CronDetailDrawer({ job, timezone, t, onClose, onSaved, onDeleted }) {
			const [submitting, setSubmitting] = react.useState(false);
			const { closing, close } = useDrawerClose(onClose);
			const save = async (payload) => {
				setSubmitting(true);
				try {
					await mutate("/cron-api/jobs/" + encodeURIComponent(job.id), "PATCH", payload);
					onSaved();
				} finally {
					setSubmitting(false);
				}
			};
			const remove = async () => {
				if (!window.confirm(t("delete.confirm", { title: job.title }))) return;
				setSubmitting(true);
				try {
					await mutate("/cron-api/jobs/" + encodeURIComponent(job.id), "DELETE");
					onDeleted();
				} finally {
					setSubmitting(false);
				}
			};
			return react_jsx_runtime.jsx("div", {
				className: "dshc-pageDrawer" + (closing ? " dshc-pageDrawerClosing" : ""),
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dshc-drawerHeader",
						children: [
							react_jsx_runtime.jsx("span", { className: "dshc-overlayTitle", children: t("drawer.edit") }),
							react_jsx_runtime.jsx("span", { className: "dshc-spacer" }),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dshc-iconButton",
								"aria-label": t("close.aria"),
								title: t("close.aria"),
								onClick: close,
								children: react_jsx_runtime.jsx(IconCloseOutline16, { size: 14 })
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "dshc-drawerBody",
						children: react_jsx_runtime.jsx(JobForm, {
							initial: { ...job, history: job.runHistory },
							mode: "edit",
							timezone,
							t,
							onSubmit: save,
							onDelete: remove,
							submitting
						})
					})
				]
			});
		}

		/** Create drawer: manual job creation (optionally prefilled schedule). */
		function CronCreateDrawer({ presetExpression, timezone, t, onClose, onCreated }) {
			const [submitting, setSubmitting] = react.useState(false);
			const { closing, close } = useDrawerClose(onClose);
			const create = async (payload) => {
				setSubmitting(true);
				try {
					await mutate("/cron-api/jobs", "POST", payload);
					onCreated();
				} finally {
					setSubmitting(false);
				}
			};
			const initial = {
				prompt: "",
				title: "",
				schedule: presetExpression ? { expression: presetExpression, timezone } : { expression: "", timezone },
				target: { kind: "new-chat" }
			};
			return react_jsx_runtime.jsx("div", {
				className: "dshc-pageDrawer" + (closing ? " dshc-pageDrawerClosing" : ""),
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dshc-drawerHeader",
						children: [
							react_jsx_runtime.jsx("span", { className: "dshc-overlayTitle", children: t("drawer.create") }),
							react_jsx_runtime.jsx("span", { className: "dshc-spacer" }),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dshc-iconButton",
								"aria-label": t("close.aria"),
								title: t("close.aria"),
								onClick: close,
								children: react_jsx_runtime.jsx(IconCloseOutline16, { size: 14 })
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "dshc-drawerBody",
						children: react_jsx_runtime.jsx(JobForm, {
							initial,
							mode: "create",
							timezone,
							t,
							onSubmit: create,
							onCancel: close,
							submitting
						})
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
		 * list slot) with filter tabs, schedule suggestions and a detail/create
		 * drawer. Renders null while closed; the header/footer triggers open it
		 * via the store.
		 */
		function CronOverlay({ t }) {
			const open = react.useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot);
			const { jobs, timezone, error, reload } = useCron();
			const { busy, mutError, toggle, remove } = useJobActions(reload, t);
			const [tab, setTab] = react.useState("all");
			const [drawer, setDrawer] = react.useState(null);
			const jobsList = jobs === null ? [] : jobs;
			const enabledCount = jobsList.filter((job) => job.enabled).length;
			const overdueCount = jobsList.filter((job) => job.state === "overdue").length;
			const counts = {
				all: jobsList.length,
				enabled: jobsList.filter((job) => job.enabled).length,
				disabled: jobsList.filter((job) => !job.enabled).length
			};
			const visible = tab === "all" ? jobsList : tab === "enabled" ? jobsList.filter((job) => job.enabled) : jobsList.filter((job) => !job.enabled);
			const now = Date.now();
			const detailJob = drawer !== null && drawer.kind === "detail" ? jobsList.find((job) => job.id === drawer.jobId) : null;

			react.useEffect(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					// With a drawer open the drawer owns Esc (animated close);
					// otherwise Esc leaves the page.
					if (drawer === null) overlayStore.setOpen(false);
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open, drawer]);

			if (!open) return null;
			return react_jsx_runtime.jsx("div", {
				className: "dshc-page",
				"data-shell-overlay-page": "@walltech/dsh-cron",
				children: [
					react_jsx_runtime.jsx("div", {
						className: "dshc-pageHeader",
						children: [
							react_jsx_runtime.jsx("span", { className: "dshc-overlayTitle", children: t("menu.title") }),
							enabledCount > 0 && react_jsx_runtime.jsx("span", {
								className: "dshc-count" + (overdueCount > 0 ? " dshc-countOverdue" : ""),
								children: String(enabledCount)
							}),
							react_jsx_runtime.jsx("span", { className: "dshc-spacer" }),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dshc-textButton dshc-textButtonPrimary",
								onClick: () => setDrawer({ kind: "create", presetExpression: null }),
								children: [react_jsx_runtime.jsx(IconPlusOutline16, { size: 14 }), " ", t("create")]
							}),
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
					react_jsx_runtime.jsx("div", {
						className: "dshc-pageBody",
						children: [
							react_jsx_runtime.jsx("div", {
								className: "dshc-pageList",
								children: [
									react_jsx_runtime.jsx(CronTabs, { active: tab, counts, onChange: setTab, t }),
									react_jsx_runtime.jsx(JobListContent, {
										jobs,
										jobsList: visible,
										timezone,
										error,
										mutError,
										busy,
										now,
										toggle,
										remove,
										onOpen: (job) => setDrawer({ kind: "detail", jobId: job.id }),
										t
									}),
									react_jsx_runtime.jsx(CronSuggestions, {
										onPick: (expression) => setDrawer({ kind: "create", presetExpression: expression }),
										t
									}),
									react_jsx_runtime.jsx("div", {
										className: "dshc-foot",
										children: [react_jsx_runtime.jsx(IconPlusOutline16, { size: 12 }), " ", t("empty.hint")]
									})
								]
							}),
							drawer !== null && drawer.kind === "detail" && detailJob !== null && react_jsx_runtime.jsx(CronDetailDrawer, {
								job: detailJob,
								timezone,
								t,
								onClose: () => setDrawer(null),
								onSaved: () => { setDrawer(null); reload(); },
								onDeleted: () => { setDrawer(null); reload(); }
							}),
							drawer !== null && drawer.kind === "create" && react_jsx_runtime.jsx(CronCreateDrawer, {
								presetExpression: drawer.presetExpression,
								timezone,
								t,
								onClose: () => setDrawer(null),
								onCreated: () => { setDrawer(null); reload(); }
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
			"time.daysAgo": "{n} 天前",
			"tab.all": "全部",
			"tab.enabled": "已开启",
			"tab.disabled": "已暂停",
			"create": "新建",
			"sugg.morning": "每天早上 9 点",
			"sugg.evening": "每天晚上 21 点",
			"drawer.edit": "任务详情",
			"drawer.create": "新建定时任务",
			"field.title": "标题（可选）",
			"field.title.placeholder": "留空则按调度自动生成",
			"field.prompt": "任务说明",
			"field.prompt.placeholder": "描述要定期执行的任务，例如：每天早上 9 点跑回归测试并把结果发到群里",
			"field.target": "运行于",
			"target.new-chat": "新聊天",
			"target.existing-chat": "现有聊天",
			"field.session": "会话 ID",
			"field.session.hint": "现有聊天需要填写目标会话 ID（session-…）",
			"field.project": "项目",
			"field.project.hint": "从已有工作区选择，或选择「手动添加工作区」",
			"field.project.none": "未选择项目",
			"field.project.custom": "自定义路径",
			"field.project.add": "手动添加工作区…",
			"field.project.add.placeholder": "输入绝对路径，如 /Users/…/repos/walltech",
			"field.project.add.submit": "添加",
			"field.model": "模型 / 推理",
			"field.model.hint": "留空使用默认；推理可选 off / high / max",
			"effort.none": "推理默认",
			"field.frequency": "频率",
			"field.frequency.hint": "5 段 cron 表达式，例如 0 21 * * *",
			"preset.hourly": "每小时",
			"preset.daily9": "每天 9:00",
			"preset.daily21": "每天 21:00",
			"preset.monday": "每周一 9:00",
			"preset.monthly": "每月 1 号 9:00",
			"field.timezone": "时区",
			"field.notification": "通知",
			"notification.session": "运行结果发送到会话",
			"field.history": "运行历史",
			"history.empty": "暂无运行记录",
			"history.ok": "成功",
			"history.failed": "失败",
			"save": "保存",
			"saving": "保存中…",
			"create.submit": "创建",
			"cancel": "取消",
			"error.required": "任务说明不能为空",
			"error.session": "现有聊天需要填写会话 ID"
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
			"time.daysAgo": "{n} d ago",
			"tab.all": "All",
			"tab.enabled": "Active",
			"tab.disabled": "Paused",
			"create": "New",
			"sugg.morning": "Every day at 9:00",
			"sugg.evening": "Every day at 21:00",
			"drawer.edit": "Task details",
			"drawer.create": "New scheduled task",
			"field.title": "Title (optional)",
			"field.title.placeholder": "Leave empty to auto-generate from the schedule",
			"field.prompt": "Task prompt",
			"field.prompt.placeholder": "Describe the recurring task, e.g. run the regression test at 9am daily",
			"field.target": "Run in",
			"target.new-chat": "New chat",
			"target.existing-chat": "Existing chat",
			"field.session": "Session ID",
			"field.session.hint": "Existing chat requires the target session ID (session-…)",
			"field.project": "Project",
			"field.project.hint": "Pick an existing workspace, or choose “add workspace”",
			"field.project.none": "No project",
			"field.project.custom": "Custom path",
			"field.project.add": "Add workspace…",
			"field.project.add.placeholder": "Absolute path, e.g. /Users/…/repos/walltech",
			"field.project.add.submit": "Add",
			"field.model": "Model / Reasoning",
			"field.model.hint": "Leave empty for defaults; reasoning: off / high / max",
			"effort.none": "Default reasoning",
			"field.frequency": "Frequency",
			"field.frequency.hint": "5-field cron expression, e.g. 0 21 * * *",
			"preset.hourly": "Hourly",
			"preset.daily9": "Daily 9:00",
			"preset.daily21": "Daily 21:00",
			"preset.monday": "Mon 9:00",
			"preset.monthly": "1st 9:00",
			"field.timezone": "Timezone",
			"field.notification": "Notification",
			"notification.session": "Run result delivered to the session",
			"field.history": "Run history",
			"history.empty": "No runs yet",
			"history.ok": "OK",
			"history.failed": "Failed",
			"save": "Save",
			"saving": "Saving…",
			"create.submit": "Create",
			"cancel": "Cancel",
			"error.required": "Task prompt is required",
			"error.session": "Existing chat requires a session ID"
		};
		//#endregion

		/** Dictionary namespace owned by this plugin. */
		const NS = "cron";

		/** Required client services (informational module-graph edges). */
		const inject = ["slots", "locale", "workspaces"];

		/**
		 * Client plugin body: register the dictionaries and the slot entries.
		 * - conversation.session.header.actions — trigger button (header)
		 * - sidebar.footer.action               — trigger button beside Settings (wide + rail)
		 * - shell.overlay                       — the standalone "已安排" page
		 * All three are official framework slots; no sidebar fork is required.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			workspacesSvc = ctx.get("workspaces");
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
