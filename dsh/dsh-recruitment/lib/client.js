window.__ModuleLoader__.load({
	id: "@recruitment/dsh-recruitment",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/client/normalize.ts
		/** 契约里的六个 actor 视角列表键。 */
		const OVERVIEW_LIST_KEYS = [
			"pending_decisions",
			"my_interviews",
			"overdue_scorecards",
			"pending_reviews",
			"connector_incidents",
			"waiting_human_tasks"
		];
		/** 未分配（全租户共享）区块里的四个列表键。 */
		const UNASSIGNED_LIST_KEYS = [
			"pending_decisions",
			"pending_reviews",
			"waiting_human_tasks",
			"connector_incidents"
		];
		/** 面评维度的 assessment 枚举（D-89 / scorecard 契约）。 */
		const ASSESSMENT_VALUES = [
			"MET",
			"NOT_MET",
			"NOT_OBSERVED",
			"UNREADABLE"
		];
		/** 面评 overall 枚举。 */
		const OVERALL_VALUES = [
			"ADVANCE",
			"HOLD",
			"REJECT"
		];
		/** 动态表单的三种模式。 */
		const FORM_MODES = [
			"CREATE",
			"REVISE",
			"ALREADY_SUBMITTED"
		];
		/** 取一个非空字符串；否则兜底（数字/布尔不算字符串，避免把坏类型伪装成文本）。 */
		function asText(value, fallback = "") {
			if (typeof value === "string") {
				const trimmed = value.trim();
				return trimmed === "" ? fallback : trimmed;
			}
			return fallback;
		}
		/** 取一个非负有限整数；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
		function asCount(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
		}
		/** 取一个布尔；只认严格 true。 */
		function asBool(value) {
			return value === true;
		}
		/** 取一个对象（null / 数组 / 非对象一律降级为空对象）。 */
		function asRecord(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		}
		/** 字符串数组归一化（丢弃非字符串项）。 */
		function asStringArray(value) {
			if (!Array.isArray(value)) return [];
			const out = [];
			for (const item of value) if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
			return out;
		}
		/** labels 映射归一化（只保留字符串值）。 */
		function normalizeLabels(value) {
			const out = {};
			for (const [key, label] of Object.entries(asRecord(value))) if (typeof label === "string" && label.trim() !== "") out[key] = label.trim();
			return out;
		}
		/** 单条列表行拍平：只展示标量字段与业务引用，不展示嵌套对象（避免 `[object Object]`）。 */
		function describeValue(value) {
			if (typeof value === "string") {
				const trimmed = value.trim();
				return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
			}
			if (typeof value === "number" && Number.isFinite(value)) return String(value);
			if (typeof value === "boolean") return value ? "是" : "否";
			return "";
		}
		/** 拍平一行的字段（业务引用数组按 `kind:id` 拼；其余嵌套对象跳过）。 */
		function flattenFields(row, labels, skipKeys) {
			const fields = [];
			const seen = /* @__PURE__ */ new Set();
			const preferred = [
				"title",
				"display_name",
				"summary",
				"stage_code",
				"status",
				"round_no",
				"slot_code",
				"scheduled_start_at",
				"due_at",
				"deadline_at",
				"assignee_display_name",
				"assignee_actor_id",
				"created_by_display_name",
				"created_by_actor_id",
				"reason",
				"note",
				"source_kind",
				"error_code",
				"message",
				"business_refs"
			];
			const push = (key, value) => {
				if (seen.has(key) || value === "") return;
				seen.add(key);
				fields.push({
					key,
					label: labels[key] ?? key,
					value
				});
			};
			const render = (key, value) => {
				if (key === "business_refs" && Array.isArray(value)) {
					const refs = [];
					for (const item of value) {
						const ref = asRecord(item);
						const kind = asText(ref.kind);
						const id = asText(ref.id);
						if (kind !== "" && id !== "") refs.push(`${kind}:${id}`);
					}
					if (refs.length > 0) push(key, refs.join("、"));
					return;
				}
				if (Array.isArray(value)) return;
				push(key, describeValue(value));
			};
			for (const key of preferred) {
				if (skipKeys.has(key)) continue;
				if (key in row) render(key, row[key]);
			}
			for (const [key, value] of Object.entries(row)) {
				if (skipKeys.has(key) || seen.has(key) || preferred.includes(key)) continue;
				render(key, value);
			}
			return fields;
		}
		/**
		* 归一化一条列表行。
		* @param value - 服务端原始行。
		* @param labels - 服务端 labels（键 → 中文标签）。
		* @param idKeys - 该列表行主 id 的候选字段（按优先级）。
		* @returns 安全形状；`id` 取不到时为空串（不伪造）。
		*/
		function normalizeListItem(value, labels, idKeys) {
			const row = asRecord(value);
			let id = "";
			for (const key of idKeys) {
				id = asText(row[key]);
				if (id !== "") break;
			}
			if (id === "") id = asText(row.id);
			const nestedInterview = asRecord(row.interview);
			const interviewId = asText(row.interview_id) || asText(nestedInterview.id);
			const needsScorecard = asBool(row.needs_scorecard);
			const fields = flattenFields(row, labels, /* @__PURE__ */ new Set([
				...idKeys,
				"id",
				"needs_scorecard",
				"interview"
			]));
			for (const [key, value] of Object.entries(nestedInterview)) {
				if (key === "id") continue;
				const rendered = describeValue(value);
				if (rendered !== "" && !fields.some((field) => field.key === `interview_${key}`)) fields.push({
					key: `interview_${key}`,
					label: `面试·${labels[key] ?? key}`,
					value: rendered
				});
			}
			return {
				id,
				interview_id: interviewId,
				needs_scorecard: needsScorecard,
				fields
			};
		}
		/** 归一化一个列表；非数组降级为空数组，非对象行丢弃。 */
		function normalizeList(value, labels, idKeys) {
			if (!Array.isArray(value)) return [];
			const out = [];
			for (const item of value.slice(0, 500)) {
				if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
				out.push(normalizeListItem(item, labels, idKeys));
			}
			return out;
		}
		/** 每个列表的主 id 字段优先级（与服务端投影行的自然主键对齐）。 */
		const LIST_ID_KEYS = {
			pending_decisions: [
				"application_id",
				"interview_id",
				"id"
			],
			my_interviews: [
				"interview_id",
				"application_id",
				"id"
			],
			overdue_scorecards: [
				"interview_id",
				"scorecard_id",
				"application_id",
				"id"
			],
			pending_reviews: ["review_id", "id"],
			connector_incidents: [
				"run_id",
				"incident_id",
				"intake_id",
				"task_id",
				"id"
			],
			waiting_human_tasks: [
				"task_id",
				"business_task_id",
				"id"
			]
		};
		/** 归一化按阶段聚合的计数表。 */
		function normalizeStageMap(value) {
			const out = {};
			for (const [stageCode, count] of Object.entries(asRecord(value))) {
				const key = asText(stageCode);
				if (key !== "") out[key] = asCount(count);
			}
			return out;
		}
		/** 把任意 overview 响应体归一化成 `OverviewResponse`：字段缺失不抛错，只降级。 */
		function normalizeOverview(value) {
			const raw = asRecord(value);
			const labels = normalizeLabels(raw.labels);
			const countsRaw = asRecord(raw.counts);
			const listsRaw = asRecord(raw.lists);
			const unassignedRaw = asRecord(raw.unassigned);
			const lists = {};
			for (const key of OVERVIEW_LIST_KEYS) lists[key] = normalizeList(listsRaw[key], labels, LIST_ID_KEYS[key] ?? ["id"]);
			const unassigned = {};
			for (const key of UNASSIGNED_LIST_KEYS) unassigned[key] = normalizeList(unassignedRaw[key], labels, LIST_ID_KEYS[key] ?? ["id"]);
			const actorRaw = asRecord(raw.actor);
			const issues = [];
			if (Array.isArray(raw.issues)) {
				for (const issue of raw.issues) if (typeof issue === "string" && issue.trim() !== "") issues.push(issue);
			}
			return {
				contract_version: asText(raw.contract_version),
				configured: raw.configured === true,
				evaluated_at: asText(raw.evaluated_at),
				actor: {
					actor_id: asText(actorRaw.actor_id),
					display_name: asText(actorRaw.display_name),
					roles: asStringArray(actorRaw.roles)
				},
				labels,
				pending: normalizeList(raw.pending, labels, LIST_ID_KEYS.pending_decisions),
				counts: {
					pending_total: asCount(countsRaw.pending_total),
					pending_by_stage: normalizeStageMap(countsRaw.pending_by_stage),
					active_total: asCount(countsRaw.active_total),
					active_by_stage: normalizeStageMap(countsRaw.active_by_stage),
					my_interviews_total: asCount(countsRaw.my_interviews_total),
					overdue_scorecards_total: asCount(countsRaw.overdue_scorecards_total),
					pending_reviews_total: asCount(countsRaw.pending_reviews_total),
					connector_incidents_total: asCount(countsRaw.connector_incidents_total),
					waiting_human_total: asCount(countsRaw.waiting_human_total),
					unassigned_total: asCount(countsRaw.unassigned_total)
				},
				lists: {
					pending_decisions: lists.pending_decisions,
					my_interviews: lists.my_interviews,
					overdue_scorecards: lists.overdue_scorecards,
					pending_reviews: lists.pending_reviews,
					connector_incidents: lists.connector_incidents,
					waiting_human_tasks: lists.waiting_human_tasks
				},
				unassigned: {
					note: asText(unassignedRaw.note),
					pending_decisions: unassigned.pending_decisions,
					pending_reviews: unassigned.pending_reviews,
					waiting_human_tasks: unassigned.waiting_human_tasks,
					connector_incidents: unassigned.connector_incidents
				},
				issues
			};
		}
		/** 只保留允许枚举里的值（服务端给了未知枚举值时丢弃，不渲染成可选项）。 */
		function filterAllowed(value, allowed) {
			const out = [];
			for (const item of asStringArray(value)) if (allowed.includes(item) && !out.includes(item)) out.push(item);
			return out;
		}
		/** 归一化一个维度控件（key 为空则返回 null：没有 key 就无法构造动态键，fail-closed）。 */
		function normalizeDimension(value) {
			const raw = asRecord(value);
			const key = asText(raw.key);
			if (key === "") return null;
			const controls = asRecord(raw.controls);
			const score = asRecord(controls.score);
			const scoreMin = asCount(score.min);
			const scoreMax = asCount(score.max);
			return {
				key,
				label: asText(raw.label, key),
				kind: asText(raw.kind),
				weight: typeof raw.weight === "number" && Number.isFinite(raw.weight) ? raw.weight : 0,
				assessmentOptions: filterAllowed(controls.assessment, ASSESSMENT_VALUES),
				scoreMin: scoreMin > 0 ? scoreMin : 1,
				scoreMax: scoreMax >= scoreMin && scoreMax > 0 ? scoreMax : 5,
				noteRequired: asBool(controls.note_required)
			};
		}
		/** 归一化 rubric 维度元数据（标题展示用）。 */
		function normalizeRubricDimension(value) {
			const raw = asRecord(value);
			const key = asText(raw.key);
			if (key === "") return null;
			return {
				key,
				label: asText(raw.label, key),
				kind: asText(raw.kind),
				weight: typeof raw.weight === "number" && Number.isFinite(raw.weight) ? raw.weight : 0
			};
		}
		/** 归一化 `GET /recruitment/api/scorecard-form` 响应（字段缺失一律降级，不抛错）。 */
		function normalizeFormSpec(value) {
			const raw = asRecord(value);
			const actorRaw = asRecord(raw.actor);
			const interviewRaw = asRecord(raw.interview);
			const rubricRaw = asRecord(raw.rubric);
			const transcriptRaw = asRecord(raw.transcript_basis);
			const currentRaw = raw.current === null || raw.current === void 0 ? null : asRecord(raw.current);
			const dimensions = [];
			if (Array.isArray(raw.dimensions)) for (const item of raw.dimensions) {
				const dimension = normalizeDimension(item);
				if (dimension !== null) dimensions.push(dimension);
			}
			else if (Array.isArray(rubricRaw.dimensions)) for (const item of rubricRaw.dimensions) {
				const meta = normalizeRubricDimension(item);
				if (meta === null) continue;
				dimensions.push({
					key: meta.key,
					label: meta.label,
					kind: meta.kind,
					weight: meta.weight,
					assessmentOptions: [],
					scoreMin: 1,
					scoreMax: 5,
					noteRequired: false
				});
			}
			const rubricDimensions = [];
			if (Array.isArray(rubricRaw.dimensions)) for (const item of rubricRaw.dimensions) {
				const meta = normalizeRubricDimension(item);
				if (meta !== null) rubricDimensions.push(meta);
			}
			const modeRaw = asText(raw.mode);
			const mode = FORM_MODES.includes(modeRaw) ? modeRaw : "ALREADY_SUBMITTED";
			const overallOptions = filterAllowed(raw.overall_options, OVERALL_VALUES);
			return {
				contract_version: asText(raw.contract_version),
				actor: {
					actor_id: asText(actorRaw.actor_id),
					display_name: asText(actorRaw.display_name),
					roles: asStringArray(actorRaw.roles)
				},
				interview: {
					id: asText(interviewRaw.id),
					application_id: asText(interviewRaw.application_id),
					round_no: asCount(interviewRaw.round_no),
					slot_code: asText(interviewRaw.slot_code),
					status: asText(interviewRaw.status),
					scheduled_start_at: asText(interviewRaw.scheduled_start_at)
				},
				rubric: {
					id: asText(rubricRaw.id),
					job_id: asText(rubricRaw.job_id),
					payload_hash: asText(rubricRaw.payload_hash),
					dimensions: rubricDimensions
				},
				dimensions,
				transcript_basis: {
					value: asText(transcriptRaw.value),
					options: asStringArray(transcriptRaw.options),
					locked: asBool(transcriptRaw.locked)
				},
				overall_options: overallOptions,
				mode,
				current: currentRaw === null ? null : {
					id: asText(currentRaw.id),
					status: asText(currentRaw.status),
					revision_no: asCount(currentRaw.revision_no),
					record_version: asCount(currentRaw.record_version),
					rubric_version_id: asText(currentRaw.rubric_version_id)
				},
				labels: normalizeLabels(raw.labels)
			};
		}
		/** 归一化提交成功响应（scorecard 子对象缺失时降级为空串/0，绝不当作成功依据）。 */
		function normalizeSubmitResult(value) {
			const raw = asRecord(value);
			const scorecardRaw = asRecord(raw.scorecard);
			return {
				status: asText(raw.status),
				replayed: asBool(raw.replayed),
				scorecard: {
					id: asText(scorecardRaw.id),
					revision_no: asCount(scorecardRaw.revision_no),
					status: asText(scorecardRaw.status)
				},
				coverage: raw.coverage ?? null
			};
		}
		/** 带 status / code / reason_code 的 HTTP 错误：界面按契约字段原样显示。 */
		var RecruitmentHttpError = class extends Error {
			/** HTTP 状态码（网络层失败为 0）。 */
			status;
			/** 契约错误码（`INVALID_ARGS` 等）；解析不到为空串。 */
			code;
			/** 契约原因码（`DIMENSION_NOT_IN_RUBRIC` 等）；解析不到为空串。 */
			reasonCode;
			/** 服务端 detail 原样保留（展示用）。 */
			detail;
			constructor(status, code, reasonCode, message, detail) {
				super(message);
				this.name = "RecruitmentHttpError";
				this.status = status;
				this.code = code;
				this.reasonCode = reasonCode;
				this.detail = detail;
			}
		};
		/**
		* 把非 2xx 响应体解析成可读 `RecruitmentHttpError`。
		*
		* 契约形状优先级：`{error:{code,reason_code,message,detail}}` →
		* `{error:"文本"}` → 原文。解析不到时仍保留 HTTP 状态码。
		* @param status - HTTP 状态码。
		* @param bodyText - 响应体原文。
		* @returns 可读错误（保留 code / reason_code / detail）。
		*/
		function parseHttpError(status, bodyText) {
			const text = bodyText.trim();
			let parsed;
			if (text !== "") try {
				parsed = JSON.parse(text);
			} catch {
				parsed = void 0;
			}
			const errorRaw = asRecord(parsed).error;
			if (errorRaw !== null && typeof errorRaw === "object" && !Array.isArray(errorRaw)) {
				const error = asRecord(errorRaw);
				const code = asText(error.code);
				const reasonCode = asText(error.reason_code);
				const message = asText(error.message, asText(error.detail));
				const composed = [code, reasonCode].filter((part) => part !== "").join("/");
				return new RecruitmentHttpError(status, code, reasonCode, composed === "" && message === "" ? `宿主返回 HTTP ${status}` : `${composed === "" ? "" : `${composed}：`}${message === "" ? `HTTP ${status}` : message}`, error.detail);
			}
			if (typeof errorRaw === "string" && errorRaw.trim() !== "") return new RecruitmentHttpError(status, "", "", `宿主返回 HTTP ${status}：${errorRaw.trim()}`, void 0);
			return new RecruitmentHttpError(status, "", "", text === "" ? `宿主返回 HTTP ${status}` : `宿主返回 HTTP ${status}：${text.slice(0, 200)}`, void 0);
		}
		/**
		* 从 JSON 响应体里抽取 scorecard 工具错误（200 但 `status !== 'OK'` 的失败要按失败展示）。
		* @returns 失败时返回错误；`status === 'OK'` 返回 null。
		*/
		function submitResultError(value) {
			const raw = asRecord(value);
			const status = asText(raw.status);
			if (status === "OK") return null;
			const error = asRecord(raw.error);
			const code = asText(error.code, asText(raw.code));
			const reasonCode = asText(error.reason_code, asText(raw.reason_code));
			const message = asText(error.message, asText(raw.message, status === "" ? "面评提交返回了空响应" : status));
			const composed = [code, reasonCode].filter((part) => part !== "").join("/");
			return new RecruitmentHttpError(200, code, reasonCode, composed === "" ? message : `${composed}：${message}`, error.detail ?? raw.detail);
		}
		// src/client/use-overview.ts
		/** 宿主只读路由（同源相对路径）。 */
		const OVERVIEW_ENDPOINT = "/recruitment/api/overview";
		/** D-89 动态面评表单路由（GET spec / POST 提交）。 */
		const SCORECARD_ENDPOINT = "/recruitment/api/scorecard-form";
		/** 同源标记头（宿主侧 `x-recruitment-request: 1` 才放行）。 */
		const REQUEST_HEADER = "x-recruitment-request";
		/**
		* 统一请求封装：网络错误 / 非 2xx / 坏 JSON 都变成可读错误。
		* @param url - 同源相对路径。
		* @param init - fetch 参数（方法/头/体）。
		* @returns 解析后的 JSON（空体为 undefined）。
		* @throws {RecruitmentHttpError} 非 2xx 时（保留 code / reason_code / status）。
		*/
		async function requestJson(url, init) {
			let response;
			try {
				response = await fetch(url, {
					cache: "no-store",
					...init,
					headers: {
						[REQUEST_HEADER]: "1",
						...init.headers
					}
				});
			} catch (error) {
				throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`);
			}
			let text = "";
			try {
				text = await response.text();
			} catch {
				text = "";
			}
			if (!response.ok) throw parseHttpError(response.status, text);
			if (text.trim() === "") return void 0;
			try {
				return JSON.parse(text);
			} catch {
				throw new Error("宿主返回的不是 JSON");
			}
		}
		/** 读取一次工作台投影（GET `/recruitment/api/overview`）。 */
		async function fetchOverview(signal) {
			return normalizeOverview(await requestJson(OVERVIEW_ENDPOINT, {
				method: "GET",
				signal
			}));
		}
		/**
		* 读取 D-89 动态面评表单 spec（GET `/recruitment/api/scorecard-form`）。
		* @param interviewId - 面试 id（UUID 文本；必须来自服务端 overview 列表）。
		* @param rubricVersionId - 可选 rubric 版本 id（服务端用它锁定维度集合）。
		* @returns 归一化后的表单 spec（dimensions 顺序与键都来自服务端）。
		*/
		async function fetchFormSpec(interviewId, rubricVersionId) {
			const query = new URLSearchParams({ interview_id: interviewId });
			if (rubricVersionId !== void 0 && rubricVersionId !== "") query.set("rubric_version_id", rubricVersionId);
			return normalizeFormSpec(await requestJson(`${SCORECARD_ENDPOINT}?${query.toString()}`, { method: "GET" }));
		}
		/**
		* 提交面评（POST `/recruitment/api/scorecard-form`）。
		*
		* 200 但工具层 `status !== 'OK'` 也按失败抛错（绝不把失败显示成假成功）。
		* @param payload - 由 spec.dimensions 构造的提交体。
		* @returns 归一化后的成功回显（scorecard id / revision_no / status / coverage）。
		* @throws {RecruitmentHttpError} 400/403/404/409 或工具层失败。
		*/
		async function submitScorecardForm(payload) {
			const value = await requestJson(SCORECARD_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			const failure = submitResultError(value);
			if (failure !== null) throw failure;
			return normalizeSubmitResult(value);
		}
		/**
		* 面板取数 hook：挂载时读一次，`reload()` 重新从服务端重取；卸载时放弃在途请求。
		* 不做轮询 / 实时推送——刷新必须是"重新 GET 服务端"，不是前端本地重算。
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
		/** 六个 actor 视角列表区的配置（顺序即渲染顺序）。 */
		const SECTIONS = [
			{
				key: "pending_decisions",
				title: "待决策",
				countKey: "pending_total",
				empty: "没有待决策"
			},
			{
				key: "my_interviews",
				title: "我的面试",
				countKey: "my_interviews_total",
				empty: "没有我的面试"
			},
			{
				key: "overdue_scorecards",
				title: "逾期/缺面评",
				countKey: "overdue_scorecards_total",
				empty: "没有逾期/缺面评"
			},
			{
				key: "pending_reviews",
				title: "待复核材料",
				countKey: "pending_reviews_total",
				empty: "没有待复核材料"
			},
			{
				key: "connector_incidents",
				title: "连接器异常",
				countKey: "connector_incidents_total",
				empty: "没有连接器异常",
				shared: "全租户共享"
			},
			{
				key: "waiting_human_tasks",
				title: "等待人工的任务",
				countKey: "waiting_human_total",
				empty: "没有等待人工的任务"
			}
		];
		/** 未分配（全租户共享）区块里的四个子区。 */
		const UNASSIGNED_SECTIONS = [
			{
				key: "pending_decisions",
				title: "未分配的待决策",
				empty: "没有未分配的待决策"
			},
			{
				key: "pending_reviews",
				title: "未分配的待复核材料",
				empty: "没有未分配的待复核材料"
			},
			{
				key: "waiting_human_tasks",
				title: "未分配的等待人工任务",
				empty: "没有未分配的等待人工任务"
			},
			{
				key: "connector_incidents",
				title: "未分配的连接器异常",
				empty: "没有未分配的连接器异常"
			}
		];
		/** 把 actor_id 取尾 8 位用于展示（避免整串 UUID 淹没标题）。 */
		function actorTail(actorId) {
			return actorId.length <= 8 ? actorId : actorId.slice(-8);
		}
		/** 渲染一条只读列表行（id + 拍平字段 + 可选"填写面评"按钮）。 */
		function ItemRow({ item, sectionKey, onOpenScorecard }) {
			const interviewId = item.interview_id !== "" ? item.interview_id : item.id;
			const canOpen = item.needs_scorecard && interviewId !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				"data-panel-section": sectionKey,
				"data-item-id": item.id,
				"data-needs-scorecard": item.needs_scorecard ? "1" : "0",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["id：", item.id !== "" ? item.id : "（服务端未提供）"] }) }),
					item.fields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						"data-field": field.key,
						children: [
							field.label,
							"：",
							field.value
						]
					}, field.key)),
					canOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"data-action": "open-scorecard",
						"data-interview-id": interviewId,
						onClick: () => onOpenScorecard(interviewId),
						children: "填写面评"
					}) }) : null
				]
			});
		}
		/** 渲染一个列表区（标题带服务端计数；空态明确写"没有…"）。 */
		function ListSection({ title, count, shared, empty, items, sectionKey, onOpenScorecard }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-section": sectionKey,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", { children: [
					title,
					"（",
					count,
					"）",
					shared !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
						"（",
						shared,
						"）"
					] }) : null
				] }), items.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: empty }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: items.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ItemRow, {
					item,
					sectionKey,
					onOpenScorecard
				}, `${item.id}-${index}`)) })]
			});
		}
		/** 读取 FormData 式 DOM 值（不依赖 React 受控，浏览器脚本可直接 set 值）。 */
		function readControl(form, role, key) {
			for (const element of Array.from(form.querySelectorAll(`[data-role="${role}"]`))) if (element.getAttribute("data-dim-key") === key) return element;
			return null;
		}
		/** 动态面评表单（D-89）：控件由服务端 spec 生成，提交体由 spec.dimensions 构造。 */
		function ScorecardForm({ state, onClose, onSubmitted }) {
			const formRef = (0, react.useRef)(null);
			const [assessments, setAssessments] = (0, react.useState)({});
			const [submitting, setSubmitting] = (0, react.useState)(false);
			const [submitError, setSubmitError] = (0, react.useState)(void 0);
			const [submitDetail, setSubmitDetail] = (0, react.useState)(void 0);
			const [result, setResult] = (0, react.useState)(void 0);
			if (state.loading) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				"data-testid": "scorecard-form",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "正在读取面评表单…" })
			});
			if (state.error !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-testid": "scorecard-form",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "alert",
					children: ["面评表单读取失败：", state.error]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: onClose,
					children: "关闭"
				})]
			});
			const spec = state.spec;
			if (spec === void 0) return null;
			const readonlyMode = spec.mode !== "CREATE";
			const scoringEnabled = (key) => assessments[key] === "MET" || assessments[key] === "NOT_MET";
			const submit = async (event) => {
				event.preventDefault();
				const form = formRef.current ?? event.currentTarget;
				const dimensions = {};
				for (const dimension of spec.dimensions) {
					const assessmentElement = readControl(form, "assessment", dimension.key);
					const assessment = assessmentElement instanceof HTMLSelectElement ? assessmentElement.value : "";
					if (assessment === "") {
						setSubmitError(`维度 ${dimension.label}（${dimension.key}）还没有选择 assessment`);
						setSubmitDetail(void 0);
						return;
					}
					let score;
					const scoreElement = readControl(form, "score", dimension.key);
					if (scoreElement instanceof HTMLInputElement && scoringEnabled(dimension.key)) {
						const raw = scoreElement.value.trim();
						if (raw !== "") {
							score = Number(raw);
							if (!Number.isInteger(score) || score < dimension.scoreMin || score > dimension.scoreMax) {
								setSubmitError(`维度 ${dimension.label}（${dimension.key}）的 score 必须是 ${dimension.scoreMin}–${dimension.scoreMax} 的整数`);
								setSubmitDetail(void 0);
								return;
							}
						}
					}
					const noteElement = readControl(form, "note", dimension.key);
					const note = noteElement instanceof HTMLTextAreaElement ? noteElement.value.trim() : "";
					if (dimension.noteRequired && note === "") {
						setSubmitError(`维度 ${dimension.label}（${dimension.key}）要求填写 note`);
						setSubmitDetail(void 0);
						return;
					}
					dimensions[dimension.key] = {
						assessment,
						...score !== void 0 ? { score } : {},
						...note !== "" ? { note } : {}
					};
				}
				const overallElement = Array.from(form.querySelectorAll("[data-role=\"overall\"]"))[0];
				const overall = overallElement === void 0 ? "" : overallElement.value;
				if (overall === "") {
					setSubmitError("还没有选择 overall 结论");
					setSubmitDetail(void 0);
					return;
				}
				setSubmitting(true);
				setSubmitError(void 0);
				setSubmitDetail(void 0);
				try {
					const submitted = await submitScorecardForm({
						interview_id: spec.interview.id !== "" ? spec.interview.id : state.interviewId,
						dimensions,
						transcript_basis: spec.transcript_basis.value,
						overall,
						...spec.mode === "REVISE" && spec.current !== null ? { revision: spec.current.revision_no } : {}
					});
					const coverageText = submitted.coverage === null || submitted.coverage === void 0 ? "未返回" : typeof submitted.coverage === "string" ? submitted.coverage : JSON.stringify(submitted.coverage);
					setResult([
						`提交成功：scorecard ${submitted.scorecard.id !== "" ? submitted.scorecard.id : "（服务端未返回 id）"}`,
						`revision_no：${submitted.scorecard.revision_no}`,
						`status：${submitted.scorecard.status !== "" ? submitted.scorecard.status : submitted.status}`,
						`coverage：${coverageText}`,
						`replayed：${submitted.replayed ? "是" : "否"}`
					]);
					onSubmitted();
				} catch (failure) {
					if (failure instanceof RecruitmentHttpError) {
						setSubmitError(`提交失败：${failure.message}`);
						setSubmitDetail([
							`code：${failure.code !== "" ? failure.code : "（无）"}`,
							`reason_code：${failure.reasonCode !== "" ? failure.reasonCode : "（无）"}`,
							failure.detail === void 0 ? "" : `detail：${JSON.stringify(failure.detail)}`
						].filter((line) => line !== "").join(" · "));
					} else {
						setSubmitError(`提交失败：${failure instanceof Error ? failure.message : String(failure)}`);
						setSubmitDetail(void 0);
					}
				} finally {
					setSubmitting(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-testid": "scorecard-form",
				"data-interview-id": spec.interview.id,
				"data-mode": spec.mode,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "面评表单" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						"面试：第 ",
						spec.interview.round_no,
						" 轮 · ",
						spec.interview.slot_code !== "" ? spec.interview.slot_code : "（未提供 slot）",
						" ·",
						" ",
						spec.interview.status !== "" ? spec.interview.status : "（未提供状态）"
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["面试 id：", spec.interview.id] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						"rubric：",
						spec.rubric.id !== "" ? spec.rubric.id : "（服务端未提供）",
						spec.rubric.payload_hash !== "" ? ` · payload_hash：${spec.rubric.payload_hash}` : ""
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						"data-testid": "transcript-basis",
						children: [
							"转写依据（只读）：",
							spec.transcript_basis.value !== "" ? spec.transcript_basis.value : "（服务端未提供）",
							spec.transcript_basis.locked ? "（已锁定）" : ""
						]
					}),
					spec.mode === "REVISE" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						"data-testid": "mode-revise",
						children: [
							"修订模式：该面试已有面评（revision ",
							spec.current?.revision_no ?? 0,
							"）。本版表单暂只读展示，提交按钮禁用—— 修订提交需服务端 revision 闭环验证后再放开。"
						]
					}) : null,
					spec.mode === "ALREADY_SUBMITTED" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						"data-testid": "mode-submitted",
						children: [
							"该面试已有已提交面评：status ",
							spec.current?.status ?? "（未知）",
							" · revision ",
							spec.current?.revision_no ?? 0,
							"（本表单只读）"
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						ref: formRef,
						"data-testid": "scorecard-form-fields",
						onSubmit: (event) => {
							if (readonlyMode) {
								event.preventDefault();
								return;
							}
							submit(event);
						},
						children: [
							spec.dimensions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								children: "服务端没有返回任何 rubric 维度，无法填写面评（fail-closed）。"
							}) : null,
							spec.dimensions.map((dimension) => {
								const enabled = scoringEnabled(dimension.key);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
									"data-dim-key": dimension.key,
									"data-dim-label": dimension.label,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("legend", { children: [
											dimension.label,
											"（",
											dimension.key,
											"）"
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
											"类型：",
											dimension.kind !== "" ? dimension.kind : "（未提供）",
											" · 权重：",
											dimension.weight
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["assessment：", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											"data-role": "assessment",
											"data-dim-key": dimension.key,
											value: assessments[dimension.key] ?? "",
											disabled: readonlyMode,
											onChange: (event) => setAssessments((previous) => ({
												...previous,
												[dimension.key]: event.target.value
											})),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: "请选择"
											}), dimension.assessmentOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: option,
												children: option
											}, option))]
										})] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["score：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "number",
											"data-role": "score",
											"data-dim-key": dimension.key,
											min: dimension.scoreMin,
											max: dimension.scoreMax,
											disabled: !enabled || readonlyMode
										}, enabled ? "enabled" : "disabled")] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["note：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											"data-role": "note",
											"data-dim-key": dimension.key,
											disabled: readonlyMode,
											rows: 2
										})] })
									]
								}, dimension.key);
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: ["overall：", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								"data-role": "overall",
								disabled: readonlyMode,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "请选择"
								}), spec.overall_options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: option,
									children: option
								}, option))]
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "submit",
									disabled: submitting || readonlyMode,
									children: submitting ? "正在提交…" : "提交面评"
								}),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: onClose,
									children: "关闭表单"
								})
							] })
						]
					}),
					submitError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						role: "alert",
						"data-testid": "submit-error",
						children: [submitError, submitDetail !== void 0 ? `（${submitDetail}）` : ""]
					}) : null,
					result !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "submit-result",
						children: [result.map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: line }, line)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "已重新读取总览（reload）。" })]
					}) : null
				]
			});
		}
		/**
		* 「待人工决定」工作台主体（main 面板内容）。
		* @returns 面板 JSX。
		*/
		function Workbench() {
			const { data, error, loading, reload } = useOverview();
			const [formState, setFormState] = (0, react.useState)(void 0);
			const openScorecard = (interviewId) => {
				setFormState({
					interviewId,
					loading: true
				});
				fetchFormSpec(interviewId).then((spec) => setFormState({
					interviewId,
					loading: false,
					spec
				})).catch((failure) => setFormState({
					interviewId,
					loading: false,
					error: failure instanceof Error ? failure.message : String(failure)
				}));
			};
			const issueText = data !== void 0 && data.issues.length > 0 ? data.issues.join("；") : "";
			const configured = data?.configured ?? false;
			const showSections = !loading && error === void 0 && data !== void 0 && configured;
			const actor = data?.actor;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				"data-testid": "recruitment-workbench",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "待人工决定" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							"data-testid": "actor-line",
							children: [
								"当前身份：",
								actor?.display_name !== void 0 && actor.display_name !== "" ? actor.display_name : "（服务端未提供 display_name）",
								actor !== void 0 && actor.actor_id !== "" ? `（${actorTail(actor.actor_id)}）` : ""
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							"data-testid": "evaluated-at",
							children: ["评估时间：", data?.evaluated_at !== void 0 && data.evaluated_at !== "" ? data.evaluated_at : "（服务端未提供）"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: reload,
							disabled: loading,
							"data-action": "refresh",
							children: loading ? "正在读取…" : "刷新"
						})
					] }),
					error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						role: "alert",
						children: ["读取失败：", error]
					}) : null,
					data !== void 0 && !configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["数据库未配置，暂时读不到数据", issueText !== "" ? `（缺少：${issueText}）` : ""] }) : null,
					data !== void 0 && configured && issueText !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["配置问题：", issueText] }) : null,
					formState !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScorecardForm, {
						state: formState,
						onClose: () => setFormState(void 0),
						onSubmitted: reload
					}, formState.interviewId) : null,
					loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "正在读取…" }) : null,
					showSections && data !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [SECTIONS.map((section) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListSection, {
						sectionKey: section.key,
						title: section.title,
						count: data.counts[section.countKey],
						..."shared" in section ? { shared: section.shared } : {},
						empty: section.empty,
						items: data.lists[section.key],
						onOpenScorecard: openScorecard
					}, section.key)), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						"data-section": "unassigned",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "未分配（全租户共享）" }),
							data.unassigned.note !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: data.unassigned.note }) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								"服务端计数：",
								data.counts.unassigned_total,
								" 条"
							] }),
							UNASSIGNED_SECTIONS.map((section) => {
								const items = data.unassigned[section.key];
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									"data-section": `unassigned_${section.key}`,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: section.title }), items.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: section.empty }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: items.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ItemRow, {
										item,
										sectionKey: `unassigned_${section.key}`,
										onOpenScorecard: openScorecard
									}, `${item.id}-${index}`)) })]
								}, section.key);
							})
						]
					})] }) : null,
					data?.contract_version !== void 0 && data.contract_version !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: ["契约版本：", data.contract_version] }) }) : null
				]
			});
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
