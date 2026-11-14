window.__ModuleLoader__.load({
	id: "@recruitment/dsh-recruitment",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/client/use-overview.ts
		/** 宿主只读路由（同源相对路径）。 */
		const ENDPOINT = "/recruitment/api/overview";
		/** 同源标记头（宿主侧 `x-recruitment-request: 1` 才放行）。 */
		const REQUEST_HEADER = "x-recruitment-request";
		/** 取一个非空字符串；否则用兜底。 */
		function asText(value, fallback = "") {
			return typeof value === "string" && value.trim() !== "" ? value : fallback;
		}
		/** 取一个非负有限数字；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
		function asCount(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
		}
		/** 把任意响应体归一化成 `OverviewResponse`：字段缺失不抛错，只降级。 */
		function normalizeOverview(value) {
			const raw = value !== null && typeof value === "object" ? value : {};
			const pending = [];
			if (Array.isArray(raw.pending)) for (const item of raw.pending) {
				if (item === null || typeof item !== "object") continue;
				const row = item;
				const application_id = asText(row.application_id);
				if (application_id === "") continue;
				pending.push({
					application_id,
					stage_code: asText(row.stage_code, "未知阶段"),
					reason: asText(row.reason, "未提供原因")
				});
			}
			const countsRaw = raw.counts !== null && typeof raw.counts === "object" ? raw.counts : {};
			const stageMap = (value) => {
				const source = value !== null && typeof value === "object" ? value : {};
				const out = {};
				for (const [stageCode, count] of Object.entries(source)) {
					const key = asText(stageCode);
					if (key !== "") out[key] = asCount(count);
				}
				return out;
			};
			const pendingByStage = stageMap(countsRaw.pending_by_stage);
			const activeByStage = stageMap(countsRaw.active_by_stage);
			const issues = Array.isArray(raw.issues) ? raw.issues.filter((issue) => typeof issue === "string") : [];
			return {
				configured: raw.configured === true,
				pending,
				counts: {
					pending_total: countsRaw.pending_total === void 0 ? pending.length : asCount(countsRaw.pending_total),
					pending_by_stage: pendingByStage,
					active_total: asCount(countsRaw.active_total),
					active_by_stage: activeByStage
				},
				...issues.length > 0 ? { issues } : {}
			};
		}
		/**
		* 读取一次工作台投影；网络错误 / HTTP 错误 / 坏 JSON 都变成可读的错误文本。
		* @param signal - 组件卸载时用于放弃请求。
		* @returns 归一化后的响应。
		* @throws {Error} 当宿主返回非 2xx 或响应体不是 JSON 时。
		*/
		async function fetchOverview(signal) {
			const response = await fetch(ENDPOINT, {
				method: "GET",
				headers: { [REQUEST_HEADER]: "1" },
				cache: "no-store",
				signal
			});
			const text = await response.text();
			if (!response.ok) {
				const detail = text.trim() === "" ? "" : `：${text.slice(0, 200)}`;
				throw new Error(`宿主返回 HTTP ${response.status}${detail}`);
			}
			let parsed;
			try {
				parsed = text.trim() === "" ? void 0 : JSON.parse(text);
			} catch {
				throw new Error("宿主返回的不是 JSON");
			}
			return normalizeOverview(parsed);
		}
		/**
		* 面板取数 hook：挂载时读一次，`reload()` 重新读；卸载时放弃在途请求。
		* 不做轮询——第一版的面板要证明的是"注册链路通了"，实时性不是这一版的问题。
		* @returns 数据、错误、加载中、重新读取。
		*/
		function useOverview() {
			const [data, setData] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(true);
			const [generation, setGeneration] = (0, react.useState)(0);
			const reload = (0, react.useCallback)(() => {
				setGeneration((value) => value + 1);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				let active = true;
				setLoading(true);
				fetchOverview(controller.signal).then((value) => {
					if (!active) return;
					setData(value);
					setError(void 0);
				}).catch((failure) => {
					if (!active || controller.signal.aborted) return;
					setError(failure instanceof Error ? failure.message : String(failure));
				}).finally(() => {
					if (active) setLoading(false);
				});
				return () => {
					active = false;
					controller.abort();
				};
			}, [generation]);
			return {
				data,
				error,
				loading,
				reload
			};
		}
		// src/client/Workbench.tsx
		/**
		* 「待人工决定」工作台主体（main 面板内容）。
		* @returns 面板 JSX。
		*/
		function Workbench() {
			const { data, error, loading, reload } = useOverview();
			const pending = data?.pending ?? [];
			const issues = data?.issues ?? [];
			const configured = data?.configured ?? false;
			const pendingTotal = data?.counts.pending_total ?? 0;
			const activeTotal = data?.counts.active_total ?? 0;
			const pendingByStageEntries = Object.entries(data?.counts.pending_by_stage ?? {});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "待人工决定" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "下面这些申请在等一个真人做决定。" }),
				error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "alert",
					children: ["读取失败：", error]
				}) : null,
				data !== void 0 && !configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["数据库未配置，暂时读不到数据", issues.length > 0 ? `（缺少：${issues.join("；")}）` : ""] }) : null,
				loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "正在读取…" }) : null,
				!loading && error === void 0 && configured ? pending.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "没有等你决定的事" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: pending.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["申请：", row.application_id] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["阶段：", row.stage_code] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["为什么等：", row.reason] })
				] }, row.application_id)) }) : null,
				data !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
					"待人工决定 ",
					pendingTotal,
					" 条；在办申请 ",
					activeTotal,
					" 条。"
				] }) : null,
				pendingByStageEntries.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["按阶段：", pendingByStageEntries.map(([stageCode, count]) => `${stageCode} ${count} 条`).join(" · ")] }) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: reload,
					disabled: loading,
					children: "刷新"
				}) })
			] });
		}
		// src/client/index.tsx
		/** 需要 cordis 客户端服务：槽位注册表（由 browser renderer 提供）。 */
		const inject = ["slots"];
		/** 面板 id：侧栏列表 id 与 main 面板 key 必须是同一个值，否则点图标打不开面板。 */
		const PANEL_ID = "recruitment-workbench";
		/**
		* 侧栏图标：一个带指针的圆（"待处理"语义），线色用 `currentColor`，
		* 因此跟随宿主的明暗主题，不自己造一套颜色。
		* @param props - 宿主给的尺寸。
		* @returns 图标 SVG。
		*/
		function PanelIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "12",
					cy: "12",
					r: "8"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 8.5v4l2.5 1.5" })]
			});
		}
		/**
		* 注册面板与侧栏图标。
		* @param ctx - 客户端上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				inject: () => ({})
			}, Workbench));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 10,
				label: "待人工决定"
			}, PanelIcon));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
