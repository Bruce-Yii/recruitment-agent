window.__ModuleLoader__.load({
	id: "@recruitment/dsh-recruitment",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/client/recruiting/format.ts
		/** 取非空字符串；数字/布尔/对象不算字符串（避免把坏类型伪装成文本）。 */
		function text(value, fallback = "") {
			if (typeof value === "string") {
				const trimmed = value.trim();
				return trimmed === "" ? fallback : trimmed;
			}
			return fallback;
		}
		/** 取非负有限整数；否则 0（杜绝 NaN / Infinity / 字符串数字 / 负数）。 */
		function count(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
		}
		/** 取非负有限数字；否则 null（用于 `page_count` 这类"可能没有"的字段）。 */
		function numberOrNull(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		/** 取布尔；只认严格 true（字符串 'true' 不算）。 */
		function bool(value) {
			return value === true;
		}
		/** 取普通对象；null / 数组 / 标量一律降级成空对象。 */
		function record(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		}
		/** 取数组；非数组降级成空数组（调用方自行过滤元素）。 */
		function items(value) {
			return Array.isArray(value) ? value : [];
		}
		/** 字符串数组归一化：丢弃非字符串 / 空白项，保留顺序。 */
		function stringList(value) {
			const out = [];
			for (const item of items(value)) if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
			return out;
		}
		/** 只保留白名单里的枚举值；未知值降级成 `''`（不把未知枚举渲染成合法选项）。 */
		function oneOf(value, allowed) {
			const candidate = text(value);
			return allowed.includes(candidate) ? candidate : "";
		}
		/** 把若干文本拼成一句（跳过空串），默认分隔符 ` · `。 */
		function joinTexts(parts, separator = " · ") {
			return parts.filter((part) => part !== "").join(separator);
		}
		/** 本地时区 `YYYY-MM-DD HH:mm`；null / 空串 / 非法日期 → `''`。 */
		function formatDateTime(value) {
			const raw = text(value);
			if (raw === "") return "";
			const parsed = new Date(raw);
			const time = parsed.valueOf();
			if (!Number.isFinite(time)) return "";
			return `${formatDateParts(parsed)} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
		}
		/** 字节数 → 可读体量（B / KB / MB / GB）。0 → `0 B`；负数 / 非数字 / null → `''`。 */
		function formatBytes(value) {
			const bytes = numberOrNull(value);
			if (bytes === null) return "";
			if (bytes === 0) return "0 B";
			const units = [
				"B",
				"KB",
				"MB",
				"GB"
			];
			let size = bytes;
			let unit = 0;
			while (size >= 1024 && unit < units.length - 1) {
				size /= 1024;
				unit += 1;
			}
			return unit === 0 ? `${String(Math.round(size))} B` : `${size.toFixed(1)} ${units[unit]}`;
		}
		/** sha256 截断展示：64 位十六进制 → 前 10 位 + `…`；短文本原样返回；空 → `''`。 */
		function shortSha(value) {
			const raw = text(value);
			if (raw === "") return "";
			if (/^[0-9a-fA-F]{16,}$/.test(raw)) return `${raw.slice(0, 10)}…`;
			return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
		}
		/** 头像里的首字（中文取第一个字符；空 → `·`）。 */
		function initial(value) {
			const raw = text(value);
			return raw === "" ? "·" : Array.from(raw)[0] ?? "·";
		}
		/** 任意未知值的一行预览（用于 rubric 的 `value` 这类无契约字段；不渲染 `[object Object]`）。 */
		function preview(value, maxLength = 108) {
			if (value === null || value === void 0) return "";
			if (typeof value === "string") {
				const trimmed = value.trim();
				return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
			}
			if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
			if (typeof value === "boolean") return value ? "是" : "否";
			if (Array.isArray(value)) {
				const parts = [];
				for (const item of value.slice(0, 8)) {
					const rendered = preview(item, 32);
					if (rendered !== "") parts.push(rendered);
				}
				return parts.join("、");
			}
			try {
				const serialized = JSON.stringify(value);
				if (typeof serialized !== "string") return "";
				return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
			} catch {
				return "";
			}
		}
		/** 两位补零。 */
		function pad2(value) {
			return value < 10 ? `0${String(value)}` : String(value);
		}
		/** 本地 `YYYY-MM-DD`。 */
		function formatDateParts(date) {
			return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
		}
		// src/client/recruiting/actions.ts
		/** 决策事实只读投影（GET；`?application_id=<uuid>`）。 */
		const DECISION_FACTS_PATH = "/recruitment/api/decision/facts";
		/** 执行初筛评估（POST，Human Host Action）。 */
		const DECISION_EVALUATE_PATH = "/recruitment/api/decision/screening/evaluate";
		/** 正式决策 facade（POST，body 由服务端从 facts 组装 basis）。 */
		const DECISION_RECORD_PATH = "/recruitment/api/decision/record";
		/** 岗位草案生成（POST，只读不写库）。 */
		const JOB_DRAFT_PATH = "/recruitment/api/job-action/job/draft";
		/** 人确认后的岗位创建（POST）。 */
		const JOB_CREATE_PATH = "/recruitment/api/job-action/job/create";
		/** 岗位关闭（POST；信封见 `work/d5/joblife/CONTRACT.md` §1）。 */
		const JOB_CLOSE_PATH = "/recruitment/api/job-action/job/close";
		/**
		* 客户端永不上送的身份 / 服务端派生键（命中即 400 `ACTOR_OVERRIDE_REJECTED`，本层发送前就拒绝）。
		*
		* 出处：`work/d5/actions/CONTRACT.md` §0.4 的 11 个身份键 + 决策端点额外禁止的 5 个派生键。
		* 注意：只匹配**顶层精确键**；`basis_refs[].actor_id`、`interviewers[].actor_id` 是正常业务数据。
		*/
		const ACTION_RESERVED_BODY_KEYS = [
			"actor_id",
			"tenant_id",
			"actor",
			"tenant",
			"alias",
			"actor_alias",
			"decided_by_actor_id",
			"confirmed_by_actor_id",
			"created_by_actor_id",
			"approved_by_actor_id",
			"submitted_by_actor_id",
			"human_confirmation",
			"approval_id",
			"stage_code",
			"decided_at",
			"status"
		];
		/** 决策端点封闭结果集（`HIRED` 在 v1.0 禁用）。 */
		const SCREENING_RESULTS = [
			"ADVANCE",
			"HOLD",
			"WITHDRAW",
			"REJECT"
		];
		/** facade 决策结果集（`work/d5/decision/CONTRACT.md` §3）。 */
		const RECORD_RESULTS = [
			"ADVANCE",
			"HOLD",
			"REJECT"
		];
		/** 决策 scope。 */
		const DECISION_SCOPES = ["STAGE", "FINAL"];
		/** transcript 来源封闭集（`work/d5/actions/CONTRACT.md` §3.2）。 */
		const TRANSCRIPT_SOURCE_KINDS = ["PLATFORM_EXPORT", "DEMO_SAMPLE"];
		/** 设置实体封闭集（`work/d5/actions/CONTRACT.md` §4.2）。 */
		const CONFIG_ENTITIES = [
			"role",
			"team",
			"pipeline"
		];
		/** 设置写 operation 封闭集（读 operation 一律拒绝：`READ_OPERATION_NOT_EXPOSED`）。 */
		const CONFIG_WRITE_OPERATIONS = {
			role: ["create", "update"],
			team: [
				"create",
				"update",
				"add_member",
				"remove_member"
			],
			pipeline: [
				"create",
				"update",
				"add_stage",
				"add_stage_template"
			]
		};
		/** 岗位创建初始状态（`src/tools/job-create.ts` 的 CREATE_STATUSES）。 */
		const JOB_CREATE_STATUSES = ["DRAFT", "OPEN"];
		/** rubric criterion 的封闭 kind（`src/tools/job-create.ts`）。 */
		const CRITERION_KINDS = [
			"MUST_HAVE",
			"NICE_TO_HAVE",
			"DISQUALIFIER"
		];
		/** UUID 文本形态（服务端 `isUuid` 同口径；不做版本位归一）。 */
		const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		/** 带时区偏移的 ISO-8601（`Z` 或 `±HH:MM`；裸本地时间会被服务端拒绝）。 */
		const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
		/** `idempotency_key` 字符集（`work/d5/actions/CONTRACT.md` §3.1）。 */
		const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
		/** 岗位 code（`src/tools/job-create.ts`：`^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$`）。 */
		const JOB_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$/;
		/** 造一个失败预检；reasonText 写给运维/验收看（含契约出处）。 */
		function fail(reasonCode, reasonText, missing = []) {
			return {
				ok: false,
				reasonCode,
				reasonText,
				missing: missing.length > 0 ? [...missing] : [reasonCode]
			};
		}
		/** 造一个成功预检。 */
		function ok(body) {
			return {
				ok: true,
				body
			};
		}
		/** 精确保留键自检（顶层精确键；命中即服务端 400，客户端不该发出）。 */
		function reservedKeysOf(body) {
			return Object.keys(body).filter((key) => ACTION_RESERVED_BODY_KEYS.includes(key)).sort();
		}
		/** 组包末尾统一做保留键自检（所有 build* 共用，避免某条漏掉）。 */
		function finish(body) {
			const reserved = reservedKeysOf(body);
			if (reserved.length > 0) return fail("CLIENT_RESERVED_KEY", `body 含客户端禁止上送的身份/服务端派生键：${reserved.join(", ")}（服务端会 400 ACTOR_OVERRIDE_REJECTED，客户端不发送）`, reserved);
			return ok(body);
		}
		/** 字符串是否 UUID 形态。 */
		function isUuid(value) {
			return UUID_RE.test(value);
		}
		/** 字符串是否带时区偏移的 ISO-8601。 */
		function isOffsetIso(value) {
			return value !== "" && OFFSET_ISO_RE.test(value) && Number.isFinite(Date.parse(value));
		}
		/** 校验一个必填 UUID 字段；不合法时把 missing 键追加进去。 */
		function requireUuid(value, field, missing) {
			if (value === "") {
				missing.push(field);
				return false;
			}
			if (!isUuid(value)) {
				missing.push(`${field}:ID_NOT_UUID`);
				return false;
			}
			return true;
		}
		/** 字符串长度（按 Unicode 码点，避免 emoji 撑爆长度校验）。 */
		function charLength(value) {
			return Array.from(value).length;
		}
		/** 取人话标题（读回行的 label：已知键给中文，未知键原样）。 */
		const READBACK_LABELS = {
			application_id: "申请 id",
			job_id: "岗位 id",
			interview_id: "面试 id",
			decision_id: "决策 id",
			artifact_id: "产物 id",
			status: "状态",
			lifecycle_status: "申请状态",
			stage_code: "阶段码",
			record_version: "记录版本",
			actor_id: "执行账号 actor",
			stage_changed_at: "阶段变更时间",
			stage_entered_at: "进入阶段时间",
			decision_scope: "决策范围",
			result: "结论",
			decided_at: "决策时间",
			is_current: "是否当前有效",
			superseded_by_decision_id: "被取代为",
			round_no: "轮次",
			slot_code: "时段码",
			scheduled_start_at: "开始时间",
			scheduled_end_at: "结束时间",
			timezone: "时区",
			interviewers: "面试官分配",
			job: "岗位",
			rubric: "Rubric",
			approval: "审批",
			members: "团队成员",
			stages: "流水线阶段",
			meeting_id: "会议 id",
			provenance: "数据来源",
			trigger_mode: "触发方式",
			connection_state: "连接状态",
			content_sha256: "正文 sha256",
			segment_count: "分段数",
			replayed: "是否幂等重放",
			contract_version: "契约版本",
			"readback.table": "读回表",
			decision: "决策行",
			evaluation: "初筛评估",
			basis_refs: "决策依据（服务端组装）"
		};
		/** 任意值 → 原样文本（对象/数组 JSON 序列化并截断；不做业务翻译）。 */
		function rawValueText(value, maxLength = 400) {
			if (value === null) return "null";
			if (typeof value === "string") return value;
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			if (value === void 0) return "";
			const serialized = preview(value, maxLength);
			return serialized !== "" ? serialized : "";
		}
		/** 把 2xx 响应体解析成普通对象；空体 / 非 JSON / 数组 → null（不编造）。 */
		function parseActionPayload(bodyText) {
			const body = bodyText.trim();
			if (body === "") return null;
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				return null;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			return parsed;
		}
		/** 解析标准写动作信封（`{action,actor,approval,result,readback}`）；不合法 → null。 */
		function parseActionEnvelope(bodyText) {
			const payload = parseActionPayload(bodyText);
			if (payload === null) return null;
			const action = text(payload.action);
			if (action === "") return null;
			const actorRaw = record(payload.actor);
			const approvalRaw = record(payload.approval);
			const toRecordOrNull = (value) => {
				if (value === null || value === void 0) return null;
				if (typeof value !== "object" || Array.isArray(value)) return null;
				return value;
			};
			return {
				action,
				actor: {
					sessionId: text(actorRaw.session_id),
					alias: text(actorRaw.alias),
					actorId: text(actorRaw.actor_id)
				},
				approval: {
					requested: count(approvalRaw.requested),
					result: text(approvalRaw.result),
					toolNames: stringList(approvalRaw.tool_names)
				},
				result: toRecordOrNull(payload.result),
				readback: toRecordOrNull(payload.readback)
			};
		}
		/** `terminated` 的八个计数键（逐字；少一个就 parse 失败，不编造 0）。 */
		const TERMINATED_COUNT_KEYS = [
			"applications_total",
			"applications_closed",
			"applications_already_closed",
			"interviews_cancelled",
			"interviews_already_terminal",
			"interviews_occurred_kept",
			"tasks_cancelled",
			"task_attempts_cancelled"
		];
		/** 读一个必填非负整数计数（缺失/非数字 → null）。 */
		function requiredCount(source, key) {
			const value = source[key];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
			return value;
		}
		/** 解析 `job/close` 200 信封（键名逐字；任一必填键缺失/坏类型 → null）。 */
		function parseJobCloseEnvelope(bodyText) {
			const payload = parseActionPayload(bodyText);
			if (payload === null) return null;
			const contractVersion = text(payload.contract_version);
			if (contractVersion === "") return null;
			const job = record(payload.job);
			const actor = record(payload.actor);
			const terminatedRaw = record(payload.terminated);
			const jobId = text(job.job_id);
			const status = text(job.status);
			const recordVersion = job.record_version;
			if (jobId === "" || status === "") return null;
			if (typeof recordVersion !== "number" || !Number.isFinite(recordVersion) || recordVersion < 0) return null;
			if (typeof payload.replayed !== "boolean") return null;
			const counts = [];
			for (const key of TERMINATED_COUNT_KEYS) {
				const value = requiredCount(terminatedRaw, key);
				if (value === null) return null;
				counts.push(value);
			}
			return {
				contractVersion,
				job: {
					jobId,
					status,
					recordVersion,
					statusChangedAt: text(job.status_changed_at),
					statusChangedByActorId: text(job.status_changed_by_actor_id)
				},
				terminated: {
					applicationsTotal: counts[0],
					applicationsClosed: counts[1],
					applicationsAlreadyClosed: counts[2],
					interviewsCancelled: counts[3],
					interviewsAlreadyTerminal: counts[4],
					interviewsOccurredKept: counts[5],
					tasksCancelled: counts[6],
					taskAttemptsCancelled: counts[7]
				},
				actor: {
					actorId: text(actor.actor_id),
					alias: text(actor.alias),
					displayName: text(actor.display_name)
				},
				replayed: payload.replayed
			};
		}
		/** 终止计数 → 人读行（顺序固定；缺失数值由 parse 拦掉，这里是纯展示）。 */
		function terminatedLines(terminated) {
			return [
				`本次进入终止范围的申请：${String(terminated.applicationsTotal)} 条`,
				`实际终止（UPDATE 命中）：${String(terminated.applicationsClosed)} 条`,
				`此前已关闭（只计数、不写）：${String(terminated.applicationsAlreadyClosed)} 条`,
				`取消的未开始面试：${String(terminated.interviewsCancelled)} 场`,
				`已终态面试（不碰）：${String(terminated.interviewsAlreadyTerminal)} 场`,
				`已发生/进行中的面试（保留、不伪造取消）：${String(terminated.interviewsOccurredKept)} 场`,
				`取消的未完成任务：${String(terminated.tasksCancelled)} 个`,
				`取消的任务尝试：${String(terminated.taskAttemptsCancelled)} 个`
			];
		}
		/** 已知 `code` / `code/reason_code` → 人话补救说明（未知码返回 ''，界面仍显示服务端原文）。 */
		const ERROR_ADVICE = {
			"FORBIDDEN/SAME_ORIGIN_REQUIRED": "写动作只接受本机同源请求（127.0.0.1/localhost 且带 x-recruitment-request: 1）；不要跨源调用",
			"FORBIDDEN/ACTOR_NOT_AUTHORIZED": "当前身份无权执行招聘写动作；请切换到 Recruiter 身份（面试官只能提交本人面评）",
			"FORBIDDEN/APPROVAL_UNAVAILABLE": "宿主的 approval 通道不可用（D-79 闸门未装配），本次没有写库",
			"FORBIDDEN/APPROVAL_NOT_GRANTED": "人类确认闸门未放行（本次请求的 allow-once 已用过或未授权）",
			"DECISION_REQUIRES_HUMAN/NO_HUMAN_CONFIRMATION": "缺少人工确认：服务端本应派生 IN_APP_CONFIRM，出现此码说明实现异常",
			"INVALID_ARGS/SESSION_REQUIRED": "缺 x-dsh-session：先在工作台完成身份选择（PUT /recruitment/api/actor）再重试",
			"INVALID_ARGS/SESSION_ID_INVALID": "x-dsh-session 形态非法（必须是 session-<uuid> 或裸 UUID）",
			"DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND": "当前 session 未绑定 alias（刷新或宿主重启会丢失）；重新选择身份后重试",
			"INVALID_ARGS/ACTOR_OVERRIDE_REJECTED": "请求里出现了身份或服务端派生键，服务端一律拒绝；这是客户端实现缺陷（本 UI 已在发送前自检）",
			"INVALID_ARGS/MISSING_REQUIRED": "必填字段缺失：按表单提示补齐后重试",
			"INVALID_ARGS/ID_NOT_UUID": "id 不是 UUID 形态：请从服务端投影里选择，不要手工输入",
			"INVALID_ARGS/ENUM_INVALID": "枚举值不在契约封闭集内",
			"INVALID_ARGS/OUT_OF_RANGE": "字段超出契约范围",
			"INVALID_ARGS/UNKNOWN_PARAM": "出现了契约不允许的字段",
			"INVALID_ARGS/SCOPE_MISMATCH": "决策范围与端点不符：初筛用 screening/decide，正式决策用 decision/record",
			"INVALID_ARGS/STAGE_REQUIRES_INTERVIEW": "STAGE 决策必须带面试 id",
			"INVALID_ARGS/FINAL_SCOPE_NO_INTERVIEW": "FINAL 决策不能带面试 id",
			"INVALID_ARGS/SCREENING_SCOPE_NO_SUMMARY": "SCREENING 决策不能带 summary_digest",
			"INVALID_ARGS/AS_OF_IN_FUTURE": "as_of 晚于服务端当前时间：必须原样使用 facts 里的 as_of，不要用本地时间",
			"INVALID_ARGS/TIMESTAMP_WITHOUT_OFFSET": "时间必须带时区偏移（ISO-8601），裸本地时间会被拒绝",
			"INVALID_ARGS/START_IN_PAST": "排期开始时间已过去：请选择将来时间",
			"INVALID_ARGS/ROUND_OUT_OF_RANGE": "轮次必须是 1..20 的整数",
			"INVALID_ARGS/DURATION_OUT_OF_RANGE": "面试时长必须是 15..480 分钟",
			"INVALID_ARGS/INTERVIEWER_REQUIRED": "至少需要一名面试官",
			"INVALID_ARGS/DUPLICATE_INTERVIEWER": "面试官重复：同一 actor 只能出现一次",
			"INVALID_ARGS/IDEMPOTENCY_KEY_REUSED": "同一 idempotency_key 用在了不同参数上（重试必须复用同一份参数）",
			"INVALID_ARGS/EXPORT_FILE_NAME_REQUIRED": "PLATFORM_EXPORT 必须填写平台导出的文件名",
			"INVALID_ARGS/REASON_REQUIRED": "该动作需要填写理由",
			"INVALID_ARGS/SUMMARY_STALE": "as_of 与汇总时不一致：必须原样回传 facts 里的 as_of",
			"INVALID_ARGS/CONFIRM_REQUIRED": "关闭岗位必须显式确认（confirm: true）",
			"INVALID_ARGS/UNKNOWN_BODY_KEY": "请求体出现封闭键集之外的键",
			"INVALID_ARGS/UNKNOWN_ENTITY": "设置实体只能是 role / team / pipeline",
			"INVALID_ARGS/READ_OPERATION_NOT_EXPOSED": "写入口只接受写 operation（create/update/…）；读操作走只读投影",
			"CLIENT_REFUSED": "客户端拒绝发送：动作不可用 / seam 非同源 / 缺必要事实（见 reason_code）",
			"CLIENT_REFUSED/CLIENT_RESERVED_KEY": "body 含身份/服务端派生键，客户端拒绝发送（服务端也会 400）",
			"CLIENT_REFUSED/EMPTY_BODY": "写请求 body 为空：必须由 build* 产出（固定发 {} 会被 400）",
			"CLIENT_REFUSED/SESSION_MISSING": "缺少当前 DSH session id（只能由宿主 props 传入，不读 localStorage）",
			"CLIENT_REFUSED/UNSAFE_SEAM": "动作 seam 不是同源 /recruitment/ 相对路径，客户端拒绝发送",
			"CLIENT_REFUSED/ACTION_NOT_AVAILABLE": "服务端声明该动作不可用（available=false）；客户端不发送请求",
			"CLIENT_RESERVED_KEY": "body 含身份/服务端派生键，客户端拒绝发送（服务端也会 400）",
			"NOT_FOUND": "对象不存在（申请/面试/rubric/岗位/会议）；先刷新服务端投影再重试",
			"VERSION_CONFLICT": "并发冲突：记录版本已被他人更新；重新读取后用最新版本重试",
			"ALREADY_DECIDED": "该申请已有当前有效决策（uq_decision_current）；如需改判走 supersedes",
			"ALREADY_SCHEDULED": "该轮已排期；改时间要走 RESCHEDULE",
			"ALREADY_EXISTS": "同 code 的对象已存在；换一个 code",
			"CONFLICT_SLOT": "时段冲突：该面试官/时段已被占用",
			"BLOCKED_BY_REVIEW": "有评审未完成，动作被前置事实阻塞",
			"NO_RUBRIC": "岗位没有可用 rubric；先批准 rubric",
			"NO_TRANSCRIPT": "该面试没有可用 transcript",
			"EVIDENCE_INSUFFICIENT": "证据不足（决策汇总门禁）：先补面评/汇总",
			"NOT_CONFIGURED": "数据库/连接器未配置，写动作不可用（不是\"没有数据\"）",
			"INVALID_REFERENCE": "引用的部门 / actor / 阶段 / 面试模板不存在",
			"SUMMARY_MISSING": "正式决策需要 evaluation summary：facts 里 summary 不可用，不允许记录决策",
			"MISSING_SUMMARY": "服务端 facade 拿不到汇总（MISSING_SUMMARY），零写入",
			"DECISION_FACTS_MISSING": "决策事实投影缺失：无法组装 as_of/basis_refs，客户端不发请求",
			"DECISION_FACTS_ROUTE_MISSING": "决策事实只读路由未接线（GET /recruitment/api/decision/facts 404）",
			"DECISION_FACTS_ERROR": "决策事实读取失败（看服务端原文）；先修好 facts 路由/身份再重试",
			"DECISION_FACTS_LOADING": "正在读取决策事实投影：读完后表单才可提交",
			"MISSING_RUBRIC_PAYLOAD_HASH": "facts 缺 rubric 的 payload_hash：客户端不编造 rubric 哈希，SCREENING 决策 disabled",
			"MISSING_AUTHORITY_FACTS": "facts 缺 AUTHORITY（actor_id / is_hiring_manager）：客户端不编造权威事实",
			"MISSING_SCREENING_EVALUATION": "ADVANCE/REJECT 必须先执行初筛评估（facts.screening_evaluation 六个字段齐全）",
			"MISSING_AS_OF": "facts 没有 as_of：客户端不用本地时间造 as_of（会 SUMMARY_STALE），不发送",
			"APPLICATION_MISMATCH": "facts 与当前申请不一致（页面数据过期）：刷新后重试",
			"SCREENING_EVALUATION_PRESENT": "facts 已有初筛评估：无需重复执行（如需重评走服务端方法）",
			"SUMMARY_DIGEST_MISSING": "facts 缺 summary_digest：正式决策 disabled",
			"NETWORK": "网络请求失败：检查宿主是否还在运行",
			"BAD_RESPONSE": "宿主响应不是可解析 JSON / 信封不可用：不当作成功",
			"READBACK_MISSING": "服务端写事务已提交但读回不到行：数据异常，不要当作成功",
			"INTERNAL": "服务端内部错误（不是业务结论）"
		};
		/** 服务端错误码 → 人话补救（未知返回 ''；不吞服务端 message）。 */
		function describeActionError(code, reasonCode) {
			const byPair = ERROR_ADVICE[`${code}/${reasonCode}`];
			if (byPair !== void 0) return byPair;
			const byCode = ERROR_ADVICE[code];
			if (byCode !== void 0) return byCode;
			const byReason = ERROR_ADVICE[reasonCode];
			if (byReason !== void 0) return byReason;
			return "";
		}
		/**
		* GET 同路径探测状态映射（**不许**用 POST 空 body 探测：会打日志/可能触发闸门）。
		* @param status - GET 同路径的 HTTP 状态码（0 = 网络失败）。
		*/
		function interpretRouteProbe(status) {
			if (status === 405) return "AVAILABLE";
			if (status === 404) return "MISSING";
			if (status === 403) return "FORBIDDEN";
			return "UNKNOWN";
		}
		/**
		* `GET /recruitment/api/job-action/job/close` 的状态 → 人读结论（405 = 已注册 POST 路由；404 = 未接线；403 = 同源问题）。
		* @param status - GET 同路径的 HTTP 状态码（0 = 网络失败）。
		*/
		function interpretCloseProbe(status) {
			const state = interpretRouteProbe(status);
			if (state === "AVAILABLE") return {
				state,
				status,
				reasonText: "路由已注册（GET 返回 405，只接受 POST）；确认关闭会真的写库"
			};
			if (state === "MISSING") return {
				state,
				status,
				reasonText: "路由未接线（GET 返回 404）；关闭岗位不可用，客户端不发请求"
			};
			if (state === "FORBIDDEN") return {
				state,
				status,
				reasonText: "同源/身份校验失败（GET 返回 403）；先完成身份选择并用同源页面操作"
			};
			return {
				state,
				status,
				reasonText: status === 0 ? "探测请求网络失败（宿主可能未运行）" : `探测返回未知状态 HTTP ${String(status)}`
			};
		}
		/** 归一化 facts 里的 `missing[]`（只保留有 key 的条目）。 */
		function normalizeMissing(value) {
			const out = [];
			for (const item of items(value)) {
				const entry = record(item);
				const key = text(entry.key);
				if (key === "") continue;
				out.push({
					key,
					reason: text(entry.reason)
				});
			}
			return out;
		}
		/** 归一化 `rubric_version` 子对象（缺 id/payload_hash → null）。 */
		function normalizeRubricBinding(value) {
			const raw = record(value);
			const id = text(raw.id);
			const payloadHash = text(raw.payload_hash);
			if (id === "" || payloadHash === "") return null;
			return {
				id,
				payloadHash
			};
		}
		/** 归一化 `authority` 子对象（缺 actor_id 或 is_hiring_manager 非布尔 → null，不猜 false）。 */
		function normalizeAuthority(value) {
			const raw = record(value);
			const actorId = text(raw.actor_id);
			const isHiringManager = raw.is_hiring_manager;
			if (actorId === "" || typeof isHiringManager !== "boolean") return null;
			return {
				actorId,
				isHiringManager
			};
		}
		/** 归一化 `screening_evaluation`（缺 evaluation_id 与 digest → null）。 */
		function normalizeFactsEvaluation(value) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			const evaluationId = text(raw.evaluation_id);
			const evaluationDigest = text(raw.evaluation_digest);
			if (evaluationId === "" && evaluationDigest === "") return null;
			return {
				evaluationId,
				evaluationDigest,
				verdict: text(raw.verdict),
				rubricVersionId: text(raw.rubric_version_id),
				rubricPayloadHash: text(raw.rubric_payload_hash),
				resumeVersionId: text(raw.resume_version_id),
				resumeContentSha256: text(raw.resume_content_sha256),
				asOf: text(raw.as_of),
				criteriaEvaluated: items(raw.criteria_evaluated),
				counts: record(raw.counts)
			};
		}
		/** 归一化 `evaluation_summary`（null → null；字段缺失保留空值，由 build* 判 missing）。 */
		function normalizeFactsSummary(value) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			if (Object.keys(raw).length === 0) return null;
			return {
				available: raw.available === true,
				asOf: text(raw.as_of),
				summaryDigest: text(raw.summary_digest),
				warningCount: count(raw.warning_count),
				source: text(raw.source)
			};
		}
		/** 归一化 `basis.screening_decide`（空对象 → null）。 */
		function normalizeScreeningBasis(value) {
			const raw = record(value);
			if (Object.keys(raw).length === 0) return null;
			const evaluationRaw = record(raw.screening_evaluation);
			const evaluationId = text(evaluationRaw.evaluation_id);
			const evaluationDigest = text(evaluationRaw.evaluation_digest);
			return {
				rubricVersion: normalizeRubricBinding(raw.rubric_version),
				authority: normalizeAuthority(raw.authority),
				screeningEvaluation: evaluationId === "" && evaluationDigest === "" ? null : {
					evaluationId,
					evaluationDigest,
					verdict: text(evaluationRaw.verdict)
				}
			};
		}
		/** 归一化 `basis.decision_record`（空对象 → null）。 */
		function normalizeRecordBasis(value) {
			const raw = record(value);
			if (Object.keys(raw).length === 0) return null;
			return {
				asOf: text(raw.as_of),
				summaryDigest: text(raw.summary_digest),
				rubricVersion: normalizeRubricBinding(raw.rubric_version),
				authority: normalizeAuthority(raw.authority)
			};
		}
		/**
		* 归一化 `GET /recruitment/api/decision/facts` 响应（严格容错：坏类型 → null/缺省，不编造 hash/actor）。
		* @param value - 原始 JSON。
		* @returns 缺少 `application_id`（无法归属申请）时返回 null。
		*/
		function normalizeDecisionFacts(value) {
			const raw = record(value);
			const applicationId = text(raw.application_id);
			if (applicationId === "") return null;
			const basisRaw = record(raw.basis);
			return {
				contractVersion: text(raw.contract_version),
				applicationId,
				stageCode: text(raw.stage_code),
				missing: normalizeMissing(raw.missing),
				screeningEvaluation: normalizeFactsEvaluation(raw.screening_evaluation),
				evaluationSummary: normalizeFactsSummary(raw.evaluation_summary),
				basisScreeningDecide: normalizeScreeningBasis(basisRaw.screening_decide),
				basisDecisionRecord: normalizeRecordBasis(basisRaw.decision_record)
			};
		}
		/** facts 里某键是否登记为 missing（key 精确匹配）。 */
		function factsMissingKeys(facts) {
			return facts.missing.map((entry) => entry.key);
		}
		/**
		* `stage/advance` body（唯一键 `application_id`；目标阶段由服务端按已发生事实推导）。
		* 出处：`work/d5/actions/CONTRACT.md` §2.2。
		*/
		function buildStageAdvanceBody(input) {
			const applicationId = text(input.applicationId);
			const missing = [];
			if (!requireUuid(applicationId, "application_id", missing)) return fail(missing.some((entry) => entry.endsWith(":ID_NOT_UUID")) ? "ID_NOT_UUID" : "MISSING_APPLICATION_ID", "申请 id 缺失或不是 UUID；阶段推进只提交 application_id，服务端按已发生事实推导目标阶段", missing);
			return finish({ application_id: applicationId });
		}
		/** SCREENING 决策可用的 as_of（服务端原样值：优先初筛评估，其次汇总/记录 basis；都没有 → ''）。 */
		function screeningDecisionAsOf(facts) {
			if (facts.screeningEvaluation !== null && facts.screeningEvaluation.asOf !== "") return facts.screeningEvaluation.asOf;
			if (facts.evaluationSummary !== null && facts.evaluationSummary.asOf !== "") return facts.evaluationSummary.asOf;
			return facts.basisDecisionRecord?.asOf ?? "";
		}
		/**
		* SCREENING 决策表单的结构性阻塞原因（facts 事实缺失；**空数组 = 事实齐全，可提交**）。
		* 组件据此 disabled + 显示 reasonCode（不发请求）；与 `buildScreeningDecisionBody` 同一判据。
		* @param facts - 决策事实投影（null = 路由缺失/未读取）。
		* @param needsEvaluation - 当前选择的结论是否要求 SCREENING_EVALUATION（ADVANCE/REJECT 要求）。
		*/
		function screeningDecisionBlockers(facts, needsEvaluation) {
			if (facts === null) return ["DECISION_FACTS_MISSING"];
			const out = [];
			const basis = facts.basisScreeningDecide;
			if (basis === null || basis.rubricVersion === null) out.push("MISSING_RUBRIC_PAYLOAD_HASH");
			if (basis === null || basis.authority === null) out.push("MISSING_AUTHORITY_FACTS");
			const asOf = screeningDecisionAsOf(facts);
			if (asOf === "") out.push("MISSING_AS_OF");
			else if (!isOffsetIso(asOf)) out.push("AS_OF_WITHOUT_OFFSET");
			if (needsEvaluation) {
				const evaluation = facts.screeningEvaluation;
				if (!(evaluation !== null && evaluation.evaluationDigest !== "" && evaluation.verdict !== "" && evaluation.rubricVersionId !== "" && evaluation.rubricPayloadHash !== "" && evaluation.resumeVersionId !== "" && evaluation.resumeContentSha256 !== "")) out.push("MISSING_SCREENING_EVALUATION");
			}
			return out;
		}
		/**
		* `POST /recruitment/api/decision/record`（facade）表单的结构性阻塞原因（**空数组 = 可提交**）。
		* summary 不可用 → `SUMMARY_MISSING`（契约 §3：facade 拿不到汇总时服务端如实 400，客户端先拦住）。
		* @param facts - 决策事实投影（null = 路由缺失/未读取）。
		*/
		function decisionRecordBlockers(facts) {
			if (facts === null) return ["DECISION_FACTS_MISSING"];
			const summary = facts.evaluationSummary;
			const out = [];
			if (summary === null || !summary.available || summary.summaryDigest === "" || summary.asOf === "") out.push("SUMMARY_MISSING");
			else if (!isOffsetIso(summary.asOf)) out.push("MISSING_AS_OF");
			if (facts.basisDecisionRecord === null) out.push("MISSING_DECISION_BASIS");
			return out;
		}
		/**
		* 结构性阻塞码 → HR 人话（O6：机器码不进可见文案；未知码给中性兜底，原文仍在数据层）。
		* @param code - `screeningDecisionBlockers` / `decisionRecordBlockers` 产出的封闭码。
		* @returns 可读的缺什么说明。
		*/
		function blockerTextOf(code) {
			return {
				DECISION_FACTS_MISSING: "决策依据还没有读取",
				MISSING_RUBRIC_PAYLOAD_HASH: "评分标准快照还没有准备好",
				MISSING_AUTHORITY_FACTS: "审批 / 授权依据还没有准备好",
				MISSING_AS_OF: "决策时点还没有生成",
				AS_OF_WITHOUT_OFFSET: "决策时点缺少时区（请刷新后重试）",
				MISSING_SCREENING_EVALUATION: "还没有初筛评估",
				SUMMARY_MISSING: "决策汇总还没有生成",
				MISSING_DECISION_BASIS: "决策依据还没有准备好"
			}[code] ?? "还有一项前置事实没有准备好";
		}
		/**
		* `screening/decide` body：`{application_id, as_of, result, reason, basis_refs[]}`。
		*
		* basis_refs **只能**从 facts 组装（`RUBRIC_VERSION` / `AUTHORITY` / `SCREENING_EVALUATION`）：
		*   · SCREENING_EVALUATION 不带 `evaluation_id`（不在允许键集）；
		*   · ADVANCE/REJECT 必须有 SCREENING_EVALUATION；HOLD/WITHDRAW 有则带、没有也可。
		* facts 缺失 → `DECISION_FACTS_MISSING`（不发请求，不编造 hash/as_of）。
		* 出处：`work/d5/w2b/INTERFACE2.md` §2 + `work/d5/actions/CONTRACT.md` §2.1。
		*/
		function buildScreeningDecisionBody(input) {
			const facts = input.facts;
			if (facts === null) return fail("DECISION_FACTS_MISSING", "决策事实投影（GET /recruitment/api/decision/facts）不可用；客户端不编造 as_of / basis_refs，不发送请求", ["facts"]);
			const applicationId = text(input.applicationId) || facts.applicationId;
			const missing = [];
			if (!requireUuid(applicationId, "application_id", missing)) return fail("ID_NOT_UUID", "申请 id 缺失或不是 UUID", missing);
			if (applicationId !== facts.applicationId) return fail("APPLICATION_MISMATCH", `facts 属于申请 ${facts.applicationId}，与当前申请 ${applicationId} 不一致；请刷新后重试`, ["facts.application_id"]);
			const result = text(input.result);
			if (!SCREENING_RESULTS.includes(result)) return fail("ENUM_INVALID", `result 只能是 ${SCREENING_RESULTS.join(" / ")}（HIRED 在 v1.0 禁用）`, ["result"]);
			const reason = typeof input.reason === "string" ? input.reason.trim() : "";
			if (reason === "") return fail("MISSING_REASON", "初筛结论必须填写理由（1..4000 字）", ["reason"]);
			if (charLength(reason) > 4e3) return fail("REASON_OUT_OF_RANGE", "理由不得超过 4000 字", ["reason"]);
			const asOf = screeningDecisionAsOf(facts);
			if (asOf === "") return fail("MISSING_AS_OF", "facts 没有 as_of（screening_evaluation / evaluation_summary 均缺失）；SCREENING 决策必须原样回传服务端 as_of", ["as_of"]);
			if (!isOffsetIso(asOf)) return fail("AS_OF_WITHOUT_OFFSET", `facts 的 as_of 不是带时区偏移的 ISO-8601：${asOf}`, ["as_of"]);
			const basisScreening = facts.basisScreeningDecide;
			const rubric = basisScreening?.rubricVersion ?? null;
			if (rubric === null) return fail("MISSING_RUBRIC_PAYLOAD_HASH", "facts.basis.screening_decide.rubric_version 缺 id/payload_hash；客户端不编造 rubric 哈希", ["rubric_version.payload_hash"]);
			const authority = basisScreening?.authority ?? null;
			if (authority === null) return fail("MISSING_AUTHORITY_FACTS", "facts.basis.screening_decide.authority 缺失（actor_id / is_hiring_manager）；客户端不编造权威事实", ["authority"]);
			const basisRefs = [{
				kind: "RUBRIC_VERSION",
				id: rubric.id,
				payload_hash: rubric.payloadHash
			}, {
				kind: "AUTHORITY",
				actor_id: authority.actorId,
				is_hiring_manager: authority.isHiringManager
			}];
			const evaluation = facts.screeningEvaluation;
			const needsEvaluation = result === "ADVANCE" || result === "REJECT";
			if (evaluation !== null && evaluation.evaluationDigest !== "" && evaluation.verdict !== "" && evaluation.rubricVersionId !== "" && evaluation.rubricPayloadHash !== "" && evaluation.resumeVersionId !== "" && evaluation.resumeContentSha256 !== "" && evaluation !== null) basisRefs.push({
				kind: "SCREENING_EVALUATION",
				evaluation_digest: evaluation.evaluationDigest,
				verdict: evaluation.verdict,
				rubric_version_id: evaluation.rubricVersionId,
				rubric_payload_hash: evaluation.rubricPayloadHash,
				resume_version_id: evaluation.resumeVersionId,
				resume_content_sha256: evaluation.resumeContentSha256
			});
			else if (needsEvaluation) return fail("MISSING_SCREENING_EVALUATION", "ADVANCE / REJECT 必须带 SCREENING_EVALUATION 六个字段；facts 尚未执行初筛评估或字段不全", evaluation === null ? ["screening_evaluation"] : [
				evaluation.evaluationDigest === "" ? "evaluation_digest" : "",
				evaluation.verdict === "" ? "verdict" : "",
				evaluation.rubricVersionId === "" ? "rubric_version_id" : "",
				evaluation.rubricPayloadHash === "" ? "rubric_payload_hash" : "",
				evaluation.resumeVersionId === "" ? "resume_version_id" : "",
				evaluation.resumeContentSha256 === "" ? "resume_content_sha256" : ""
			].filter((entry) => entry !== ""));
			return finish({
				application_id: applicationId,
				as_of: asOf,
				result,
				reason,
				basis_refs: basisRefs
			});
		}
		/**
		* `POST /recruitment/api/decision/record`（facade）body：`{application_id, decision_scope, result, reason, as_of?}`。
		*
		* 前端**不得**传 `summary_digest` / `basis_refs`（facade 自己从 facts 组装）；summary 不可用 → `SUMMARY_MISSING`。
		* 出处：`work/d5/decision/CONTRACT.md` §3 + `work/d5/w2b/INTERFACE2.md` §2。
		*/
		function buildDecisionRecordBody(input) {
			const facts = input.facts;
			if (facts === null) return fail("DECISION_FACTS_MISSING", "决策事实投影（GET /recruitment/api/decision/facts）不可用；facade 无法被调用（不发送请求）", ["facts"]);
			const applicationId = text(input.applicationId) || facts.applicationId;
			const missing = [];
			if (!requireUuid(applicationId, "application_id", missing)) return fail("ID_NOT_UUID", "申请 id 缺失或不是 UUID", missing);
			if (applicationId !== facts.applicationId) return fail("APPLICATION_MISMATCH", `facts 属于申请 ${facts.applicationId}，与当前申请 ${applicationId} 不一致；请刷新后重试`, ["facts.application_id"]);
			const scope = text(input.scope);
			if (!DECISION_SCOPES.includes(scope)) return fail("ENUM_INVALID", "decision_scope 只能是 STAGE / FINAL", ["decision_scope"]);
			const result = text(input.result);
			if (!RECORD_RESULTS.includes(result)) return fail("ENUM_INVALID", `result 只能是 ${RECORD_RESULTS.join(" / ")}（facade 不接受 WITHDRAW/HIRED）`, ["result"]);
			const reason = typeof input.reason === "string" ? input.reason.trim() : "";
			if (reason === "") return fail("MISSING_REASON", "正式决策必须填写理由（1..4000 字）", ["reason"]);
			if (charLength(reason) > 4e3) return fail("REASON_OUT_OF_RANGE", "理由不得超过 4000 字", ["reason"]);
			const summary = facts.evaluationSummary;
			const summaryMissingInFacts = factsMissingKeys(facts).includes("summary");
			if (summary === null || !summary.available || summary.summaryDigest === "" || summary.asOf === "") return fail("SUMMARY_MISSING", "facts.evaluation_summary 不可用（available=false / 缺 as_of / 缺 summary_digest）；正式决策必须先有服务端汇总", [
				summary === null ? "evaluation_summary" : "",
				summary !== null && !summary.available ? "evaluation_summary.available" : "",
				summary !== null && summary.asOf === "" ? "evaluation_summary.as_of" : "",
				summary !== null && summary.summaryDigest === "" ? "evaluation_summary.summary_digest" : "",
				summaryMissingInFacts ? "missing.summary" : ""
			].filter((entry) => entry !== ""));
			if (!isOffsetIso(summary.asOf)) return fail("MISSING_AS_OF", `facts.evaluation_summary.as_of 不是带时区偏移的 ISO-8601：${summary.asOf}`, ["as_of"]);
			return finish({
				application_id: applicationId,
				decision_scope: scope,
				result,
				reason,
				as_of: summary.asOf
			});
		}
		/**
		* 从设置快照里取面试官候选（按 actorId 去重；招聘团队是唯一人员来源，不手工编 actor id）。
		* @param settings - `overview.settings`（未取到 undefined → 空候选）。
		*/
		function interviewerCandidates(settings) {
			if (settings === void 0) return [];
			const out = [];
			const seen = /* @__PURE__ */ new Set();
			for (const team of settings.hiringTeams) for (const member of team.members) {
				if (member.actorId === "" || seen.has(member.actorId)) continue;
				seen.add(member.actorId);
				out.push({
					actorId: member.actorId,
					displayName: member.displayName,
					teamName: team.name !== "" ? team.name : team.code,
					teamRole: member.teamRole
				});
			}
			return out;
		}
		/**
		* 从申请详情里取面试选项（不编造：只列服务端已返回的 interview 行）。
		* @param view - 申请详情（未取到 undefined → 空选项）。
		*/
		function interviewChoices(view) {
			if (view === void 0) return [];
			return view.interviews.map((interview) => {
				const roundText = `第 ${String(interview.roundNo)} 轮`;
				const slotText = interview.slotCode !== "" ? ` · ${interview.slotCode}` : "";
				const statusText = interview.statusLabel !== "" ? ` · ${interview.statusLabel}` : "";
				return {
					interviewId: interview.id,
					roundNo: interview.roundNo,
					slotCode: interview.slotCode,
					statusLabel: interview.statusLabel,
					label: `${roundText}${slotText}${statusText}`
				};
			});
		}
		/**
		* `interview/schedule` CREATE body（`intent` 显式 CREATE；四 intent 都必填 `idempotency_key`）。
		* 出处：`work/d5/actions/CONTRACT.md` §3.1。
		*/
		function buildInterviewScheduleBody(input) {
			const missing = [];
			const applicationId = text(input.applicationId);
			if (!requireUuid(applicationId, "application_id", missing)) return fail("ID_NOT_UUID", "申请 id 缺失或不是 UUID", missing);
			const roundNo = input.roundNo;
			if (typeof roundNo !== "number" || !Number.isInteger(roundNo) || roundNo < 1 || roundNo > 20) return fail("ROUND_OUT_OF_RANGE", "轮次必须是 1..20 的整数（服务端 INV-4）", ["round_no"]);
			const scheduledStartAt = text(input.scheduledStartAt);
			if (scheduledStartAt === "") return fail("MISSING_START", "排期必须给开始时间", ["scheduled_start_at"]);
			if (!isOffsetIso(scheduledStartAt)) return fail("TIMESTAMP_WITHOUT_OFFSET", "scheduled_start_at 必须是带时区偏移的 ISO-8601（datetime-local 需经 toOffsetIso 转换）", ["scheduled_start_at"]);
			const durationMinutes = input.durationMinutes;
			if (typeof durationMinutes !== "number" || !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) return fail("DURATION_OUT_OF_RANGE", "面试时长必须是 15..480 分钟的整数", ["duration_minutes"]);
			if (input.interviewers.length === 0) return fail("INTERVIEWER_REQUIRED", "至少需要一名面试官（来自招聘团队人员）", ["interviewers"]);
			const interviewers = [];
			const seen = /* @__PURE__ */ new Set();
			for (const interviewer of input.interviewers) {
				const actorId = text(interviewer.actorId);
				if (actorId === "") return fail("MISSING_INTERVIEWER_ACTOR", "面试官候选缺 actorId", ["interviewers[].actor_id"]);
				if (!isUuid(actorId)) return fail("ID_NOT_UUID", `面试官 actorId 不是 UUID：${actorId}`, ["interviewers[].actor_id"]);
				if (seen.has(actorId)) return fail("DUPLICATE_INTERVIEWER", `面试官重复：${actorId} 只能出现一次`, ["interviewers"]);
				seen.add(actorId);
				const element = { actor_id: actorId };
				const roleInInterview = text(interviewer.roleInInterview);
				if (roleInInterview !== "") element.role_in_interview = roleInInterview;
				if (typeof interviewer.requiredScorecard === "boolean") element.required_scorecard = interviewer.requiredScorecard;
				interviewers.push(element);
			}
			const idempotencyKey = text(input.idempotencyKey);
			if (idempotencyKey === "") return fail("MISSING_IDEMPOTENCY_KEY", "排期必须带 idempotency_key（前端生成并保留，重试复用同一 key）", ["idempotency_key"]);
			if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) return fail("IDEMPOTENCY_KEY_INVALID", "idempotency_key 只能是 1..200 个 [A-Za-z0-9_.:-] 字符", ["idempotency_key"]);
			const timezone = text(input.timezone);
			return finish({
				intent: "CREATE",
				application_id: applicationId,
				round_no: roundNo,
				scheduled_start_at: scheduledStartAt,
				duration_minutes: durationMinutes,
				interviewers,
				idempotency_key: idempotencyKey,
				...timezone !== "" ? { timezone } : {}
			});
		}
		/**
		* `transcript/import` 人工上传 body（`PLATFORM_EXPORT` 必带导出文件名；`DEMO_SAMPLE` = FIXTURE 演示文本）。
		* 出处：`work/d5/actions/CONTRACT.md` §3.2。
		*/
		function buildTranscriptImportBody(input) {
			const missing = [];
			const interviewId = text(input.interviewId);
			if (!requireUuid(interviewId, "interview_id", missing)) return fail("ID_NOT_UUID", "面试 id 缺失或不是 UUID（转写只能挂到已绑定的面试）", missing);
			const content = typeof input.content === "string" ? input.content : "";
			if (content.trim() === "") return fail("MISSING_CONTENT", "转写正文不能为空（1..400000 字符）", ["content"]);
			if (charLength(content) > 4e5) return fail("CONTENT_OUT_OF_RANGE", "转写正文不得超过 400000 字符", ["content"]);
			const sourceKind = text(input.sourceKind);
			if (!TRANSCRIPT_SOURCE_KINDS.includes(sourceKind)) return fail("ENUM_INVALID", "source_kind 只能是 PLATFORM_EXPORT / DEMO_SAMPLE", ["source_kind"]);
			const exportedFileName = text(input.exportedFileName);
			if (sourceKind === "PLATFORM_EXPORT") {
				if (exportedFileName === "") return fail("EXPORT_FILE_NAME_REQUIRED", "PLATFORM_EXPORT 必须填写平台导出的文件名", ["exported_file_name"]);
				if (charLength(exportedFileName) > 255 || exportedFileName.includes(";") || /[\r\n]/.test(exportedFileName)) return fail("EXPORT_FILE_NAME_INVALID", "导出文件名不得超过 255 字，且不得含 \";\" 或换行", ["exported_file_name"]);
			}
			const language = text(input.language);
			if (language !== "" && charLength(language) > 16) return fail("LANGUAGE_INVALID", "语言标签不得超过 16 字符", ["language"]);
			const note = typeof input.note === "string" ? input.note.trim() : "";
			if (charLength(note) > 500) return fail("NOTE_TOO_LONG", "备注不得超过 500 字", ["note"]);
			const body = {
				interview_id: interviewId,
				content,
				source_kind: sourceKind
			};
			if (sourceKind === "PLATFORM_EXPORT" && exportedFileName !== "") body.exported_file_name = exportedFileName;
			if (language !== "") body.language = language;
			if (note !== "") body.note = note;
			return finish(body);
		}
		/** `job/rubric-approve` body：`{job_id, rubric_version_id, reason?}`（reason ≤500）。 */
		function buildRubricApproveBody(input) {
			const missing = [];
			const jobId = text(input.jobId);
			const rubricVersionId = text(input.rubricVersionId);
			if (!requireUuid(jobId, "job_id", missing)) return fail("ID_NOT_UUID", "岗位 id 缺失或不是 UUID", missing);
			if (!requireUuid(rubricVersionId, "rubric_version_id", missing)) return fail("ID_NOT_UUID", "rubric 版本 id 缺失或不是 UUID", missing);
			const reason = typeof input.reason === "string" ? input.reason.trim() : "";
			if (charLength(reason) > 500) return fail("REASON_OUT_OF_RANGE", "批准理由不得超过 500 字", ["reason"]);
			return finish({
				job_id: jobId,
				rubric_version_id: rubricVersionId,
				...reason !== "" ? { reason } : {}
			});
		}
		/** 设置写 operation 的 create 必填字段（`work/d5/actions/CONTRACT.md` §4.2）。 */
		const CONFIG_CREATE_REQUIRED = {
			role: [
				"code",
				"name",
				"permission_scopes"
			],
			team: [
				"code",
				"name",
				"department_id"
			],
			pipeline: ["code", "name"]
		};
		/**
		* 设置统一入口 body：`{entity, operation, ...实体字段}`（只接受写 operation）。
		* 出处：`work/d5/actions/CONTRACT.md` §4.2 + INTERFACE §1 表（`recruiting_settings_write` → `/config`）。
		*/
		function buildSettingsWriteBody(input) {
			const entity = text(input.entity);
			if (!CONFIG_ENTITIES.includes(entity)) return fail("UNKNOWN_ENTITY", "entity 只能是 role / team / pipeline", ["entity"]);
			const operation = text(input.operation);
			const allowed = CONFIG_WRITE_OPERATIONS[entity] ?? [];
			if (operation === "") return fail("MISSING_OPERATION", "缺必填字段 operation", ["operation"]);
			if (!allowed.includes(operation)) {
				const isReadOperation = [
					"list",
					"get",
					"read",
					"search"
				].includes(operation);
				return fail(isReadOperation ? "READ_OPERATION_NOT_EXPOSED" : "OPERATION_INVALID", isReadOperation ? "写入口只接受写 operation；读/list/get 走既有只读投影" : `operation 只能是 ${allowed.join(" / ")}`, ["operation"]);
			}
			const fields = record(input.fields);
			if (operation === "create") {
				const missingInline = (CONFIG_CREATE_REQUIRED[entity] ?? []).filter((key) => {
					const value = fields[key];
					if (key === "permission_scopes") return !Array.isArray(value) || value.length === 0;
					return typeof value !== "string" || value.trim() === "";
				});
				if (missingInline.length > 0) return fail("MISSING_REQUIRED", `create 缺必填字段：${missingInline.join(", ")}`, missingInline);
			}
			return finish({
				entity,
				operation,
				...fields
			});
		}
		/** 草案里的文本项：字符串原样；对象取常见文本键，否则 JSON 预览（不编造业务含义）。 */
		function draftTextItem(value) {
			if (typeof value === "string") return value.trim();
			const raw = record(value);
			for (const key of [
				"text",
				"title",
				"label",
				"name",
				"description",
				"statement",
				"focus"
			]) {
				const candidate = text(raw[key]);
				if (candidate !== "") return candidate;
			}
			return preview(value, 200);
		}
		/** 文本数组归一化（丢弃空项）。 */
		function draftTextList(value) {
			const out = [];
			for (const item of items(value)) {
				const rendered = draftTextItem(item);
				if (rendered !== "") out.push(rendered);
			}
			return out;
		}
		/** 归一化 `POST job/draft` 响应；没有 `draft` 段 → null（不把空响应当草案）。 */
		function normalizeJobDraftResponse(value) {
			const raw = record(value);
			const draft = record(raw.draft);
			if (Object.keys(draft).length === 0) return null;
			const jobDraft = record(draft.job_draft);
			const rubricDraft = record(draft.rubric_draft);
			const rounds = [];
			for (const item of items(jobDraft.rounds)) {
				const entry = record(item);
				rounds.push({
					roundNo: count(entry.round_no),
					title: text(entry.title),
					focus: draftTextList(entry.focus),
					questions: draftTextList(entry.questions)
				});
			}
			const rubricDimensions = [];
			for (const item of items(rubricDraft.dimensions)) {
				const entry = record(item);
				const key = text(entry.key);
				if (key === "") continue;
				rubricDimensions.push({
					key,
					label: text(entry.label) !== "" ? text(entry.label) : key,
					kind: text(entry.kind),
					weight: numberOrNull(entry.weight),
					reason: text(entry.reason)
				});
			}
			const reasons = [];
			for (const item of items(draft.reasons)) {
				const entry = record(item);
				const path = text(entry.path);
				if (path === "") continue;
				reasons.push({
					path,
					reason: text(entry.reason),
					source: text(entry.source)
				});
			}
			const missingItems = [];
			for (const item of items(draft.missing_items)) {
				const entry = record(item);
				const key = text(entry.key);
				if (key === "") continue;
				missingItems.push({
					key,
					question: text(entry.question)
				});
			}
			const confirmationRaw = record(raw.confirmation);
			return {
				contractVersion: text(raw.contract_version),
				recruitingReason: text(jobDraft.recruiting_reason),
				responsibilities: draftTextList(jobDraft.responsibilities),
				successProfile: draftTextList(jobDraft.success_profile),
				mustHave: draftTextList(jobDraft.must_have),
				niceToHave: draftTextList(jobDraft.nice_to_have),
				rounds,
				rubricDimensions,
				reasons,
				missingItems,
				confirmation: {
					required: confirmationRaw.required === true,
					status: text(confirmationRaw.status),
					next: stringList(confirmationRaw.next),
					note: text(confirmationRaw.note)
				}
			};
		}
		/** `POST job/draft` body（`request_text` 1..2000；其余可选键给了才带）。 */
		function buildJobDraftBody(input) {
			const requestText = typeof input.requestText === "string" ? input.requestText.trim() : "";
			if (requestText === "") return fail("MISSING_REQUEST_TEXT", "岗位需求原文不能为空（1..2000 字）", ["request_text"]);
			if (charLength(requestText) > 2e3) return fail("REQUEST_TEXT_TOO_LONG", "岗位需求原文不得超过 2000 字", ["request_text"]);
			const body = { request_text: requestText };
			const supplement = typeof input.recruiterSupplement === "string" ? input.recruiterSupplement.trim() : "";
			if (supplement !== "") body.recruiter_supplement = supplement;
			const departmentContext = typeof input.departmentContext === "string" ? input.departmentContext.trim() : "";
			if (departmentContext !== "") body.department_context = departmentContext;
			const templateId = text(input.templateId);
			if (templateId !== "") body.template_id = templateId;
			return finish(body);
		}
		/** job-create 的 criteria 权重和容差（`src/tools/job-create.ts`：Σweight = 1，tolerance 1e-6）。 */
		const CRITERIA_WEIGHT_TOLERANCE = 1e-6;
		/**
		* `POST job/create` body：`{job_create_args:{code,title,department_id,description_md,requirements_md,criteria[],status}}`。
		* 客户端只做封闭形状校验（criteria 非空、Σweight≈1、≥1 MUST_HAVE/DISQUALIFIER），业务规则仍在服务端。
		* 出处：`work/d5/joblife/CONTRACT-ACTIONS.md` §2 + `src/tools/job-create.ts` 的 validateDimensions 口径。
		*/
		function buildJobCreateBody(input) {
			const missing = [];
			const code = text(input.code);
			const title = text(input.title);
			const departmentId = text(input.departmentId);
			if (code === "") missing.push("code");
			else if (!JOB_CODE_RE.test(code)) return fail("CODE_INVALID", "岗位 code 必须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$", ["code"]);
			if (title === "") missing.push("title");
			if (charLength(title) > 200) return fail("TITLE_OUT_OF_RANGE", "岗位名称不得超过 200 字", ["title"]);
			if (!requireUuid(departmentId, "department_id", missing)) {
				if (missing.includes("department_id:ID_NOT_UUID")) return fail("ID_NOT_UUID", "部门 id 不是 UUID（必须来自 settings.departments）", ["department_id"]);
			}
			const descriptionMd = typeof input.descriptionMd === "string" ? input.descriptionMd : "";
			const requirementsMd = typeof input.requirementsMd === "string" ? input.requirementsMd : "";
			if (charLength(descriptionMd) > 2e4) return fail("DESCRIPTION_OUT_OF_RANGE", "description_md 不得超过 20000 字", ["description_md"]);
			if (charLength(requirementsMd) > 2e4) return fail("REQUIREMENTS_OUT_OF_RANGE", "requirements_md 不得超过 20000 字", ["requirements_md"]);
			if (missing.length > 0) return fail("MISSING_REQUIRED", `岗位创建缺必填字段：${missing.join(", ")}`, missing);
			if (input.criteria.length === 0) return fail("CRITERIA_REQUIRED", "岗位创建至少需要 1 条 rubric 维度（1..50）", ["criteria"]);
			if (input.criteria.length > 50) return fail("CRITERIA_OUT_OF_RANGE", "criteria 最多 50 条", ["criteria"]);
			const criteria = [];
			let weightSum = 0;
			let hasGate = false;
			for (const dimension of input.criteria) {
				const entry = record(dimension);
				const key = text(entry.key);
				const label = text(entry.label);
				const kind = text(entry.kind);
				const weight = entry.weight;
				if (key === "" || label === "") return fail("CRITERIA_INCOMPLETE", "每条 criteria 必须有 key/label", ["criteria[].key"]);
				if (!CRITERION_KINDS.includes(kind)) return fail("CRITERIA_KIND_INVALID", `criteria[].kind 只能是 ${CRITERION_KINDS.join(" / ")}`, ["criteria[].kind"]);
				if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) return fail("CRITERIA_WEIGHT_INVALID", "criteria[].weight 必须是 0..1 的数字", ["criteria[].weight"]);
				weightSum += weight;
				if (kind === "MUST_HAVE" || kind === "DISQUALIFIER") hasGate = true;
				const shaped = {
					key,
					label,
					kind,
					weight
				};
				for (const optionalKey of [
					"field",
					"operator",
					"value",
					"question",
					"notes"
				]) {
					const value = entry[optionalKey];
					if (typeof value === "string" && value.trim() !== "") shaped[optionalKey] = value;
				}
				criteria.push(shaped);
			}
			if (Math.abs(weightSum - 1) > CRITERIA_WEIGHT_TOLERANCE) return fail("CRITERIA_WEIGHT_SUM", `criteria 的 weight 之和必须为 1（当前 ${weightSum.toFixed(6)}；服务端容差 1e-6）`, ["criteria[].weight"]);
			if (!hasGate) return fail("CRITERIA_KIND_REQUIRED", "criteria 至少要有一条 MUST_HAVE 或 DISQUALIFIER", ["criteria[].kind"]);
			const status = text(input.status);
			if (status !== "" && !JOB_CREATE_STATUSES.includes(status)) return fail("STATUS_INVALID", "初始状态只能是 DRAFT / OPEN", ["status"]);
			return finish({ job_create_args: {
				code,
				title,
				department_id: departmentId,
				description_md: descriptionMd,
				requirements_md: requirementsMd,
				criteria,
				status: status !== "" ? status : "DRAFT"
			} });
		}
		/** 造一个发送前拒绝结果。 */
		function refuse(reasonCode, reasonText, missing = []) {
			return {
				ok: false,
				status: 0,
				code: "CLIENT_REFUSED",
				reasonCode,
				reasonText,
				missing
			};
		}
		/**
		* 任意写请求的发送前自检：`sessionId` 非空、body 非空、body 顶层无保留键、path 是同源相对路径。
		* @param path - 待 POST 的同源相对路径。
		* @param body - 已由 build* 产出的 body。
		* @param sessionId - 宿主传入的 session id（**只从形参来，不读 localStorage**）。
		*/
		function checkWriteRequest(path, body, sessionId) {
			if (text(sessionId) === "") return refuse("SESSION_MISSING", "缺少当前 DSH session id（由宿主 props 传入），客户端不发送写请求", ["sessionId"]);
			if (path === "" || !path.startsWith("/recruitment/") || path.startsWith("//")) return refuse("UNSAFE_SEAM", `写动作路径必须是同源相对 /recruitment/ 路径（当前：${path}）`, ["path"]);
			if (Object.keys(body).length === 0) return refuse("EMPTY_BODY", "写请求 body 为空（固定发 {} 会被服务端 400 MISSING_REQUIRED）", ["body"]);
			const reserved = reservedKeysOf(body);
			if (reserved.length > 0) return refuse("CLIENT_RESERVED_KEY", `body 含客户端禁止上送的身份/服务端派生键：${reserved.join(", ")}；客户端不发送`, reserved);
			return { ok: true };
		}
		/** 动作写请求的自检：在 {@link checkWriteRequest} 之前先看服务端可用性。 */
		function checkActionRequest(action, body, sessionId) {
			if (!action.available) return refuse("ACTION_NOT_AVAILABLE", `动作 ${action.key} 服务端声明不可用（pending: ${action.pending !== "" ? action.pending : "ACTION_SEAM_NOT_WIRED"}）；客户端不发送`, ["action.available"]);
			return checkWriteRequest(action.seam, body, sessionId);
		}
		/** 读回行的 label：已知键给中文，未知键原样（记录里没有业务结论）。 */
		function labelOf(key) {
			const direct = READBACK_LABELS[key];
			if (direct !== void 0) return direct;
			const segments = key.split(".");
			const last = segments[segments.length - 1] ?? key;
			return READBACK_LABELS[last] ?? key;
		}
		/** 造一行读回显示。 */
		function lineOf(key, value) {
			return {
				key,
				label: labelOf(key),
				value: rawValueText(value)
			};
		}
		/** 把普通对象铺成 `prefix.key` 行（数组/标量当值原样；不递归推断业务含义）。 */
		function objectLines(prefix, value) {
			const out = [];
			for (const [key, child] of Object.entries(value)) out.push(lineOf(prefix === "" ? key : `${prefix}.${key}`, child));
			return out;
		}
		/**
		* 标准信封 `readback` → 显示行（键/值原样，顺序 = 服务端 JSON 键序）。
		* @param envelope - `parseActionEnvelope` 的结果；null → 空数组。
		*/
		function readbackLines(envelope) {
			if (envelope === null || envelope.readback === null) return [];
			return objectLines("", envelope.readback);
		}
		/**
		* 任意写动作响应 → 显示行：标准信封用 `readback`；非标准信封（evaluate/record/draft/create/job-close）
		* 把 `readback`/`decision`/`evaluation`/`job`/`draft` 等段铺成 `段.键` 行（键/值原样）。
		* @param outcome - 最近一次写动作结果；undefined → 空数组。
		*/
		function actionResultLines(outcome) {
			if (outcome === void 0 || outcome === null) return [];
			const envelopeLines = readbackLines(outcome.envelope);
			if (envelopeLines.length > 0) return envelopeLines;
			const payload = outcome.payload;
			if (payload === null) return [];
			const out = [];
			for (const [key, value] of Object.entries(payload)) {
				if (key === "error") continue;
				if (value !== null && typeof value === "object" && !Array.isArray(value)) {
					const nested = value;
					const row = nested.row;
					if (row !== null && typeof row === "object" && !Array.isArray(row)) {
						out.push(lineOf(`${key}.table`, nested.table));
						out.push(...objectLines(`${key}.row`, row));
						continue;
					}
					out.push(...objectLines(key, nested));
					continue;
				}
				out.push(lineOf(key, value));
			}
			return out;
		}
		/**
		* 把 `<input type="datetime-local">` 的 `YYYY-MM-DDTHH:mm[:ss]` 解释为**浏览器本地时间**，
		* 输出带时区偏移的 ISO-8601（服务端 `TIMESTAMP_WITHOUT_OFFSET` 会拒绝裸本地时间）。
		* @param localValue - datetime-local 的原始值。
		* @returns 带偏移 ISO-8601；无法解析 → ''（调用方按 MISSING_START 处理）。
		*/
		function toOffsetIso(localValue) {
			const raw = text(localValue);
			const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
			if (match === null) return "";
			const year = match[1];
			const month = match[2];
			const day = match[3];
			const hour = match[4];
			const minute = match[5];
			const second = match[6] ?? "00";
			const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
			if (!Number.isFinite(date.valueOf())) return "";
			const offsetMinutes = -date.getTimezoneOffset();
			const sign = offsetMinutes >= 0 ? "+" : "-";
			const absolute = Math.abs(offsetMinutes);
			return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
		}
		/** 生成一个符合 `[A-Za-z0-9_.:-]{1,200}` 的排期幂等键（前端生成并保留，重试复用同一 key）。 */
		function newIdempotencyKey() {
			return `ui-schedule-${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
		}
		// src/client/recruiting/view-model.ts
		/** 写动作的封闭集（与 `src/http/recruiting.ts` 的 `RecruitingActionKey` 一一对应）。 */
		const ACTION_KEYS = [
			"screening_decide",
			"interview_schedule",
			"transcript_import",
			"stage_advance",
			"decision_record",
			"rubric_approve",
			"recruiting_settings_write"
		];
		/** 动作按钮文案（键不存在时退化成动作键本身，不丢信息）。 */
		const ACTION_LABELS = {
			screening_decide: "记录初筛结论",
			interview_schedule: "安排面试",
			transcript_import: "导入 / 关联 Transcript",
			stage_advance: "推进阶段",
			decision_record: "记录招聘决策",
			rubric_approve: "批准 Rubric",
			recruiting_settings_write: "保存招聘设置"
		};
		/** 后端 pending 机器码 → 给人看的原因（未知码原样显示，不吞掉）。 */
		const PENDING_REASON_TEXT = {
			ACTION_SEAM_NOT_WIRED: "这个操作在当前版本尚未接线（页面没有提供入口）",
			ACTION_SEAM_MISSING: "服务端声明可用，但没有给出可执行入口（按不可用处理）",
			NOT_IMPLEMENTED: "这个操作还没有实现"
		};
		/** 阶段码 → 默认中文名（`stage_catalog` 缺失时的展示兜底；权威标签仍以服务端 catalog 为准）。 */
		const DEFAULT_STAGE_LABELS = {
			S1: "招聘需求发现",
			S2: "招聘需求创建与审批",
			S3: "岗位 / JD / Rubric 设计",
			S4: "岗位发布",
			S5: "人才获取",
			S6: "简历接入与处理",
			S7: "初筛",
			S8: "面试规划与排期",
			S9: "面试执行与材料获取",
			S10: "综合评价与招聘决策",
			S11: "Offer 与入职交接",
			S12: "人才沉淀与复盘"
		};
		/** 阶段顺序（排序用；未知阶段排最后）。 */
		const STAGE_ORDER = {
			S1: 1,
			S2: 2,
			S3: 3,
			S4: 4,
			S5: 5,
			S6: 6,
			S7: 7,
			S8: 8,
			S9: 9,
			S10: 10,
			S11: 11,
			S12: 12
		};
		/** 阶段色档（只表"当前阶段"这一事实，不代表结论）。 */
		const STAGE_TONES = {
			S6: "blue",
			S7: "amber",
			S8: "blue",
			S9: "blue",
			S10: "amber",
			S11: "gray",
			S12: "gray"
		};
		/** `application.lifecycle_status` 枚举（0001_init.sql:880）→ 中文 + 色档。 */
		const LIFECYCLE_LABELS = {
			ACTIVE: "进行中",
			ON_HOLD: "已暂缓",
			WITHDRAWN: "候选人撤回",
			CLOSED: "已关闭"
		};
		const LIFECYCLE_TONES = {
			ACTIVE: "green",
			ON_HOLD: "amber",
			WITHDRAWN: "gray",
			CLOSED: "gray"
		};
		/** `job.status` 枚举（0001_init.sql:529）→ 中文 + 色档。 */
		const JOB_STATUS_LABELS = {
			DRAFT: "草案",
			PENDING_REVIEW: "待审批",
			APPROVED: "已批准",
			OPEN: "招聘中",
			PAUSED: "已暂停",
			CLOSED: "已关闭",
			ARCHIVED: "已归档"
		};
		const JOB_STATUS_TONES = {
			DRAFT: "gray",
			PENDING_REVIEW: "amber",
			APPROVED: "blue",
			OPEN: "green",
			PAUSED: "amber",
			CLOSED: "gray",
			ARCHIVED: "gray"
		};
		/**
		* 岗位展示排序权重（纯客户端口径，不改服务端）：
		* `OPEN`(0) > `DRAFT`/`PENDING_REVIEW`(1) > `PAUSED`(2) > 未知(8) > `CLOSED`/`ARCHIVED`(9)。
		* 未知状态放在 `PAUSED` 之后、终态之前，避免一个脏 status 被顶到第一位。
		*/
		const JOB_STATUS_SORT_RANK = {
			OPEN: 0,
			DRAFT: 1,
			PENDING_REVIEW: 1,
			PAUSED: 2,
			CLOSED: 9,
			ARCHIVED: 9
		};
		/** 一个岗位状态的排序权重（未知状态 → 8）。 */
		function jobSortRank(status) {
			return JOB_STATUS_SORT_RANK[status] ?? 8;
		}
		/** `created_at` 的时间戳（非法/缺失 → 0，老岗位排后面）。 */
		function createdAtValue(job) {
			const parsed = Date.parse(job.createdAt);
			return Number.isFinite(parsed) ? parsed : 0;
		}
		/**
		* 岗位展示排序（**纯函数**）：
		* 1. 状态优先级（OPEN 优先，归档/关闭最后）；
		* 2. 同优先级按 `application_counts.total` 降序（演示主岗位排前面）；
		* 3. 再按 `created_at` 降序（新的在前；缺失/非法时间排最后）。
		* 排序稳定：三者都相等时保持服务端原顺序。
		*/
		function sortJobViews(jobs) {
			return [...jobs].sort((left, right) => {
				const rank = jobSortRank(left.status) - jobSortRank(right.status);
				if (rank !== 0) return rank;
				const total = right.applicationCounts.total - left.applicationCounts.total;
				if (total !== 0) return total;
				return createdAtValue(right) - createdAtValue(left);
			});
		}
		/**
		* 右侧岗位侧栏分组：`active` = OPEN + DRAFT（"正在招聘"里不堆归档岗位）；
		* `archived` = 其余（PAUSED / CLOSED / ARCHIVED / 未知状态），由组件放进折叠区。
		*/
		function splitSidebarJobs(jobs) {
			const active = [];
			const archived = [];
			for (const job of jobs) if (job.status === "OPEN" || job.status === "DRAFT") active.push(job);
			else archived.push(job);
			return {
				active,
				archived
			};
		}
		/** `resume_version.parse_status` 枚举（0001_init.sql:826）→ 中文 + 色档。 */
		const PARSE_LABELS = {
			PENDING: "等待解析",
			PARSING: "解析中",
			PARSED: "解析完成",
			PARTIAL: "部分解析",
			FAILED: "解析失败",
			NEEDS_REVIEW: "待人工复核"
		};
		const PARSE_TONES = {
			PENDING: "gray",
			PARSING: "blue",
			PARSED: "green",
			PARTIAL: "amber",
			FAILED: "red",
			NEEDS_REVIEW: "amber"
		};
		/** `intake_asset.validation_status` 枚举（0001_init.sql:716）→ 中文 + 色档。 */
		const VALIDATION_LABELS = {
			PENDING: "待校验",
			VALID: "校验通过",
			INVALID: "校验失败"
		};
		const VALIDATION_TONES = {
			PENDING: "amber",
			VALID: "green",
			INVALID: "red"
		};
		/** `decision.result` 枚举（0001_init.sql:1354）→ 中文 + 色档。 */
		const DECISION_RESULT_LABELS = {
			ADVANCE: "通过",
			HOLD: "暂缓",
			REJECT: "不通过",
			WITHDRAW: "撤回",
			HIRED: "录用"
		};
		const DECISION_RESULT_TONES = {
			ADVANCE: "green",
			HOLD: "amber",
			REJECT: "red",
			WITHDRAW: "gray",
			HIRED: "green"
		};
		/** `decision.decision_scope` 枚举（0001_init.sql:1353）→ 中文。 */
		const DECISION_SCOPE_LABELS = {
			SCREENING: "初筛",
			STAGE: "阶段",
			FINAL: "最终"
		};
		/** `interview.status` 枚举（0001_init.sql:959）→ 中文 + 色档（**只表排期，不推断转写/面评**）。 */
		const INTERVIEW_STATUS_LABELS = {
			SCHEDULED: "已排期",
			IN_PROGRESS: "进行中",
			POST_INTERVIEW: "面试后",
			EVALUATION_READY: "评价就绪",
			DECIDED: "已决策",
			RESCHEDULED: "已改期",
			CANCELLED: "已取消",
			NO_SHOW: "未出席"
		};
		const INTERVIEW_STATUS_TONES = {
			SCHEDULED: "blue",
			IN_PROGRESS: "blue",
			POST_INTERVIEW: "amber",
			EVALUATION_READY: "green",
			DECIDED: "green",
			RESCHEDULED: "amber",
			CANCELLED: "gray",
			NO_SHOW: "red"
		};
		/** `scorecard.status` 枚举（0001_init.sql:1310）→ 中文 + 色档。 */
		const SCORECARD_STATUS_LABELS = {
			PENDING: "待提交",
			SUBMITTED: "已提交",
			WAIVED: "已豁免"
		};
		const SCORECARD_STATUS_TONES = {
			PENDING: "amber",
			SUBMITTED: "green",
			WAIVED: "gray"
		};
		/** `scorecard.overall` 枚举（面评契约）→ 中文 + 色档。 */
		const OVERALL_LABELS = {
			ADVANCE: "建议推进",
			HOLD: "暂缓",
			REJECT: "不建议推进"
		};
		const OVERALL_TONES = {
			ADVANCE: "green",
			HOLD: "amber",
			REJECT: "red"
		};
		/** `transcript_artifact.transcript_status` 枚举（0001_init.sql:1092）→ 中文 + 色档。 */
		const TRANSCRIPT_STATUS_LABELS = {
			DISCOVERED: "已发现",
			FETCHING: "获取中",
			PARTIAL: "部分获取",
			READY: "已就绪",
			WAITING_EXTERNAL: "等待外部",
			RETRYABLE_FAILED: "可重试失败",
			AUTH_REQUIRED: "需要授权",
			NEEDS_LINKING: "待关联"
		};
		const TRANSCRIPT_STATUS_TONES = {
			DISCOVERED: "gray",
			FETCHING: "blue",
			PARTIAL: "amber",
			READY: "green",
			WAITING_EXTERNAL: "amber",
			RETRYABLE_FAILED: "red",
			AUTH_REQUIRED: "red",
			NEEDS_LINKING: "amber"
		};
		/**
		* `TranscriptSummary.state` → 中文 + 色档（客户端消费的稳定枚举）。
		*
		* O7 / D-133：转写是"收到什么就是什么"的**输入事实**，不是给 HR 的缺件清单
		* （禁止"缺失 / 缺件"叙事）；只允许三种口径：
		*   已收到（READY / PROCESSING）· 还没有转写（NOT_READY / MISSING）· 处理失败（FAILED）。
		* 枚举键与色档映射保持不变（色档只表达"要不要注意"）。
		*/
		const TRANSCRIPT_STATE_LABELS = {
			READY: "已收到",
			PROCESSING: "处理中",
			NOT_READY: "还没有转写",
			FAILED: "处理失败",
			MISSING: "还没有转写"
		};
		const TRANSCRIPT_STATE_TONES = {
			READY: "green",
			PROCESSING: "blue",
			NOT_READY: "amber",
			FAILED: "red",
			MISSING: "gray"
		};
		/** 时间线 `kind` → 中文。 */
		const TIMELINE_KIND_LABELS = {
			APPLIED: "提交申请",
			INTAKE: "简历接入",
			SCREENING_DECISION: "初筛结论",
			INTERVIEW_SCHEDULED: "面试排期",
			TRANSCRIPT_FETCHED: "Transcript 获取",
			INTERVIEW_RECORD: "面试记录",
			SCORECARD_SUBMITTED: "面评提交",
			DECISION: "招聘决策"
		};
		/** 阶段中文名：服务端 catalog 优先，其次内置兜底，最后原样返回码。 */
		function stageLabelOf(code, context) {
			if (code === "") return "未提供阶段";
			const fromCatalog = context?.labels[code];
			if (fromCatalog !== void 0 && fromCatalog !== "") return fromCatalog;
			return DEFAULT_STAGE_LABELS[code] ?? code;
		}
		/** 阶段排序权重。 */
		function stageOrderOf(code, context) {
			return context?.order[code] ?? STAGE_ORDER[code] ?? 999;
		}
		/** 归一化 `next_step`；缺字段/坏类型降级为空（`hasStep=false`）。 */
		function normalizeNextStep(value) {
			const raw = record(value);
			const code = text(raw.code);
			const label = text(raw.label);
			const kind = oneOf(raw.kind, [
				"INFO",
				"HUMAN_ACTION",
				"WAIT"
			]);
			return {
				code,
				label,
				kind,
				kindLabel: kind === "HUMAN_ACTION" ? "需要人工处理" : kind === "WAIT" ? "等待中" : kind === "INFO" ? "进展" : "",
				tone: code === "CLOSED" ? "gray" : kind === "HUMAN_ACTION" ? "amber" : kind === "WAIT" ? "amber" : kind === "INFO" ? "blue" : "gray",
				hasStep: code !== "" || label !== ""
			};
		}
		/** 三维标签的展示口径（`LIVE`/`FIXTURE` 等原值直接带出，不翻译、不合并）。 */
		function normalizeThreeDimLabels(value) {
			const raw = record(value);
			const provenance = text(raw.provenance);
			const trigger = text(raw.trigger);
			const connection = text(raw.connection);
			const provenanceTone = provenance === "LIVE" ? "green" : provenance === "FIXTURE" ? "amber" : "gray";
			const triggerTone = trigger === "EVENT" ? "blue" : trigger === "MANUAL" ? "amber" : "gray";
			const connectionTone = connection === "CONNECTED" ? "green" : connection === "AUTH_REQUIRED" ? "red" : connection === "NOT_CONNECTED" ? "gray" : "gray";
			return {
				provenance,
				trigger,
				connection,
				provenanceTone,
				triggerTone,
				connectionTone,
				rows: [
					{
						key: "provenance",
						label: "数据来源",
						value: provenance,
						tone: provenanceTone
					},
					{
						key: "trigger",
						label: "触发方式",
						value: trigger,
						tone: triggerTone
					},
					{
						key: "connection",
						label: "连接状态",
						value: connection,
						tone: connectionTone
					}
				]
			};
		}
		/** 归一化一个写动作：`available` 只在服务端明确 true **且** 给了 seam 时才为 true（fail-closed）。 */
		function normalizeAction(key, value) {
			const raw = record(value);
			const seam = text(raw.seam);
			const declaredAvailable = bool(raw.available);
			const pending = text(raw.pending);
			const available = declaredAvailable && seam !== "";
			const reasonCode = available ? "" : pending !== "" ? pending : declaredAvailable ? "ACTION_SEAM_MISSING" : "ACTION_SEAM_NOT_WIRED";
			return {
				key,
				label: ACTION_LABELS[key] ?? key,
				available,
				seam,
				pending: reasonCode,
				pendingText: reasonCode === "" ? "" : `待后端接入（pending: ${reasonCode}）`,
				reasonText: reasonCode === "" ? "" : PENDING_REASON_TEXT[reasonCode] ?? "后端写路径未接入"
			};
		}
		/** 归一化整张动作表（未知键忽略、缺键按不可用渲染，保证按钮集合稳定）。 */
		function normalizeActions(value) {
			const raw = record(value);
			const byKey = {};
			for (const key of ACTION_KEYS) byKey[key] = normalizeAction(key, raw[key]);
			for (const [key, actionValue] of Object.entries(raw)) {
				if (byKey[key] !== void 0) continue;
				byKey[key] = normalizeAction(key, actionValue);
			}
			return {
				byKey,
				list: ACTION_KEYS.map((key) => byKey[key]).filter((action) => action !== void 0)
			};
		}
		/** 归一化简历材料摘要；null / 坏类型 → null（不伪造材料）。 */
		function normalizeMaterial(value) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			const fileName = text(raw.file_name);
			const resumeVersionId = text(raw.resume_version_id);
			const sha256 = text(raw.sha256);
			if (fileName === "" && resumeVersionId === "" && sha256 === "") return null;
			const parseStatus = oneOf(raw.parse_status, [
				"PENDING",
				"PARSING",
				"PARSED",
				"PARTIAL",
				"FAILED",
				"NEEDS_REVIEW"
			]) || text(raw.parse_status);
			const validationStatus = oneOf(raw.validation_status, [
				"PENDING",
				"VALID",
				"INVALID"
			]) || text(raw.validation_status);
			const pageCount = numberOrNull(raw.page_count);
			const fieldStatesRaw = record(raw.field_states);
			const fieldStates = [];
			for (const key of Object.keys(fieldStatesRaw)) {
				const state = text(fieldStatesRaw[key]);
				if (state !== "") fieldStates.push({
					key,
					state
				});
			}
			const entryCountsRaw = record(raw.entry_counts);
			return {
				resumeVersionId,
				resumeId: text(raw.resume_id),
				assetId: text(raw.asset_id),
				fileName,
				mimeType: text(raw.mime_type),
				byteSize: count(raw.byte_size),
				byteSizeText: formatBytes(raw.byte_size),
				sha256,
				sha256Text: shortSha(sha256),
				sourceSha256Text: shortSha(raw.source_asset_sha256),
				hashAligned: bool(raw.source_hash_aligned),
				validationStatus,
				validationLabel: VALIDATION_LABELS[validationStatus] ?? (validationStatus !== "" ? validationStatus : "校验状态未知"),
				validationTone: VALIDATION_TONES[validationStatus] ?? "gray",
				parseStatus,
				parseLabel: PARSE_LABELS[parseStatus] ?? (parseStatus !== "" ? parseStatus : "解析状态未知"),
				parseTone: PARSE_TONES[parseStatus] ?? "gray",
				parser: text(raw.parser_name),
				parserVersion: text(raw.parser_version),
				pageCount,
				pageCountText: pageCount === null ? "" : `${String(pageCount)} 页`,
				fieldStates,
				entryCounts: {
					work: count(entryCountsRaw.work),
					education: count(entryCountsRaw.education)
				},
				evidenceCount: count(raw.evidence_count)
			};
		}
		/** 材料摘要的一行文案（`profile` 等坏类型不会撑爆行）。 */
		function materialSummaryOf(material) {
			if (material === null) return {
				summary: "未关联材料",
				tone: "gray"
			};
			return {
				summary: joinTexts([material.parseLabel, material.pageCountText]),
				tone: material.parseTone
			};
		}
		/** 归一化初筛证据分片。 */
		function normalizeScreeningEvaluation(value) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			const verdict = text(raw.verdict);
			const provenance = text(raw.provenance);
			const digest = text(raw.evaluation_digest);
			const criteriaEvaluated = typeof raw.criteria_evaluated === "boolean" ? raw.criteria_evaluated : null;
			const resumeVersionId = text(raw.resume_version_id);
			const rubricVersionId = text(raw.rubric_version_id);
			if (verdict === "" && provenance === "" && digest === "" && resumeVersionId === "" && rubricVersionId === "") return null;
			return {
				verdict,
				provenance,
				provenanceTone: provenance === "LIVE" ? "green" : provenance === "FIXTURE" ? "amber" : "gray",
				criteriaEvaluated,
				evaluationDigest: digest,
				evaluationDigestText: shortSha(digest),
				resumeVersionId,
				rubricVersionId
			};
		}
		/** 归一化初筛结论。 */
		function normalizeScreening(value, context) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			const decisionId = text(raw.decision_id);
			const result = text(raw.result);
			const reason = text(raw.reason);
			if (decisionId === "" && result === "" && reason === "") return null;
			const stageCode = text(raw.stage_code);
			return {
				decisionId,
				result,
				resultLabel: DECISION_RESULT_LABELS[result] ?? (result !== "" ? result : "结论未知"),
				resultTone: DECISION_RESULT_TONES[result] ?? "gray",
				stageCode,
				stageLabel: stageCode === "" ? "" : stageLabelOf(stageCode, context),
				reason,
				decidedAt: text(raw.decided_at),
				decidedAtText: formatDateTime(raw.decided_at),
				decidedBy: text(raw.decided_by_display_name),
				rubricVersionId: text(raw.rubric_version_id),
				basisKinds: stringList(raw.basis_kinds),
				evaluation: normalizeScreeningEvaluation(raw.evaluation)
			};
		}
		/** 初筛结论的一行文案。 */
		function screeningSummaryOf(screening) {
			if (screening === null) return {
				summary: "未初筛",
				tone: "gray"
			};
			return {
				summary: screening.resultLabel,
				tone: screening.resultTone
			};
		}
		/** 归一化一条面评。 */
		function normalizeScorecard$1(value) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			const id = text(raw.scorecard_id);
			const status = text(raw.status);
			if (id === "" && status === "") return null;
			const overall = text(raw.overall);
			return {
				id,
				interviewId: text(raw.interview_id),
				interviewerId: text(raw.interviewer_id),
				interviewerName: text(raw.interviewer_display_name),
				status,
				statusLabel: SCORECARD_STATUS_LABELS[status] ?? (status !== "" ? status : "状态未知"),
				statusTone: SCORECARD_STATUS_TONES[status] ?? "gray",
				overall,
				overallLabel: OVERALL_LABELS[overall] ?? (overall !== "" ? overall : ""),
				overallTone: OVERALL_TONES[overall] ?? "gray",
				revisionNo: count(raw.revision_no),
				submittedAt: text(raw.submitted_at),
				submittedAtText: formatDateTime(raw.submitted_at)
			};
		}
		/** 归一化面试官分配。 */
		function normalizeInterviewer(value) {
			const raw = record(value);
			const id = text(raw.interviewer_row_id);
			const actorId = text(raw.actor_id);
			const displayName = text(raw.display_name);
			if (id === "" && actorId === "" && displayName === "") return null;
			return {
				id,
				actorId,
				displayName,
				roleInInterview: text(raw.role_in_interview),
				required: bool(raw.required_scorecard),
				dueAt: text(raw.scorecard_due_at),
				dueAtText: formatDateTime(raw.scorecard_due_at),
				scorecard: normalizeScorecard$1(raw.scorecard)
			};
		}
		/** 归一化 Transcript 状态（`state` 与 `artifact_id` 的组合由服务端保证，这里只如实透传）。 */
		function normalizeTranscript$1(value) {
			const raw = record(value);
			const state = oneOf(raw.state, [
				"READY",
				"PROCESSING",
				"NOT_READY",
				"FAILED",
				"MISSING"
			]);
			const transcriptStatus = text(raw.transcript_status);
			const recordRaw = raw.interview_record;
			const interviewRecord = recordRaw === null || recordRaw === void 0 ? null : (() => {
				const entry = record(recordRaw);
				const id = text(entry.interview_record_id);
				if (id === "" && text(entry.status) === "") return null;
				const chunkCoverage = numberOrNull(entry.chunk_coverage);
				return {
					id,
					status: text(entry.status),
					verificationStatus: text(entry.verification_status),
					evidenceOk: bool(entry.evidence_ok),
					isCurrent: bool(entry.is_current),
					chunkCoverage,
					chunkCoverageText: chunkCoverage === null ? "" : `${String(Math.round(chunkCoverage * 100))}%`
				};
			})();
			return {
				state,
				stateLabel: TRANSCRIPT_STATE_LABELS[state] ?? "未提供",
				stateTone: TRANSCRIPT_STATE_TONES[state] ?? "gray",
				artifactId: text(raw.artifact_id),
				artifactIdText: shortSha(raw.artifact_id),
				transcriptStatus,
				transcriptStatusLabel: TRANSCRIPT_STATUS_LABELS[transcriptStatus] ?? (transcriptStatus !== "" ? transcriptStatus : ""),
				transcriptStatusTone: TRANSCRIPT_STATUS_TONES[transcriptStatus] ?? "gray",
				provenance: text(raw.provenance),
				triggerMode: text(raw.trigger_mode),
				connectionState: text(raw.connection_state),
				labels: normalizeThreeDimLabels({
					provenance: raw.provenance,
					trigger: raw.trigger_mode,
					connection: raw.connection_state
				}),
				isComplete: bool(raw.is_complete),
				isCanonical: bool(raw.is_canonical),
				segmentCount: count(raw.segment_count),
				record: interviewRecord
			};
		}
		/** 轮次重点的空视图（缺字段 / 坏类型 / `available=false` 降级时用它，**不编造**本轮内容）。 */
		function emptyRoundFocus$1() {
			return {
				available: false,
				source: "",
				roundNo: 0,
				templateVersionId: "",
				templateVersionNo: 0,
				templatePayloadHash: "",
				title: "",
				description: "",
				focusDimensions: [],
				questions: [],
				scorecardFields: [],
				reason: ""
			};
		}
		/** 归一化重点维度：只保留有 key 的元素；weight 只认非负有限数（缺失 → null）。 */
		function normalizeRoundFocusDimensions(value) {
			const out = [];
			for (const item of items(value)) {
				const entry = record(item);
				const key = text(entry.key);
				if (key === "") continue;
				out.push({
					key,
					label: text(entry.label) !== "" ? text(entry.label) : key,
					weight: numberOrNull(entry.weight),
					required: bool(entry.required),
					inRubric: bool(entry.in_rubric)
				});
			}
			return out;
		}
		/** 归一化建议问题：只保留有原文的元素（key 可以是 ''，不编造）。 */
		function normalizeRoundFocusQuestions(value) {
			const out = [];
			for (const item of items(value)) {
				const entry = record(item);
				const questionText = text(entry.text);
				if (questionText === "") continue;
				out.push({
					key: text(entry.key),
					text: questionText
				});
			}
			return out;
		}
		/** 归一化评分表字段：只保留有 key 的元素（label 缺失回退 key）。 */
		function normalizeRoundFocusScorecardFields(value) {
			const out = [];
			for (const item of items(value)) {
				const entry = record(item);
				const key = text(entry.key);
				if (key === "") continue;
				out.push({
					key,
					label: text(entry.label) !== "" ? text(entry.label) : key,
					kind: text(entry.kind),
					required: bool(entry.required)
				});
			}
			return out;
		}
		/**
		* 归一化 `application.interviews[].round_focus`（task-50 冻结字段，严格容错）。
		*
		* 规则（`work/d5/round/REPORT.md` §2 + INTERFACE §2.4）：
		*   1. 非对象 / 缺键 / 坏类型 → `emptyRoundFocus()`（available:false、source:''、数组空），**不编造**；
		*   2. `available` 只认严格 true；`available=false` 时只保留服务端事实 `source/roundNo/reason`，
		*      内容数组一律清空——降级卡靠 `reason` 说明，绝不用岗位 Rubric 冒充本轮重点；
		*   3. `available=true` 时逐字段原样映射；缺字段的数组项直接丢弃（不补默认文案）。
		* @param value - 服务端原始 `round_focus`。
		* @returns 可渲染的轮次重点视图（绝不抛错）。
		*/
		function normalizeRoundFocus$1(value) {
			if (value === null || value === void 0) return emptyRoundFocus$1();
			const raw = record(value);
			if (Object.keys(raw).length === 0) return emptyRoundFocus$1();
			const available = bool(raw.available);
			const source = text(raw.source);
			const roundNo = count(raw.round_no);
			const reason = text(raw.reason);
			if (!available) return {
				...emptyRoundFocus$1(),
				available: false,
				source,
				roundNo,
				reason
			};
			return {
				available: true,
				source,
				roundNo,
				templateVersionId: text(raw.template_version_id),
				templateVersionNo: count(raw.template_version_no),
				templatePayloadHash: text(raw.template_payload_hash),
				title: text(raw.title),
				description: text(raw.description),
				focusDimensions: normalizeRoundFocusDimensions(raw.focus_dimensions),
				questions: normalizeRoundFocusQuestions(raw.questions),
				scorecardFields: normalizeRoundFocusScorecardFields(raw.scorecard_fields),
				reason
			};
		}
		/** 归一化一轮面试（四个独立分支各归各的，不用排期状态推断面评/转写）。 */
		function normalizeInterview(value, context) {
			const raw = record(value);
			const id = text(raw.interview_id);
			const roundNo = count(raw.round_no);
			const slotCode = text(raw.slot_code);
			if (id === "" && roundNo === 0 && slotCode === "") return null;
			const status = oneOf(raw.status, [
				"SCHEDULED",
				"IN_PROGRESS",
				"POST_INTERVIEW",
				"EVALUATION_READY",
				"DECIDED",
				"RESCHEDULED",
				"CANCELLED",
				"NO_SHOW"
			]) || text(raw.status);
			const interviewersRaw = items(raw.interviewers);
			const interviewers = [];
			for (const item of interviewersRaw) {
				const interviewer = normalizeInterviewer(item);
				if (interviewer !== null) interviewers.push(interviewer);
			}
			const scorecardsRaw = record(raw.scorecards);
			const required = count(scorecardsRaw.required_total);
			const submitted = count(scorecardsRaw.submitted);
			const missing = count(scorecardsRaw.missing_total);
			const overdue = count(scorecardsRaw.overdue);
			const complete = required > 0 && submitted >= required;
			return {
				id,
				roundNo,
				slotCode,
				stageCode: text(raw.stage_code),
				stageLabel: text(raw.stage_code) === "" ? "" : stageLabelOf(text(raw.stage_code), context),
				status,
				statusLabel: INTERVIEW_STATUS_LABELS[status] ?? (status !== "" ? status : "状态未知"),
				statusTone: INTERVIEW_STATUS_TONES[status] ?? "gray",
				scheduledStartAt: text(raw.scheduled_start_at),
				scheduledStartText: formatDateTime(raw.scheduled_start_at),
				scheduledEndAt: text(raw.scheduled_end_at),
				scheduledEndText: formatDateTime(raw.scheduled_end_at),
				timezone: text(raw.timezone),
				interviewers,
				scorecards: {
					required,
					submitted,
					missing,
					overdue,
					summaryText: required === 0 ? "无需面评" : roundNo > 0 ? `已提交 ${String(submitted)}/${String(required)}（第 ${String(roundNo)} 轮）` : `已提交 ${String(submitted)}/${String(required)}`,
					tone: required === 0 ? "gray" : complete ? "green" : overdue > 0 ? "red" : "amber"
				},
				transcript: normalizeTranscript$1(raw.transcript),
				roundFocus: normalizeRoundFocus$1(raw.round_focus)
			};
		}
		/**
		* 从服务端进度聚合出"面评进度"（不重算业务数）。
		*
		* O9：`scorecards_required` 是**跨轮应提交份数合计**（例：第 1 轮 1 份 + 第 2 轮 2 份 = 3），
		* 不是"3 个面试官"。所以这里只用**同一份数据**里的 `interviews[]`（每轮 `round_no` +
		* `scorecards.required_total/submitted`）把轮次口径说出来，不新增服务端字段、不改数字。
		*
		* 口径不编造规则（两条同时满足才写逐轮明细）：① 至少 2 轮——单轮时 `x/y` 不会读成"面试官人数"，
		* 不必加括注；② 逐轮 required 之和必须等于服务端聚合 required。对不上 / 只有一轮时只给总数，
		* 绝不凭空造轮次。
		* @param value - `progress` 段（`scorecards_required` / `scorecards_submitted`）。
		* @param interviews - 同一份申请数据里的面试轮次（缺省 = 没有逐轮口径）。
		*/
		function buildScorecardProgress(value, interviews = []) {
			const raw = record(value);
			const required = count(raw.scorecards_required);
			const submitted = count(raw.scorecards_submitted);
			const complete = required > 0 && submitted >= required;
			const rounds = [];
			for (const interview of interviews) {
				if (interview.roundNo <= 0 || interview.scorecards.required <= 0) continue;
				rounds.push({
					roundNo: interview.roundNo,
					required: interview.scorecards.required,
					submitted: interview.scorecards.submitted
				});
			}
			const sumRequired = rounds.reduce((total, round) => total + round.required, 0);
			const perRound = rounds.length >= 2 && sumRequired === required;
			const breakdown = perRound ? rounds.map((round) => `第 ${String(round.roundNo)} 轮 ${String(round.required)} 份`).join(" / ") : `跨 ${String(rounds.length)} 轮合计`;
			const suffix = rounds.length >= 2 ? `（${breakdown}）` : "";
			return {
				required,
				submitted,
				rounds: perRound ? rounds : [],
				summaryText: required === 0 ? "无需面评" : `已提交 ${String(submitted)}/${String(required)}${suffix}`,
				tone: required === 0 ? "gray" : complete ? "green" : "amber"
			};
		}
		/** 面试轮次与状态的一行文案。 */
		function interviewSummaryOf(interviews) {
			const rounds = interviews.length;
			if (rounds === 0) return {
				rounds,
				summary: "未排期",
				tone: "gray"
			};
			let tone = "gray";
			for (const interview of interviews) {
				const candidate = interview.status === "SCHEDULED" || interview.status === "IN_PROGRESS" ? "blue" : interview.status === "POST_INTERVIEW" || interview.status === "RESCHEDULED" ? "amber" : interview.status === "EVALUATION_READY" || interview.status === "DECIDED" ? "green" : interview.status === "NO_SHOW" ? "red" : "gray";
				const rank = {
					red: 4,
					amber: 3,
					blue: 2,
					green: 1,
					gray: 0
				};
				if (rank[candidate] > rank[tone]) tone = candidate;
			}
			const last = interviews[interviews.length - 1];
			return {
				rounds,
				summary: `${String(rounds)} 轮${last !== void 0 ? ` · ${last.statusLabel}` : ""}`,
				tone
			};
		}
		/** 转写状态一行文案（来自服务端 `progress.transcript_state`）。 */
		function transcriptSummaryOf(value) {
			const state = oneOf(value, [
				"READY",
				"PROCESSING",
				"NOT_READY",
				"FAILED",
				"MISSING"
			]);
			if (state === "") return {
				summary: "状态未知",
				tone: "gray"
			};
			return {
				summary: TRANSCRIPT_STATE_LABELS[state] ?? state,
				tone: TRANSCRIPT_STATE_TONES[state] ?? "gray"
			};
		}
		/** 归一化决策。 */
		function normalizeDecision(value, context) {
			const raw = record(value);
			const id = text(raw.decision_id);
			const result = text(raw.result);
			const reason = text(raw.reason);
			if (id === "" && result === "" && reason === "") return null;
			const scope = text(raw.decision_scope);
			const stageCode = text(raw.stage_code);
			return {
				id,
				scope,
				scopeLabel: DECISION_SCOPE_LABELS[scope] ?? (scope !== "" ? scope : ""),
				stageCode,
				stageLabel: stageCode === "" ? "" : stageLabelOf(stageCode, context),
				result,
				resultLabel: DECISION_RESULT_LABELS[result] ?? (result !== "" ? result : "结论未知"),
				resultTone: DECISION_RESULT_TONES[result] ?? "gray",
				reason,
				decidedAt: text(raw.decided_at),
				decidedAtText: formatDateTime(raw.decided_at),
				decidedBy: text(raw.decided_by_display_name),
				isCurrent: bool(raw.is_current),
				supersededBy: text(raw.superseded_by_decision_id),
				basisKinds: stringList(raw.basis_kinds)
			};
		}
		/** 归一化时间线一条。 */
		function normalizeTimelineEntry(value) {
			const raw = record(value);
			const at = text(raw.at);
			const kind = text(raw.kind);
			const label = text(raw.label);
			if (at === "" && kind === "" && label === "") return null;
			return {
				at,
				atText: formatDateTime(at),
				kind,
				kindLabel: TIMELINE_KIND_LABELS[kind] ?? (kind !== "" ? kind : ""),
				label,
				refId: text(raw.ref_id)
			};
		}
		/** 申请头部（行 / 详情共用；**不含下一步**）。 */
		function buildApplicationHeader(value, context) {
			const raw = record(value);
			const candidate = record(raw.candidate);
			const job = record(raw.job);
			const id = text(raw.application_id);
			const lifecycleStatus = oneOf(raw.lifecycle_status, [
				"ACTIVE",
				"ON_HOLD",
				"WITHDRAWN",
				"CLOSED"
			]) || text(raw.lifecycle_status);
			const stageCode = text(raw.current_stage_code);
			const candidateName = text(candidate.display_name);
			const applicationRubricRaw = record(raw.rubric);
			const applicationRubricVersionNo = count(applicationRubricRaw.version_no);
			const applicationRubric = applicationRubricVersionNo > 0 ? {
				versionNo: applicationRubricVersionNo,
				approved: bool(applicationRubricRaw.approved)
			} : null;
			return {
				id,
				rowKey: id !== "" ? id : `application-${text(job.job_id)}-${String(count(raw.record_version))}`,
				candidateId: text(candidate.candidate_id),
				candidateName: candidateName !== "" ? candidateName : "（服务端未提供候选人姓名）",
				candidateInitial: initial(candidateName),
				jobId: text(job.job_id),
				jobCode: text(job.code),
				jobTitle: text(job.title) !== "" ? text(job.title) : "（服务端未提供岗位名称）",
				lifecycleStatus,
				lifecycleLabel: LIFECYCLE_LABELS[lifecycleStatus] ?? (lifecycleStatus !== "" ? lifecycleStatus : "状态未知"),
				lifecycleTone: LIFECYCLE_TONES[lifecycleStatus] ?? "gray",
				stageCode,
				stageLabel: stageLabelOf(stageCode, context),
				stageTone: STAGE_TONES[stageCode] ?? "gray",
				stageEnteredAt: text(raw.stage_entered_at),
				stageEnteredAtText: formatDateTime(raw.stage_entered_at),
				appliedAt: text(raw.applied_at),
				appliedAtText: formatDateTime(raw.applied_at),
				stageBlockedReason: text(raw.stage_blocked_reason),
				recordVersion: count(raw.record_version),
				applicationRubric
			};
		}
		/**
		* 申请钉住的评分标准一行文案（O13：与"岗位当前评分标准"分开出现，绝不并成一句）。
		* `null` = 该申请没有钉住版本（服务端 `application.rubric = null`），如实写"未钉住"。
		*/
		function applicationRubricTextOf(value) {
			if (value === null) return "未钉住";
			return `v${String(value.versionNo)} · ${value.approved ? "已批准" : "未批准"}`;
		}
		/**
		* 设置入口说明的 HR 文案（O6：服务端 `settings.entry.note` 原文里可能带 `seam` / href / 机器码，
		* 主文案不展示原文；原文保留在 `settings.entry.note` 数据层，供证据/排障读取）。
		*/
		function settingsEntryNoteText(entry) {
			return entry.available ? "设置页已可用" : "设置页暂不可用（当前只读）";
		}
		/** 面试列表（详情与行共用同一套归一化）。 */
		function buildInterviews(value, context) {
			const out = [];
			for (const item of items(value)) {
				const interview = normalizeInterview(item, context);
				if (interview !== null) out.push(interview);
			}
			return out;
		}
		/** 申请列表行（唯一一份下一步来自 `progress.next_step`）。 */
		function buildApplicationRow(value, context) {
			const raw = record(value);
			const header = buildApplicationHeader(raw, context);
			const material = normalizeMaterial(raw.material);
			const materialSummary = materialSummaryOf(material);
			const screening = normalizeScreening(raw.screening, context);
			const screeningSummary = screeningSummaryOf(screening);
			const interviews = buildInterviews(raw.interviews, context);
			const interviewSummary = interviewSummaryOf(interviews);
			const progress = record(raw.progress);
			const scorecardProgress = buildScorecardProgress(progress, interviews);
			const transcriptSummary = transcriptSummaryOf(progress.transcript_state);
			const nextStep = normalizeNextStep(progress.next_step);
			const filterKind = nextStep.code === "PROVIDE_SCREENING_DECISION" || header.stageCode === "S7" ? "screening" : nextStep.code === "PREPARE_INTERVIEW" || nextStep.code === "WAIT_SCORECARDS" || header.stageCode === "S8" || header.stageCode === "S9" ? "interviewing" : "other";
			return {
				...header,
				material,
				materialSummary: materialSummary.summary,
				materialTone: materialSummary.tone,
				screening,
				screeningSummary: screeningSummary.summary,
				screeningTone: screeningSummary.tone,
				interviews,
				interviewRoundCount: interviewSummary.rounds,
				interviewSummary: interviewSummary.summary,
				interviewTone: interviewSummary.tone,
				scorecardProgress,
				transcriptSummary: transcriptSummary.summary,
				transcriptTone: transcriptSummary.tone,
				nextStep,
				filterKind
			};
		}
		/** 申请行列表；非对象元素直接丢弃（`null` / 字符串不是申请）。 */
		function buildApplicationRows(value, context) {
			const out = [];
			for (const item of items(value)) {
				if (Object.keys(record(item)).length === 0) continue;
				out.push(buildApplicationRow(item, context));
			}
			return out;
		}
		/** 岗位卡。 */
		function buildJob(value, context) {
			const raw = record(value);
			const rubricRaw = record(raw.rubric);
			const rubricVersionId = text(rubricRaw.rubric_version_id);
			const rubric = rubricVersionId === "" && count(rubricRaw.version_no) === 0 && count(rubricRaw.dimension_count) === 0 ? null : {
				rubricVersionId,
				versionNo: count(rubricRaw.version_no),
				approved: bool(rubricRaw.approved),
				dimensionCount: count(rubricRaw.dimension_count),
				summaryText: joinTexts([
					`岗位当前 Rubric v${String(count(rubricRaw.version_no))}`,
					`${String(count(rubricRaw.dimension_count))} 个维度`,
					bool(rubricRaw.approved) ? "已批准" : "未批准"
				]),
				tone: bool(rubricRaw.approved) ? "green" : "amber"
			};
			const postingsRaw = items(raw.postings);
			const postings = [];
			for (const item of postingsRaw) {
				const entry = record(item);
				const status = text(entry.status);
				postings.push({
					id: text(entry.posting_id),
					channelName: text(entry.channel_name),
					status,
					statusLabel: status !== "" ? status : "状态未知",
					tone: status === "PUBLISHED" || status === "ACTIVE" ? "green" : status === "CLOSED" ? "gray" : "gray",
					externalUrl: text(entry.external_url)
				});
			}
			const countsRaw = record(raw.application_counts);
			const byStageRaw = record(countsRaw.by_stage);
			const byStage = Object.keys(byStageRaw).map((code) => ({
				code,
				label: stageLabelOf(code, context),
				count: count(byStageRaw[code])
			})).sort((left, right) => stageOrderOf(left.code, context) - stageOrderOf(right.code, context));
			const status = oneOf(raw.status, [
				"DRAFT",
				"PENDING_REVIEW",
				"APPROVED",
				"OPEN",
				"PAUSED",
				"CLOSED",
				"ARCHIVED"
			]) || text(raw.status);
			const versionNo = numberOrNull(raw.version_no);
			const title = text(raw.title);
			const code = text(raw.code);
			const id = text(raw.job_id);
			return {
				id,
				rowKey: id !== "" ? id : `job-${code}`,
				code,
				title: title !== "" ? title : code !== "" ? code : "（服务端未提供岗位名称）",
				status,
				statusLabel: JOB_STATUS_LABELS[status] ?? (status !== "" ? status : "状态未知"),
				statusTone: JOB_STATUS_TONES[status] ?? "gray",
				departmentName: text(raw.department_name),
				createdAt: text(raw.created_at),
				createdAtText: formatDateTime(raw.created_at),
				statusChangedAt: text(raw.status_changed_at),
				statusChangedAtText: formatDateTime(raw.status_changed_at),
				versionNo,
				versionText: versionNo === null ? "" : `r${String(versionNo)}`,
				rubric,
				postings,
				applicationCounts: {
					total: count(countsRaw.total),
					active: count(countsRaw.active),
					byStage
				},
				nextStep: normalizeNextStep(raw.next_step)
			};
		}
		/** 设置快照（只读）。 */
		function normalizeSettings(value, context) {
			const raw = record(value);
			const catalogRaw = raw.stage_catalog;
			let stageCatalog = null;
			if (catalogRaw !== null && catalogRaw !== void 0) {
				const entry = record(catalogRaw);
				const stagesRaw = items(entry.stages);
				const stages = [];
				for (const item of stagesRaw) {
					const stage = record(item);
					const code = text(stage.code);
					if (code === "") continue;
					stages.push({
						code,
						label: text(stage.label) !== "" ? text(stage.label) : stageLabelOf(code, context),
						kind: text(stage.kind),
						order: count(stage.order),
						inV1Scope: bool(stage.in_v1_scope)
					});
				}
				stageCatalog = {
					versionNo: count(entry.version_no),
					effectiveFrom: text(entry.effective_from),
					effectiveFromText: formatDateTime(entry.effective_from),
					stages
				};
			}
			const configsRaw = items(raw.configs);
			const configs = [];
			for (const item of configsRaw) {
				const entry = record(item);
				const payloadKeys = stringList(entry.payload_keys);
				configs.push({
					configKey: text(entry.config_key),
					scope: text(entry.scope),
					scopeId: text(entry.scope_id),
					versionNo: count(entry.version_no),
					effectiveFrom: text(entry.effective_from),
					effectiveFromText: formatDateTime(entry.effective_from),
					effectiveTo: text(entry.effective_to),
					effectiveToText: formatDateTime(entry.effective_to),
					payloadKeys,
					payloadKeyCount: payloadKeys.length
				});
			}
			const departments = [];
			for (const item of items(raw.departments)) {
				const entry = record(item);
				const id = text(entry.department_id);
				const name = text(entry.name);
				if (id === "" && name === "") continue;
				departments.push({
					id,
					name
				});
			}
			const hiringTeams = [];
			for (const item of items(raw.hiring_teams)) {
				const entry = record(item);
				const teamId = text(entry.team_id);
				const membersRaw = items(entry.members);
				const members = [];
				for (const memberItem of membersRaw) {
					const member = record(memberItem);
					const actorId = text(member.actor_id);
					const displayName = text(member.display_name);
					if (actorId === "" && displayName === "") continue;
					members.push({
						actorId,
						displayName: displayName !== "" ? displayName : "（未提供姓名）",
						teamRole: text(member.team_role),
						actorKind: text(member.actor_kind)
					});
				}
				hiringTeams.push({
					id: teamId,
					code: text(entry.code),
					name: text(entry.name),
					departmentName: text(entry.department_name),
					members
				});
			}
			const entryRaw = record(raw.entry);
			return {
				stageCatalog,
				configs,
				departments,
				hiringTeams,
				entry: {
					available: bool(entryRaw.available),
					href: text(entryRaw.href),
					note: text(entryRaw.note)
				}
			};
		}
		/** 从阶段目录构造阶段上下文（标签 / 顺序都以服务端为准）。 */
		function stageContextOf(settingsRaw) {
			const catalog = record(record(settingsRaw).stage_catalog);
			const labels = {};
			const order = {};
			for (const item of items(catalog.stages)) {
				const stage = record(item);
				const code = text(stage.code);
				if (code === "") continue;
				const label = text(stage.label);
				if (label !== "") labels[code] = label;
				const sortOrder = count(stage.order);
				if (sortOrder > 0) order[code] = sortOrder;
			}
			return {
				labels,
				order
			};
		}
		/** 阶段计数表 → 稳定排序数组（空阶段码直接丢弃，不渲染"未提供阶段 · N"这种假分组）。 */
		function byStageRows(value, context) {
			const raw = record(value);
			return Object.keys(raw).filter((code) => code.trim() !== "").map((code) => ({
				code,
				label: stageLabelOf(code, context),
				count: count(raw[code])
			})).sort((left, right) => stageOrderOf(left.code, context) - stageOrderOf(right.code, context));
		}
		/** overview 的下一步聚合（用于 aside 的计数，不重复逐条结论）。 */
		function summarizeNextSteps(rows) {
			let info = 0;
			let human = 0;
			let wait = 0;
			let missing = 0;
			for (const row of rows) if (!row.nextStep.hasStep) missing += 1;
			else if (row.nextStep.kind === "HUMAN_ACTION") human += 1;
			else if (row.nextStep.kind === "WAIT") wait += 1;
			else info += 1;
			return {
				info,
				human,
				wait,
				missing
			};
		}
		/** 归一化 `GET /recruitment/api/recruiting/overview` 响应（坏类型只降级，不抛错）。 */
		function normalizeOverviewView(value) {
			const raw = record(value);
			const context = stageContextOf(raw.settings);
			const countsRaw = record(raw.counts);
			const actorRaw = record(raw.actor);
			const settings = normalizeSettings(raw.settings, context);
			const actions = normalizeActions(raw.actions);
			const applications = buildApplicationRows(raw.applications, context);
			const jobsRaw = items(raw.jobs);
			const jobs = [];
			for (const item of jobsRaw) {
				if (Object.keys(record(item)).length === 0) continue;
				jobs.push(buildJob(item, context));
			}
			const sortedJobs = sortJobViews(jobs);
			return {
				contractVersion: text(raw.contract_version),
				configured: bool(raw.configured),
				issues: stringList(raw.issues),
				evaluatedAt: text(raw.evaluated_at),
				evaluatedAtText: formatDateTime(raw.evaluated_at),
				actor: {
					actorId: text(actorRaw.actor_id),
					displayName: text(actorRaw.display_name),
					roles: stringList(actorRaw.roles)
				},
				labels: normalizeThreeDimLabels(raw.labels),
				counts: {
					jobsTotal: count(countsRaw.jobs_total),
					jobsOpen: count(countsRaw.jobs_open),
					applicationsTotal: count(countsRaw.applications_total),
					applicationsActive: count(countsRaw.applications_active),
					awaitingScreening: count(countsRaw.awaiting_screening),
					interviewing: count(countsRaw.interviewing),
					awaitingDecision: count(countsRaw.awaiting_decision),
					interviewsScheduled: count(countsRaw.interviews_scheduled),
					scorecardsRequiredTotal: count(countsRaw.scorecards_required_total),
					scorecardsSubmittedTotal: count(countsRaw.scorecards_submitted_total),
					transcriptsReady: count(countsRaw.transcripts_ready),
					transcriptsPending: count(countsRaw.transcripts_pending),
					byStage: byStageRows(countsRaw.applications_by_stage, context)
				},
				jobs: sortedJobs,
				applications,
				settings,
				actions: actions.byKey,
				actionList: actions.list,
				nextStepTotals: summarizeNextSteps(applications)
			};
		}
		/** 归一化申请详情里的简历段。 */
		function normalizeResumeDetail(value) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			const material = normalizeMaterial(raw.material);
			if (material === null) return null;
			const fields = [];
			for (const item of items(raw.fields)) {
				const entry = record(item);
				const key = text(entry.key) !== "" ? text(entry.key) : text(entry.field);
				if (key === "") continue;
				fields.push({
					key,
					state: text(entry.state),
					provenance: text(entry.provenance),
					entryCount: numberOrNull(entry.entry_count),
					valuePreview: text(entry.value_preview)
				});
			}
			const workEntries = [];
			for (const item of items(raw.work_entries)) {
				const entry = record(item);
				workEntries.push({
					company: text(entry.company),
					title: text(entry.title),
					start: text(entry.start),
					end: text(entry.end)
				});
			}
			const educationEntries = [];
			for (const item of items(raw.education_entries)) {
				const entry = record(item);
				educationEntries.push({
					text: text(entry.text),
					start: text(entry.start),
					end: text(entry.end)
				});
			}
			const evidenceSamples = [];
			for (const item of items(raw.evidence_samples)) {
				const entry = record(item);
				const quote = text(entry.quote);
				if (quote === "") continue;
				evidenceSamples.push({
					field: text(entry.field),
					page: numberOrNull(entry.page),
					quote,
					block: numberOrNull(entry.block)
				});
			}
			return {
				material,
				fields,
				workEntries,
				educationEntries,
				evidenceSamples
			};
		}
		/** 归一化 rubric 维度（详情用；`rubricVersionId` 供批准动作构造请求，缺失为 ''）。 */
		function normalizeRubricDimensions$1(value) {
			if (value === null || value === void 0) return null;
			const raw = record(value);
			const rubricVersionId = text(raw.rubric_version_id);
			const versionNo = count(raw.version_no);
			const approved = bool(raw.approved);
			const dimensions = [];
			for (const item of items(raw.dimensions)) {
				const entry = record(item);
				const key = text(entry.key);
				if (key === "") continue;
				dimensions.push({
					key,
					kind: text(entry.kind),
					label: text(entry.label) !== "" ? text(entry.label) : key,
					weight: numberOrNull(entry.weight),
					operator: text(entry.operator),
					valuePreview: preview(entry.value),
					question: text(entry.question)
				});
			}
			if (versionNo === 0 && dimensions.length === 0 && rubricVersionId === "") return null;
			return {
				rubricVersionId,
				versionNo,
				approved,
				dimensions
			};
		}
		/** 归一化申请详情（`GET .../applications/:id`）。 */
		function normalizeApplicationDetail(value) {
			const raw = record(value);
			const applicationRaw = record(raw.application);
			const header = buildApplicationHeader(applicationRaw);
			const progress = record(applicationRaw.progress);
			const interviews = buildInterviews(applicationRaw.interviews);
			const transcriptSummary = transcriptSummaryOf(progress.transcript_state);
			const actions = normalizeActions(raw.actions);
			const screeningEvidenceRaw = record(raw.screening_evidence);
			const decision = normalizeScreening(screeningEvidenceRaw.decision);
			const rubric = normalizeRubricDimensions$1(screeningEvidenceRaw.rubric);
			const basis = [];
			for (const item of items(screeningEvidenceRaw.basis)) {
				const entry = record(item);
				const kind = text(entry.kind);
				if (kind === "") continue;
				basis.push({
					kind,
					detailText: preview(entry.detail)
				});
			}
			const transcriptRuns = [];
			for (const item of items(raw.transcript_runs)) {
				const entry = record(item);
				const runId = text(entry.run_id);
				const artifactId = text(entry.artifact_id);
				if (runId === "" && artifactId === "") continue;
				transcriptRuns.push({
					runId,
					artifactId,
					artifactIdText: shortSha(artifactId),
					status: text(entry.status),
					chunkTotal: count(entry.chunk_total),
					chunkSucceeded: count(entry.chunk_succeeded),
					chunkFailed: count(entry.chunk_failed),
					modelId: text(entry.model_id)
				});
			}
			const decisions = [];
			for (const item of items(applicationRaw.decisions)) {
				const normalized = normalizeDecision(item);
				if (normalized !== null) decisions.push(normalized);
			}
			const timeline = [];
			for (const item of items(raw.timeline)) {
				const normalized = normalizeTimelineEntry(item);
				if (normalized !== null) timeline.push(normalized);
			}
			const actorRaw = record(raw.actor);
			return {
				contractVersion: text(raw.contract_version),
				evaluatedAt: text(raw.evaluated_at),
				evaluatedAtText: formatDateTime(raw.evaluated_at),
				actor: {
					actorId: text(actorRaw.actor_id),
					displayName: text(actorRaw.display_name),
					roles: stringList(actorRaw.roles)
				},
				labels: normalizeThreeDimLabels(raw.labels),
				header,
				nextStep: normalizeNextStep(progress.next_step),
				material: normalizeMaterial(applicationRaw.material),
				resume: normalizeResumeDetail(raw.resume),
				screeningEvidence: {
					decision,
					rubric,
					basis
				},
				interviews,
				scorecardProgress: buildScorecardProgress(progress, interviews),
				transcriptSummary: transcriptSummary.summary,
				transcriptTone: transcriptSummary.tone,
				transcriptRuns,
				decisions,
				timeline,
				actions: actions.byKey,
				actionList: actions.list
			};
		}
		/** 归一化岗位详情（`GET .../jobs/:id`）。 */
		function normalizeJobDetail(value) {
			const raw = record(value);
			const job = buildJob(raw.job);
			const versions = [];
			for (const item of items(raw.versions)) {
				const entry = record(item);
				const id = text(entry.job_version_id);
				const versionNo = count(entry.version_no);
				if (id === "" && versionNo === 0) continue;
				const payloadHash = text(entry.payload_hash);
				versions.push({
					id,
					versionNo,
					payloadHash,
					payloadHashText: shortSha(payloadHash),
					createdAt: text(entry.created_at),
					createdAtText: formatDateTime(entry.created_at),
					approved: bool(entry.approved)
				});
			}
			const rubricRaw = normalizeRubricDimensions$1(raw.rubric);
			const rubric = rubricRaw === null ? null : {
				...rubricRaw,
				approved: rubricRaw.approved || (job.rubric?.approved ?? false)
			};
			const applications = buildApplicationRows(raw.applications);
			const actions = normalizeActions(raw.actions);
			return {
				contractVersion: text(raw.contract_version),
				evaluatedAt: text(raw.evaluated_at),
				evaluatedAtText: formatDateTime(raw.evaluated_at),
				labels: normalizeThreeDimLabels(raw.labels),
				job,
				descriptionMd: text(raw.description_md),
				requirementsMd: text(raw.requirements_md),
				versions,
				rubric,
				applications,
				actions: actions.byKey,
				actionList: actions.list
			};
		}
		// src/client/recruiting/use-recruiting.ts
		/** 只读路由前缀（独立前缀，见 `src/http/recruiting.ts`）。 */
		const RECRUITING_API_PREFIX = "/recruitment/api/recruiting";
		/** 同源标记头：宿主只放行带 `x-recruitment-request: 1` 的请求。 */
		const RECRUITING_REQUEST_HEADER = "x-recruitment-request";
		/** 身份头：写动作的身份**只**来自当前 DSH session（值由宿主 props 传入，不读 localStorage）。 */
		const RECRUITING_SESSION_HEADER = "x-dsh-session";
		/** 带契约字段的客户端请求错误。 */
		var RecruitingRequestError = class extends Error {
			info;
			constructor(info) {
				super(info.message);
				this.name = "RecruitingRequestError";
				this.info = info;
			}
		};
		/** 把任意异常归一化成 `RecruitingErrorInfo`（网络异常 → status 0 / code NETWORK）。 */
		function toRecruitingErrorInfo(failure) {
			if (failure instanceof RecruitingRequestError) return failure.info;
			return {
				status: 0,
				code: "NETWORK",
				reasonCode: "",
				message: `请求失败：${failure instanceof Error ? failure.message : String(failure)}`,
				rawBody: ""
			};
		}
		/** 解析非 2xx 响应体（保留 code / reason_code / message 原文）。 */
		function parseRecruitingError(status, rawBody) {
			const body = rawBody.trim();
			let parsed = void 0;
			if (body !== "") try {
				parsed = JSON.parse(body);
			} catch {
				parsed = void 0;
			}
			const errorRaw = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.error : void 0;
			const errorRecord = errorRaw !== null && typeof errorRaw === "object" && !Array.isArray(errorRaw) ? errorRaw : {};
			const code = typeof errorRecord.code === "string" ? errorRecord.code : "";
			const reasonCode = typeof errorRecord.reason_code === "string" ? errorRecord.reason_code : "";
			const serverMessage = typeof errorRecord.message === "string" ? errorRecord.message : typeof errorRaw === "string" ? errorRaw : "";
			const prefix = [code, reasonCode].filter((part) => part !== "").join("/");
			return {
				status,
				code,
				reasonCode,
				message: serverMessage !== "" ? `${prefix === "" ? "" : `${prefix}：`}${serverMessage}` : `宿主返回 HTTP ${String(status)}${body === "" ? "" : `：${body.slice(0, 200)}`}`,
				rawBody: body.slice(0, 2e3)
			};
		}
		/** 只读 GET 的公共头（同源标记）。 */
		function readHeaders() {
			return { [RECRUITING_REQUEST_HEADER]: "1" };
		}
		/** 写请求的公共头（同源标记 + JSON + session；session 只来自形参）。 */
		function writeHeaders(sessionId) {
			return {
				[RECRUITING_REQUEST_HEADER]: "1",
				"content-type": "application/json",
				[RECRUITING_SESSION_HEADER]: sessionId.trim()
			};
		}
		/** 统一请求：网络异常转可读错误；非 2xx 转 `RecruitingRequestError`。 */
		async function requestRaw(url, init, signal) {
			let response;
			try {
				response = await fetch(url, {
					cache: "no-store",
					...init,
					...signal !== void 0 ? { signal } : {},
					headers: {
						...readHeaders(),
						...init.headers
					}
				});
			} catch (failure) {
				if (signal?.aborted === true) throw failure;
				throw new RecruitingRequestError({
					status: 0,
					code: "NETWORK",
					reasonCode: "",
					message: `网络请求失败：${failure instanceof Error ? failure.message : String(failure)}`,
					rawBody: ""
				});
			}
			let bodyText = "";
			try {
				bodyText = await response.text();
			} catch {
				bodyText = "";
			}
			if (!response.ok) throw new RecruitingRequestError(parseRecruitingError(response.status, bodyText));
			return {
				ok: true,
				status: response.status,
				bodyText
			};
		}
		/**
		* GET 一个 JSON 契约响应（**类型只用于编译期**；运行时形状由视图模型兜底归一化）。
		* @param url - 同源相对路径。
		* @param signal - 取消信号。
		* @returns 解析后的原始 JSON（空体/非 JSON 抛 `BAD_RESPONSE`）。
		*/
		async function requestJson$1(url, signal) {
			const raw = await requestRaw(url, { method: "GET" }, signal);
			const body = raw.bodyText.trim();
			if (body === "") throw new RecruitingRequestError({
				status: raw.status,
				code: "BAD_RESPONSE",
				reasonCode: "",
				message: "宿主返回了空响应体",
				rawBody: ""
			});
			try {
				return JSON.parse(body);
			} catch {
				throw new RecruitingRequestError({
					status: raw.status,
					code: "BAD_RESPONSE",
					reasonCode: "",
					message: "宿主返回的不是 JSON",
					rawBody: body.slice(0, 2e3)
				});
			}
		}
		/** 读取 `GET /recruitment/api/recruiting/overview` 并归一化成视图模型。 */
		async function fetchOverviewView(signal) {
			return normalizeOverviewView(await requestJson$1(`${RECRUITING_API_PREFIX}/overview`, signal));
		}
		/** 读取 `GET /recruitment/api/recruiting/applications/:id` 并归一化成视图模型。 */
		async function fetchApplicationDetail(applicationId, signal) {
			const id = applicationId.trim();
			if (id === "") throw new RecruitingRequestError({
				status: 0,
				code: "INVALID_ARGS",
				reasonCode: "ID_MISSING",
				message: "申请 id 为空，拒绝请求",
				rawBody: ""
			});
			return normalizeApplicationDetail(await requestJson$1(`${RECRUITING_API_PREFIX}/applications/${encodeURIComponent(id)}`, signal));
		}
		/** 读取 `GET /recruitment/api/recruiting/jobs/:id` 并归一化成视图模型。 */
		async function fetchJobDetail(jobId, signal) {
			const id = jobId.trim();
			if (id === "") throw new RecruitingRequestError({
				status: 0,
				code: "INVALID_ARGS",
				reasonCode: "ID_MISSING",
				message: "岗位 id 为空，拒绝请求",
				rawBody: ""
			});
			return normalizeJobDetail(await requestJson$1(`${RECRUITING_API_PREFIX}/jobs/${encodeURIComponent(id)}`, signal));
		}
		/**
		* 通用取数 hook：KEY 变化或 `reload()` 时重新 GET；卸载 / KEY 变化时取消在途请求。
		* @param key - 资源键（null = 不请求）。
		* @param loader - 真正的取数函数（可被替换而不触发重取）。
		* @returns 数据 / 错误 / 加载中 / 重取。
		*/
		function useResource(key, loader) {
			const [generation, setGeneration] = (0, react.useState)(0);
			const [data, setData] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(key !== null);
			const loaderRef = (0, react.useRef)(loader);
			loaderRef.current = loader;
			const reload = (0, react.useCallback)(() => {
				setGeneration((value) => value + 1);
			}, []);
			(0, react.useEffect)(() => {
				if (key === null) {
					setData(void 0);
					setError(void 0);
					setLoading(false);
					return;
				}
				const controller = new AbortController();
				let active = true;
				setLoading(true);
				setError(void 0);
				loaderRef.current(controller.signal).then((value) => {
					if (!active) return;
					setData(value);
					setLoading(false);
				}).catch((failure) => {
					if (!active || controller.signal.aborted) return;
					setData(void 0);
					setError(toRecruitingErrorInfo(failure));
					setLoading(false);
				});
				return () => {
					active = false;
					controller.abort();
				};
			}, [key, generation]);
			return {
				data,
				error,
				loading,
				reload,
				generation
			};
		}
		/** 工作区总览（岗位 / 申请 / 设置 / 动作可用性）。 */
		function useWorkspaceOverview() {
			return useResource("overview", (signal) => fetchOverviewView(signal));
		}
		/** 单个申请详情（id 为空串时不请求）。 */
		function useApplicationDetail(applicationId) {
			return useResource(applicationId.trim() === "" ? null : `application:${applicationId.trim()}`, (signal) => fetchApplicationDetail(applicationId, signal));
		}
		/** 单个岗位详情（id 为空串时不请求）。 */
		function useJobDetail(jobId) {
			return useResource(jobId.trim() === "" ? null : `job:${jobId.trim()}`, (signal) => fetchJobDetail(jobId, signal));
		}
		/** 发送前拒绝 → `ActionOutcome`（status 0，不发请求）。 */
		function refusedOutcome(key, check) {
			return {
				key,
				accepted: false,
				status: 0,
				envelope: null,
				error: {
					status: 0,
					code: check.code,
					reasonCode: check.reasonCode,
					message: `${check.reasonText}（reason_code：${check.reasonCode}）`,
					rawBody: ""
				},
				bodyText: "",
				payload: null
			};
		}
		/**
		* POST 一个写路径（body 已由 build* 产出）；成功只解析信封，**不**在这里判定业务成功。
		* @param path - 同源相对路径。
		* @param body - build* 产出的 body。
		* @param sessionId - 宿主 props 传入的 session id（只从形参来）。
		* @param key - 动作键（结果里回显）。
		* @returns 受理状态 / 信封 / 服务端错误原文。
		*/
		async function postWrite(path, body, sessionId, key, signal) {
			const check = checkWriteRequest(path, body, sessionId);
			if (!check.ok) return refusedOutcome(key, check);
			try {
				const raw = await requestRaw(path, {
					method: "POST",
					headers: writeHeaders(sessionId),
					body: JSON.stringify(body)
				}, signal);
				return {
					key,
					accepted: true,
					status: raw.status,
					envelope: parseActionEnvelope(raw.bodyText),
					error: null,
					bodyText: raw.bodyText.slice(0, 2e3),
					payload: parseActionPayload(raw.bodyText)
				};
			} catch (failure) {
				if (failure instanceof RecruitingRequestError) return {
					key,
					accepted: false,
					status: failure.info.status,
					envelope: null,
					error: failure.info,
					bodyText: failure.info.rawBody,
					payload: parseActionPayload(failure.info.rawBody)
				};
				return {
					key,
					accepted: false,
					status: 0,
					envelope: null,
					error: toRecruitingErrorInfo(failure),
					bodyText: "",
					payload: null
				};
			}
		}
		/**
		* POST 后端 action seam（JSON + `x-recruitment-request: 1` + `x-dsh-session`）。
		*
		* 安全口径：`action.available !== true` / seam 非 `/recruitment/` 同源相对路径 / body 含身份派生键 /
		* 缺 sessionId → **不发请求**，返回 `CLIENT_REFUSED`；2xx 只算"服务端受理"，调用方必须随后 `reload()`。
		* @param action - 归一化后的写动作（来自 `overview.actions` / 详情 `actions`）。
		* @param body - 由 `actions.ts` 的 `build*` 产出的 body（**不再固定发 {}**）。
		* @param sessionId - 当前 DSH session id（只来自形参）。
		* @returns `ActionOutcome`（信封 readback + 服务端错误原文）。
		*/
		async function postActionSeam(action, body, sessionId) {
			const check = checkActionRequest(action, body, sessionId);
			if (!check.ok) return refusedOutcome(action.key, check);
			return postWrite(action.seam, body, sessionId, action.key);
		}
		/**
		* 岗位关闭：内部固定 body `{job_id, confirm:true, reason?}`（`confirm:true` 是人的裁决）。
		* 调用方只在用户点"确认关闭"后调用；成功信封用 `parseJobCloseEnvelope(outcome.bodyText)` 解析。
		* @param jobId - 岗位 id。
		* @param reason - 可选关闭原因（≤500）。
		* @param sessionId - 当前 DSH session id（只来自形参）。
		*/
		async function postJobClose(jobId, reason, sessionId) {
			const id = jobId.trim();
			const trimmedReason = reason.trim();
			if (id === "") return refusedOutcome("job_close", {
				ok: false,
				status: 0,
				code: "CLIENT_REFUSED",
				reasonCode: "JOB_ID_INVALID",
				reasonText: "岗位 id 为空，拒绝关闭请求",
				missing: ["job_id"]
			});
			const body = {
				job_id: id,
				confirm: true
			};
			if (trimmedReason !== "") body.reason = trimmedReason;
			return postWrite(JOB_CLOSE_PATH, body, sessionId, "job_close");
		}
		/**
		* GET 同路径探测岗位关闭路由（零写入；405 = 已注册 POST 路由，404 = 未接线，403 = 同源问题）。
		* @param sessionId - 当前 DSH session id（带上是让同源/身份闸门按真实情况回答）。
		* @param signal - 取消信号。
		*/
		async function probeJobCloseSeam(sessionId, signal) {
			let status = 0;
			try {
				const response = await fetch(JOB_CLOSE_PATH, {
					method: "GET",
					cache: "no-store",
					...signal !== void 0 ? { signal } : {},
					headers: writeHeaders(sessionId)
				});
				status = response.status;
				try {
					await response.text();
				} catch {}
			} catch {
				status = 0;
			}
			return interpretCloseProbe(status);
		}
		/**
		* 岗位关闭 seam 探测 hook（只在启用时探测；卸载/重新探测时取消在途请求）。
		* @param sessionId - 当前 DSH session id。
		* @param enabled - 是否探测（例如只有 Recruiter 视图才需要）。
		*/
		function useJobCloseSeam(sessionId, enabled) {
			const [probe, setProbe] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(false);
			const [generation, setGeneration] = (0, react.useState)(0);
			const refresh = (0, react.useCallback)(() => {
				setGeneration((value) => value + 1);
			}, []);
			(0, react.useEffect)(() => {
				if (!enabled) {
					setProbe(void 0);
					setLoading(false);
					return;
				}
				const controller = new AbortController();
				let active = true;
				setLoading(true);
				probeJobCloseSeam(sessionId, controller.signal).then((value) => {
					if (!active) return;
					setProbe(value);
					setLoading(false);
				}).catch(() => {
					if (!active) return;
					setProbe(interpretCloseProbe(0));
					setLoading(false);
				});
				return () => {
					active = false;
					controller.abort();
				};
			}, [
				enabled,
				sessionId,
				generation
			]);
			return {
				probe,
				loading,
				refresh
			};
		}
		/**
		* 执行初筛评估 `POST /recruitment/api/decision/screening/evaluate`（body 只有 application_id）。
		* 成功信封不是标准 action 信封：用 `outcome.payload.evaluation/.readback` 显示；随后重新 GET facts。
		* @param applicationId - 申请 id。
		* @param sessionId - 当前 DSH session id（只来自形参）。
		*/
		async function postScreeningEvaluate(applicationId, sessionId) {
			const id = applicationId.trim();
			if (id === "") return refusedOutcome("screening_evaluate", {
				ok: false,
				status: 0,
				code: "CLIENT_REFUSED",
				reasonCode: "MISSING_APPLICATION_ID",
				reasonText: "申请 id 为空，拒绝初筛评估请求",
				missing: ["application_id"]
			});
			return postWrite(DECISION_EVALUATE_PATH, { application_id: id }, sessionId, "screening_evaluate");
		}
		/**
		* 正式决策 facade `POST /recruitment/api/decision/record`（body 必须由 `buildDecisionRecordBody` 产出；
		* 前端不传 summary_digest / basis_refs —— facade 自己从 facts 组装）。
		* @param body - `buildDecisionRecordBody` 产出的 body。
		* @param sessionId - 当前 DSH session id（只来自形参）。
		*/
		async function postDecisionRecordFacade(body, sessionId) {
			return postWrite(DECISION_RECORD_PATH, body, sessionId, "decision_record_facade");
		}
		/**
		* 岗位草案 `POST /recruitment/api/job-action/job/draft`（body 由 `buildJobDraftBody` 产出；只读不写库）。
		* @param body - `buildJobDraftBody` 产出的 body。
		* @param sessionId - 当前 DSH session id（只来自形参）。
		*/
		async function postJobDraft(body, sessionId) {
			return postWrite(JOB_DRAFT_PATH, body, sessionId, "job_draft");
		}
		/**
		* 岗位创建 `POST /recruitment/api/job-action/job/create`（body 由 `buildJobCreateBody` 产出；人确认后才调用）。
		* @param body - `buildJobCreateBody` 产出的 body。
		* @param sessionId - 当前 DSH session id（只来自形参）。
		*/
		async function postJobCreate(body, sessionId) {
			return postWrite(JOB_CREATE_PATH, body, sessionId, "job_create");
		}
		/**
		* GET 同路径探测一个写路由是否已注册（405 = 已注册 POST 路由 / 404 = 未接线 / 403 = 同源问题）。
		*
		* **不许**用 POST 空 body 探测（会打日志、可能触发闸门）。
		* @param path - 写路由路径（`/recruitment/...`）。
		* @param sessionId - 当前 DSH session id。
		* @param enabled - 是否探测。
		*/
		function useRouteProbe(path, sessionId, enabled) {
			const [state, setState] = (0, react.useState)("UNKNOWN");
			const [status, setStatus] = (0, react.useState)(0);
			const [loading, setLoading] = (0, react.useState)(false);
			const [generation, setGeneration] = (0, react.useState)(0);
			const refresh = (0, react.useCallback)(() => {
				setGeneration((value) => value + 1);
			}, []);
			(0, react.useEffect)(() => {
				if (!enabled || path === "") {
					setState("UNKNOWN");
					setStatus(0);
					setLoading(false);
					return;
				}
				const controller = new AbortController();
				let active = true;
				setLoading(true);
				const headers = { [RECRUITING_REQUEST_HEADER]: "1" };
				if (sessionId.trim() !== "") headers[RECRUITING_SESSION_HEADER] = sessionId.trim();
				fetch(path, {
					method: "GET",
					cache: "no-store",
					signal: controller.signal,
					headers
				}).then(async (response) => {
					const next = interpretRouteProbe(response.status);
					try {
						await response.text();
					} catch {}
					if (!active) return;
					setState(next);
					setStatus(response.status);
					setLoading(false);
				}).catch(() => {
					if (!active) return;
					setState("UNKNOWN");
					setStatus(0);
					setLoading(false);
				});
				return () => {
					active = false;
					controller.abort();
				};
			}, [
				path,
				sessionId,
				enabled,
				generation
			]);
			return {
				state,
				status,
				loading,
				refresh
			};
		}
		/**
		* 读取决策事实投影 `GET /recruitment/api/decision/facts?application_id=<uuid>`。
		*
		* 404 / 非 2xx **不**当空 facts：`facts` 保持 undefined，probe 区分 MISSING(404) / ERROR(其它)。
		* @param applicationId - 申请 id。
		* @param sessionId - 当前 DSH session id（空串 = 不带该头，由服务端决定是否 400）。
		* @param signal - 取消信号。
		*/
		async function fetchDecisionFacts(applicationId, sessionId = "", signal) {
			const id = applicationId.trim();
			if (id === "") return {
				facts: void 0,
				probe: "MISSING",
				status: 0,
				error: {
					status: 0,
					code: "CLIENT_REFUSED",
					reasonCode: "MISSING_APPLICATION_ID",
					message: "申请 id 为空，拒绝读取决策事实",
					rawBody: ""
				}
			};
			const headers = { [RECRUITING_REQUEST_HEADER]: "1" };
			if (sessionId.trim() !== "") headers[RECRUITING_SESSION_HEADER] = sessionId.trim();
			const url = `${DECISION_FACTS_PATH}?application_id=${encodeURIComponent(id)}`;
			let status = 0;
			let bodyText = "";
			try {
				const response = await fetch(url, {
					method: "GET",
					cache: "no-store",
					...signal !== void 0 ? { signal } : {},
					headers
				});
				status = response.status;
				try {
					bodyText = await response.text();
				} catch {
					bodyText = "";
				}
			} catch (failure) {
				if (signal?.aborted === true) throw failure;
				return {
					facts: void 0,
					probe: "ERROR",
					status: 0,
					error: toRecruitingErrorInfo(failure)
				};
			}
			if (status === 404) return {
				facts: void 0,
				probe: "MISSING",
				status,
				error: parseRecruitingError(status, bodyText)
			};
			if (status < 200 || status >= 300) return {
				facts: void 0,
				probe: "ERROR",
				status,
				error: parseRecruitingError(status, bodyText)
			};
			const facts = normalizeDecisionFacts(parseActionPayload(bodyText));
			if (facts === null) return {
				facts: void 0,
				probe: "ERROR",
				status,
				error: {
					status,
					code: "BAD_RESPONSE",
					reasonCode: "",
					message: "决策事实投影响应无法归一化（缺 application_id 或不是 JSON 对象）",
					rawBody: bodyText.slice(0, 2e3)
				}
			};
			return {
				facts,
				probe: "READY",
				status,
				error: void 0
			};
		}
		/**
		* 决策事实 hook（facts 路由 404 → probe=MISSING，表单 disabled；成功 → READY + facts）。
		* @param applicationId - 申请 id。
		* @param enabled - 是否读取（例如详情已加载且是 Recruiter 视图）。
		* @param sessionId - 当前 DSH session id（**写动作身份只来自宿主 props**，不读 localStorage）。
		*/
		function useDecisionFacts(applicationId, enabled, sessionId = "") {
			const id = applicationId.trim();
			const [resource, setResource] = (0, react.useState)({
				facts: void 0,
				probe: "LOADING",
				error: void 0,
				status: 0
			});
			const [generation, setGeneration] = (0, react.useState)(0);
			const reload = (0, react.useCallback)(() => {
				setGeneration((value) => value + 1);
			}, []);
			(0, react.useEffect)(() => {
				if (!enabled || id === "") {
					setResource({
						facts: void 0,
						probe: "MISSING",
						error: void 0,
						status: 0
					});
					return;
				}
				if (sessionId.trim() === "") {
					setResource({
						facts: void 0,
						probe: "ERROR",
						status: 0,
						error: {
							status: 0,
							code: "CLIENT_REFUSED",
							reasonCode: "SESSION_MISSING",
							message: "缺少当前 DSH session id（由宿主 props 传入），客户端不读取决策事实",
							rawBody: ""
						}
					});
					return;
				}
				const controller = new AbortController();
				let active = true;
				setResource({
					facts: void 0,
					probe: "LOADING",
					error: void 0,
					status: 0
				});
				fetchDecisionFacts(id, sessionId, controller.signal).then((value) => {
					if (!active) return;
					setResource(value);
				}).catch((failure) => {
					if (!active) return;
					setResource({
						facts: void 0,
						probe: "ERROR",
						status: 0,
						error: toRecruitingErrorInfo(failure)
					});
				});
				return () => {
					active = false;
					controller.abort();
				};
			}, [
				id,
				enabled,
				sessionId,
				generation
			]);
			return {
				facts: resource.facts,
				probe: resource.probe,
				error: resource.error,
				reload
			};
		}
		// src/client/recruiting/styles.ts
		/** V5.6.1 设计 token（与 `work/v561/index.html:4` 的 `:root` 逐字一致）。 */
		const TOKENS = {
			bg: "#f8f9fb",
			surface: "#fff",
			text: "#29384d",
			sub: "#64738a",
			dim: "#8b97a8",
			border: "#e7ebf1",
			border2: "#d6dfeb",
			blue: "#496cad",
			blue2: "#365891",
			bluebg: "#edf3fc",
			green: "#347b65",
			greenbg: "#eaf6f0",
			amber: "#97743b",
			amberbg: "#fcf6e9",
			red: "#a45450",
			redbg: "#fff0ef",
			shadow: "0 4px 22px rgba(40,55,80,.027)",
			radius: "14px"
		};
		/** 根节点内联样式：字体/底色/正文口径（宿主页面里也能独立成立）。 */
		const ROOT_STYLE = {
			background: TOKENS.bg,
			color: TOKENS.text,
			fontFamily: "Inter,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif",
			fontSize: 14,
			lineHeight: 1.65,
			minHeight: "100%",
			boxSizing: "border-box",
			padding: "28px 32px 96px",
			WebkitFontSmoothing: "antialiased"
		};
		/** chip 的 class（色档）。 */
		function chipClass(tone) {
			return tone === "gray" ? "rcw-chip" : `rcw-chip rcw-chip-${tone}`;
		}
		/** 组件内注入的样式表（选择器全部 `rcw-` 前缀；token 走 `--rcw-*` 变量）。 */
		const RECRUITING_CSS = `
.rcw-root{
  --rcw-bg:${TOKENS.bg};--rcw-surface:${TOKENS.surface};--rcw-text:${TOKENS.text};--rcw-sub:${TOKENS.sub};
  --rcw-dim:${TOKENS.dim};--rcw-border:${TOKENS.border};--rcw-border2:${TOKENS.border2};
  --rcw-blue:${TOKENS.blue};--rcw-blue2:${TOKENS.blue2};--rcw-bluebg:${TOKENS.bluebg};
  --rcw-green:${TOKENS.green};--rcw-greenbg:${TOKENS.greenbg};--rcw-amber:${TOKENS.amber};--rcw-amberbg:${TOKENS.amberbg};
  --rcw-red:${TOKENS.red};--rcw-redbg:${TOKENS.redbg};--rcw-radius:${TOKENS.radius};--rcw-shadow:${TOKENS.shadow};
  overflow-wrap:break-word;
}
.rcw-root *{box-sizing:border-box}
.rcw-root h1,.rcw-root h2,.rcw-root h3,.rcw-root h4,.rcw-root p,.rcw-root ul,.rcw-root ol{margin:0;padding:0}
.rcw-root ul,.rcw-root ol{list-style:none}
.rcw-root h1{font-size:24px;line-height:1.45;font-weight:720;letter-spacing:-.7px}
.rcw-root h2{font-size:17px;line-height:1.5;font-weight:680;letter-spacing:-.3px}
.rcw-root h3{font-size:14px;font-weight:680}
.rcw-root small{font-size:12px}
.rcw-root button{font:inherit;cursor:pointer}
.rcw-root button:disabled{opacity:.45;cursor:not-allowed}
.rcw-root button:focus-visible,.rcw-root summary:focus-visible,.rcw-root select:focus-visible{outline:2px solid #92afe3;outline-offset:2px}
.rcw-content{max-width:1218px;margin:0 auto}
.rcw-cap{font-size:11px;font-weight:720;letter-spacing:.65px;color:#8290a2}
.rcw-muted{color:var(--rcw-sub)}
.rcw-dim{color:var(--rcw-dim)}
.rcw-tiny{font-size:11px}
.rcw-nowrap{white-space:nowrap}
.rcw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;word-break:break-all}
.rcw-headline{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:22px}
.rcw-headline-left{min-width:0}
.rcw-headline h1{margin-top:4px}
.rcw-headline .rcw-sub{color:var(--rcw-sub);font-size:13px;margin-top:7px}
.rcw-headline-right{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.rcw-grid{display:grid;grid-template-columns:minmax(0,1.73fr) minmax(273px,.78fr);gap:19px;align-items:start}
.rcw-detailgrid{grid-template-columns:minmax(0,1.55fr) minmax(260px,.77fr)}
.rcw-main{min-width:0}
.rcw-aside{display:flex;flex-direction:column;gap:16px;min-width:0}
.rcw-paper{background:var(--rcw-surface);border:1px solid var(--rcw-border);border-radius:var(--rcw-radius);box-shadow:var(--rcw-shadow)}
.rcw-hero{padding:24px 26px}
.rcw-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
.rcw-hero h2{font-size:22px;margin-top:6px}
.rcw-hero .rcw-sub{color:var(--rcw-sub);font-size:13px;margin-top:7px}
.rcw-select{background:#fff;border:1px solid var(--rcw-border2);border-radius:8px;padding:8px 9px;color:#566880;font-size:12px;min-width:135px;max-width:240px}
.rcw-metrics{display:flex;margin-top:20px;padding:18px 0 15px;border-top:1px solid var(--rcw-border);border-bottom:1px solid var(--rcw-border);flex-wrap:wrap}
.rcw-metric{flex:1;min-width:110px;border-right:1px solid #edf0f4;padding:0 14px}
.rcw-metric:first-child{padding-left:0}
.rcw-metric:last-child{border-right:0;padding-right:0}
.rcw-metric strong{display:block;font-size:22px;line-height:1.3;font-weight:680;color:#394e6b}
.rcw-metric small{display:block;font-size:11px;color:#8190a3;margin-top:6px}
.rcw-chip{display:inline-flex;align-items:center;gap:5px;border-radius:7px;padding:4px 8px;background:#f2f4f7;color:#66768a;font-weight:650;font-size:11px;white-space:nowrap}
.rcw-chip-green{background:var(--rcw-greenbg);color:var(--rcw-green)}
.rcw-chip-blue{background:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-chip-amber{background:var(--rcw-amberbg);color:var(--rcw-amber)}
.rcw-chip-red{background:var(--rcw-redbg);color:var(--rcw-red)}
.rcw-chiprow{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.rcw-dot{width:7px;height:7px;border-radius:100%;background:#bdc7d3;flex:none;display:inline-block}
.rcw-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--rcw-border2);background:#fff;color:#566780;padding:9px 13px;min-height:36px;border-radius:9px;font-size:12px;font-weight:660;white-space:nowrap;transition:background .15s}
.rcw-btn:hover{background:#f5f8fd}
.rcw-btn-blue{background:var(--rcw-blue);color:#fff;border-color:var(--rcw-blue)}
.rcw-btn-blue:hover{background:var(--rcw-blue2)}
.rcw-btn-soft{background:var(--rcw-bluebg);border-color:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-btn-sm{min-height:30px;padding:5px 10px;font-size:11px}
.rcw-btn-negative{color:var(--rcw-red)}
.rcw-textbtn{border:0;background:transparent;color:var(--rcw-blue);font-size:12px;font-weight:660;padding:5px 0}
.rcw-textbtn:hover{text-decoration:underline}
.rcw-sectionhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:26px 1px 12px}
.rcw-sectionhead h2{font-size:14px}
.rcw-sectionhead small{color:var(--rcw-dim)}
.rcw-filterbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.rcw-filter{border:1px solid var(--rcw-border);background:#fff;color:#5b708e;font-size:11px;font-weight:650;padding:6px 11px;border-radius:999px}
.rcw-filter-active{background:var(--rcw-bluebg);border-color:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-list{overflow:hidden}
.rcw-appitem{width:100%;border:0;background:#fff;text-align:left;display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #eff1f5;color:inherit}
.rcw-appitem:last-child{border-bottom:0}
.rcw-appitem:hover{background:#fafbfd}
.rcw-av{width:35px;height:35px;flex:none;display:grid;place-items:center;border-radius:11px;background:#edf2f7;color:#56718e;font-size:13px;font-weight:680}
.rcw-rowmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.rcw-rowtitle{font-size:13px;font-weight:680;min-width:0}
.rcw-rowjob{font-weight:590;color:#7b899d;font-size:11px;margin-left:6px}
.rcw-rowmeta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:#8490a3}
.rcw-rowend{display:flex;align-items:center;gap:6px;flex:none}
.rcw-chev{color:#a8b3c2;font-size:18px;margin-left:2px}
.rcw-joblist{padding:6px 0}
.rcw-jobrow{width:100%;border:0;border-bottom:1px solid #f1f2f5;background:transparent;display:flex;align-items:center;gap:10px;padding:12px 4px;text-align:left;color:inherit}
.rcw-jobrow:last-child{border-bottom:0}
.rcw-jobrow:hover{background:#fafbfd}
.rcw-jobrow-active{background:#f3f7fd;border-radius:9px;padding-left:8px;padding-right:8px}
.rcw-jobrow .rcw-av{width:30px;height:30px;border-radius:9px;font-size:12px}
.rcw-jobrow strong{display:block;font-size:12px;font-weight:680}
.rcw-jobrow small{display:block;color:#8190a3;font-size:11px;margin-top:2px}
.rcw-asidecard{padding:20px}
.rcw-asidecard h2{font-size:14px;margin-bottom:8px}
.rcw-kv{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed #eef1f5;font-size:12px}
.rcw-kv:last-child{border-bottom:0}
.rcw-kv .rcw-k{color:#7b899d;flex:none}
.rcw-kv .rcw-v{text-align:right;min-width:0}
.rcw-nextstep{margin-top:18px;padding:16px 18px;border-radius:12px;background:#f6f9fd;border:1px solid #e8eff9}
.rcw-nextstep-main{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}
.rcw-nextstep-main strong{font-size:15px;font-weight:680}
.rcw-nextstep-meta{margin-top:7px;font-size:11px;color:#7787a0;display:flex;gap:12px;flex-wrap:wrap}
.rcw-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:#8490a3;word-break:break-all}
.rcw-inlineactions{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:16px}
.rcw-actionwrap{display:flex;flex-direction:column;gap:4px;min-width:0}
.rcw-pending{font-size:10px;color:#9aa6b6;max-width:220px}
.rcw-divider{height:1px;background:var(--rcw-border);margin:16px 0}
.rcw-insight{padding:17px 18px;border-radius:12px;background:#f6f8fb;border:1px solid #edf1f6}
.rcw-insight h3{font-size:13px}
.rcw-insight p{margin-top:6px;font-size:12px;color:#516177;line-height:1.85}
.rcw-disclosure{margin-top:12px;padding:14px 16px}
.rcw-disclosure summary{cursor:pointer;font-weight:670;font-size:12px;color:#566780;list-style-position:outside}
.rcw-disclosure summary::marker{color:#9aa8ba}
.rcw-disclosure-body{margin-top:13px}
.rcw-subhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0 8px}
.rcw-subhead h3{font-size:13px}
.rcw-cardrow{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.rcw-smallcard{padding:14px 15px;border:1px solid var(--rcw-border);border-radius:11px;min-width:0}
.rcw-smallcard strong{display:block;font-size:12px}
.rcw-smallcard p{font-size:11px;color:#8190a3;margin-top:5px}
.rcw-tablewrap{overflow-x:auto;border:1px solid var(--rcw-border);border-radius:11px}
.rcw-table{width:100%;border-collapse:collapse;min-width:520px}
.rcw-table th{font-size:11px;color:#8b98a9;text-align:left;font-weight:670;padding:10px 12px;border-bottom:1px solid var(--rcw-border);background:#fafbfd;white-space:nowrap}
.rcw-table td{padding:10px 12px;border-bottom:1px solid #eff1f5;font-size:12px;vertical-align:top}
.rcw-table tr:last-child td{border-bottom:0}
.rcw-sourcebox{padding:14px;background:#fbfcfd;border:1px solid var(--rcw-border);border-radius:11px;white-space:pre-wrap;color:#53647a;font-size:12px;line-height:1.9;word-break:break-word}
.rcw-quote{background:#f2f6fc;border-left:3px solid #92add9;border-radius:0 7px 7px 0;padding:9px 12px;font-size:12px;color:#53667f;margin-top:8px}
.rcw-criteria{display:flex;gap:9px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #eff2f5}
.rcw-criteria:last-child{border-bottom:0}
.rcw-criteria .rcw-dot{margin-top:8px}
.rcw-criteriabody{font-size:12px;color:#69788d;min-width:0}
.rcw-criteriabody strong{color:#4d5f77}
.rcw-timeline{padding:2px 0}
.rcw-timelineitem{padding:9px 0;border-bottom:1px solid #f2f3f6;font-size:12px}
.rcw-timelineitem:last-child{border:0}
.rcw-timelineitem small{display:block;color:#8996a9;margin-top:3px;font-size:11px}
.rcw-alert{border:1px solid #f0d5d2;background:var(--rcw-redbg);color:#8c4642;border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:12px}
.rcw-alert pre{margin:8px 0 0;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;color:#9a5a56}
.rcw-notice{border:1px solid #f3e9d7;background:#fff9ee;color:#987749;border-radius:11px;padding:11px 14px;margin-bottom:16px;font-size:12px;font-weight:650}
.rcw-empty{padding:26px 20px;text-align:center;color:#8b97a8;font-size:12px}
.rcw-loading{padding:22px 20px;color:#7b899d;font-size:12px}
.rcw-back{border:0;background:transparent;color:#7c8aa0;padding:0;margin-bottom:16px;font-size:12px}
.rcw-back:hover{color:var(--rcw-blue)}
.rcw-detailmain{padding:24px 26px}
.rcw-detailaside{gap:15px}
.rcw-detailgrid .rcw-aside{min-width:0}
.rcw-cards-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.rcw-file{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.rcw-badge{font-size:10px;font-weight:720;letter-spacing:.4px;border-radius:6px;padding:3px 7px;background:#f2f4f7;color:#66768a;white-space:nowrap}
.rcw-badge-live{background:var(--rcw-greenbg);color:var(--rcw-green)}
.rcw-badge-fixture{background:var(--rcw-amberbg);color:var(--rcw-amber)}
.rcw-badge-connected{background:var(--rcw-greenbg);color:var(--rcw-green)}
.rcw-badge-not_connected{background:#f2f4f7;color:#66768a}
.rcw-badge-auth_required{background:var(--rcw-redbg);color:var(--rcw-red)}
.rcw-badge-event{background:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-badge-manual{background:var(--rcw-amberbg);color:var(--rcw-amber)}
.rcw-fields-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.rcw-fieldrow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;border-bottom:1px dashed #eef1f5;padding:5px 0;font-size:12px;min-width:0}
.rcw-fieldrow .rcw-fieldkey{color:#7b899d}
.rcw-fieldrow .rcw-fieldval{text-align:right;min-width:0;color:#53647a}
.rcw-stagebar{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.rcw-stageseq{display:flex;align-items:center;gap:5px;font-size:11px;color:#8b98a9;flex-wrap:wrap}
.rcw-stagepill{border-radius:6px;padding:2px 7px;background:#f2f4f7;color:#7b899d}
.rcw-stagepill-now{background:var(--rcw-bluebg);color:var(--rcw-blue2);font-weight:700}
.rcw-stagepill-done{background:var(--rcw-greenbg);color:var(--rcw-green)}
/* ---- W2b 新增（只新增 class，不改既有 token 值）：轮次重点卡 / 人类闸门弹窗 / 写表单 ---- */
.rcw-roundfocus{margin-top:16px;padding:16px 18px;border-radius:12px;background:#f7fafd;border:1px solid #e6eef8}
.rcw-roundfocus-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.rcw-roundfocus-title{margin-top:10px;font-size:15px;font-weight:680;color:#394e6b}
.rcw-roundfocus-desc{margin-top:7px;font-size:12px;color:#516177;line-height:1.85}
.rcw-roundfocus-block{margin-top:10px}
.rcw-roundfocus-list{list-style:decimal inside;margin:0;padding:0}
.rcw-roundfocus-list .rcw-quote{list-style:none;margin-top:6px}
.rcw-roundfocus-note{margin-top:10px;font-size:11px;color:var(--rcw-amber);background:var(--rcw-amberbg);border-radius:8px;padding:8px 10px}
.rcw-roundfocus-degrade{margin-top:10px;font-size:12px;color:#516177;line-height:1.85}
.rcw-roundfocus-degrade p{margin-top:6px}
.rcw-modalscrim{position:fixed;inset:0;background:rgba(41,56,77,.38);display:flex;align-items:flex-start;justify-content:center;padding:48px 18px;z-index:60;overflow-y:auto}
.rcw-modal{width:min(620px,100%);background:var(--rcw-surface);border:1px solid var(--rcw-border2);border-radius:var(--rcw-radius);box-shadow:0 18px 60px rgba(30,45,70,.18);padding:24px 26px}
.rcw-modal h2{font-size:18px;font-weight:720}
.rcw-modal-job{margin-top:6px;font-size:12px;font-weight:650;color:#394e6b}
.rcw-modal-body{margin-top:12px;font-size:12px;color:#516177;line-height:1.9}
.rcw-modal-body p{margin-top:3px}
.rcw-modalfield{display:flex;flex-direction:column;gap:5px;margin-top:12px;font-size:12px;color:#516177;font-weight:600}
.rcw-modalerror{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--rcw-redbg);border:1px solid #f0d5d2;color:#8c4642;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all}
.rcw-textarea,.rcw-input{width:100%;border:1px solid var(--rcw-border2);border-radius:9px;padding:8px 10px;font:inherit;font-size:12px;color:var(--rcw-text);background:#fff}
.rcw-textarea{resize:vertical;min-height:64px;line-height:1.7}
.rcw-textarea:disabled,.rcw-input:disabled{background:#f5f7fa;color:#8b97a8}
.rcw-writeform{margin-top:16px;padding:14px 15px;border:1px solid var(--rcw-border);border-radius:11px}
.rcw-writeform strong{display:block;font-size:12px;margin-bottom:4px}
.rcw-writeform .rcw-btn{margin-top:10px}
/* ---- W2b 新增结束 ---- */
@media (max-width:1100px){
  .rcw-root{padding:24px 24px 88px}
  .rcw-grid{grid-template-columns:minmax(0,1.4fr) minmax(255px,.78fr);gap:16px}
  .rcw-detailgrid{grid-template-columns:minmax(0,1.3fr) minmax(240px,.7fr)}
  .rcw-hero{padding:21px 22px}
  .rcw-detailmain{padding:21px 22px}
}
@media (max-width:850px){
  .rcw-root{padding:20px 18px 74px}
  .rcw-grid,.rcw-detailgrid{grid-template-columns:1fr}
  .rcw-aside{display:grid;grid-template-columns:1fr 1fr}
  .rcw-headline{align-items:flex-start;flex-direction:column;gap:10px}
  .rcw-headline h1{font-size:21px}
  .rcw-headline-right{justify-content:flex-start;width:100%}
  .rcw-cards-grid,.rcw-cardrow{grid-template-columns:1fr}
  .rcw-fields-grid{grid-template-columns:1fr}
}
@media (max-width:570px){
  .rcw-root{padding:16px 13px 56px}
  .rcw-modalscrim{padding:16px 10px}
  .rcw-modal{width:100%;padding:18px 15px}
  .rcw-modal-body{font-size:12px}
  .rcw-headline{margin-bottom:15px}
  .rcw-hero{padding:18px 16px}
  .rcw-hero h2{font-size:20px}
  .rcw-hero-top{flex-direction:column}
  .rcw-select{max-width:100%;width:100%}
  .rcw-aside{display:flex}
  .rcw-metric{min-width:calc(50% - 14px);padding:6px 12px}
  .rcw-metric:nth-child(2n){border-right:0}
  .rcw-metric:nth-child(n+3){border-top:1px solid #edf0f4;margin-top:8px;padding-top:12px}
  .rcw-appitem{padding:13px 12px;gap:10px;align-items:flex-start}
  .rcw-rowend{flex-direction:column;align-items:flex-end;gap:4px}
  .rcw-rowmeta{gap:5px}
  .rcw-detailmain{padding:19px 16px}
  .rcw-asidecard{padding:16px}
  .rcw-table{min-width:460px}
  .rcw-table th:nth-child(3),.rcw-table td:nth-child(3){display:none}
  .rcw-inlineactions{gap:7px}
  .rcw-actionwrap{flex:1 1 45%}
  .rcw-btn{width:100%}
  .rcw-headline-right .rcw-btn{width:auto}
}
`;
		/** 供组件渲染 `<style>` 用的唯一 key（避免 React 复用警告）。 */
		const STYLE_ELEMENT_KEY = "rcw-styles";
		// src/client/recruiting/parts.tsx
		/** 白纸卡（V5.6.1 `.paper`）。 */
		function Card({ children, className = "", style, testid }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				className: `rcw-paper ${className}`.trim(),
				style,
				...testid !== void 0 ? { "data-testid": testid } : {},
				children
			});
		}
		/** 状态 chip。 */
		function Chip({ tone = "gray", children, title, testid }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: chipClass(tone),
				...title !== void 0 ? { title } : {},
				...testid !== void 0 ? { "data-testid": testid } : {},
				children
			});
		}
		/** 三维标签徽标（LIVE / FIXTURE / EVENT / MANUAL / CONNECTED …）。 */
		function ThreeDimBadges({ labels, testid }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "rcw-chiprow",
				...testid !== void 0 ? { "data-testid": testid } : {},
				children: labels.rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: `rcw-badge rcw-badge-${row.value.toLowerCase()}`,
					title: `${row.label}：${row.value !== "" ? row.value : "（服务端未提供）"}`,
					"data-dim": row.key,
					"data-value": row.value,
					children: [
						row.label,
						" ",
						row.value !== "" ? row.value : "—"
					]
				}, row.key))
			});
		}
		/** 区块标题（V5.6.1 `.sectionhead`）。 */
		function SectionHead({ title, note, right }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-sectionhead",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", { children: [title, note !== void 0 && note !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
					style: { marginLeft: 8 },
					children: note
				}) : null] }), right]
			});
		}
		/** 指标块（数字 + 标签；数字非负整数，标签写清口径）。 */
		function Metric({ value, label, testid }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-metric",
				...testid !== void 0 ? { "data-testid": testid } : {},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: value }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: label })]
			});
		}
		/** 键值行（值缺失时显示"—"，不显示 undefined）。 */
		function KeyValue({ label, value, mono = false }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-kv",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "rcw-k",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: `rcw-v ${mono ? "rcw-mono" : ""}`.trim(),
					children: value !== "" ? value : "—"
				})]
			});
		}
		/** 业务结论 + 下一步（**每视图唯一一份**；`data-testid="next-step"` 供浏览器证据读）。 */
		function NextStepPanel({ step, scope, fallback = "暂无下一步", testid = "next-step" }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-nextstep",
				"data-testid": testid,
				"data-scope": scope,
				"data-code": step.code,
				"data-kind": step.kind,
				"data-has-step": step.hasStep ? "true" : "false",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "rcw-cap",
						children: "业务结论 · 下一步"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-nextstep-main",
						children: [step.kindLabel !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: step.tone,
							children: step.kindLabel
						}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
							"data-testid": "next-step-label",
							children: step.label !== "" ? step.label : fallback
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-nextstep-meta",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-code",
							"data-testid": "next-step-code",
							"data-code": step.code,
							hidden: true
						}), !step.hasStep ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "还没有下一步信息" }) : null]
					})
				]
			});
		}
		/** 默认收起的渐进展开区（`<details>`，服务端事实在里面）。 */
		function Disclosure({ title, hint, testid, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				className: "rcw-paper rcw-disclosure",
				...testid !== void 0 ? { "data-testid": testid } : {},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [title, hint !== void 0 && hint !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "rcw-dim",
					style: {
						marginLeft: 8,
						fontWeight: 500
					},
					children: hint
				}) : null] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "rcw-disclosure-body",
					children
				})]
			});
		}
		/** 空态（明确写"没有…"，不把故障说成空台账）。 */
		function EmptyState({ children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "rcw-empty",
				children
			});
		}
		/** 只读原文框（简历原文 / 描述 / 服务端错误体）。 */
		function SourceBox({ children, testid }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "rcw-sourcebox",
				...testid !== void 0 ? { "data-testid": testid } : {},
				children
			});
		}
		/** 错误块：显示服务端 `{error:{code,reason_code,message}}` 原文，绝不伪装成"没有数据"。 */
		function ErrorAlert({ title, message, rawBody, onRetry }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-alert",
				role: "alert",
				"data-testid": "load-error",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: title }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { marginTop: 6 },
						children: message
					}),
					rawBody !== void 0 && rawBody !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						"data-testid": "load-error-raw",
						children: rawBody
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						"data-testid": "load-error-raw",
						children: "（服务端没有返回响应体）"
					}),
					onRetry !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { marginTop: 10 },
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-btn rcw-btn-sm",
							"data-testid": "retry-load",
							onClick: onRetry,
							children: "重新读取"
						})
					}) : null
				]
			});
		}
		// src/client/recruiting/round-focus.tsx
		/** 轮次重点来源 → 展示文案（未知来源原样显示，不冒充已知枚举）。 */
		const SOURCE_LABELS = {
			ROUND_CONFIG: "轮次配置（本轮专属）",
			JOB_BASE: "岗位 Rubric 底座（JOB_BASE 降级）"
		};
		/** 轮次重点来源 → chip 色档（ROUND_CONFIG 绿 / JOB_BASE 琥珀 / 未知灰）。 */
		const SOURCE_TONES = {
			ROUND_CONFIG: "green",
			JOB_BASE: "amber"
		};
		/** 来源文案：已知枚举给中文，未知值原样返回（不吞信息）。 */
		function sourceLabelOf(source) {
			if (source === "") return "来源未提供";
			return SOURCE_LABELS[source] ?? source;
		}
		/**
		* 本轮考察重点卡。
		* @param focus - 归一化后的 `round_focus`（`InterviewView.roundFocus`）。
		* @returns 轮次重点 JSX（不可用时只显示降级 reason，不编造内容）。
		*/
		function RoundFocusCard$1({ focus }) {
			const sourceTone = SOURCE_TONES[focus.source] ?? "gray";
			const roundText = focus.roundNo > 0 ? `第 ${String(focus.roundNo)} 轮` : "轮次未提供";
			const hasTemplateTrace = focus.templateVersionNo > 0 || focus.templatePayloadHash !== "";
			const hasContent = focus.title !== "" || focus.description !== "" || focus.focusDimensions.length > 0 || focus.questions.length > 0 || focus.scorecardFields.length > 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-roundfocus",
				"data-testid": "round-focus",
				"data-available": focus.available ? "true" : "false",
				"data-source": focus.source,
				"data-round": String(focus.roundNo),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-roundfocus-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "rcw-cap",
						children: "本轮考察重点"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "rcw-chiprow",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
								tone: sourceTone,
								testid: "round-focus-source",
								children: sourceLabelOf(focus.source)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-dim rcw-tiny",
								"data-testid": "round-focus-round",
								children: roundText
							}),
							hasTemplateTrace ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-mono rcw-tiny",
								"data-testid": "round-focus-template",
								children: [
									"模板 ",
									focus.templateVersionNo > 0 ? `v${String(focus.templateVersionNo)}` : "版本未提供",
									focus.templatePayloadHash !== "" ? ` · payload ${shortSha(focus.templatePayloadHash)}` : ""
								]
							}) : null
						]
					})]
				}), focus.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					focus.title !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: "rcw-roundfocus-title",
						"data-testid": "round-focus-title",
						children: focus.title
					}) : null,
					focus.description !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-roundfocus-desc",
						"data-testid": "round-focus-description",
						children: focus.description
					}) : null,
					focus.focusDimensions.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-roundfocus-block",
						"data-testid": "round-focus-dimensions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-subhead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "本轮重点维度" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim rcw-tiny",
								children: [
									"共 ",
									focus.focusDimensions.length,
									" 个"
								]
							})]
						}), focus.focusDimensions.map((dimension) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-criteria",
							"data-dim-key": dimension.key,
							"data-testid": `round-focus-dimension-${dimension.key}`,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `rcw-dot ${dimension.inRubric ? "rcw-dot-blue" : ""}`.trim() }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-criteriabody",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
									dimension.label,
									"（",
									dimension.key,
									"）"
								] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "rcw-dim rcw-tiny",
									style: { marginLeft: 6 },
									children: [
										dimension.weight !== null ? `权重 ${String(dimension.weight)}` : "权重未提供",
										" ·",
										" ",
										dimension.required ? "本轮必覆盖" : "非必覆盖",
										" ·",
										" ",
										dimension.inRubric ? "在面评 Rubric 内" : "不在面评提交键集（仅展示）"
									]
								})]
							})]
						}, dimension.key))]
					}) : null,
					focus.questions.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-roundfocus-block",
						"data-testid": "round-focus-questions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-subhead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "建议问题" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim rcw-tiny",
								children: [
									"共 ",
									focus.questions.length,
									" 条"
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
							className: "rcw-roundfocus-list",
							children: focus.questions.map((question, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: "rcw-quote",
								"data-question-key": question.key,
								"data-testid": `round-focus-question-${question.key !== "" ? question.key : String(index)}`,
								children: question.text
							}, question.key !== "" ? question.key : `round-focus-question-${String(index)}`))
						})]
					}) : null,
					focus.scorecardFields.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-roundfocus-block",
						"data-testid": "round-focus-scorecard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-subhead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "评分表字段" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim rcw-tiny",
								children: [
									"共 ",
									focus.scorecardFields.length,
									" 个"
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-tablewrap",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								className: "rcw-table",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "key" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "字段" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "类型" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "必填" })
								] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: focus.scorecardFields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									"data-testid": `round-focus-field-${field.key}`,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: "rcw-mono",
											children: field.key
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: field.label }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: field.kind !== "" ? field.kind : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: field.required ? "是" : "否" })
									]
								}, field.key)) })]
							})
						})]
					}) : null,
					!hasContent ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-roundfocus-desc",
						"data-testid": "round-focus-empty",
						children: "服务端标记本轮重点可用（available=true），但没有返回标题/说明/维度/问题/评分表字段；界面不编造内容。"
					}) : null,
					focus.reason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "rcw-roundfocus-note",
						"data-testid": "round-focus-note",
						children: ["服务端附注：", focus.reason]
					}) : null
				] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-roundfocus-degrade",
					"data-testid": "round-focus-reason",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: "amber",
							children: "本轮重点不可用（降级）"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: focus.reason !== "" ? focus.reason : "服务端没有提供轮次重点配置（round_focus.available=false），界面不编造本轮重点。" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "rcw-muted rcw-tiny",
							children: [
								"当前来源：",
								sourceLabelOf(focus.source),
								"；降级内容由服务端 reason 决定，客户端不用岗位 Rubric 冒充本轮重点。"
							]
						})
					]
				})]
			});
		}
		// src/client/recruiting/application-detail.tsx
		/** 申请详情里可用的写动作（顺序即渲染顺序；可用性仍来自服务端 `actions`）。 */
		const APPLICATION_ACTION_KEYS = [
			"screening_decide",
			"interview_schedule",
			"transcript_import",
			"stage_advance",
			"decision_record"
		];
		/** 表单控件的内联样式（styles.ts 属 B 的写范围，本组件不写 CSS）。 */
		const FIELD_STYLE = {
			background: "#fff",
			border: "1px solid var(--rcw-border2, #d6dde8)",
			borderRadius: 8,
			padding: "7px 9px",
			color: "#33465e",
			fontSize: 12,
			width: "100%",
			boxSizing: "border-box"
		};
		/** 顶部头部（详情优先，回退 overview 行）。 */
		function DetailHeadline({ header, onBack, onRefresh, refreshing }) {
			const refreshButton = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "rcw-btn rcw-btn-sm",
				"data-testid": "refresh-detail",
				disabled: refreshing,
				onClick: onRefresh,
				children: refreshing ? "正在读取…" : "刷新"
			});
			if (header === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-headline",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-headline-left",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-back",
							"data-testid": "detail-back",
							onClick: onBack,
							children: "← 返回招聘总览"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-cap",
							children: "RECRUITING WORKSPACE · APPLICATION"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: "申请详情" })
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "rcw-headline-right",
					children: refreshButton
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-headline",
				"data-testid": "detail-headline",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-headline-left",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-back",
							"data-testid": "detail-back",
							onClick: onBack,
							children: "← 返回招聘总览"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-cap",
							children: "RECRUITING WORKSPACE · APPLICATION"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h1", { children: [header.candidateName, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-dim",
							style: {
								fontSize: 15,
								fontWeight: 590,
								marginLeft: 8
							},
							children: header.jobTitle
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-sub",
							"data-application-id": header.id !== "" ? header.id : void 0,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim",
								children: ["岗位编号 ", header.jobCode !== "" ? header.jobCode : "（未提供）"]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim",
								style: { marginLeft: 8 },
								children: ["申请记录版本 ", header.recordVersion]
							})]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-headline-right",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: header.stageTone,
							testid: "detail-stage",
							children: ["当前阶段 · ", header.stageLabel]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: header.lifecycleTone,
							testid: "detail-lifecycle",
							children: ["申请状态 · ", header.lifecycleLabel]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: header.applicationRubric === null ? "gray" : header.applicationRubric.approved ? "green" : "amber",
							testid: "detail-application-rubric",
							children: ["本申请钉住 Rubric · ", applicationRubricTextOf(header.applicationRubric)]
						}),
						refreshButton
					]
				})]
			});
		}
		/** 材料与解析摘要（展开区 1）。 */
		function MaterialSection({ material, resume }) {
			if (material === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "该申请没有关联简历材料（服务端 material 为 null），不展示解析摘要。" });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-chiprow",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: material.parseTone,
							testid: "material-parse",
							children: ["解析 · ", material.parseLabel]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: material.validationTone,
							children: ["校验 · ", material.validationLabel]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: material.hashAligned ? "green" : "red",
							testid: "material-hash-aligned",
							children: ["来源哈希 · ", material.hashAligned ? "一致" : "不一致"]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-cardrow",
					style: { marginTop: 12 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-smallcard",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: material.fileName !== "" ? material.fileName : "（服务端未提供文件名）" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								material.mimeType !== "" ? material.mimeType : "类型未知",
								" · ",
								material.byteSizeText !== "" ? material.byteSizeText : "体量未知",
								material.pageCountText !== "" ? ` · ${material.pageCountText}` : ""
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "rcw-mono",
								"data-testid": "material-sha",
								children: ["sha256：", material.sha256Text !== "" ? material.sha256Text : "—"]
							}),
							material.sourceSha256Text !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "rcw-mono",
								children: ["来源 sha256：", material.sourceSha256Text]
							}) : null
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-smallcard",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "解析器" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [material.parser !== "" ? material.parser : "（未提供）", material.parserVersion !== "" ? ` · ${material.parserVersion}` : ""] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
								"工作经历 ",
								material.entryCounts.work,
								" 条 · 教育经历 ",
								material.entryCounts.education,
								" 条 · 证据",
								" ",
								material.evidenceCount,
								" 条"
							] })
						]
					})]
				}),
				material.fieldStates.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { marginTop: 14 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-cap",
						children: "字段状态（只给 state，不给邮箱/电话原值）"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-fields-grid",
						style: { marginTop: 8 },
						children: material.fieldStates.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-fieldrow",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-fieldkey",
								children: field.key
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-fieldval",
								children: field.state
							})]
						}, field.key))
					})]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "rcw-muted rcw-tiny",
					style: { marginTop: 12 },
					children: "服务端没有返回字段状态表。"
				}),
				resume !== null && resume.fields.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { marginTop: 14 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-cap",
						children: "结构化字段（可读预览；PII 字段恒为空）"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-fields-grid",
						style: { marginTop: 8 },
						children: resume.fields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-fieldrow",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-fieldkey",
								children: field.key
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-fieldval",
								children: [
									field.state,
									field.valuePreview !== "" ? ` · ${field.valuePreview}` : "",
									field.entryCount !== null ? ` · ${String(field.entryCount)} 条` : ""
								]
							})]
						}, field.key))
					})]
				}) : null,
				resume !== null && resume.workEntries.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { marginTop: 14 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-cap",
						children: "工作经历"
					}), resume.workEntries.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-criteria",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "rcw-dot rcw-dot-blue" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-criteriabody",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [entry.company !== "" ? entry.company : "（未提供公司）", entry.title !== "" ? ` · ${entry.title}` : ""] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-dim rcw-tiny",
								children: [
									entry.start !== "" ? entry.start : "?",
									" – ",
									entry.end !== "" ? entry.end : "至今"
								]
							})]
						})]
					}, `work-${String(index)}`))]
				}) : null,
				resume !== null && resume.educationEntries.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { marginTop: 14 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-cap",
						children: "教育经历"
					}), resume.educationEntries.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-criteria",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "rcw-dot rcw-dot-blue" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-criteriabody",
							children: [entry.text !== "" ? entry.text : "（未提供文本）", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-dim rcw-tiny",
								children: [
									entry.start !== "" ? entry.start : "?",
									" – ",
									entry.end !== "" ? entry.end : "至今"
								]
							})]
						})]
					}, `edu-${String(index)}`))]
				}) : null,
				resume !== null && resume.evidenceSamples.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: { marginTop: 14 },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-cap",
						children: "简历证据（页码 + 短引文；不含 PII）"
					}), resume.evidenceSamples.map((sample, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-quote",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-dim rcw-tiny",
							children: [
								"字段 ",
								sample.field !== "" ? sample.field : "—",
								" · 第 ",
								sample.page !== null ? String(sample.page) : "?",
								" 页",
								sample.block !== null ? ` · block ${String(sample.block)}` : ""
							]
						}), sample.quote]
					}, `evidence-${String(index)}`))]
				}) : null
			] });
		}
		/** 初筛证据（展开区 2）：结论 + rubric 维度 + SCREENING_EVALUATION + basis kinds。 */
		function ScreeningSection({ evidence }) {
			const { decision, rubric, basis } = evidence;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				decision === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "还没有初筛结论（当前有效的 SCREENING 决定不存在）。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-chiprow",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: decision.resultTone,
								testid: "screening-decision-result",
								children: ["初筛结论 · ", decision.resultLabel]
							}),
							decision.stageLabel !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
								tone: "gray",
								children: decision.stageLabel
							}) : null,
							decision.decidedBy !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: "blue",
								children: [
									"由 ",
									decision.decidedBy,
									" 决定"
								]
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-dim rcw-tiny",
								children: decision.decidedAtText !== "" ? decision.decidedAtText : "时间未提供"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceBox, {
						testid: "screening-reason-readback",
						children: decision.reason !== "" ? decision.reason : "（服务端未提供理由）"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginTop: 10 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "决定 id",
								value: decision.decisionId,
								mono: true
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "rubric 版本 id",
								value: decision.rubricVersionId,
								mono: true
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "basis kinds",
								value: decision.basisKinds.length > 0 ? decision.basisKinds.join("、") : ""
							})
						]
					}),
					decision.evaluation !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-insight",
						style: { marginTop: 12 },
						"data-testid": "screening-evaluation",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "SCREENING_EVALUATION 机器证据" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-chiprow",
								style: { marginTop: 6 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
										tone: decision.evaluation.verdict !== "" ? "blue" : "gray",
										children: ["verdict · ", decision.evaluation.verdict !== "" ? decision.evaluation.verdict : "未提供"]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
										tone: decision.evaluation.provenanceTone,
										children: ["provenance · ", decision.evaluation.provenance !== "" ? decision.evaluation.provenance : "未提供"]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
										tone: decision.evaluation.criteriaEvaluated === true ? "green" : "gray",
										children: [
											"criteria_evaluated ·",
											" ",
											decision.evaluation.criteriaEvaluated === null ? "未提供" : decision.evaluation.criteriaEvaluated ? "是" : "否"
										]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 8 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
										label: "evaluation digest",
										value: decision.evaluation.evaluationDigestText,
										mono: true
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
										label: "凭据 resume_version",
										value: decision.evaluation.resumeVersionId,
										mono: true
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
										label: "凭据 rubric_version",
										value: decision.evaluation.rubricVersionId,
										mono: true
									})
								]
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-muted rcw-tiny",
						style: { marginTop: 10 },
						children: "该初筛结论没有携带 SCREENING_EVALUATION 分片（basis_refs 里没有机器证据）。"
					})
				] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-subhead",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Rubric 维度快照" }), rubric !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "rcw-dim rcw-tiny",
						children: [
							"初筛结论所用 Rubric 快照 · v",
							String(rubric.versionNo),
							" · ",
							rubric.dimensions.length,
							" 个维度"
						]
					}) : null]
				}),
				rubric === null || rubric.dimensions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "没有可用的 rubric 维度快照。" }) : rubric.dimensions.map((dimension) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-criteria",
					"data-dim-key": dimension.key,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "rcw-dot rcw-dot-blue" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-criteriabody",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
								dimension.label,
								"（",
								dimension.key,
								"）"
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim rcw-tiny",
								style: { marginLeft: 6 },
								children: [
									dimension.kind,
									dimension.weight !== null ? ` · 权重 ${String(dimension.weight)}` : "",
									dimension.operator !== "" ? ` · ${dimension.operator}` : "",
									dimension.valuePreview !== "" ? ` · 阈值 ${dimension.valuePreview}` : ""
								]
							}),
							dimension.question !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-dim rcw-tiny",
								children: ["问题：", dimension.question]
							}) : null
						]
					})]
				}, dimension.key)),
				basis.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "rcw-subhead",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "basis 分片（安全投影）" })
				}), basis.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-quote rcw-mono",
					children: [entry.kind, entry.detailText !== "" ? ` · ${entry.detailText}` : ""]
				}, `basis-${String(index)}-${entry.kind}`))] }) : null
			] });
		}
		/** 面试排期与状态（展开区 3）：每轮附 task-50 的「本轮重点」卡。 */
		function InterviewSection({ interviews }) {
			if (interviews.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "该申请还没有面试记录（没有排期就是没有排期，不推断）。" });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: interviews.map((interview) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-smallcard",
				style: { marginTop: 10 },
				"data-testid": `interview-${interview.id}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-chiprow",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
								"第 ",
								interview.roundNo,
								" 轮 · ",
								interview.slotCode !== "" ? interview.slotCode : "（未提供 slot）"
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: interview.statusTone,
								children: ["排期状态 · ", interview.statusLabel]
							}),
							interview.stageLabel !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
								tone: "gray",
								children: interview.stageLabel
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: interview.scorecards.tone,
								testid: `interview-${interview.id}-scorecard`,
								children: ["面评 · ", interview.scorecards.summaryText]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginTop: 8 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "开始",
								value: interview.scheduledStartText !== "" ? interview.scheduledStartText : ""
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "结束",
								value: interview.scheduledEndText !== "" ? interview.scheduledEndText : ""
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "时区",
								value: interview.timezone
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "面评进度",
								value: interview.scorecards.required === 0 ? "该轮不需要面评" : `已提交 ${String(interview.scorecards.submitted)} / 必需 ${String(interview.scorecards.required)} · 未提交 ${String(interview.scorecards.missing)} · 逾期 ${String(interview.scorecards.overdue)}`
							})
						]
					}),
					interview.interviewers.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginTop: 8 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-cap",
							children: "面试官与本人面评"
						}), interview.interviewers.map((interviewer) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-fieldrow",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-fieldkey",
								children: [
									interviewer.displayName,
									interviewer.roleInInterview !== "" ? ` · ${interviewer.roleInInterview}` : "",
									interviewer.required ? " · 必需面评" : ""
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-fieldval",
								children: interviewer.scorecard !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: chipClass(interviewer.scorecard.statusTone),
										children: interviewer.scorecard.statusLabel
									}),
									interviewer.scorecard.overallLabel !== "" ? ` · ${interviewer.scorecard.overallLabel}` : "",
									interviewer.scorecard.submittedAtText !== "" ? ` · ${interviewer.scorecard.submittedAtText}` : ""
								] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "rcw-dim",
									children: ["未提交", interviewer.dueAtText !== "" ? ` · 截止 ${interviewer.dueAtText}` : ""]
								})
							})]
						}, interviewer.id !== "" ? interviewer.id : interviewer.actorId))]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoundFocusCard$1, { focus: interview.roundFocus })
				]
			}, interview.id)) });
		}
		/** Transcript 状态（展开区 4）：只给状态/计数，不给正文。 */
		function TranscriptSection({ interviews, runs }) {
			const rows = interviews.filter((interview) => interview.transcript.state !== "" || interview.transcript.artifactId !== "");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "没有找到与面试关联的 Transcript 事实（不代表未录取，只代表没有可读状态）。" }) : rows.map((interview) => {
				const transcript = interview.transcript;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-smallcard",
					style: { marginTop: 10 },
					"data-testid": `transcript-${interview.id}`,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-chiprow",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
									"第 ",
									interview.roundNo,
									" 轮 · ",
									interview.slotCode !== "" ? interview.slotCode : "（未提供 slot）"
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
									tone: transcript.stateTone,
									testid: `transcript-${interview.id}-state`,
									children: ["Transcript · ", transcript.stateLabel]
								}),
								transcript.transcriptStatus !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
									tone: transcript.transcriptStatusTone,
									children: transcript.transcriptStatusLabel
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
									tone: transcript.isCanonical ? "green" : "gray",
									children: ["canonical · ", transcript.isCanonical ? "是" : "否"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
									tone: transcript.isComplete ? "green" : "gray",
									children: ["complete · ", transcript.isComplete ? "是" : "否"]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 8 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "artifact id",
								value: transcript.artifactId,
								mono: true
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "分段数",
								value: String(transcript.segmentCount)
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { marginTop: 6 },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreeDimBadges, {
								labels: transcript.labels,
								testid: `transcript-${interview.id}-labels`
							})
						}),
						transcript.record !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 8 },
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "rcw-cap",
									children: "面试记录（独立分支）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "状态",
									value: transcript.record.status
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "校验",
									value: transcript.record.verificationStatus
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "证据齐备",
									value: transcript.record.evidenceOk ? "是" : "否"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "当前有效",
									value: transcript.record.isCurrent ? "是" : "否"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "chunk coverage",
									value: transcript.record.chunkCoverageText !== "" ? transcript.record.chunkCoverageText : ""
								})
							]
						}) : null
					]
				}, interview.id);
			}), runs.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "rcw-subhead",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "转写处理运行" })
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "rcw-tablewrap",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
					className: "rcw-table",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "run" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "artifact" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "状态" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "分片（成功/总数）" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "失败" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "model" })
					] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: runs.map((run) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
							className: "rcw-mono",
							children: run.runId !== "" ? run.runId : "—"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
							className: "rcw-mono",
							children: run.artifactIdText !== "" ? run.artifactIdText : "—"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: run.status !== "" ? run.status : "—" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
							String(run.chunkSucceeded),
							"/",
							String(run.chunkTotal)
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: run.chunkFailed }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: run.modelId !== "" ? run.modelId : "—" })
					] }, run.runId !== "" ? run.runId : `${run.artifactId}-run`)) })]
				})
			})] }) : null] });
		}
		/** 已提交面评汇总（展开区 5）。 */
		function ScorecardSection({ interviews }) {
			const rows = [];
			for (const interview of interviews) for (const interviewer of interview.interviewers) {
				if (interviewer.scorecard === null) continue;
				rows.push({
					interview,
					interviewerName: interviewer.displayName !== "" ? interviewer.displayName : "（未提供姓名）",
					scorecard: interviewer.scorecard
				});
			}
			if (rows.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "还没有已提交的面评（服务端没有返回任何 scorecard）。" });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "rcw-tablewrap",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
					className: "rcw-table",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "轮次" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "面试官" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "状态" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "overall" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "revision" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "提交时间" })
					] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
						"data-testid": `scorecard-${row.scorecard.id}`,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [
								"第 ",
								row.interview.roundNo,
								" 轮"
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.interviewerName }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: chipClass(row.scorecard.statusTone),
								children: row.scorecard.statusLabel
							}) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.scorecard.overallLabel !== "" ? row.scorecard.overallLabel : "—" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.scorecard.revisionNo }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: row.scorecard.submittedAtText !== "" ? row.scorecard.submittedAtText : "—" })
						]
					}, row.scorecard.id)) })]
				})
			});
		}
		/** 决策状态（展开区 6）：当前有效 + 历史。 */
		function DecisionSection({ decisions }) {
			if (decisions.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "还没有招聘决策记录（decision 表对该申请为空）。" });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: decisions.map((decision) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-smallcard",
				style: { marginTop: 10 },
				"data-testid": `decision-${decision.id}`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-chiprow",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: decision.resultTone,
								children: [
									decision.scopeLabel !== "" ? decision.scopeLabel : "决策",
									" · ",
									decision.resultLabel
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
								tone: decision.isCurrent ? "green" : "gray",
								children: decision.isCurrent ? "当前有效" : "已被取代"
							}),
							decision.stageLabel !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
								tone: "gray",
								children: decision.stageLabel
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim rcw-tiny",
								children: [decision.decidedBy !== "" ? `由 ${decision.decidedBy} 决定` : "决定人未提供", decision.decidedAtText !== "" ? ` · ${decision.decidedAtText}` : ""]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceBox, { children: decision.reason !== "" ? decision.reason : "（服务端未提供理由）" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginTop: 6 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "decision id",
								value: decision.id,
								mono: true
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "scope",
								value: decision.scope
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "basis kinds",
								value: decision.basisKinds.join("、")
							}),
							decision.supersededBy !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "superseded_by",
								value: decision.supersededBy,
								mono: true
							}) : null
						]
					})
				]
			}, decision.id)) });
		}
		/** 时间线（展开区 7）。 */
		function TimelineSection({ timeline }) {
			if (timeline.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "没有可展示的时间线事实。" });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "rcw-timeline",
				children: timeline.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-timelineitem",
					children: [entry.label !== "" ? entry.label : entry.kindLabel !== "" ? entry.kindLabel : entry.kind, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
						entry.atText !== "" ? entry.atText : "时间未提供",
						entry.kindLabel !== "" ? ` · ${entry.kindLabel}` : "",
						entry.refId !== "" ? ` · ${entry.refId}` : ""
					] })]
				}, `${entry.at}-${entry.kind}-${String(index)}`))
			});
		}
		/** 一个"展开区"壳（加载中/不可用时给出明确说明，不伪造内容）。 */
		function LazySection({ title, testid, available, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Disclosure, {
				title,
				testid,
				children: available ? children : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "详情数据尚未读取成功（或服务端未返回该段），展开内容不可用。" })
			});
		}
		/** 表单里的一个字段（label + 控件）。 */
		function FormField({ label, hint, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: {
					display: "block",
					marginTop: 8
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "rcw-cap",
						style: {
							display: "block",
							marginBottom: 4
						},
						children: label
					}),
					children,
					hint !== void 0 && hint !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "rcw-dim rcw-tiny",
						style: {
							display: "block",
							marginTop: 3
						},
						children: hint
					}) : null
				]
			});
		}
		/** 一个写动作卡片的外壳（`data-testid="action-<key>"` 是浏览器证据钩子）。 */
		function ActionCard({ actionKey, title, available, blockedReason, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-smallcard",
				style: { marginTop: 14 },
				"data-testid": `action-${actionKey}`,
				"data-available": available ? "true" : "false",
				"data-blocked-reason": blockedReason,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-chiprow",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: available ? "green" : "gray",
							children: available ? "事实齐备，可提交" : "禁用（缺事实/越权）"
						})]
					}),
					children,
					blockedReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-pending",
						"data-testid": `pending-${actionKey}`,
						style: { marginTop: 8 },
						children: blockedReason
					}) : null
				]
			});
		}
		/** 结构性禁用原因（服务端不可用 / alias 越权 / 提交中）；空串 = 结构上可提交。 */
		function structuralReason(action, binding) {
			if (action === void 0) return "当前页面版本没有提供这个操作";
			if (!action.available) return action.reasonText !== "" ? action.reasonText : "这个操作暂时不可用";
			if (binding.aliasBlocked) return `${binding.aliasNote !== "" ? binding.aliasNote : "当前身份不能执行写操作，请切换到招聘方身份"}`;
			if (binding.pending) return "提交中…";
			return "";
		}
		/** build 失败 → 人读禁用原因（机器码留在数据层，文案只给 HR 能执行的下一步）。 */
		function buildReasonOf(built) {
			if (built.ok) return "";
			return built.reasonText !== "" ? built.reasonText : "表单还没有填完整，请检查必填项";
		}
		/** P0 `stage/advance`：点击即提交 `{application_id}`（服务端按已发生事实推导目标阶段）。 */
		function StageAdvanceForm({ action, applicationId, aliasBlocked, aliasNote, pending, onRunAction }) {
			const [localError, setLocalError] = (0, react.useState)("");
			const built = buildStageAdvanceBody({ applicationId });
			const structural = structuralReason(action, {
				aliasBlocked,
				aliasNote,
				pending
			});
			const blockedReason = structural !== "" ? structural : buildReasonOf(built);
			const disabled = blockedReason !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(ActionCard, {
				actionKey: "stage_advance",
				title: "推进阶段（stage/advance）",
				available: !disabled,
				blockedReason,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-dim rcw-tiny",
						children: "服务端按已发生事实推导目标阶段（本表单只提交 application_id，不指定 to_stage；ADVANCED / NO_OP / BLOCKED 都是服务端业务结论）。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rcw-btn rcw-btn-blue",
						"data-testid": "stage-advance-submit",
						disabled,
						onClick: () => {
							if (!built.ok) {
								setLocalError(buildReasonOf(built));
								return;
							}
							if (action === void 0) return;
							setLocalError("");
							onRunAction(action, built.body);
						},
						children: pending ? "提交中…" : "推进阶段"
					}),
					localError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-alert",
						"data-testid": "stage-advance-error",
						style: { marginTop: 8 },
						children: localError
					}) : null
				]
			});
		}
		/** P0 `screening/decide`：结论 + 理由；facts 缺 → disabled + 精确原因（不发请求）。 */
		function ScreeningForm({ action, detail, decisionFacts, decisionFactsProbe, aliasBlocked, aliasNote, pending, factsBlockedReason, onRunAction, onScreeningEvaluate, evaluateDisabledReason, evaluatePending }) {
			const [result, setResult] = (0, react.useState)("HOLD");
			const [reason, setReason] = (0, react.useState)("");
			const [localError, setLocalError] = (0, react.useState)("");
			const applicationId = detail?.header.id ?? "";
			const blockers = screeningDecisionBlockers(decisionFacts ?? null, result === "ADVANCE" || result === "REJECT");
			const blockedReason = [
				structuralReason(action, {
					aliasBlocked,
					aliasNote,
					pending
				}),
				factsBlockedReason,
				blockers.length > 0 ? blockers.map(blockerTextOf).join("、") : ""
			].filter((part) => part !== "").join("；");
			const disabled = blockedReason !== "";
			const evaluateBlocked = evaluateDisabledReason !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(ActionCard, {
				actionKey: "screening_decide",
				title: "记录初筛结论（screening/decide）",
				available: !disabled,
				blockedReason,
				children: [
					factsBlockedReason !== "" || blockers.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-alert",
						"data-testid": "screening-disabled-reason",
						style: { marginTop: 6 },
						children: [factsBlockedReason, blockers.map(blockerTextOf).join("、")].filter((part) => part !== "").join("；")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "结论（result）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "rcw-select",
							"data-testid": "screening-result",
							value: result,
							onChange: (event) => setResult(event.target.value),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "ADVANCE",
									children: "通过（ADVANCE）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "HOLD",
									children: "暂缓（HOLD）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "WITHDRAW",
									children: "撤回（WITHDRAW）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "REJECT",
									children: "不通过（REJECT）"
								})
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "理由（1..4000 字；REJECT 必须引到 rubric 维度 key）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							"data-testid": "screening-reason",
							rows: 3,
							style: FIELD_STYLE,
							value: reason,
							onChange: (event) => setReason(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-chiprow",
						style: { marginTop: 10 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-btn rcw-btn-blue",
							"data-testid": "screening-submit",
							disabled,
							onClick: () => {
								const built = buildScreeningDecisionBody({
									facts: decisionFacts ?? null,
									result,
									reason,
									applicationId
								});
								if (!built.ok) {
									setLocalError(buildReasonOf(built));
									return;
								}
								if (action === void 0) return;
								setLocalError("");
								onRunAction(action, built.body);
							},
							children: pending ? "提交中…" : "记录初筛结论"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-btn rcw-btn-soft",
							"data-testid": "screening-evaluate",
							disabled: evaluateBlocked || evaluatePending || onScreeningEvaluate === void 0,
							onClick: () => {
								if (evaluateBlocked || onScreeningEvaluate === void 0) return;
								onScreeningEvaluate();
							},
							children: evaluatePending ? "评估执行中…" : "执行初筛评估"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-dim rcw-tiny",
						style: { marginTop: 6 },
						"data-testid": "screening-evaluate-pending",
						children: evaluateBlocked ? evaluateDisabledReason : "执行初筛评估会真的写 screening_evaluation；成功后再 GET facts。"
					}),
					localError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-alert",
						"data-testid": "screening-error",
						style: { marginTop: 8 },
						children: localError
					}) : null
				]
			});
		}
		/** P1 `interview/schedule` CREATE：轮次/开始/时长/面试官（候选来自 settings.hiringTeams）/幂等键。 */
		function InterviewScheduleForm({ action, detail, settings, aliasBlocked, aliasNote, pending, onRunAction }) {
			const candidates = interviewerCandidates(settings);
			const existingRounds = detail?.interviews.map((interview) => interview.roundNo) ?? [];
			const defaultRound = Math.min(20, Math.max(1, existingRounds.length === 0 ? 1 : Math.max(...existingRounds) + 1));
			const [roundNo, setRoundNo] = (0, react.useState)(String(defaultRound));
			const [start, setStart] = (0, react.useState)("");
			const [duration, setDuration] = (0, react.useState)("60");
			const [interviewerActorId, setInterviewerActorId] = (0, react.useState)(candidates[0]?.actorId ?? "");
			const [idempotencyKey] = (0, react.useState)(() => newIdempotencyKey());
			const [localError, setLocalError] = (0, react.useState)("");
			const blockedReason = [structuralReason(action, {
				aliasBlocked,
				aliasNote,
				pending
			}), candidates.length === 0 ? "还没有可选的面试官：招聘团队里没有可用人员，请先在招聘设置里补上" : ""].filter((part) => part !== "").join("；");
			const disabled = blockedReason !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(ActionCard, {
				actionKey: "interview_schedule",
				title: "安排面试（interview/schedule · CREATE）",
				available: !disabled,
				blockedReason,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "轮次（1..20）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "number",
							min: 1,
							max: 20,
							"data-testid": "schedule-round",
							style: FIELD_STYLE,
							value: roundNo,
							onChange: (event) => setRoundNo(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "开始时间（datetime-local → 带偏移 ISO）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "datetime-local",
							"data-testid": "schedule-start",
							style: FIELD_STYLE,
							value: start,
							onChange: (event) => setStart(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "时长（15..480 分钟）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "number",
							min: 15,
							max: 480,
							"data-testid": "schedule-duration",
							style: FIELD_STYLE,
							value: duration,
							onChange: (event) => setDuration(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "面试官（来自招聘团队；值是 actorId）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "rcw-select",
							"data-testid": "schedule-interviewer",
							value: interviewerActorId,
							onChange: (event) => setInterviewerActorId(event.target.value),
							children: [candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "（没有可用候选人）"
							}) : null, candidates.map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: candidate.actorId,
								children: [
									candidate.displayName,
									candidate.teamName !== "" ? ` · ${candidate.teamName}` : "",
									candidate.teamRole !== "" ? ` · ${candidate.teamRole}` : ""
								]
							}, candidate.actorId))]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "幂等键（前端生成并保留；重试复用同一 key）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							"data-testid": "schedule-idempotency",
							style: FIELD_STYLE,
							value: idempotencyKey,
							readOnly: true
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rcw-btn rcw-btn-blue",
						"data-testid": "schedule-submit",
						disabled,
						onClick: () => {
							const built = buildInterviewScheduleBody({
								applicationId: detail?.header.id ?? "",
								roundNo: Number(roundNo),
								scheduledStartAt: toOffsetIso(start),
								durationMinutes: Number(duration),
								interviewers: interviewerActorId !== "" ? [{
									actorId: interviewerActorId,
									requiredScorecard: true
								}] : [],
								idempotencyKey,
								timezone: "Asia/Shanghai"
							});
							if (!built.ok) {
								setLocalError(buildReasonOf(built));
								return;
							}
							if (action === void 0) return;
							setLocalError("");
							onRunAction(action, built.body);
						},
						children: pending ? "提交中…" : "安排面试"
					}),
					localError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-alert",
						"data-testid": "schedule-error",
						style: { marginTop: 8 },
						children: localError
					}) : null
				]
			});
		}
		/** P1 `transcript/import`：人工粘贴正文；DEMO_SAMPLE = FIXTURE 演示文本（不得冒充 LIVE）。 */
		function TranscriptImportForm({ action, detail, aliasBlocked, aliasNote, pending, onRunAction }) {
			const choices = interviewChoices(detail);
			const [interviewId, setInterviewId] = (0, react.useState)(choices[0]?.interviewId ?? "");
			const [content, setContent] = (0, react.useState)("");
			const [sourceKind, setSourceKind] = (0, react.useState)("DEMO_SAMPLE");
			const [fileName, setFileName] = (0, react.useState)("");
			const [language, setLanguage] = (0, react.useState)("zh");
			const [note, setNote] = (0, react.useState)("");
			const [localError, setLocalError] = (0, react.useState)("");
			const blockedReason = [structuralReason(action, {
				aliasBlocked,
				aliasNote,
				pending
			}), choices.length === 0 ? "这个申请还没有可关联的面试，请先安排面试" : ""].filter((part) => part !== "").join("；");
			const disabled = blockedReason !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(ActionCard, {
				actionKey: "transcript_import",
				title: "导入 / 关联 Transcript（transcript/import）",
				available: !disabled,
				blockedReason,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "面试（转写只能挂到已绑定的面试）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "rcw-select",
							"data-testid": "transcript-interview",
							value: interviewId,
							onChange: (event) => setInterviewId(event.target.value),
							children: [choices.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "（该申请没有面试）"
							}) : null, choices.map((choice) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: choice.interviewId,
								children: choice.label
							}, choice.interviewId))]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "来源（source_kind）",
						hint: sourceKind === "DEMO_SAMPLE" ? "DEMO_SAMPLE = 演示文本（provenance=FIXTURE，附 FIXTURE_CONTENT_NOT_LIVE 警告；不是真实平台导出件）" : "PLATFORM_EXPORT = 平台导出件（provenance=LIVE，必须填导出文件名）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "rcw-select",
							"data-testid": "transcript-source-kind",
							value: sourceKind,
							onChange: (event) => setSourceKind(event.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "DEMO_SAMPLE",
								children: "DEMO_SAMPLE（FIXTURE 演示文本）"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "PLATFORM_EXPORT",
								children: "PLATFORM_EXPORT（真实平台导出）"
							})]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "导出文件名（exported_file_name；PLATFORM_EXPORT 必填）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							"data-testid": "transcript-file-name",
							style: FIELD_STYLE,
							value: fileName,
							onChange: (event) => setFileName(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "正文（content，逐字节保存，1..400000 字符）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							"data-testid": "transcript-content",
							rows: 4,
							style: FIELD_STYLE,
							value: content,
							onChange: (event) => setContent(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "语言（language，默认 zh）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							"data-testid": "transcript-language",
							style: FIELD_STYLE,
							value: language,
							onChange: (event) => setLanguage(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "备注（note，≤500，人工追溯）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							"data-testid": "transcript-note",
							style: FIELD_STYLE,
							value: note,
							onChange: (event) => setNote(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rcw-btn rcw-btn-blue",
						"data-testid": "transcript-submit",
						disabled,
						onClick: () => {
							const built = buildTranscriptImportBody({
								interviewId,
								content,
								sourceKind,
								exportedFileName: fileName,
								language,
								note
							});
							if (!built.ok) {
								setLocalError(buildReasonOf(built));
								return;
							}
							if (action === void 0) return;
							setLocalError("");
							onRunAction(action, built.body);
						},
						children: pending ? "提交中…" : "导入 Transcript"
					}),
					localError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-alert",
						"data-testid": "transcript-error",
						style: { marginTop: 8 },
						children: localError
					}) : null
				]
			});
		}
		/** P0 `decision/record`（facade）：scope/result/理由；summary 缺 → SUMMARY_MISSING disabled。 */
		function DecisionRecordForm({ decisionFacts, decisionFactsProbe, applicationId, aliasBlocked, aliasNote, pending, onDecisionRecord }) {
			const [scope, setScope] = (0, react.useState)("STAGE");
			const [result, setResult] = (0, react.useState)("ADVANCE");
			const [reason, setReason] = (0, react.useState)("");
			const [localError, setLocalError] = (0, react.useState)("");
			const factsProbeReason = decisionFactsProbe === "MISSING" ? "还不能记录决策：决策依据暂时读不到，请稍后重试" : decisionFactsProbe === "ERROR" ? "决策依据读取失败，请稍后重试；如果一直失败请联系管理员" : decisionFactsProbe === "LOADING" ? "正在读取决策依据…" : decisionFacts === void 0 ? "还不能记录决策：决策依据还没有读取" : "";
			const blockers = decisionRecordBlockers(decisionFacts ?? null);
			const blockedReason = [
				...[
					aliasBlocked ? `${aliasNote !== "" ? aliasNote : "当前身份不能执行写操作，请切换到招聘方身份"}` : "",
					pending ? "提交中…" : "",
					onDecisionRecord === void 0 ? "当前页面版本没有提供「记录正式决策」操作" : ""
				].filter((part) => part !== ""),
				factsProbeReason,
				blockers.length > 0 ? blockers.map(blockerTextOf).join("、") : ""
			].filter((part) => part !== "").join("；");
			const disabled = blockedReason !== "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(ActionCard, {
				actionKey: "decision_record",
				title: "记录正式决策（decision/record · facade）",
				available: !disabled,
				blockedReason,
				children: [
					blockedReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-alert",
						"data-testid": "decision-disabled-reason",
						style: { marginTop: 6 },
						children: blockedReason
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "决策范围（decision_scope）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "rcw-select",
							"data-testid": "decision-scope",
							value: scope,
							onChange: (event) => setScope(event.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "STAGE",
								children: "阶段决策（STAGE）"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "FINAL",
								children: "最终决策（FINAL）"
							})]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "结论（result；WITHDRAW/HIRED 不在 facade 封闭集）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "rcw-select",
							"data-testid": "decision-result",
							value: result,
							onChange: (event) => setResult(event.target.value),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "ADVANCE",
									children: "通过（ADVANCE）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "HOLD",
									children: "暂缓（HOLD）"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "REJECT",
									children: "不通过（REJECT）"
								})
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FormField, {
						label: "理由（1..4000 字）",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							"data-testid": "decision-reason",
							rows: 3,
							style: FIELD_STYLE,
							value: reason,
							onChange: (event) => setReason(event.target.value)
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "rcw-btn rcw-btn-blue",
						"data-testid": "decision-submit",
						disabled,
						onClick: () => {
							const built = buildDecisionRecordBody({
								facts: decisionFacts ?? null,
								applicationId,
								scope,
								result,
								reason
							});
							if (!built.ok) {
								setLocalError(buildReasonOf(built));
								return;
							}
							if (onDecisionRecord === void 0) return;
							setLocalError("");
							onDecisionRecord(built.body);
						},
						children: pending ? "提交中…" : "记录决策"
					}),
					localError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-alert",
						"data-testid": "decision-error",
						style: { marginTop: 8 },
						children: localError
					}) : null
				]
			});
		}
		/** `action-result` 读回区：只显示服务端 readback/决策/评估的键值行（键/值原样，不做业务推断）。 */
		function ActionResultPanel({ outcomes }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-smallcard",
				style: { marginTop: 14 },
				"data-testid": "action-result",
				"data-has-outcome": outcomes.length > 0 ? "true" : "false",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-chiprow",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "写动作结果 · 服务端读回" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
						tone: "gray",
						children: "成功事实只认 readback + 重新 GET"
					})]
				}), outcomes.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "rcw-dim rcw-tiny",
					style: { marginTop: 6 },
					children: "尚未执行写动作。"
				}) : outcomes.map((outcome, index) => {
					const lines = actionResultLines(outcome);
					const readbackShown = outcome.envelope !== null && outcome.envelope.readback !== null;
					const advice = outcome.error !== null ? describeActionError(outcome.error.code, outcome.error.reasonCode) : "";
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						"data-testid": "action-result-item",
						"data-action-key": outcome.key,
						"data-accepted": outcome.accepted ? "true" : "false",
						"data-has-readback": readbackShown ? "true" : "false",
						style: {
							marginTop: 10,
							borderTop: index === 0 ? "none" : "1px dashed #e6ebf2",
							paddingTop: index === 0 ? 0 : 10
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-chiprow",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
										tone: "blue",
										children: ["动作 · ", outcome.key]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
										tone: outcome.accepted ? "blue" : "red",
										children: ["HTTP ", outcome.status]
									}),
									readbackShown ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
										tone: "green",
										children: "readback 已读回"
									}) : outcome.accepted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
										tone: "amber",
										children: "2xx 但无 readback（不当作成功）"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
										tone: "red",
										children: "服务端拒绝"
									})
								]
							}),
							outcome.error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 6 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										className: "rcw-alert",
										"data-testid": "action-result-error",
										children: [
											outcome.error.code !== "" ? `${outcome.error.code}/` : "",
											outcome.error.reasonCode !== "" ? outcome.error.reasonCode : "",
											"：",
											outcome.error.message
										]
									}),
									advice !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										className: "rcw-dim rcw-tiny",
										"data-testid": "action-result-advice",
										children: ["补救：", advice]
									}) : null,
									outcome.error.rawBody !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
										className: "rcw-mono rcw-tiny",
										"data-testid": "action-result-raw",
										children: outcome.error.rawBody
									}) : null
								]
							}) : null,
							lines.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { marginTop: 6 },
								children: lines.map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "rcw-fieldrow",
									"data-readback-key": line.key,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "rcw-fieldkey",
										children: [line.label, line.label !== line.key ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "rcw-mono rcw-tiny",
											children: [" · ", line.key]
										}) : null]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "rcw-fieldval rcw-mono",
										children: line.value
									})]
								}, line.key))
							}) : outcome.accepted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "rcw-dim rcw-tiny",
								style: { marginTop: 6 },
								children: "服务端 HTTP 2xx，但信封里没有可展示的 readback —— 不当作成功（界面不会用本地状态代替读回）。"
							}) : null,
							outcome.bodyText !== "" && outcome.error === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								className: "rcw-mono rcw-tiny",
								"data-testid": "action-result-body",
								children: outcome.bodyText
							}) : null
						]
					}, `${outcome.key}-${String(index)}`);
				})]
			});
		}
		/**
		* 申请详情视图。
		* @param props - 见 {@link ApplicationDetailProps}。
		* @returns 详情页 JSX（结论 + 写动作表单 + 渐进展开 + aside）。
		*/
		function ApplicationDetail(props) {
			const header = props.detail?.header ?? props.row;
			const step = props.detail?.nextStep ?? props.row?.nextStep;
			const detail = props.detail;
			const material = detail?.material ?? props.row?.material ?? null;
			const interviews = detail?.interviews ?? props.row?.interviews ?? [];
			const scorecardProgress = detail?.scorecardProgress ?? props.row?.scorecardProgress;
			const transcriptSummary = detail !== void 0 ? detail.transcriptSummary : props.row?.transcriptSummary ?? "";
			const transcriptTone = detail !== void 0 ? detail.transcriptTone : props.row?.transcriptTone ?? "gray";
			const materialSummary = props.row !== void 0 ? props.row.materialSummary : material !== null ? material.parseLabel : "未关联材料";
			const actionList = APPLICATION_ACTION_KEYS.map((key) => props.actions[key]).filter((action) => action !== void 0);
			const applicationId = header?.id ?? "";
			const pendingKey = props.pendingActionKey;
			const [localOutcome, setLocalOutcome] = (0, react.useState)(void 0);
			const outcomes = [];
			if (props.actionOutcome !== void 0) outcomes.push(props.actionOutcome);
			if (localOutcome !== void 0) outcomes.push(localOutcome);
			const factsProbeReason = props.decisionFactsProbe === "MISSING" ? "还不能执行初筛评估：决策依据暂时读不到，请稍后重试" : props.decisionFactsProbe === "ERROR" ? "决策依据读取失败，请稍后重试；如果一直失败请联系管理员" : props.decisionFactsProbe === "LOADING" ? "正在读取决策依据…" : props.decisionFacts === void 0 ? "还不能执行初筛评估：决策依据还没有读取" : "";
			const evaluationPresent = (props.decisionFacts?.screeningEvaluation ?? null) !== null;
			const evaluateDisabledReason = [
				props.aliasBlocked ? "当前身份不能执行写操作，请切换到招聘方身份" : "",
				props.onScreeningEvaluate === void 0 ? "当前页面版本没有提供「执行初筛评估」操作" : "",
				factsProbeReason,
				evaluationPresent ? "已经有初筛评估，不需要重复执行" : "",
				pendingKey === "screening_evaluate" ? "提交中…" : ""
			].filter((part) => part !== "");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailHeadline, {
					header,
					onBack: props.onBack,
					onRefresh: props.onRefresh,
					refreshing: props.refreshing
				}),
				props.error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorAlert, {
					title: "申请详情读取失败",
					message: props.error.message,
					rawBody: props.error.rawBody,
					onRetry: props.onRetry
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-grid rcw-detailgrid",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-main",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
							className: "rcw-detailmain",
							testid: "detail-conclusion",
							children: [
								step !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NextStepPanel, {
									step,
									scope: "application"
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "rcw-nextstep",
									"data-testid": "next-step",
									"data-scope": "application",
									"data-code": "",
									"data-has-step": "false",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "rcw-cap",
										children: "业务结论 · 下一步"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "rcw-nextstep-main",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "正在读取申请详情…" })
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "rcw-inlineactions",
									"data-testid": "detail-actions",
									children: actionList.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "rcw-dim rcw-tiny",
										children: "当前申请没有可用的写操作。"
									}) : actionList.map((action) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
										tone: action.available ? "blue" : "gray",
										testid: `detail-action-${action.key}`,
										title: action.available ? "可执行；点击后由你确认并提交" : action.reasonText !== "" ? action.reasonText : "暂不可用",
										children: [
											action.label,
											" · ",
											action.available ? "可执行" : "暂不可用"
										]
									}, action.key))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StageAdvanceForm, {
									action: props.actions["stage_advance"],
									applicationId,
									aliasBlocked: props.aliasBlocked,
									aliasNote: props.aliasNote,
									pending: pendingKey === "stage_advance",
									onRunAction: props.onRunAction
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScreeningForm, {
									action: props.actions["screening_decide"],
									detail,
									decisionFacts: props.decisionFacts,
									decisionFactsProbe: props.decisionFactsProbe,
									aliasBlocked: props.aliasBlocked,
									aliasNote: props.aliasNote,
									pending: pendingKey === "screening_decide",
									factsBlockedReason: factsProbeReason,
									onRunAction: props.onRunAction,
									onScreeningEvaluate: props.onScreeningEvaluate,
									evaluateDisabledReason: evaluateDisabledReason.join("；"),
									evaluatePending: pendingKey === "screening_evaluate"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DecisionRecordForm, {
									decisionFacts: props.decisionFacts,
									decisionFactsProbe: props.decisionFactsProbe,
									applicationId,
									aliasBlocked: props.aliasBlocked,
									aliasNote: props.aliasNote,
									pending: pendingKey === "decision_record_facade",
									onDecisionRecord: props.onDecisionRecord
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InterviewScheduleForm, {
									action: props.actions["interview_schedule"],
									detail,
									settings: props.settings,
									aliasBlocked: props.aliasBlocked,
									aliasNote: props.aliasNote,
									pending: pendingKey === "interview_schedule",
									onRunAction: props.onRunAction
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TranscriptImportForm, {
									action: props.actions["transcript_import"],
									detail,
									aliasBlocked: props.aliasBlocked,
									aliasNote: props.aliasNote,
									pending: pendingKey === "transcript_import",
									onRunAction: props.onRunAction
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionResultPanel, { outcomes }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "rcw-divider" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "rcw-metrics",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "rcw-metric",
											"data-testid": "detail-metric-material",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
												style: { fontSize: 15 },
												children: materialSummary !== "" ? materialSummary : "未关联材料"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "简历材料与解析" })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "rcw-metric",
											"data-testid": "detail-metric-interviews",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: interviews.length }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "面试轮次" })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "rcw-metric",
											"data-testid": "detail-metric-scorecards",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
												style: { fontSize: 15 },
												children: scorecardProgress !== void 0 ? scorecardProgress.summaryText : "—"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "面评进度（跨轮合计）" })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "rcw-metric",
											"data-testid": "detail-metric-transcript",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
												style: { fontSize: 15 },
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: chipClass(transcriptTone),
													children: transcriptSummary !== "" ? transcriptSummary : "状态未知"
												})
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "Transcript 状态" })]
										})
									]
								}),
								props.loading && detail === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "rcw-loading",
									"data-testid": "detail-loading",
									children: "正在读取申请详情…"
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazySection, {
									title: "简历材料与解析摘要",
									testid: "section-material",
									available: detail !== void 0,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MaterialSection, {
										material: detail?.material ?? null,
										resume: detail?.resume ?? null
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazySection, {
									title: "初筛证据 · rubric 维度 / SCREENING_EVALUATION / basis kinds",
									testid: "section-screening",
									available: detail !== void 0,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScreeningSection, { evidence: detail?.screeningEvidence ?? {
										decision: null,
										rubric: null,
										basis: []
									} })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazySection, {
									title: "面试排期与状态（含本轮重点）",
									testid: "section-interviews",
									available: detail !== void 0,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InterviewSection, { interviews: detail?.interviews ?? [] })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazySection, {
									title: "Transcript 状态",
									testid: "section-transcript",
									available: detail !== void 0,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TranscriptSection, {
										interviews: detail?.interviews ?? [],
										runs: detail?.transcriptRuns ?? []
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazySection, {
									title: "已提交面评汇总",
									testid: "section-scorecards",
									available: detail !== void 0,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScorecardSection, { interviews: detail?.interviews ?? [] })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazySection, {
									title: "决策状态（当前有效 + 历史）",
									testid: "section-decisions",
									available: detail !== void 0,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DecisionSection, { decisions: detail?.decisions ?? [] })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LazySection, {
									title: "时间线",
									testid: "section-timeline",
									available: detail !== void 0,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TimelineSection, { timeline: detail?.timeline ?? [] })
								})
							]
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
						className: "rcw-aside rcw-detailaside",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
								className: "rcw-asidecard",
								testid: "detail-aside-stage",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "申请事实" }), header !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "rcw-chiprow",
										style: { marginTop: 8 },
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											tone: header.stageTone,
											children: header.stageLabel
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											tone: header.lifecycleTone,
											children: header.lifecycleLabel
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: { marginTop: 10 },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
												label: "申请时间",
												value: header.appliedAtText
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
												label: "进入本阶段",
												value: header.stageEnteredAtText
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
												label: "记录版本",
												value: String(header.recordVersion)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
												label: "岗位",
												value: header.jobTitle
											})
										]
									}),
									header.stageBlockedReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										className: "rcw-alert",
										style: {
											marginTop: 10,
											marginBottom: 0
										},
										children: ["阶段阻塞原因：", header.stageBlockedReason]
									}) : null
								] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "没有申请头部数据。" })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
								className: "rcw-asidecard",
								testid: "detail-aside-siblings",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "同一候选人的其他申请" }), props.siblings.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "没有同一候选人的其他岗位申请。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "rcw-joblist",
									children: props.siblings.map((sibling) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "rcw-jobrow",
										"data-testid": `sibling-row-${sibling.id}`,
										onClick: () => props.onOpenApplication(sibling.id),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "rcw-av",
												children: sibling.candidateInitial
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "rcw-rowmain",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: sibling.jobTitle }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
													sibling.stageLabel,
													" · ",
													sibling.lifecycleLabel
												] })]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
												tone: sibling.stageTone,
												children: sibling.stageLabel
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "rcw-chev",
												children: "›"
											})
										]
									}, sibling.rowKey))
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
								className: "rcw-asidecard",
								testid: "detail-aside-labels",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "数据来源与标签" }),
									detail !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreeDimBadges, {
										labels: detail.labels,
										testid: "detail-labels"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: { marginTop: 8 },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
												label: "评估时间",
												value: detail.evaluatedAtText
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
												label: "契约版本",
												value: detail.contractVersion
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
												label: "读取身份",
												value: detail.actor.displayName
											})
										]
									})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "详情读取成功后显示三维标签与契约版本。" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "rcw-textbtn",
										"data-testid": "open-job-from-detail",
										onClick: props.onOpenJob,
										children: "查看该岗位版本与 rubric →"
									})
								]
							})
						]
					})]
				})
			] });
		}
		/**
		* 弹窗文案（逐字取自 `work/d5/joblife/CONTRACT.md` §3；改文案必须先改合同）。
		*
		* 拼回完整文案的口径：
		*   `标题：${title}` / `正文：${bodyLines[0]}` / `      ${bodyLines[1..]}` /
		*   `可选输入：${reasonLabel}` / `主按钮：${confirmLabel}` / `次按钮：${cancelLabel}`。
		*/
		const CLOSE_JOB_DIALOG_TEXT = {
			/** 标题。 */
			title: "关闭岗位并终止在途申请？",
			/** 正文（第一段接在「正文：」后；其余段落各占一行）。 */
			bodyLines: [
				"关闭后该岗位不再接收新申请，招聘流程停止。",
				"该岗位下所有进行中（ACTIVE / ON_HOLD）的申请将被终止（status=CLOSED），",
				"尚未开始的面试将被取消，与该岗位相关的未完成任务将被取消。",
				"历史记录保留；进行中/已面试的面试与已有评价不会被改写。",
				"此操作不可自动恢复，且必须由人工确认。"
			],
			/** 可选输入说明（UI 前缀「可选输入：」）。 */
			reasonLabel: "关闭原因（选填，最多 500 字）",
			/** 主按钮。 */
			confirmLabel: "确认关闭并终止在途申请",
			/** 次按钮。 */
			cancelLabel: "取消"
		};
		/**
		* 岗位关闭确认弹窗。
		* @param props - 见 {@link CloseJobDialogProps}。
		* @returns 弹窗 JSX（取消只调 `onCancel`，组件内没有任何网络调用）。
		*/
		function CloseJobDialog({ jobTitle, busy, error, onConfirm, onCancel }) {
			const [reason, setReason] = (0, react.useState)("");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "rcw-modalscrim",
				"data-testid": "close-job-scrim",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-modal",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": CLOSE_JOB_DIALOG_TEXT.title,
					"data-testid": "close-job-dialog",
					"data-job-title": jobTitle,
					"data-busy": busy ? "true" : "false",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							"data-testid": "close-job-title",
							children: CLOSE_JOB_DIALOG_TEXT.title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "rcw-modal-job",
							"data-testid": "close-job-job",
							children: ["目标岗位：", jobTitle !== "" ? jobTitle : "（服务端未提供岗位名称）"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-modal-body",
							"data-testid": "close-job-body",
							children: CLOSE_JOB_DIALOG_TEXT.bodyLines.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								"data-testid": `close-job-body-${String(index)}`,
								children: line
							}, `close-job-body-${String(index)}`))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "rcw-modalfield",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-testid": "close-job-reason-label",
									children: ["可选输入：", CLOSE_JOB_DIALOG_TEXT.reasonLabel]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: "rcw-textarea",
									"data-testid": "close-job-reason",
									rows: 3,
									maxLength: 500,
									value: reason,
									disabled: busy,
									placeholder: "选填；该原因只进内部审计事件，不写任何业务列",
									onChange: (event) => {
										setReason(event.target.value.slice(0, 500));
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "rcw-dim rcw-tiny",
									"data-testid": "close-job-reason-count",
									children: [
										"已输入 ",
										reason.length,
										" / ",
										500,
										" 字"
									]
								})
							]
						}),
						error !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: "rcw-modalerror",
							"data-testid": "close-job-error",
							children: error
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-inlineactions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "rcw-btn rcw-btn-negative",
								"data-testid": "close-job-confirm",
								disabled: busy,
								onClick: () => {
									onConfirm(reason.trim());
								},
								children: busy ? "提交中…" : CLOSE_JOB_DIALOG_TEXT.confirmLabel
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "rcw-btn rcw-btn-soft",
								"data-testid": "close-job-cancel",
								disabled: busy,
								onClick: onCancel,
								children: CLOSE_JOB_DIALOG_TEXT.cancelLabel
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "rcw-muted rcw-tiny",
							style: { marginTop: 10 },
							children: [
								"点「",
								CLOSE_JOB_DIALOG_TEXT.cancelLabel,
								"」不发任何请求、零写入； 点「",
								CLOSE_JOB_DIALOG_TEXT.confirmLabel,
								"」才会真正提交一次关闭请求（需要你确认，会留下记录）。"
							]
						})
					]
				})
			});
		}
		// src/client/recruiting/RecruitingWorkspace.tsx
		/** 空下一步（服务端没给时用它渲染 fallback，而不是编造结论）。 */
		const EMPTY_STEP = {
			code: "",
			label: "",
			kind: "",
			kindLabel: "",
			tone: "gray",
			hasStep: false
		};
		/** 读回行的标签：`label（key）`（label 与 key 相同时只显示一次）。 */
		function readbackRowLabel(row) {
			return row.label === "" || row.label === row.key ? row.key : `${row.label}（${row.key}）`;
		}
		/** 最近一次写动作结果卡：2xx 不等于业务成功；只显示信封 `readback` 与服务端原文。 */
		function OutcomeReadbackCard({ outcome, title, testid }) {
			if (outcome === void 0) return null;
			const rows = outcome.envelope !== null ? readbackLines(outcome.envelope) : [];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-detailmain",
				style: { marginTop: 14 },
				testid,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-sectionhead",
						style: { marginTop: 0 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: outcome.accepted ? "blue" : "red",
							testid: `${testid}-status`,
							children: outcome.accepted ? `HTTP ${String(outcome.status)} 已受理（业务事实看 readback）` : `失败（HTTP ${String(outcome.status)}）`
						})]
					}),
					rows.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						"data-testid": `${testid}-lines`,
						children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
							label: readbackRowLabel(row),
							value: row.value,
							mono: true
						}, row.key))
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-muted rcw-tiny",
						"data-testid": `${testid}-empty`,
						children: "服务端没有返回 readback（界面不把 2xx 当成功）。"
					}),
					outcome.error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SourceBox, {
						testid: `${testid}-error`,
						children: [outcome.error.message, outcome.error.rawBody !== "" ? `\n\n${outcome.error.rawBody}` : ""]
					}) : null,
					outcome.envelope !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "rcw-dim rcw-tiny",
						"data-testid": `${testid}-actor`,
						children: [
							"动作 ",
							outcome.envelope.action,
							" · alias",
							" ",
							outcome.envelope.actor.alias !== "" ? outcome.envelope.actor.alias : "—",
							" · approval",
							" ",
							outcome.envelope.approval.result !== "" ? outcome.envelope.approval.result : "—"
						]
					}) : null
				]
			});
		}
		/** 服务端响应体 → JSON 对象（解析失败 → null；不猜业务值）。 */
		function parseJsonObject(bodyText) {
			const trimmed = bodyText.trim();
			if (trimmed === "") return null;
			try {
				return record(JSON.parse(trimmed));
			} catch {
				return null;
			}
		}
		/** 岗位关闭结果卡：信封 `terminated` 逐条 + `job.status/record_version/actor` + `replayed`。 */
		function CloseJobResultCard({ envelope, jobId, error, errorRaw, bodyText }) {
			if (envelope === void 0 && error === "") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-detailmain",
				style: { marginTop: 14 },
				testid: "close-job-result",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-sectionhead",
						style: { marginTop: 0 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "岗位关闭结果（服务端信封 + 重新 GET）" }), envelope !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: envelope.replayed ? "amber" : "green",
							testid: "close-job-replayed",
							children: envelope.replayed ? "replayed（重复确认）" : "首次关闭"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: "red",
							children: "没有可用信封"
						})]
					}),
					error !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorAlert, {
						title: "岗位关闭失败（服务端原文，界面不推断结果）",
						message: error,
						rawBody: errorRaw !== "" ? errorRaw : bodyText
					}) : null,
					envelope !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-kv",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "job.status",
									value: envelope.job.status
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "record_version",
									value: String(envelope.job.recordVersion)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "status_changed_at",
									value: envelope.job.statusChangedAt
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "status_changed_by_actor_id",
									value: envelope.job.statusChangedByActorId,
									mono: true
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "actor",
									value: `${envelope.actor.alias} · ${envelope.actor.displayName} · ${envelope.actor.actorId}`,
									mono: true
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "replayed",
									value: envelope.replayed ? "true" : "false"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
									label: "job_id",
									value: envelope.job.jobId !== "" ? envelope.job.jobId : jobId,
									mono: true
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-subhead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "本次终止计数（信封 terminated 逐条）" })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "rcw-roundfocus-list",
							"data-testid": "close-job-terminated",
							children: terminatedLines(envelope.terminated).map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								className: "rcw-quote",
								children: line
							}, line))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "rcw-muted rcw-tiny",
							children: "已重新 GET overview 与岗位详情；界面没有先把本地岗位状态改成已关闭。"
						})
					] }) : null
				]
			});
		}
		/** 草案字段容错读取：先试 camelCase 键，再试 snake_case（A 的归一化命名以 INTERFACE2 为准）。 */
		function draftTextNode(source, keys) {
			const raw = record(source);
			for (const key of keys) {
				const value = text(raw[key]);
				if (value !== "") return value;
			}
			return "";
		}
		/** 草案数组容错读取：缺失/坏类型 → `[]`。 */
		function draftArrayNode(source, keys) {
			const raw = record(source);
			for (const key of keys) {
				const value = items(raw[key]);
				if (value.length > 0) return value;
			}
			return [];
		}
		/** 把 A 的 `JobDraftView` 拆成可渲染事实（两种键名都接受，缺字段不补默认文案）。 */
		function jobDraftFactsOf(draft) {
			if (draft === null) return null;
			const raw = record(draft);
			const jobDraft = record(raw.job_draft ?? raw.jobDraft);
			const rubricDraft = record(raw.rubric_draft ?? raw.rubricDraft);
			const rounds = [];
			for (const item of draftArrayNode(jobDraft, ["rounds"])) {
				const entry = record(item);
				rounds.push({
					roundNo: count(entry.round_no ?? entry.roundNo),
					title: text(entry.title),
					focus: stringList(entry.focus),
					questions: stringList(entry.questions)
				});
			}
			const rubricDimensions = [];
			for (const item of draftArrayNode(rubricDraft, ["dimensions"])) {
				const entry = record(item);
				const key = text(entry.key);
				if (key === "") continue;
				rubricDimensions.push({
					key,
					label: text(entry.label) !== "" ? text(entry.label) : key,
					kind: text(entry.kind),
					weight: numberOrNull(entry.weight),
					notes: text(entry.reason) !== "" ? text(entry.reason) : text(entry.notes)
				});
			}
			const reasons = [];
			for (const item of draftArrayNode(raw, ["reasons"])) {
				const entry = record(item);
				const reasonLine = text(entry.reason);
				if (reasonLine === "") continue;
				reasons.push({
					path: text(entry.path),
					reason: reasonLine,
					source: text(entry.source)
				});
			}
			const missingItems = [];
			for (const item of draftArrayNode(raw, ["missing_items", "missingItems"])) {
				const entry = record(item);
				const key = text(entry.key);
				const question = text(entry.question);
				if (key === "" && question === "") continue;
				missingItems.push({
					key,
					question
				});
			}
			const confirmationRaw = record(raw.confirmation);
			return {
				recruitingReason: draftTextNode(jobDraft, ["recruiting_reason", "recruitingReason"]),
				responsibilities: stringList(jobDraft.responsibilities),
				successProfile: stringList(jobDraft.success_profile ?? jobDraft.successProfile),
				mustHave: stringList(jobDraft.must_have ?? jobDraft.mustHave),
				niceToHave: stringList(jobDraft.nice_to_have ?? jobDraft.niceToHave),
				rounds,
				rubricDimensions,
				reasons,
				missingItems,
				confirmation: {
					required: confirmationRaw.required === true,
					status: text(confirmationRaw.status),
					note: text(confirmationRaw.note),
					next: stringList(confirmationRaw.next)
				},
				draftTitle: draftTextNode(jobDraft, ["title"]),
				draftCode: draftTextNode(jobDraft, ["code"])
			};
		}
		/** 岗位草案卡（task-57）：生成 → 展示服务端草案/理由/缺项/轮次/评分标准 → 人改 → 确认创建 → 读回。 */
		function JobDraftCard({ draftProbeReason, createProbeReason, draft, draftBusy, createBusy, draftError, draftRaw, createError, createRaw, createOutcome, departments, onGenerate, onCreate }) {
			const [requestText, setRequestText] = (0, react.useState)("");
			const [titleText, setTitleText] = (0, react.useState)("");
			const [codeText, setCodeText] = (0, react.useState)("");
			const [departmentId, setDepartmentId] = (0, react.useState)("");
			const [descriptionMd, setDescriptionMd] = (0, react.useState)("");
			const [requirementsMd, setRequirementsMd] = (0, react.useState)("");
			const facts = jobDraftFactsOf(draft);
			(0, react.useEffect)(() => {
				const next = jobDraftFactsOf(draft);
				if (next === null) return;
				setTitleText((current) => current !== "" ? current : next.draftTitle);
				setCodeText((current) => current !== "" ? current : next.draftCode);
				setDescriptionMd((current) => current !== "" ? current : next.responsibilities.join("\n"));
				setRequirementsMd((current) => current !== "" ? current : [...next.mustHave.map((line) => `必备：${line}`), ...next.niceToHave.map((line) => `加分：${line}`)].join("\n"));
			}, [draft]);
			const criteria = (facts?.rubricDimensions ?? []).map((dimension) => ({
				key: dimension.key,
				label: dimension.label,
				kind: dimension.kind,
				...dimension.weight !== null ? { weight: dimension.weight } : {},
				...dimension.notes !== "" ? { notes: dimension.notes } : {}
			}));
			const createBlockedReason = createProbeReason !== "" ? createProbeReason : facts === null ? "还没有草案，先点「生成草案」；确认创建暂不可用" : createBusy ? "" : "";
			const createDisabled = createBlockedReason !== "" || createBusy;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-detailmain",
				style: { marginTop: 14 },
				testid: "job-draft",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-sectionhead",
						style: { marginTop: 0 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "岗位草案生成" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: draftProbeReason === "" ? "blue" : "amber",
							testid: "job-draft-route",
							children: draftProbeReason === "" ? "草案生成可用" : "草案生成暂不可用"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-muted rcw-tiny",
						children: "先让服务端按你的招聘需求生成一份草案，你改完确认后才创建岗位。草案只读、不写库，内容全部来自服务端返回； 本卡不编造企业事实，也不会自动批准评分标准。"
					}),
					draftProbeReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-pending",
						"data-testid": "job-draft-pending",
						children: draftProbeReason
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "rcw-modalfield",
						style: { marginTop: 10 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "招聘需求原文（1..2000 字）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: "rcw-textarea",
							"data-testid": "job-draft-request-text",
							rows: 3,
							value: requestText,
							disabled: draftProbeReason !== "" || draftBusy,
							placeholder: "例如：我们要招一名后端工程师，做支付系统，最好有大厂经验",
							onChange: (event) => setRequestText(event.target.value)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-inlineactions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-btn rcw-btn-blue",
							"data-testid": "job-draft-generate",
							disabled: draftProbeReason !== "" || draftBusy,
							title: draftProbeReason !== "" ? draftProbeReason : "点击生成草案（只读，不写库）",
							onClick: () => onGenerate(requestText),
							children: draftBusy ? "生成中…" : "生成草案"
						})
					}),
					draftError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorAlert, {
						title: "岗位草案生成失败（服务端原文）",
						message: draftError,
						rawBody: draftRaw
					}) : null,
					facts === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-muted rcw-tiny",
						"data-testid": "job-draft-empty",
						children: "还没有草案：点「生成草案」后由服务端返回；当前无数据、不编造。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-subhead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "服务端草案（只展示，不编造）" })
						}),
						facts.recruitingReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
							label: "招聘原因（recruiting_reason）",
							value: facts.recruitingReason
						}) : null,
						facts.responsibilities.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-responsibilities",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "职责"
							}), facts.responsibilities.map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-quote",
								children: line
							}, `responsibility-${line}`))]
						}) : null,
						facts.successProfile.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-success-profile",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "成功画像"
							}), facts.successProfile.map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-quote",
								children: line
							}, `success-${line}`))]
						}) : null,
						facts.mustHave.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-must-have",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "必备条件"
							}), facts.mustHave.map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-quote",
								children: line
							}, `must-${line}`))]
						}) : null,
						facts.niceToHave.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-nice-to-have",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "加分项"
							}), facts.niceToHave.map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-quote",
								children: line
							}, `nice-${line}`))]
						}) : null,
						facts.reasons.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-reasons",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "生成理由（reasons）"
							}), facts.reasons.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-fieldrow",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "rcw-fieldkey rcw-mono",
									children: entry.path !== "" ? entry.path : "（未提供 path）"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "rcw-fieldval",
									children: [entry.reason, entry.source !== "" ? ` · 来源 ${entry.source}` : ""]
								})]
							}, `reason-${String(index)}-${entry.path}`))]
						}) : null,
						facts.missingItems.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-missing",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "待补充项（需要你补充的企业事实）"
							}), facts.missingItems.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-fieldrow",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "rcw-fieldkey rcw-mono",
									children: entry.key !== "" ? entry.key : "（未提供 key）"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "rcw-fieldval",
									children: entry.question !== "" ? entry.question : "（服务端未提供追问）"
								})]
							}, `missing-${String(index)}-${entry.key}`))]
						}) : null,
						facts.rounds.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-rounds",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "轮次与每轮重点"
							}), facts.rounds.map((round, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-smallcard",
								style: { marginTop: 8 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
										"第 ",
										round.roundNo,
										" 轮",
										round.title !== "" ? ` · ${round.title}` : ""
									] }),
									round.focus.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["重点：", round.focus.join("、")] }) : null,
									round.questions.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["问题：", round.questions.join(" / ")] }) : null
								]
							}, `round-${String(round.roundNo)}-${String(index)}`))]
						}) : null,
						facts.rubricDimensions.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							"data-testid": "job-draft-criteria",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "评分标准（rubric_draft.dimensions）"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-tablewrap",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									className: "rcw-table",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "key" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "维度" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "kind" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "权重" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "理由" })
									] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: facts.rubricDimensions.map((dimension) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: "rcw-mono",
											children: dimension.key
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: dimension.label }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: dimension.kind !== "" ? dimension.kind : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: dimension.weight !== null ? String(dimension.weight) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: dimension.notes !== "" ? dimension.notes : "—" })
									] }, dimension.key)) })]
								})
							})]
						}) : null,
						facts.confirmation.status !== "" || facts.confirmation.note !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "rcw-muted rcw-tiny",
							"data-testid": "job-draft-confirmation",
							children: [
								"确认闸门：",
								facts.confirmation.required ? "需要人工确认" : "无需确认",
								" ·",
								" ",
								facts.confirmation.status !== "" ? facts.confirmation.status : "状态未提供",
								facts.confirmation.note !== "" ? ` · ${facts.confirmation.note}` : "",
								facts.confirmation.next.length > 0 ? ` · 下一步 ${facts.confirmation.next.join("、")}` : ""
							]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-subhead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "人改后确认创建（job/create）" })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-fields-grid",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "rcw-modalfield",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "岗位名称" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: "rcw-input",
										"data-testid": "job-draft-title",
										value: titleText,
										disabled: createDisabled,
										onChange: (event) => setTitleText(event.target.value)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "rcw-modalfield",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "岗位编码（2..41 大写）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: "rcw-input",
										"data-testid": "job-draft-code",
										value: codeText,
										disabled: createDisabled,
										onChange: (event) => setCodeText(event.target.value)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "rcw-modalfield",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "部门" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: "rcw-select",
										"data-testid": "job-draft-department",
										value: departmentId,
										disabled: createDisabled,
										onChange: (event) => setDepartmentId(event.target.value),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "（请选择部门 —— 服务端 settings.departments）"
										}), departments.map((department) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: department.id,
											children: department.name !== "" ? department.name : department.id
										}, department.id))]
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "rcw-modalfield",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "岗位描述（markdown）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								className: "rcw-textarea",
								"data-testid": "job-draft-description",
								rows: 3,
								value: descriptionMd,
								disabled: createDisabled,
								onChange: (event) => setDescriptionMd(event.target.value)
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "rcw-modalfield",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "岗位要求（markdown）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								className: "rcw-textarea",
								"data-testid": "job-draft-requirements",
								rows: 3,
								value: requirementsMd,
								disabled: createDisabled,
								onChange: (event) => setRequirementsMd(event.target.value)
							})]
						}),
						createBlockedReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "rcw-pending",
							"data-testid": "job-draft-create-pending",
							children: createBlockedReason
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-inlineactions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "rcw-btn rcw-btn-blue",
								"data-testid": "job-draft-confirm",
								disabled: createDisabled,
								onClick: () => onCreate({
									code: codeText.trim(),
									title: titleText.trim(),
									departmentId,
									descriptionMd,
									requirementsMd,
									criteria
								}),
								children: createBusy ? "创建中…" : "确认创建岗位"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-dim rcw-tiny",
								children: "创建后 rubric 仍为待批准（不自动 approve）；成功事实看下方 readback + 重新 GET。"
							})]
						}),
						createError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorAlert, {
							title: "岗位创建失败（服务端原文）",
							message: createError,
							rawBody: createRaw
						}) : null,
						createOutcome !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DraftCreateResult, { outcome: createOutcome }) : null
					] })
				]
			});
		}
		/** 岗位创建响应卡（`job` / `versions` / `readback` 键值行；2xx 不独立当成功，靠 readback）。 */
		function DraftCreateResult({ outcome }) {
			const parsed = parseJsonObject(outcome.bodyText);
			const job = record(parsed?.job);
			const versions = record(parsed?.versions);
			const readback = record(parsed?.readback);
			const rows = [];
			for (const pair of [
				["job.job_id", job.job_id],
				["job.code", job.code],
				["job.status", job.status],
				["job.record_version", job.record_version],
				["versions.job_version_id", versions.job_version_id],
				["versions.version_no", versions.version_no],
				["versions.rubric_version_id", versions.rubric_version_id],
				["versions.approval_status", versions.approval_status],
				["readback.table", readback.table],
				["replayed", parsed?.replayed]
			]) {
				const value = typeof pair[1] === "number" ? String(pair[1]) : text(pair[1]);
				if (value !== "") rows.push({
					key: pair[0],
					label: pair[0],
					value
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-insight",
				style: { marginTop: 12 },
				"data-testid": "job-draft-result",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "岗位创建结果（服务端响应）" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-chiprow",
						style: { marginTop: 6 },
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: outcome.accepted ? "blue" : "red",
							children: outcome.accepted ? `HTTP ${String(outcome.status)} 已受理` : `失败（HTTP ${String(outcome.status)}）`
						})
					}),
					rows.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { marginTop: 8 },
						children: rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
							label: row.label,
							value: row.value,
							mono: true
						}, row.key))
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-muted rcw-tiny",
						children: "服务端没有返回可解析的创建结果（原文见下）。"
					}),
					rows.length === 0 || !outcome.accepted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceBox, {
						testid: "job-draft-result-raw",
						children: outcome.bodyText
					}) : null,
					outcome.error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceBox, {
						testid: "job-draft-result-error",
						children: outcome.error.message
					}) : null
				]
			});
		}
		/** 申请列表行。 */
		function ApplicationRow({ row, jobRubric, onOpen }) {
			const pinnedRubric = row.applicationRubric;
			const rubricConsistency = pinnedRubric !== null && jobRubric !== null && jobRubric !== void 0 ? pinnedRubric.versionNo === jobRubric.versionNo && pinnedRubric.approved === jobRubric.approved ? "（与岗位当前一致）" : `（与岗位当前 v${String(jobRubric.versionNo)} 不一致）` : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "rcw-appitem",
				"data-testid": `application-row-${row.id}`,
				"data-application-id": row.id,
				"data-stage": row.stageCode,
				"data-next-step": row.nextStep.code,
				"data-filter-kind": row.filterKind,
				onClick: () => onOpen(row.id),
				title: `打开 ${row.candidateName} 的申请详情`,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "rcw-av",
						children: row.candidateInitial
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "rcw-rowmain",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "rcw-rowtitle",
							children: [row.candidateName, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-rowjob",
								children: row.jobTitle
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "rcw-rowmeta",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
									tone: row.stageTone,
									testid: `application-row-${row.id}-stage`,
									children: ["阶段 · ", row.stageLabel]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-testid": `application-row-${row.id}-material`,
									children: ["材料 · ", row.materialSummary]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-testid": `application-row-${row.id}-screening`,
									children: ["初筛 · ", row.screeningSummary]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-testid": `application-row-${row.id}-interviews`,
									children: ["面试 · ", row.interviewSummary]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-testid": `application-row-${row.id}-scorecards`,
									children: ["面评 · ", row.scorecardProgress.summaryText]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-testid": `application-row-${row.id}-transcript`,
									children: ["转写 · ", row.transcriptSummary]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									"data-testid": `application-row-${row.id}-rubric`,
									children: [
										"本申请钉住 Rubric · ",
										applicationRubricTextOf(row.applicationRubric),
										rubricConsistency
									]
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "rcw-rowend",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
							tone: row.nextStep.tone,
							testid: `application-row-${row.id}-next-step`,
							children: row.nextStep.hasStep ? row.nextStep.label !== "" ? row.nextStep.label : "待处理" : "无下一步"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-chev",
							children: "›"
						})]
					})
				]
			});
		}
		/** 岗位头卡（含岗位选择器、指标、rubric、投递渠道、**唯一一份**岗位下一步、动作区）。 */
		function JobHero({ job, jobs, overview, onSelectJob, onToggleJobDetail, jobDetailOpen, rubricPendingText, rubricBusy, onApproveRubric, closePendingText, closeBusy, onOpenClose, onOpenSettings }) {
			if (job === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-hero",
				testid: "job-hero",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "rcw-cap",
						children: "当前招聘岗位"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: { marginTop: 6 },
						children: "没有可展示的岗位"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-sub",
						children: "服务端 overview 的 jobs 为空：招聘数据可能尚未接入，界面不编造岗位。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NextStepPanel, {
						step: EMPTY_STEP,
						scope: "job",
						fallback: "还没有岗位"
					})
				]
			});
			const currentStageRow = job.applicationCounts.byStage.find((row) => row.code === overview.applications[0]?.stageCode) ?? void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-hero",
				testid: "job-hero",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-hero-top",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-main",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "rcw-cap",
									children: "当前招聘岗位"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: job.title }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "rcw-sub",
									children: [
										job.departmentName !== "" ? job.departmentName : "（未提供部门）",
										job.code !== "" ? ` · ${job.code}` : "",
										job.versionText !== "" ? ` · 岗位版本 ${job.versionText}` : ""
									]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							className: "rcw-select",
							"data-testid": "job-select",
							"aria-label": "选择岗位",
							value: job.id,
							onChange: (event) => onSelectJob(event.target.value),
							children: jobs.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: item.id,
								children: [item.title, item.statusLabel !== "" ? `（${item.statusLabel}）` : ""]
							}, item.rowKey !== "" ? item.rowKey : `job-${String(index)}`))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-chiprow",
						style: { marginTop: 12 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: job.statusTone,
								testid: "job-status",
								children: ["岗位状态 · ", job.statusLabel]
							}),
							job.rubric !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
								tone: job.rubric.tone,
								testid: "job-rubric",
								children: job.rubric.summaryText
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
								tone: "gray",
								testid: "job-rubric",
								children: "未关联 rubric"
							}),
							job.postings.map((posting) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: posting.tone,
								title: posting.externalUrl !== "" ? posting.externalUrl : void 0,
								children: [
									"渠道 · ",
									posting.channelName !== "" ? posting.channelName : "（未命名渠道）",
									" · ",
									posting.statusLabel
								]
							}, posting.id))
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-metrics",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
								value: job.applicationCounts.total,
								label: "该岗位收到的申请",
								testid: "job-metric-total"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
								value: job.applicationCounts.active,
								label: "推进中的申请",
								testid: "job-metric-active"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
								value: overview.counts.awaitingScreening,
								label: "待初筛（全工作区）",
								testid: "job-metric-awaiting-screening"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Metric, {
								value: overview.counts.interviewsScheduled,
								label: "已排期面试（全工作区）",
								testid: "job-metric-interviews"
							})
						]
					}),
					job.applicationCounts.byStage.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-stagebar",
						"data-testid": "job-stage-counts",
						children: job.applicationCounts.byStage.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: row.code === currentStageRow?.code ? "blue" : "gray",
							children: [
								row.label,
								" · ",
								row.count
							]
						}, row.code))
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NextStepPanel, {
						step: job.nextStep,
						scope: "job",
						fallback: "暂无下一步"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-inlineactions",
						"data-testid": "job-actions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-actionwrap",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: `rcw-btn ${rubricPendingText === "" ? "rcw-btn-blue" : ""}`.trim(),
									"data-testid": "rubric-approve",
									"data-available": rubricPendingText === "" ? "true" : "false",
									"data-pending-reason": rubricPendingText !== "" ? rubricPendingText : void 0,
									disabled: rubricPendingText !== "" || rubricBusy,
									title: rubricPendingText !== "" ? rubricPendingText : "点击即由你确认批准当前岗位的评分标准（会留下审批记录）",
									onClick: () => {
										if (rubricPendingText !== "") return;
										onApproveRubric();
									},
									children: rubricBusy ? "提交中…" : "批准 Rubric"
								}), rubricPendingText !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "rcw-pending",
									"data-testid": "rubric-approve-pending",
									children: rubricPendingText
								}) : null]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-actionwrap",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "rcw-btn rcw-btn-negative",
									"data-testid": "close-job",
									"data-available": closePendingText === "" ? "true" : "false",
									"data-pending-reason": closePendingText !== "" ? closePendingText : void 0,
									disabled: closePendingText !== "" || closeBusy,
									title: closePendingText !== "" ? closePendingText : "打开确认弹窗（取消 = 零请求）",
									onClick: () => {
										if (closePendingText !== "") return;
										onOpenClose();
									},
									children: "关闭岗位"
								}), closePendingText !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "rcw-pending",
									"data-testid": "close-job-pending",
									children: closePendingText
								}) : null]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "rcw-btn",
								"data-testid": "toggle-job-detail",
								onClick: onToggleJobDetail,
								children: jobDetailOpen ? "收起岗位版本与 rubric" : "查看岗位版本与 rubric"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "rcw-btn rcw-btn-soft",
								"data-testid": "open-settings",
								onClick: onOpenSettings,
								children: "招聘设置（只读）"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-nextstep-meta",
						style: { marginTop: 10 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["岗位创建：", job.createdAtText !== "" ? job.createdAtText : "—"] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["状态变更：", job.statusChangedAtText !== "" ? job.statusChangedAtText : "—"] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"data-job-id": job.id !== "" ? job.id : void 0,
								children: "岗位编号："
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-code",
								children: job.code !== "" ? job.code : "—"
							})] })
						]
					})
				]
			});
		}
		/** 岗位版本 / rubric / 描述（点击头卡按钮时懒加载 `jobs/:id`）。 */
		function JobDetailCard({ jobDetail, loading, error, onRetry, onClose }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-detailmain",
				style: { marginTop: 14 },
				testid: "job-detail",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-sectionhead",
						style: { marginTop: 0 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "岗位详情 · 版本与 rubric" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-btn rcw-btn-sm",
							"data-testid": "close-job-detail",
							onClick: onClose,
							children: "收起"
						})]
					}),
					error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorAlert, {
						title: "岗位详情读取失败",
						message: error.message,
						rawBody: error.rawBody,
						onRetry
					}) : null,
					loading && jobDetail === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-loading",
						children: "正在读取岗位详情…"
					}) : null,
					jobDetail !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-chiprow",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
									tone: jobDetail.job.statusTone,
									children: ["岗位状态 · ", jobDetail.job.statusLabel]
								}),
								jobDetail.rubric !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
									tone: jobDetail.rubric.approved ? "green" : "amber",
									children: [
										"岗位当前评分标准 · r",
										String(jobDetail.rubric.versionNo),
										" · ",
										jobDetail.rubric.dimensions.length,
										" 个维度 ·",
										" ",
										jobDetail.rubric.approved ? "已批准" : "未批准"
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
									tone: "gray",
									children: "未关联 rubric"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreeDimBadges, {
									labels: jobDetail.labels,
									testid: "job-detail-labels"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-subhead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "岗位版本" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim rcw-tiny",
								children: [
									"共 ",
									jobDetail.versions.length,
									" 个版本"
								]
							})]
						}),
						jobDetail.versions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "服务端没有返回岗位版本。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-tablewrap",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
								className: "rcw-table",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "版本" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "payload hash" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "创建时间" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "批准" })
								] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: jobDetail.versions.map((version) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: ["r", version.versionNo] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: "rcw-mono",
										children: version.payloadHashText !== "" ? version.payloadHashText : "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: version.createdAtText !== "" ? version.createdAtText : "—" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: version.approved ? "已批准" : "未批准" })
								] }, version.id !== "" ? version.id : `version-${String(version.versionNo)}`)) })]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-subhead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "Rubric 维度" })
						}),
						jobDetail.rubric === null || jobDetail.rubric.dimensions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "该岗位没有可用的 rubric 维度。" }) : jobDetail.rubric.dimensions.map((dimension) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-criteria",
							"data-dim-key": dimension.key,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "rcw-dot rcw-dot-blue" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-criteriabody",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
									dimension.label,
									"（",
									dimension.key,
									"）"
								] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "rcw-dim rcw-tiny",
									style: { marginLeft: 6 },
									children: [
										dimension.kind,
										dimension.weight !== null ? ` · 权重 ${String(dimension.weight)}` : "",
										dimension.operator !== "" ? ` · ${dimension.operator}` : "",
										dimension.valuePreview !== "" ? ` · 阈值 ${dimension.valuePreview}` : ""
									]
								})]
							})]
						}, dimension.key)),
						jobDetail.requirementsMd !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 14 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "岗位要求（服务端 markdown 原文）"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceBox, {
								testid: "job-requirements",
								children: jobDetail.requirementsMd
							})]
						}) : null,
						jobDetail.descriptionMd !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: { marginTop: 14 },
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-cap",
								children: "岗位描述（服务端 markdown 原文）"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceBox, {
								testid: "job-description",
								children: jobDetail.descriptionMd
							})]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-subhead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "该岗位的申请" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-dim rcw-tiny",
								children: [jobDetail.applications.length, " 条"]
							})]
						}),
						jobDetail.applications.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "该岗位还没有申请。" }) : jobDetail.applications.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "rcw-fieldrow",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "rcw-fieldkey",
								children: [row.candidateName, row.jobTitle !== "" ? ` · ${row.jobTitle}` : ""]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "rcw-fieldval",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: chipClass(row.stageTone),
									children: row.stageLabel
								})
							})]
						}, row.rowKey))
					] }) : null
				]
			});
		}
		/** 右侧岗位侧栏：只把 OPEN / DRAFT 放进"正在招聘"，其余（归档/关闭/暂停）收进折叠区。 */
		function JobSidebar({ jobs, selectedJobId, onSelectJob }) {
			const { active, archived } = splitSidebarJobs(jobs);
			const renderRow = (job) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: `rcw-jobrow ${job.id === selectedJobId ? "rcw-jobrow-active" : ""}`.trim(),
				"data-testid": `job-row-${job.id}`,
				"data-selected": job.id === selectedJobId ? "true" : "false",
				onClick: () => onSelectJob(job.id),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "rcw-av",
						children: job.title.slice(0, 1)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "rcw-rowmain",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: job.title }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
							job.departmentName !== "" ? `${job.departmentName} · ` : "",
							job.applicationCounts.total,
							" 份申请 · ",
							job.applicationCounts.active,
							" 份推进中"
						] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
						tone: job.statusTone,
						children: job.statusLabel
					})
				]
			}, job.rowKey);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-asidecard",
				testid: "job-sidebar",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "正在招聘的岗位" }),
					active.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "当前没有在招 / 草案岗位。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-joblist",
						"data-testid": "active-job-list",
						children: active.map(renderRow)
					}),
					archived.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "rcw-disclosure",
						style: {
							marginTop: 10,
							padding: "10px 12px"
						},
						"data-testid": "archived-jobs",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [
							"已归档 / 已关闭岗位（",
							archived.length,
							"）"
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-joblist",
							style: { marginTop: 8 },
							children: archived.map(renderRow)
						})]
					}) : null
				]
			});
		}
		/** 需要你处理（只显示按 kind 的聚合计数；逐条结论在申请行 / 详情里各出现一次）。 */
		function AttentionCard({ overview }) {
			const totals = overview.nextStepTotals;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-asidecard",
				testid: "attention-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "需要你处理" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-kv",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-k",
							children: "需要人工处理"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-v",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: totals.human > 0 ? "amber" : "gray",
								testid: "attention-human",
								children: [totals.human, " 条"]
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-kv",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-k",
							children: "等待中"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-v",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: "gray",
								testid: "attention-wait",
								children: [totals.wait, " 条"]
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-kv",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-k",
							children: "进行中"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-v",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
								tone: "blue",
								testid: "attention-info",
								children: [totals.info, " 条"]
							})
						})]
					}),
					totals.missing > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "rcw-muted rcw-tiny",
						style: { marginTop: 8 },
						children: [
							"有 ",
							totals.missing,
							" 条申请没有服务端下一步（界面不推断）。"
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-muted rcw-tiny",
						style: { marginTop: 8 },
						children: "逐条结论只在申请行 / 申请详情出现一次，这里只给聚合计数。"
					})
				]
			});
		}
		/** 招聘概况（全部来自服务端 counts 聚合）。 */
		function CountsCard({ overview }) {
			const counts = overview.counts;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-asidecard",
				testid: "counts-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "招聘概况" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "岗位（招聘中 / 总数）",
						value: `${String(counts.jobsOpen)} / ${String(counts.jobsTotal)}`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "申请（推进中 / 总数）",
						value: `${String(counts.applicationsActive)} / ${String(counts.applicationsTotal)}`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "待初筛",
						value: String(counts.awaitingScreening)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "面试中",
						value: String(counts.interviewing)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "待决策",
						value: String(counts.awaitingDecision)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "已排期面试",
						value: String(counts.interviewsScheduled)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "面评份数（跨轮合计）",
						value: `${String(counts.scorecardsSubmittedTotal)} / ${String(counts.scorecardsRequiredTotal)}`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
						label: "Transcript（就绪 / 处理中）",
						value: `${String(counts.transcriptsReady)} / ${String(counts.transcriptsPending)}`
					}),
					counts.byStage.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "rcw-chiprow",
						style: { marginTop: 10 },
						children: counts.byStage.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
							tone: "gray",
							children: [
								row.label,
								" · ",
								row.count
							]
						}, row.code))
					}) : null
				]
			});
		}
		/** 招聘设置入口卡（只读数据；写入口可用性以服务端 settings.entry + action 为准）。 */
		function SettingsEntryCard({ overview, writeStateText, onOpenSettings }) {
			const { settings } = overview;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
				className: "rcw-asidecard",
				testid: "settings-entry",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "招聘设置" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-muted rcw-tiny",
						"data-testid": "settings-entry-note",
						"data-note": settings.entry.note !== "" ? settings.entry.note : void 0,
						children: settingsEntryNoteText(settings.entry)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { marginTop: 8 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "阶段目录版本",
								value: settings.stageCatalog !== null ? `v${String(settings.stageCatalog.versionNo)}` : ""
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "业务配置项",
								value: `${String(settings.configs.length)} 项`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "部门",
								value: `${String(settings.departments.length)} 个`
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
								label: "招聘团队",
								value: `${String(settings.hiringTeams.length)} 个`
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-inlineactions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-btn rcw-btn-soft",
							"data-testid": "open-settings-from-card",
							onClick: onOpenSettings,
							children: "打开招聘设置（create 表单）"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-pending",
							"data-testid": "settings-entry-write-state",
							children: writeStateText !== "" ? writeStateText : "设置写入口可用（role / team / pipeline 最小 create 表单）"
						})]
					}),
					settings.entry.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "rcw-tiny",
						style: { marginTop: 8 },
						"data-testid": "settings-entry-available",
						children: "设置页已可用。"
					}) : null
				]
			});
		}
		/** 设置视图：只读配置 + role / team / pipeline **最小 create 表单**（写操作只走服务端 action seam）。 */
		function SettingsPanel({ overview, onBack, writeDisabledReason, settingsBusy, onCreateSettings, actionOutcome, feedback }) {
			const settings = overview.settings;
			const [roleCode, setRoleCode] = (0, react.useState)("");
			const [roleName, setRoleName] = (0, react.useState)("");
			const [roleScopes, setRoleScopes] = (0, react.useState)("");
			const [teamCode, setTeamCode] = (0, react.useState)("");
			const [teamName, setTeamName] = (0, react.useState)("");
			const [teamDepartmentId, setTeamDepartmentId] = (0, react.useState)("");
			const [pipelineCode, setPipelineCode] = (0, react.useState)("");
			const [pipelineName, setPipelineName] = (0, react.useState)("");
			const settingsDisabled = writeDisabledReason !== "" || settingsBusy;
			const settingsAction = overview.actions.recruiting_settings_write;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-headline",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-headline-left",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "rcw-back",
							"data-testid": "settings-back",
							onClick: onBack,
							children: "← 返回招聘总览"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "rcw-cap",
							children: "RECRUITMENT CONFIGURATION · READ ONLY"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: "招聘设置" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-sub",
							children: settings.entry.note !== "" ? settings.entry.note : "只读展示当前生效的招聘配置。"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "rcw-headline-right",
					children: settings.stageCatalog !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
						tone: "blue",
						testid: "settings-catalog-version",
						children: [
							"阶段目录 v",
							String(settings.stageCatalog.versionNo),
							settings.stageCatalog.effectiveFromText !== "" ? ` · ${settings.stageCatalog.effectiveFromText} 生效` : ""
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
						tone: "gray",
						children: "无阶段目录"
					})
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-grid",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "rcw-main",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
							className: "rcw-detailmain",
							testid: "settings-write-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "设置写入口（新增角色 / 团队 / 流程模板）" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "rcw-muted rcw-tiny",
									style: { marginTop: 6 },
									children: "角色填 code / name / permission_scopes；团队填 code / name / department_id；流程模板填 code / name。 保存是否可用以服务端声明为准；不可用时按钮禁用并说明原因。本页只做新增， 修改 / 加成员 / 加阶段等操作没有表单（不假装覆盖）。"
								}),
								writeDisabledReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "rcw-pending",
									"data-testid": "settings-write-pending",
									children: writeDisabledReason
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "rcw-pending",
									"data-testid": "settings-write-pending-ok",
									children: "设置写入口可用；保存后页面会重新读取并显示服务端读回结果。"
								}),
								feedback !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: feedback.tone === "error" ? "rcw-alert" : "rcw-notice",
									role: feedback.tone === "error" ? "alert" : "status",
									"data-testid": "settings-feedback",
									"data-tone": feedback.tone,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: feedback.title }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: { marginTop: 6 },
											children: feedback.message
										}),
										feedback.rawBody !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
											"data-testid": "settings-feedback-raw",
											children: feedback.rawBody
										}) : null
									]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
									className: "rcw-writeform",
									"data-testid": "settings-role-form",
									onSubmit: (event) => {
										event.preventDefault();
										onCreateSettings("role", {
											code: roleCode.trim(),
											name: roleName.trim(),
											permission_scopes: roleScopes.split(/[\s,，;；]+/).map((scope) => scope.trim()).filter((scope) => scope !== "")
										});
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "新建角色（role create）" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "rcw-fields-grid",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "rcw-modalfield",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "code（2..41 大写）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "rcw-input",
													"data-testid": "settings-role-code",
													value: roleCode,
													disabled: settingsDisabled,
													onChange: (event) => setRoleCode(event.target.value)
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "rcw-modalfield",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "name（1..200）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "rcw-input",
													"data-testid": "settings-role-name",
													value: roleName,
													disabled: settingsDisabled,
													onChange: (event) => setRoleName(event.target.value)
												})]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "rcw-modalfield",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "permission_scopes（逗号分隔；服务端校验封闭枚举）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: "rcw-input",
												"data-testid": "settings-role-scopes",
												value: roleScopes,
												disabled: settingsDisabled,
												placeholder: "例如 JOB_READ,JOB_WRITE",
												onChange: (event) => setRoleScopes(event.target.value)
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "submit",
											className: "rcw-btn rcw-btn-blue",
											"data-testid": "settings-role-submit",
											disabled: settingsDisabled,
											title: writeDisabledReason !== "" ? writeDisabledReason : settingsAction?.seam,
											children: settingsBusy ? "提交中…" : "创建角色"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
									className: "rcw-writeform",
									"data-testid": "settings-team-form",
									onSubmit: (event) => {
										event.preventDefault();
										onCreateSettings("team", {
											code: teamCode.trim(),
											name: teamName.trim(),
											department_id: teamDepartmentId
										});
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "新建招聘团队（team create）" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "rcw-fields-grid",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "rcw-modalfield",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "code" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "rcw-input",
													"data-testid": "settings-team-code",
													value: teamCode,
													disabled: settingsDisabled,
													onChange: (event) => setTeamCode(event.target.value)
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "rcw-modalfield",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "name" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "rcw-input",
													"data-testid": "settings-team-name",
													value: teamName,
													disabled: settingsDisabled,
													onChange: (event) => setTeamName(event.target.value)
												})]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "rcw-modalfield",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "department_id（来自服务端 settings.departments）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												className: "rcw-select",
												"data-testid": "settings-team-department",
												value: teamDepartmentId,
												disabled: settingsDisabled,
												onChange: (event) => setTeamDepartmentId(event.target.value),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "",
													children: "（请选择部门）"
												}), settings.departments.map((department) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: department.id,
													children: department.name !== "" ? department.name : department.id
												}, department.id))]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "submit",
											className: "rcw-btn rcw-btn-blue",
											"data-testid": "settings-team-submit",
											disabled: settingsDisabled,
											title: writeDisabledReason !== "" ? writeDisabledReason : settingsAction?.seam,
											children: settingsBusy ? "提交中…" : "创建团队"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
									className: "rcw-writeform",
									"data-testid": "settings-pipeline-form",
									onSubmit: (event) => {
										event.preventDefault();
										onCreateSettings("pipeline", {
											code: pipelineCode.trim(),
											name: pipelineName.trim()
										});
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "新建招聘流程模板（pipeline create）" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "rcw-fields-grid",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "rcw-modalfield",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "code" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "rcw-input",
													"data-testid": "settings-pipeline-code",
													value: pipelineCode,
													disabled: settingsDisabled,
													onChange: (event) => setPipelineCode(event.target.value)
												})]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "rcw-modalfield",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "name" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "rcw-input",
													"data-testid": "settings-pipeline-name",
													value: pipelineName,
													disabled: settingsDisabled,
													onChange: (event) => setPipelineName(event.target.value)
												})]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "submit",
											className: "rcw-btn rcw-btn-blue",
											"data-testid": "settings-pipeline-submit",
											disabled: settingsDisabled,
											title: writeDisabledReason !== "" ? writeDisabledReason : settingsAction?.seam,
											children: settingsBusy ? "提交中…" : "创建流程模板"
										})
									]
								}),
								actionOutcome !== void 0 && actionOutcome.key === "recruiting_settings_write" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OutcomeReadbackCard, {
									outcome: actionOutcome,
									title: "设置写入读回（信封 readback；键名/值原样）",
									testid: "settings-write-readback"
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
							className: "rcw-detailmain",
							style: { marginTop: 14 },
							testid: "settings-stage-catalog",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-sectionhead",
								style: { marginTop: 0 },
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "阶段目录（stage catalog）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "rcw-dim rcw-tiny",
									children: settings.stageCatalog !== null ? `${String(settings.stageCatalog.stages.length)} 个阶段` : "未提供"
								})]
							}), settings.stageCatalog === null || settings.stageCatalog.stages.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "服务端没有返回阶段目录。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-tablewrap",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									className: "rcw-table",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "阶段码" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "名称" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "类型" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "顺序" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "v1 范围" })
									] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: settings.stageCatalog.stages.map((stage) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										"data-testid": `stage-row-${stage.code}`,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												className: "rcw-mono",
												children: stage.code
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: stage.label }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: stage.kind !== "" ? stage.kind : "—" }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: stage.order }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: stage.inV1Scope ? "是" : "否" })
										]
									}, stage.code)) })]
								})
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
							className: "rcw-detailmain",
							style: { marginTop: 14 },
							testid: "settings-configs",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-sectionhead",
								style: { marginTop: 0 },
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "业务配置（business_config 当前生效版本）" })
							}), settings.configs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "服务端没有返回业务配置。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "rcw-tablewrap",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									className: "rcw-table",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "config_key" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "作用域" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "版本" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "生效时间" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "payload 字段" })
									] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: settings.configs.map((config) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: "rcw-mono",
											children: config.configKey
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: config.scope }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: ["v", config.versionNo] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: config.effectiveFromText !== "" ? config.effectiveFromText : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: config.payloadKeys.length > 0 ? config.payloadKeys.join("、") : "—" })
									] }, `${config.configKey}-${config.scope}-${config.scopeId}`)) })]
								})
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
							className: "rcw-detailmain",
							style: { marginTop: 14 },
							testid: "settings-teams",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "rcw-sectionhead",
									style: { marginTop: 0 },
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "部门与招聘团队" })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "rcw-subhead",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "部门" })
								}),
								settings.departments.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "服务端没有返回部门。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "rcw-chiprow",
									children: settings.departments.map((department) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
										tone: "gray",
										children: department.name !== "" ? department.name : department.id
									}, department.id !== "" ? department.id : department.name))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "rcw-subhead",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "招聘团队" })
								}),
								settings.hiringTeams.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "服务端没有返回招聘团队。" }) : settings.hiringTeams.map((team) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "rcw-smallcard",
									style: { marginTop: 10 },
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [team.name !== "" ? team.name : team.code, team.code !== "" ? ` · ${team.code}` : ""] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: team.departmentName !== "" ? team.departmentName : "（未提供部门）" }),
										team.members.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "rcw-dim rcw-tiny",
											children: "该团队没有成员。"
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: { marginTop: 8 },
											children: team.members.map((member) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "rcw-fieldrow",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "rcw-fieldkey",
													children: [member.displayName, member.teamRole !== "" ? ` · ${member.teamRole}` : ""]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "rcw-fieldval rcw-mono",
													children: member.actorId !== "" ? member.actorId : "—"
												})]
											}, member.actorId !== "" ? member.actorId : member.displayName))
										})
									]
								}, team.id !== "" ? team.id : team.code))
							]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
					className: "rcw-aside",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						className: "rcw-asidecard",
						testid: "settings-aside-labels",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "数据来源" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ThreeDimBadges, {
								labels: overview.labels,
								testid: "settings-labels"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { marginTop: 8 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
										label: "评估时间",
										value: overview.evaluatedAtText
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
										label: "契约版本",
										value: overview.contractVersion
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(KeyValue, {
										label: "读取身份",
										value: overview.actor.displayName
									})
								]
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
						className: "rcw-asidecard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "只读说明" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "rcw-muted rcw-tiny",
							children: "本页只展示服务端返回的当前生效配置。保存动作由服务端执行；不可用时按钮禁用并说明原因， 不会只改本地显示、也不会用弹窗假装保存成功。"
						})]
					})]
				})]
			})] });
		}
		/**
		* 招聘工作区（W2）。
		*
		* 不读 localStorage；`sessionId`/`alias` 只来自 props。sessionId 仅作为 DOM 证据属性带出，
		* 不进入任何请求（身份由宿主插件配置决定）。
		* @param props - `{ sessionId, alias }`。
		* @returns 工作区 JSX。
		*/
		function RecruitingWorkspace(props) {
			const overview = useWorkspaceOverview();
			const [selectedJobId, setSelectedJobId] = (0, react.useState)("");
			const [selectedApplicationId, setSelectedApplicationId] = (0, react.useState)("");
			const [settingsOpen, setSettingsOpen] = (0, react.useState)(false);
			const [jobDetailOpen, setJobDetailOpen] = (0, react.useState)(false);
			const [filter, setFilter] = (0, react.useState)("all");
			const [pendingActionKey, setPendingActionKey] = (0, react.useState)("");
			const [feedback, setFeedback] = (0, react.useState)(void 0);
			const [actionOutcome, setActionOutcome] = (0, react.useState)(void 0);
			const [closeDialogOpen, setCloseDialogOpen] = (0, react.useState)(false);
			const [closeBusy, setCloseBusy] = (0, react.useState)(false);
			const [closeError, setCloseError] = (0, react.useState)("");
			const [closeRaw, setCloseRaw] = (0, react.useState)("");
			const [closeEnvelope, setCloseEnvelope] = (0, react.useState)(void 0);
			const [closeBodyText, setCloseBodyText] = (0, react.useState)("");
			const [jobDraft, setJobDraft] = (0, react.useState)(null);
			const [draftBusy, setDraftBusy] = (0, react.useState)(false);
			const [draftError, setDraftError] = (0, react.useState)("");
			const [draftRaw, setDraftRaw] = (0, react.useState)("");
			const [draftCreateBusy, setDraftCreateBusy] = (0, react.useState)(false);
			const [draftCreateError, setDraftCreateError] = (0, react.useState)("");
			const [draftCreateRaw, setDraftCreateRaw] = (0, react.useState)("");
			const [draftOutcome, setDraftOutcome] = (0, react.useState)(void 0);
			const jobs = overview.data?.jobs ?? [];
			const fallbackJob = jobs.find((job) => job.id !== "") ?? jobs[0];
			const effectiveJobId = selectedJobId !== "" && jobs.some((job) => job.id === selectedJobId) ? selectedJobId : fallbackJob?.id ?? "";
			const selectedJob = jobs.find((job) => job.id === effectiveJobId) ?? fallbackJob;
			const applicationDetail = useApplicationDetail(selectedApplicationId);
			const jobDetail = useJobDetail(jobDetailOpen ? effectiveJobId : "");
			const decisionFacts = useDecisionFacts(selectedApplicationId, selectedApplicationId !== "", props.sessionId);
			const isRecruiter = props.alias === "recruiter";
			const aliasNote = "当前是面试官视图：只读浏览；写操作请切换到「招聘方 Recruiter」身份后再进行。";
			const aliasBlocked = !isRecruiter;
			const closeSeam = useJobCloseSeam(props.sessionId, isRecruiter);
			const draftProbe = useRouteProbe(JOB_DRAFT_PATH, props.sessionId, isRecruiter);
			const createProbe = useRouteProbe(JOB_CREATE_PATH, props.sessionId, isRecruiter);
			const overviewActions = overview.data?.actions ?? {};
			const detailActions = applicationDetail.data !== void 0 && Object.keys(applicationDetail.data.actions).length > 0 ? applicationDetail.data.actions : overviewActions;
			/** 岗位关闭按钮的 disabled 原因（'' = 可用）。O6：只给 HR 人话，探针状态码留在代码/结构化状态里。 */
			const closePendingText = (() => {
				if (!isRecruiter) return aliasNote;
				if (closeSeam.loading) return "正在确认「关闭岗位」是否可用…";
				const probe = closeSeam.probe;
				if (probe === void 0) return "还在确认「关闭岗位」是否可用…";
				if (probe.state === "AVAILABLE") return "";
				if (probe.state === "MISSING") return "「关闭岗位」暂不可用：当前页面版本没有提供这个操作（不需要你再做什么）。";
				if (probe.state === "FORBIDDEN") return "「关闭岗位」未获授权：当前页面不能执行该操作，请联系管理员。";
				return "暂时确认不了「关闭岗位」是否可用，请稍后重试。";
			})();
			/** 岗位草案生成按钮的 disabled 原因（'' = 可用）。 */
			const draftPendingText = (() => {
				if (!isRecruiter) return aliasNote;
				if (draftProbe.loading) return "正在确认「生成草案」是否可用…";
				if (draftProbe.state === "AVAILABLE") return "";
				if (draftProbe.state === "MISSING") return "「生成草案」暂不可用：当前页面版本没有提供这个操作（不需要你再做什么）。";
				return "暂时确认不了「生成草案」是否可用，请稍后重试。";
			})();
			/** 岗位确认创建按钮的 disabled 原因（'' = 可用）。 */
			const createPendingText = (() => {
				if (!isRecruiter) return aliasNote;
				if (createProbe.loading) return "正在确认「确认创建岗位」是否可用…";
				if (createProbe.state === "AVAILABLE") return "";
				if (createProbe.state === "MISSING") return "「确认创建岗位」暂不可用：当前页面版本没有提供这个操作（不需要你再做什么）。";
				return "暂时确认不了「确认创建岗位」是否可用，请稍后重试。";
			})();
			/** Rubric 批准 disabled 原因（'' = 可用；版本 id 空或已批准 → disabled，不编造版本）。 */
			const rubricAction = overviewActions.rubric_approve;
			const rubricJob = jobDetailOpen && jobDetail.data !== void 0 ? jobDetail.data.job : selectedJob;
			const rubricJobId = rubricJob?.id ?? selectedJob?.id ?? "";
			const rubricVersionId = rubricJob?.rubric?.rubricVersionId ?? "";
			const rubricApproved = rubricJob?.rubric?.approved === true || jobDetailOpen && jobDetail.data?.rubric?.approved === true;
			const rubricPendingText = (() => {
				if (!isRecruiter) return aliasNote;
				if (rubricAction === void 0) return "当前页面版本没有提供「批准 Rubric」操作。";
				if (!rubricAction.available) return rubricAction.reasonText !== "" ? rubricAction.reasonText : "暂时不能批准评分标准。";
				if (rubricJobId === "") return "还没有选中岗位，暂时不能批准评分标准。";
				if (rubricVersionId === "") return "服务端没有返回当前评分标准的版本，无法批准（界面不会猜一个版本）。";
				if (rubricApproved) return "当前评分标准已批准，无需重复批准。";
				return "";
			})();
			/** 设置写入口 disabled 原因（以服务端 settings.entry.available 与 action 可用性为准）。 */
			const settingsAction = overviewActions.recruiting_settings_write;
			const settingsWriteDisabledReason = (() => {
				if (!isRecruiter) return aliasNote;
				if (overview.data === void 0) return "招聘设置需要先成功读取工作区数据。";
				if (!overview.data.settings.entry.available) return "服务端声明设置页暂不可用（当前只读）；页面不会假装保存成功。";
				if (settingsAction === void 0) return "当前页面版本没有提供「保存设置」操作。";
				if (!settingsAction.available) return settingsAction.reasonText !== "" ? settingsAction.reasonText : "暂时不能保存设置。";
				return "";
			})();
			/** 写动作统一入口：仅在表单 build* 通过后才调用；成功只设 outcome + reload，不用本地状态当成功。 */
			const runAction = async (action, request) => {
				setPendingActionKey(action.key);
				setFeedback(void 0);
				const outcome = await postActionSeam(action, request, props.sessionId);
				setActionOutcome(outcome);
				if (!outcome.accepted) {
					setFeedback({
						tone: "error",
						title: `写动作「${action.label}」未被服务端受理（HTTP ${String(outcome.status)}）`,
						message: outcome.error !== null ? outcome.error.message : "服务端没有返回错误详情",
						rawBody: outcome.error !== null && outcome.error.rawBody !== "" ? outcome.error.rawBody : outcome.bodyText
					});
					setPendingActionKey("");
					return;
				}
				setFeedback({
					tone: "ok",
					title: `服务端已受理「${action.label}」（HTTP ${String(outcome.status)}）`,
					message: "成功事实只信响应信封 readback + 重新 GET 的服务端投影；界面不用本地状态当成功。",
					rawBody: ""
				});
				overview.reload();
				applicationDetail.reload();
				jobDetail.reload();
				setPendingActionKey("");
			};
			/** Rubric 批准：body 由 `buildRubricApproveBody` 产出（预检失败不发请求）。 */
			const approveRubric = () => {
				if (rubricAction === void 0) return;
				const built = buildRubricApproveBody({
					jobId: rubricJobId,
					rubricVersionId
				});
				if (!built.ok) {
					setFeedback({
						tone: "error",
						title: "Rubric 批准未发送：表单预检未通过",
						message: `${built.reasonCode}：${built.reasonText}${built.missing.length > 0 ? `；缺少：${built.missing.join("、")}` : ""}`,
						rawBody: ""
					});
					return;
				}
				runAction(rubricAction, built.body);
			};
			/** 打开岗位关闭弹窗（零请求；真正 POST 只在 onConfirm 后）。 */
			const openCloseDialog = () => {
				setCloseError("");
				setCloseRaw("");
				setCloseDialogOpen(true);
			};
			/** 取消关闭：只关弹窗，**零请求**、零写入。 */
			const cancelCloseDialog = () => {
				setCloseDialogOpen(false);
				setCloseError("");
				setCloseRaw("");
				setCloseBusy(false);
			};
			/** 人类确认关闭 → POST job/close → 显示信封 terminated 计数 + 重新 GET（不先改本地状态）。 */
			const confirmCloseJob = async (reason) => {
				const jobId = selectedJob?.id ?? "";
				if (jobId === "") {
					setCloseError("还没有选中岗位，未发送关闭请求");
					return;
				}
				setCloseBusy(true);
				setCloseError("");
				setCloseRaw("");
				setCloseEnvelope(void 0);
				setCloseBodyText("");
				const outcome = await postJobClose(jobId, reason, props.sessionId);
				setCloseBusy(false);
				if (!outcome.accepted) {
					setCloseError(outcome.error !== null ? outcome.error.message : `服务端返回 HTTP ${String(outcome.status)}（没有错误详情）`);
					setCloseRaw(outcome.error !== null && outcome.error.rawBody !== "" ? outcome.error.rawBody : outcome.bodyText);
					return;
				}
				const envelope = parseJobCloseEnvelope(outcome.bodyText);
				setCloseBodyText(outcome.bodyText);
				setCloseEnvelope(envelope === null ? void 0 : envelope);
				setCloseDialogOpen(false);
				if (envelope === null) setCloseError("服务端返回 2xx，但响应不是 job/close 信封（见原文）；界面不推断关闭结果。");
				overview.reload();
				jobDetail.reload();
				setFeedback({
					tone: "ok",
					title: "岗位关闭已被服务端受理（请读信封 terminated 计数）",
					message: "已重新 GET overview 与岗位详情；本地没有先把岗位状态改成已关闭。",
					rawBody: ""
				});
			};
			/** 设置 create（role/team/pipeline）：封闭字段由 `buildSettingsWriteBody` 校验，预检失败不发请求。 */
			const runSettingsCreate = (entity, fields) => {
				if (settingsAction === void 0) {
					setFeedback({
						tone: "error",
						title: "设置写入未发送",
						message: "当前页面版本没有提供「保存招聘设置」操作",
						rawBody: ""
					});
					return;
				}
				const built = buildSettingsWriteBody({
					entity,
					operation: "create",
					fields
				});
				if (!built.ok) {
					setFeedback({
						tone: "error",
						title: `设置 create（${entity}）未发送：表单预检未通过`,
						message: `${built.reasonCode}：${built.reasonText}${built.missing.length > 0 ? `；缺少：${built.missing.join("、")}` : ""}`,
						rawBody: ""
					});
					return;
				}
				runAction(settingsAction, built.body);
			};
			/** 生成岗位草案（POST job/draft，只读）：成功渲染服务端草案；不编造内容。 */
			const generateJobDraft = async (requestText) => {
				setDraftBusy(true);
				setDraftError("");
				setDraftRaw("");
				setDraftOutcome(void 0);
				setDraftCreateError("");
				setDraftCreateRaw("");
				setJobDraft(null);
				const built = buildJobDraftBody({ requestText });
				if (!built.ok) {
					setDraftError(`${built.reasonCode}：${built.reasonText}`);
					setDraftBusy(false);
					return;
				}
				const outcome = await postJobDraft(built.body, props.sessionId);
				setDraftBusy(false);
				if (!outcome.accepted) {
					setDraftError(outcome.error !== null ? outcome.error.message : `HTTP ${String(outcome.status)}`);
					setDraftRaw(outcome.error !== null && outcome.error.rawBody !== "" ? outcome.error.rawBody : outcome.bodyText);
					return;
				}
				const parsed = parseJsonObject(outcome.bodyText);
				const view = parsed === null ? null : normalizeJobDraftResponse(parsed);
				if (view === null) {
					setDraftError("服务端返回 2xx，但草案响应无法归一化（见原文）；不编造草案内容。");
					setDraftRaw(outcome.bodyText);
					return;
				}
				setJobDraft(view);
			};
			/** 人改后确认创建（POST job/create）：criteria 来自草案 rubric 维度；服务端校验失败原样展示。 */
			const createJobFromDraft = async (input) => {
				setDraftCreateBusy(true);
				setDraftCreateError("");
				setDraftCreateRaw("");
				setDraftOutcome(void 0);
				const built = buildJobCreateBody(input);
				if (!built.ok) {
					setDraftCreateError(`${built.reasonCode}：${built.reasonText}${built.missing.length > 0 ? `；缺少：${built.missing.join("、")}` : ""}`);
					setDraftCreateBusy(false);
					return;
				}
				const outcome = await postJobCreate(built.body, props.sessionId);
				setDraftOutcome(outcome);
				setDraftCreateBusy(false);
				if (!outcome.accepted) {
					setDraftCreateError(outcome.error !== null ? outcome.error.message : `HTTP ${String(outcome.status)}`);
					setDraftCreateRaw(outcome.error !== null && outcome.error.rawBody !== "" ? outcome.error.rawBody : outcome.bodyText);
					return;
				}
				overview.reload();
			};
			/** 执行初筛评估（A 的 `POST /decision/screening/evaluate`）：成功 reload facts + overview + 详情。 */
			const runScreeningEvaluate = async () => {
				const applicationId = selectedApplicationId;
				if (applicationId === "") return;
				setFeedback(void 0);
				const outcome = await postScreeningEvaluate(applicationId, props.sessionId);
				setActionOutcome(outcome);
				if (!outcome.accepted) setFeedback({
					tone: "error",
					title: `执行初筛评估未被服务端受理（HTTP ${String(outcome.status)}）`,
					message: outcome.error !== null ? outcome.error.message : "服务端没有返回错误详情",
					rawBody: outcome.error !== null && outcome.error.rawBody !== "" ? outcome.error.rawBody : outcome.bodyText
				});
				else setFeedback({
					tone: "ok",
					title: `初筛评估已受理（HTTP ${String(outcome.status)}）`,
					message: "已重新 GET decision facts / overview / 申请详情；成功事实以 readback + 重新 GET 为准。",
					rawBody: ""
				});
				decisionFacts.reload();
				overview.reload();
				applicationDetail.reload();
			};
			/** 记录正式决策（A 的 facade：body 由详情页 `buildDecisionRecordBody` 产出，不由 UI 发明 hash）。 */
			const runDecisionRecord = async (request) => {
				setFeedback(void 0);
				const outcome = await postDecisionRecordFacade(request, props.sessionId);
				setActionOutcome(outcome);
				if (!outcome.accepted) setFeedback({
					tone: "error",
					title: `记录决策未被服务端受理（HTTP ${String(outcome.status)}）`,
					message: outcome.error !== null ? outcome.error.message : "服务端没有返回错误详情",
					rawBody: outcome.error !== null && outcome.error.rawBody !== "" ? outcome.error.rawBody : outcome.bodyText
				});
				else setFeedback({
					tone: "ok",
					title: `决策记录已受理（HTTP ${String(outcome.status)}）`,
					message: "已重新 GET decision facts / overview / 申请详情；成功事实以 readback + 重新 GET 为准。",
					rawBody: ""
				});
				decisionFacts.reload();
				overview.reload();
				applicationDetail.reload();
			};
			const openApplication = (applicationId) => {
				setSelectedApplicationId(applicationId);
				setFeedback(void 0);
			};
			const backToOverview = () => {
				setSelectedApplicationId("");
				setFeedback(void 0);
			};
			const openJobFromDetail = () => {
				const jobId = applicationDetail.data?.header.jobId ?? "";
				if (jobId !== "") setSelectedJobId(jobId);
				setSelectedApplicationId("");
				setJobDetailOpen(true);
			};
			const overviewData = overview.data;
			const rows = overviewData?.applications ?? [];
			const rowsForJob = rows.filter((row) => effectiveJobId === "" || row.jobId === effectiveJobId);
			const rowsForFilter = rowsForJob.filter((row) => filter === "all" || row.filterKind === filter);
			const filterCounts = {
				all: rowsForJob.length,
				screening: rowsForJob.filter((row) => row.filterKind === "screening").length,
				interviewing: rowsForJob.filter((row) => row.filterKind === "interviewing").length,
				other: rowsForJob.filter((row) => row.filterKind === "other").length
			};
			const siblingRows = rows.filter((row) => row.id !== selectedApplicationId && row.candidateId !== "" && row.candidateId === applicationDetail.data?.header.candidateId);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "rcw-root",
				"data-testid": "recruiting-workspace",
				"data-view": "recruiting",
				"data-alias": props.alias,
				"data-session-id": props.sessionId !== "" ? props.sessionId : void 0,
				style: ROOT_STYLE,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: RECRUITING_CSS }, STYLE_ELEMENT_KEY),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "rcw-content",
						children: [aliasBlocked ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "rcw-notice",
							"data-testid": "alias-notice",
							role: "status",
							children: aliasNote
						}) : null, selectedApplicationId === "" && settingsOpen ? overviewData !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsPanel, {
							overview: overviewData,
							onBack: () => setSettingsOpen(false),
							writeDisabledReason: settingsWriteDisabledReason,
							settingsBusy: pendingActionKey === "recruiting_settings_write",
							onCreateSettings: runSettingsCreate,
							actionOutcome,
							feedback
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
							className: "rcw-detailmain",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: "招聘设置需要先成功读取工作区投影（overview）。" })
						}) : selectedApplicationId !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApplicationDetail, {
							row: rows.find((row) => row.id === selectedApplicationId),
							detail: applicationDetail.data,
							loading: applicationDetail.loading,
							error: applicationDetail.error,
							onRetry: applicationDetail.reload,
							onRefresh: applicationDetail.reload,
							refreshing: applicationDetail.loading,
							onBack: backToOverview,
							actions: detailActions,
							pendingActionKey,
							onRunAction: runAction,
							aliasBlocked,
							aliasNote,
							settings: overviewData?.settings,
							actionOutcome,
							decisionFacts: decisionFacts.facts,
							decisionFactsProbe: decisionFacts.probe,
							onScreeningEvaluate: () => void runScreeningEvaluate(),
							onDecisionRecord: (request) => void runDecisionRecord(request),
							siblings: siblingRows,
							onOpenApplication: openApplication,
							onOpenJob: openJobFromDetail
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-headline",
								"data-testid": "overview-headline",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "rcw-headline-left",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "rcw-cap",
											children: "AGENT-NATIVE RECRUITMENT"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: "招聘总览" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "rcw-sub",
											children: "招聘全流程的只读视图；写操作会先让你确认再执行。"
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "rcw-headline-right",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "rcw-btn",
											"data-testid": "refresh-overview",
											disabled: overview.loading,
											onClick: overview.reload,
											children: overview.loading ? "正在读取…" : "刷新"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "rcw-btn rcw-btn-soft",
											"data-testid": "open-settings",
											onClick: () => setSettingsOpen(true),
											children: "招聘设置"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											tone: isRecruiter ? "blue" : "amber",
											testid: "alias-chip",
											children: ["当前身份 · ", isRecruiter ? "招聘方 Recruiter" : props.alias === "interviewer_a" ? "面试官 A（只读）" : "面试官 B（只读）"]
										})
									]
								})]
							}),
							overview.error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorAlert, {
								title: "招聘工作区读取失败",
								message: overview.error.message,
								rawBody: overview.error.rawBody,
								onRetry: overview.reload
							}) : null,
							overview.loading && overviewData === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "rcw-loading",
								"data-testid": "overview-loading",
								children: "正在读取招聘工作区…"
							}) : null,
							overviewData !== void 0 && !overviewData.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-notice",
								"data-testid": "overview-unconfigured",
								children: ["数据库未配置，读不到真实招聘数据", overviewData.issues.length > 0 ? `（缺少：${overviewData.issues.join("；")}）` : ""]
							}) : null,
							overviewData !== void 0 && overviewData.configured && overviewData.issues.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-notice",
								"data-testid": "overview-issues",
								children: ["配置问题：", overviewData.issues.join("；")]
							}) : null,
							feedback !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: feedback.tone === "error" ? "rcw-alert" : "rcw-notice",
								role: feedback.tone === "error" ? "alert" : "status",
								"data-testid": "action-feedback",
								"data-tone": feedback.tone,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: feedback.title }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: { marginTop: 6 },
										children: feedback.message
									}),
									feedback.rawBody !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
										"data-testid": "action-feedback-raw",
										children: feedback.rawBody
									}) : null
								]
							}) : null,
							overviewData !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "rcw-grid",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "rcw-main",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobHero, {
											job: selectedJob,
											jobs: overviewData.jobs,
											overview: overviewData,
											onSelectJob: (jobId) => {
												setSelectedJobId(jobId);
												setJobDetailOpen(false);
											},
											onToggleJobDetail: () => setJobDetailOpen((value) => !value),
											jobDetailOpen,
											rubricPendingText,
											rubricBusy: pendingActionKey === "rubric_approve",
											onApproveRubric: approveRubric,
											closePendingText,
											closeBusy,
											onOpenClose: openCloseDialog,
											onOpenSettings: () => setSettingsOpen(true)
										}),
										actionOutcome !== void 0 && actionOutcome.key === "rubric_approve" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OutcomeReadbackCard, {
											outcome: actionOutcome,
											title: "Rubric 批准读回（信封 readback：approval / rubric / job）",
											testid: "rubric-approve-readback"
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CloseJobResultCard, {
											envelope: closeEnvelope,
											jobId: selectedJob?.id ?? "",
											error: closeError,
											errorRaw: closeRaw,
											bodyText: closeBodyText
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobDraftCard, {
											draftProbeReason: draftPendingText,
											createProbeReason: createPendingText,
											draft: jobDraft,
											draftBusy,
											createBusy: draftCreateBusy,
											draftError,
											draftRaw,
											createError: draftCreateError,
											createRaw: draftCreateRaw,
											createOutcome: draftOutcome,
											departments: overviewData.settings.departments,
											onGenerate: (requestText) => void generateJobDraft(requestText),
											onCreate: (input) => void createJobFromDraft(input)
										}),
										jobDetailOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobDetailCard, {
											jobDetail: jobDetail.data,
											loading: jobDetail.loading,
											error: jobDetail.error,
											onRetry: jobDetail.reload,
											onClose: () => setJobDetailOpen(false)
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHead, {
											title: "此岗位下的候选人",
											note: `共 ${String(rowsForJob.length)} 条申请 · 显示 ${String(rowsForFilter.length)} 条`,
											right: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "rcw-dim rcw-tiny",
												children: "点击行查看申请详情（结论 + 渐进展开证据）"
											})
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "rcw-filterbar",
											"data-testid": "application-filters",
											children: [
												["all", "全部"],
												["screening", "待初筛"],
												["interviewing", "面试中"],
												["other", "其他"]
											].map(([value, label]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: `rcw-filter ${filter === value ? "rcw-filter-active" : ""}`.trim(),
												"data-testid": `filter-${value}`,
												"data-active": filter === value ? "true" : "false",
												onClick: () => setFilter(value),
												children: [
													label,
													"（",
													filterCounts[value],
													"）"
												]
											}, value))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
											className: "rcw-list",
											testid: "application-list",
											children: rowsForFilter.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, { children: rowsForJob.length === 0 ? "该岗位还没有申请。" : "当前筛选下没有申请。" }) : rowsForFilter.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ApplicationRow, {
												row,
												jobRubric: selectedJob?.rubric ?? null,
												onOpen: openApplication
											}, row.rowKey))
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
									className: "rcw-aside",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobSidebar, {
											jobs: overviewData.jobs,
											selectedJobId: effectiveJobId,
											onSelectJob: setSelectedJobId
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AttentionCard, { overview: overviewData }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CountsCard, { overview: overviewData }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsEntryCard, {
											overview: overviewData,
											writeStateText: settingsWriteDisabledReason,
											onOpenSettings: () => setSettingsOpen(true)
										})
									]
								})]
							}) : null
						] })]
					}),
					closeDialogOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CloseJobDialog, {
						jobTitle: selectedJob?.title ?? "",
						busy: closeBusy,
						error: closeError !== "" && closeRaw !== "" ? `${closeError}\n\n服务端原文：\n${closeRaw}` : closeError,
						onConfirm: (reason) => void confirmCloseJob(reason),
						onCancel: cancelCloseDialog
					}) : null
				]
			});
		}
		// src/client/interviewer/round.ts
		/** 旧端点（两键都缺）的固定文案：明确"不伪造本轮重点"。 */
		const ROUND_SERVER_FIELDS_MISSING_TEXT = "服务端未提供轮次配置（task-50 端点未就绪）→ JOB_BASE 降级，不伪造本轮重点";
		/** fail-closed 的固定文案（W3B-CONTRACT §4.2 逐字）。 */
		const ROUND_SCHEMA_MISMATCH_TEXT = "本轮评分表与面评表单 spec 不一致，已 fail-closed（不写库）";
		/** 来源文案表（W3B-CONTRACT §3 逐字）。 */
		const ROUND_SOURCE_TEXT = {
			ROUND_CONFIG: "轮次配置（本场有专属考察重点与评分表覆盖）",
			ROUND_OVERRIDE: "轮次覆盖（本轮评分表在岗位底座上有覆盖）",
			JOB_BASE: "岗位基础（JOB_BASE 降级：服务端未提供该轮配置）",
			TEMPLATE: "面试模板（旧 brief，非轮次配置）"
		};
		/** 旧端点降级的来源文案（两键都缺；与普通 JOB_BASE 区分，说明 task-50 未就绪）。 */
		const ROUND_OLD_ENDPOINT_SOURCE_TEXT = "岗位基础（JOB_BASE 降级：服务端未提供轮次配置，task-50 端点未就绪）";
		/** 取一个对象；null / 数组 / 非对象一律降级为空对象。 */
		function asRecord$1(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		}
		/** 是否是一个"可用对象"（null/数组/标量都不算服务端给了配置）。 */
		function isRecord(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value);
		}
		/** 取一个字符串；非字符串降级为 ''（坏类型不伪装成业务值）。 */
		function asText$1(value) {
			return typeof value === "string" ? value.trim() : "";
		}
		/** 取一个有限数字；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
		function asFiniteNumber$1(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}
		/** 取一个非负整数；否则 0。 */
		function asCount$1(value) {
			const number = asFiniteNumber$1(value);
			return number >= 0 ? Math.trunc(number) : 0;
		}
		/** 只认严格 true。 */
		function asBool$1(value) {
			return value === true;
		}
		/** 字符串数组归一化（丢弃非字符串/空串；上限 100 项）。 */
		function asStringArray$1(value, limit = 100) {
			if (!Array.isArray(value)) return [];
			const out = [];
			for (const item of value) {
				if (out.length >= limit) break;
				const text = asText$1(item);
				if (text !== "") out.push(text);
			}
			return out;
		}
		/** 归一化一条 `focus_dimensions[]`。 */
		function normalizeFocusDimensions(value) {
			const out = [];
			if (!Array.isArray(value)) return out;
			for (const item of value.slice(0, 100)) {
				const raw = asRecord$1(item);
				const key = asText$1(raw.key);
				const label = asText$1(raw.label) || key;
				if (key === "" && label === "") continue;
				out.push({
					key,
					label: label !== "" ? label : key,
					weight: asFiniteNumber$1(raw.weight),
					required: asBool$1(raw.required),
					inRubric: asBool$1(raw.in_rubric)
				});
			}
			return out;
		}
		/** 归一化一条 `questions[]`（text 必填；key 可为 null → ''）。 */
		function normalizeQuestions(value) {
			const out = [];
			if (!Array.isArray(value)) return out;
			for (const item of value.slice(0, 100)) {
				const text = typeof item === "string" ? asText$1(item) : asText$1(asRecord$1(item).text);
				if (text === "") continue;
				out.push({
					key: typeof item === "string" ? "" : asText$1(asRecord$1(item).key),
					text
				});
			}
			return out;
		}
		/** 归一化 `scorecard_fields[]` / `scorecard.fields[]`（同形）。 */
		function normalizeScorecardFields(value) {
			const out = [];
			if (!Array.isArray(value)) return out;
			for (const item of value.slice(0, 100)) {
				const raw = asRecord$1(item);
				const key = asText$1(raw.key);
				const label = asText$1(raw.label) || key;
				if (key === "" && label === "") continue;
				out.push({
					key,
					label: label !== "" ? label : key,
					kind: asText$1(raw.kind),
					required: asBool$1(raw.required)
				});
			}
			return out;
		}
		/** 归一化 `effective_rubric.dimensions[]`（key 为空的行丢弃：没有键就无法对齐面评）。 */
		function normalizeEffectiveDimensions(value) {
			const out = [];
			if (!Array.isArray(value)) return out;
			for (const item of value.slice(0, 100)) {
				const raw = asRecord$1(item);
				const key = asText$1(raw.key);
				if (key === "") continue;
				out.push({
					key,
					label: asText$1(raw.label) || key,
					kind: asText$1(raw.kind),
					weight: asFiniteNumber$1(raw.weight),
					required: asBool$1(raw.required),
					focus: asBool$1(raw.focus),
					mustCover: asBool$1(raw.must_cover),
					origin: asText$1(raw.origin),
					question: asText$1(raw.question)
				});
			}
			return out;
		}
		/** 空轮次重点（`round_no` 用面试行的轮次；source='' 表示服务端没给）。 */
		function emptyRoundFocus(roundNo = 0) {
			return {
				available: false,
				source: "",
				round_no: asCount$1(roundNo),
				title: "",
				description: "",
				reason: "",
				templateVersionId: "",
				templateVersionNo: 0,
				templatePayloadHash: "",
				focusDimensions: [],
				questions: [],
				scorecardFields: []
			};
		}
		/** 空生效评分表（0/0 scale = 服务端没给；不显示 `0–0`）。 */
		function emptyEffectiveRubric(roundNo = 0) {
			return {
				available: false,
				source: "",
				round_no: asCount$1(roundNo),
				jobId: "",
				rubricVersionId: "",
				rubricVersionNo: 0,
				rubricPayloadHash: "",
				baseRubricVersionId: "",
				templateVersionId: "",
				templateVersionNo: 0,
				declaredRoundRubricVersionId: "",
				dimensions: [],
				scaleMin: 0,
				scaleMax: 0,
				scorecardFields: [],
				submissionRubricVersionId: "",
				submissionDimensionKeys: [],
				reason: ""
			};
		}
		/**
		* 归一化 `round_focus`（服务端字段名逐字来自 task-50 冻结口径）。
		* @param value - 服务端原始 `round_focus`。
		* @returns 安全投影；未知字段值原样保留（''/0/[]，不猜、不补默认文案）。
		*/
		function normalizeRoundFocus(value) {
			const raw = asRecord$1(value);
			return {
				available: asBool$1(raw.available),
				source: asText$1(raw.source),
				round_no: asCount$1(raw.round_no),
				title: asText$1(raw.title),
				description: asText$1(raw.description),
				reason: asText$1(raw.reason),
				templateVersionId: asText$1(raw.template_version_id),
				templateVersionNo: asCount$1(raw.template_version_no),
				templatePayloadHash: asText$1(raw.template_payload_hash),
				focusDimensions: normalizeFocusDimensions(raw.focus_dimensions),
				questions: normalizeQuestions(raw.questions),
				scorecardFields: normalizeScorecardFields(raw.scorecard_fields)
			};
		}
		/**
		* 归一化 `effective_rubric`（服务端字段名逐字来自 task-50 冻结口径）。
		* @param value - 服务端原始 `effective_rubric`。
		* @returns 安全投影（scale 缺失时 0/0；submission 只供展示/核对，提交仍走 W1）。
		*/
		function normalizeEffectiveRubric(value) {
			const raw = asRecord$1(value);
			const scorecard = asRecord$1(raw.scorecard);
			const scale = asRecord$1(scorecard.scale);
			const submission = asRecord$1(raw.submission);
			return {
				available: asBool$1(raw.available),
				source: asText$1(raw.source),
				round_no: asCount$1(raw.round_no),
				jobId: asText$1(raw.job_id),
				rubricVersionId: asText$1(raw.rubric_version_id),
				rubricVersionNo: asCount$1(raw.rubric_version_no),
				rubricPayloadHash: asText$1(raw.rubric_payload_hash),
				baseRubricVersionId: asText$1(raw.base_rubric_version_id),
				templateVersionId: asText$1(raw.template_version_id),
				templateVersionNo: asCount$1(raw.template_version_no),
				declaredRoundRubricVersionId: asText$1(raw.declared_round_rubric_version_id),
				dimensions: normalizeEffectiveDimensions(raw.dimensions),
				scaleMin: asCount$1(scale.min),
				scaleMax: asCount$1(scale.max),
				scorecardFields: normalizeScorecardFields(scorecard.fields),
				submissionRubricVersionId: asText$1(submission.rubric_version_id),
				submissionDimensionKeys: asStringArray$1(submission.dimension_keys, 100),
				reason: asText$1(raw.reason)
			};
		}
		/** 旧 `row.rubric.dimensions` → effective 维度宇宙（JOB_BASE 底座；不伪造 focus/must_cover）。 */
		function legacyRubricDimensions(legacy) {
			if (legacy === null) return [];
			return legacy.dimensions.map((dimension) => ({
				key: dimension.key,
				label: dimension.label,
				kind: dimension.kind,
				weight: dimension.weight,
				required: true,
				focus: false,
				mustCover: false,
				origin: "JOB_BASE",
				question: dimension.question
			}));
		}
		/** 用旧 `row.rubric` 合成 JOB_BASE 评分表（服务端没给 effective schema 时的唯一诚实来源）。 */
		function legacyRubricFallback(legacy, roundNo, reason) {
			const dimensions = legacyRubricDimensions(legacy);
			return {
				...emptyEffectiveRubric(roundNo),
				available: dimensions.length > 0,
				source: "JOB_BASE",
				jobId: legacy !== null ? legacy.job_id : "",
				rubricVersionId: legacy !== null ? legacy.rubric_version_id : "",
				rubricPayloadHash: legacy !== null ? legacy.payload_hash : "",
				dimensions,
				reason: reason !== "" ? reason : dimensions.length === 0 ? "服务端未提供评分维度（不伪造）" : ""
			};
		}
		/** 取 options 里的旧 rubric（两种键名都接受，避免并行写入方的键名差异导致构建失败）。 */
		function optionsLegacyRubric(options) {
			if (options.legacyRubric !== void 0) return options.legacyRubric;
			return options.rubric !== void 0 ? options.rubric : null;
		}
		/**
		* 归一化并投影一场面试的轮次有效评分标准（`InterviewRow.round`）。
		*
		* 优先级（W3B-CONTRACT §3）：
		*   1. 两键都在 → 逐字段归一化；
		*   2. `round_focus.available=false` → focus 降级（保留服务端 reason/source），维度用 effective_rubric；
		*   3. 只有 effective_rubric → focus 降级，source 以 effective_rubric.source 为准；
		*   4. 两键都缺（旧端点）→ `serverFieldsMissing=true` + focus.source='JOB_BASE'，维度回退旧 row.rubric；
		*   5. declared rubric 与 base 冲突 → `conflict=true`，**维度宇宙不变**（不自行换版本）；
		*   6. `round_focus.round_no` ≠ 面试 `round_no` → 不套用轮次重点（`conflict=true`），只显示降级卡。
		* @param value - 服务端原始面试行（用来判断两个键是否存在）。
		* @param options - 面试行 round_no + 旧 rubric。
		* @returns 轮次有效投影（绝不抛错）。
		*/
		function normalizeRoundEffective(value, options) {
			const raw = asRecord$1(value);
			const roundNo = asCount$1(options.roundNo);
			const legacyRubric = optionsLegacyRubric(options);
			const hasFocus = isRecord(raw.round_focus);
			const hasRubric = isRecord(raw.effective_rubric);
			const conflictReasons = [];
			if (!hasFocus && !hasRubric) return {
				focus: {
					...emptyRoundFocus(roundNo),
					source: "JOB_BASE",
					reason: ROUND_SERVER_FIELDS_MISSING_TEXT
				},
				rubric: legacyRubricFallback(legacyRubric, roundNo, ROUND_SERVER_FIELDS_MISSING_TEXT),
				serverFieldsMissing: true,
				conflict: false,
				conflictReason: ""
			};
			let rubric = hasRubric ? normalizeEffectiveRubric(raw.effective_rubric) : emptyEffectiveRubric(roundNo);
			let focus = hasFocus ? normalizeRoundFocus(raw.round_focus) : emptyRoundFocus(roundNo);
			if (!hasFocus) {
				const source = rubric.source;
				focus = {
					...emptyRoundFocus(roundNo),
					available: false,
					source,
					reason: "服务端未提供 round_focus（仅有 effective_rubric）→ 本轮重点如实降级；评分维度取自 effective_rubric（不伪造轮次重点）"
				};
			}
			if (!hasRubric) rubric = legacyRubricFallback(legacyRubric, roundNo, "服务端未提供 effective_rubric（仅有 round_focus）→ 评分维度回退到旧 row.rubric（不伪造轮次覆盖）");
			if (hasFocus && focus.round_no > 0 && roundNo > 0 && focus.round_no !== roundNo) {
				conflictReasons.push(`round_focus.round_no=${focus.round_no} 与面试 round_no=${roundNo} 不一致；不套用轮次考察重点，只显示 JOB_BASE 降级`);
				focus = {
					...focus,
					available: false,
					title: "",
					description: "",
					focusDimensions: [],
					questions: [],
					scorecardFields: [],
					reason: focus.reason !== "" ? `${focus.reason}；${ROUND_SERVER_FIELDS_MISSING_TEXT}` : `round_focus.round_no=${focus.round_no} 与面试 round_no=${roundNo} 不一致，不套用轮次考察重点`
				};
			}
			if (rubric.declaredRoundRubricVersionId !== "" && rubric.declaredRoundRubricVersionId !== rubric.baseRubricVersionId) conflictReasons.push(`轮次模板声明的 rubric 版本（${rubric.declaredRoundRubricVersionId}）与申请钉住的 base（${rubric.baseRubricVersionId !== "" ? rubric.baseRubricVersionId : "服务端未提供"}）不一致；按 base/JOB_BASE 维度渲染，UI 不自行换版本`);
			return {
				focus,
				rubric,
				serverFieldsMissing: false,
				conflict: conflictReasons.length > 0,
				conflictReason: conflictReasons.join("；")
			};
		}
		/**
		* 来源文案（W3B-CONTRACT §3 表；未知 source 原样显示，不猜）。
		* @param source - 服务端 source（可为空/未知）。
		* @param serverFieldsMissing - true = 旧端点（两键都缺）降级。
		* @returns 可展示文案。
		*/
		function roundSourceText(source, serverFieldsMissing = false) {
			if (serverFieldsMissing) return ROUND_OLD_ENDPOINT_SOURCE_TEXT;
			const value = asText$1(source);
			if (value === "") return "未知来源（服务端未提供 source）";
			return ROUND_SOURCE_TEXT[value] ?? `未知来源（${value}，原样显示）`;
		}
		/**
		* 降级卡文案：优先原样使用服务端 `reason`；没有 reason 时给"没有配置"的事实说明。
		* @param view - 轮次有效投影。
		* @returns 可展示文案（绝不出现伪造的本轮重点）。
		*/
		function roundFocusDegradedText(view) {
			if (view.serverFieldsMissing) return ROUND_SERVER_FIELDS_MISSING_TEXT;
			if (view.focus.reason !== "") return view.focus.reason;
			if (view.conflict && view.conflictReason !== "") return view.conflictReason;
			return "服务端未提供本轮轮次配置（JOB_BASE 降级，不伪造本轮重点；评分维度见下方 effective schema）";
		}
		/**
		* 面评表单的 effective schema 派生（W3B-CONTRACT §4.2）。
		*
		* 规则：
		*   - 控件仍只来自 W1 spec（枚举/分数区间/note 必填）；effective schema 只覆盖顺序/标签/权重/重点标记；
		*   - effective key ∈ spec key 才覆盖；spec 其余维度按原样追加在末尾；
		*   - `submission.dimension_keys` 非空且 ≠ spec key 集合 → mismatch；effective 含 spec 外 key → mismatch；
		*   - effective 子集 → 允许提交（spec 全集仍必填）；
		*   - `serverFieldsMissing`（旧端点）→ 不产生 mismatch，按现行为提交。
		* @param spec - 归一化后的 W1 form spec（可为空，表示还没取到）。
		* @param round - 父组件传入的轮次投影（可为空以兼容旧调用）。
		* @returns 字段顺序 + fail-closed 判定。
		*/
		function deriveScorecardFields(spec, round) {
			const specDimensions = spec !== null && spec !== void 0 ? spec.dimensions : [];
			const roundView = round !== null && round !== void 0 ? round : null;
			const effectiveDimensions = roundView !== null && !roundView.serverFieldsMissing && roundView.rubric.available ? roundView.rubric.dimensions : [];
			const specByKey = /* @__PURE__ */ new Map();
			const specKeys = [];
			for (const dimension of specDimensions) {
				if (specByKey.has(dimension.key)) continue;
				specByKey.set(dimension.key, dimension);
				specKeys.push(dimension.key);
			}
			const specKeySet = new Set(specKeys);
			const fields = [];
			const rendered = /* @__PURE__ */ new Set();
			for (const dimension of effectiveDimensions) {
				const specDimension = specByKey.get(dimension.key);
				if (specDimension === void 0 || rendered.has(dimension.key)) continue;
				rendered.add(dimension.key);
				fields.push({
					key: dimension.key,
					label: dimension.label !== "" ? dimension.label : specDimension.label,
					kind: dimension.kind !== "" ? dimension.kind : specDimension.kind,
					weight: dimension.weight !== 0 ? dimension.weight : specDimension.weight,
					focus: dimension.focus,
					mustCover: dimension.mustCover,
					origin: dimension.origin,
					overridden: true,
					spec: specDimension
				});
			}
			for (const specDimension of specDimensions) {
				if (rendered.has(specDimension.key)) continue;
				rendered.add(specDimension.key);
				fields.push({
					key: specDimension.key,
					label: specDimension.label,
					kind: specDimension.kind,
					weight: specDimension.weight,
					focus: false,
					mustCover: false,
					origin: "",
					overridden: false,
					spec: specDimension
				});
			}
			const submissionKeys = roundView !== null ? roundView.rubric.submissionDimensionKeys : [];
			const extraInSubmission = submissionKeys.filter((key) => !specKeySet.has(key));
			const missingFromSubmission = specKeys.filter((key) => !submissionKeys.includes(key));
			const extraEffective = effectiveDimensions.filter((dimension) => !specKeySet.has(dimension.key)).map((dimension) => dimension.key);
			const mismatchKeys = [];
			for (const key of [
				...extraInSubmission,
				...missingFromSubmission,
				...extraEffective
			]) if (key !== "" && !mismatchKeys.includes(key)) mismatchKeys.push(key);
			const submissionMismatch = submissionKeys.length > 0 && (extraInSubmission.length > 0 || missingFromSubmission.length > 0);
			const mismatch = roundView !== null && !roundView.serverFieldsMissing && (submissionMismatch || extraEffective.length > 0);
			return {
				fields,
				usable: fields.length > 0 && !mismatch,
				mismatch,
				mismatchKeys,
				mismatchText: mismatchKeys.length > 0 ? `${ROUND_SCHEMA_MISMATCH_TEXT}（差异 key：${mismatchKeys.join("、")}）` : ROUND_SCHEMA_MISMATCH_TEXT
			};
		}
		// src/client/interviewer/normalize.ts
		/** 面评维度的 assessment 封闭枚举（scorecard-rules / D-89）。 */
		const ASSESSMENT_VALUES = [
			"MET",
			"NOT_MET",
			"NOT_OBSERVED",
			"UNREADABLE"
		];
		/** 面评 overall 封闭枚举（scorecard-rules）。 */
		const OVERALL_VALUES = [
			"ADVANCE",
			"HOLD",
			"REJECT"
		];
		/** `items.transcript_basis` 保留键的封闭枚举（TR-E2）。 */
		const TRANSCRIPT_BASES = ["TRANSCRIPT", "NO_TRANSCRIPT"];
		/** 一句话说明 assessment 的中文含义（只做展示，不改变枚举值）。 */
		const ASSESSMENT_TEXT = {
			MET: "符合",
			NOT_MET: "不符合",
			NOT_OBSERVED: "未观察到",
			UNREADABLE: "无法判读"
		};
		/** overall 的中文含义。 */
		const OVERALL_TEXT = {
			ADVANCE: "推进",
			HOLD: "暂缓",
			REJECT: "不通过"
		};
		/** 转写状态的中文含义（TR-D 七条）。 */
		const TRANSCRIPT_STATE_TEXT = {
			READY: "已取得（完整）",
			PARTIAL: "部分取得（不完整）",
			PENDING: "等待转写中",
			MISSING: "缺失（无原文）",
			AUTH_REQUIRED: "需要重新授权",
			NEEDS_LINKING: "待人工关联会议",
			RETRYABLE_FAILED: "可重试的失败"
		};
		/** 面评状态的中文含义（NONE/PENDING/SUBMITTED/WAIVED）。 */
		const SCORECARD_STATE_TEXT = {
			NONE: "未填",
			PENDING: "草稿",
			SUBMITTED: "已提交",
			WAIVED: "已豁免"
		};
		/** 会议绑定状态的中文含义。 */
		const MEETING_BINDING_TEXT = {
			BOUND_ACTIVE: "已绑定（有效）",
			UNBOUND: "未绑定",
			NONE_EXPECTED: "无需会议"
		};
		/** 简报来源的中文含义（服务端标注，客户端不冒充"原简报"）。 */
		const BRIEF_SOURCE_TEXT = {
			TEMPLATE: "面试模板",
			JOB_RUBRIC: "岗位 Rubric 维度",
			NONE: "无简报"
		};
		/** 一条面试行里"我"的身份只可能是已登记的面试官（契约 §1.4）。 */
		const ROLE_INTERVIEWER = "INTERVIEWER";
		/** 带 HTTP 状态与契约字段的错误：界面按 code/reason_code 原样展示。 */
		var RecruitmentHttpError = class extends Error {
			/** HTTP 状态码（网络层失败为 0）。 */
			status;
			/** 契约错误码（`DEMO_ACTOR_UNMAPPED` 等）；解析不到为空串。 */
			code;
			/** 契约原因码；解析不到为空串。 */
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
		/** 取一个对象；null / 数组 / 非对象一律降级为空对象。 */
		function asRecord(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
		}
		/** 取一个非空字符串；数字/布尔不算文本（避免把坏类型伪装成业务值）。 */
		function asText(value) {
			return typeof value === "string" ? value.trim() : "";
		}
		/** 取一个有限数字；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
		function asFiniteNumber(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}
		/** 取一个非负有限整数；否则 0。 */
		function asCount(value) {
			const number = asFiniteNumber(value);
			return number >= 0 ? Math.trunc(number) : 0;
		}
		/** 取一个布尔；只认严格 true。 */
		function asBool(value) {
			return value === true;
		}
		/** 字符串数组归一化（丢弃非字符串 / 空串；上限 200 项防止坏响应撑爆内存）。 */
		function asStringArray(value, limit = 200) {
			if (!Array.isArray(value)) return [];
			const out = [];
			for (const item of value) {
				if (out.length >= limit) break;
				const text = asText(item);
				if (text !== "") out.push(text);
			}
			return out;
		}
		/** 拍平标量字段为可展示文本；对象/数组降级为空串（避免 `[object Object]`）。 */
		function asDisplayText(value, maxLength = 300) {
			if (typeof value === "string") {
				const text = value.trim();
				return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
			}
			if (typeof value === "number" && Number.isFinite(value)) return String(value);
			if (typeof value === "boolean") return value ? "是" : "否";
			return "";
		}
		/** 归一化三维标签：缺项给空串（界面显示"未提供"，不借默认值冒充）。 */
		function normalizeLabels(value) {
			const raw = asRecord(value);
			return {
				provenance: asText(raw.provenance),
				trigger: asText(raw.trigger),
				connection: asText(raw.connection)
			};
		}
		/** 归一化 counts（不读列表长度，服务端算多少就是多少）。 */
		function normalizeCounts(value) {
			const raw = asRecord(value);
			return {
				assigned_total: asCount(raw.assigned_total),
				open_interview_total: asCount(raw.open_interview_total),
				pending_scorecard_total: asCount(raw.pending_scorecard_total),
				submitted_scorecard_total: asCount(raw.submitted_scorecard_total),
				transcript_ready_total: asCount(raw.transcript_ready_total),
				transcript_missing_total: asCount(raw.transcript_missing_total)
			};
		}
		/** 归一化 actor。 */
		function normalizeActor(value) {
			const raw = asRecord(value);
			return {
				alias: asText(raw.alias),
				actor_id: asText(raw.actor_id),
				display_name: asText(raw.display_name),
				roles: asStringArray(raw.roles, 20)
			};
		}
		/** 归一化 brief：focus 允许对象（契约形状）或纯字符串（防御旧响应）。 */
		function normalizeBrief(value) {
			const raw = asRecord(value);
			const focus = [];
			if (Array.isArray(raw.focus)) for (const item of raw.focus.slice(0, 50)) {
				if (typeof item === "string") {
					const label = asText(item);
					if (label !== "") focus.push({
						key: "",
						label,
						weight: 0
					});
					continue;
				}
				const entry = asRecord(item);
				const key = asText(entry.key);
				const label = asText(entry.label) || key;
				if (key === "" && label === "") continue;
				focus.push({
					key,
					label,
					weight: asFiniteNumber(entry.weight)
				});
			}
			return {
				available: asBool(raw.available),
				source: asText(raw.source),
				objective: asText(raw.objective),
				briefing: asText(raw.briefing),
				focus,
				questions: asStringArray(raw.questions, 50),
				template_version_id: asText(raw.template_version_id),
				template_payload_hash: asText(raw.template_payload_hash),
				reason: asText(raw.reason)
			};
		}
		/** 归一化 rubric 维度数组（key 为空的行丢弃：没有键就无法对齐面评）。 */
		function normalizeRubricDimensions(value) {
			const out = [];
			if (!Array.isArray(value)) return out;
			for (const item of value.slice(0, 100)) {
				const raw = asRecord(item);
				const key = asText(raw.key);
				if (key === "") continue;
				out.push({
					key,
					label: asText(raw.label) || key,
					kind: asText(raw.kind),
					weight: asFiniteNumber(raw.weight),
					question: asText(raw.question)
				});
			}
			return out;
		}
		/** 归一化 rubric（没有版本 id 且没有维度 → null；不猜版本）。 */
		function normalizeRubric(value) {
			if (value === null || value === void 0) return null;
			const raw = asRecord(value);
			const rawId = asText(raw.rubric_version_id) || asText(raw.id);
			const dimensions = normalizeRubricDimensions(raw.dimensions);
			if (rawId === "" && dimensions.length === 0) return null;
			return {
				rubric_version_id: rawId,
				job_id: asText(raw.job_id),
				payload_hash: asText(raw.payload_hash),
				dimensions
			};
		}
		/** 归一化授权材料。 */
		function normalizeMaterials(value) {
			const raw = asRecord(value);
			const resumeRaw = raw.resume;
			let resume = null;
			if (resumeRaw !== null && typeof resumeRaw === "object" && !Array.isArray(resumeRaw)) {
				const entry = asRecord(resumeRaw);
				resume = {
					resume_version_id: asText(entry.resume_version_id),
					parse_status: asText(entry.parse_status),
					parser_name: asText(entry.parser_name),
					parser_version: asText(entry.parser_version),
					content_sha256: asText(entry.content_sha256),
					fields: asRecord(entry.fields)
				};
			}
			return {
				authorization: asText(raw.authorization),
				available: asBool(raw.available),
				reason: asText(raw.reason),
				resume
			};
		}
		/** 归一化转写分支（只透传 TR-D 的结果）。 */
		function normalizeTranscript(value) {
			const raw = asRecord(value);
			return {
				state: asText(raw.state),
				reason_code: asText(raw.reason_code),
				no_transcript: asBool(raw.no_transcript),
				meeting_binding_state: asText(raw.meeting_binding_state),
				meetings_total: asCount(raw.meetings_total)
			};
		}
		/** 归一化面评分支（服务端只给"我"的那一行；缺 id 不代表没面评，state 说了算）。 */
		function normalizeScorecard(value) {
			const raw = asRecord(value);
			return {
				state: asText(raw.state),
				scorecard_id: asText(raw.scorecard_id),
				status: asText(raw.status),
				revision_no: asCount(raw.revision_no),
				record_version: asCount(raw.record_version),
				submitted_at: asText(raw.submitted_at),
				transcript_basis: asText(raw.transcript_basis),
				overall: asText(raw.overall)
			};
		}
		/**
		* 归一化一条面试行。
		* @param value - 服务端原始行。
		* @returns 安全形状；所有嵌套分支都补齐（不出现 undefined）。
		*/
		function normalizeInterviewRow(value) {
			const raw = asRecord(value);
			const candidate = asRecord(raw.candidate);
			const job = asRecord(raw.job);
			const roundNo = asCount(raw.round_no);
			const brief = normalizeBrief(raw.brief);
			const rubric = normalizeRubric(raw.rubric);
			return {
				interview_id: asText(raw.interview_id),
				application_id: asText(raw.application_id),
				candidate: {
					candidate_id: asText(candidate.candidate_id),
					display_name: asText(candidate.display_name)
				},
				job: {
					job_id: asText(job.job_id),
					code: asText(job.code),
					title: asText(job.title)
				},
				round_no: roundNo,
				slot_code: asText(raw.slot_code),
				status: asText(raw.status),
				stage_code: asText(raw.stage_code),
				scheduled_start_at: asText(raw.scheduled_start_at),
				scheduled_end_at: asText(raw.scheduled_end_at),
				timezone: asText(raw.timezone),
				record_version: asCount(raw.record_version),
				role_in_interview: asText(raw.role_in_interview),
				required_scorecard: asBool(raw.required_scorecard),
				scorecard_due_at: asText(raw.scorecard_due_at),
				brief,
				round: normalizeRoundEffective(raw, {
					roundNo,
					brief,
					rubric
				}),
				rubric,
				materials: normalizeMaterials(raw.materials),
				transcript: normalizeTranscript(raw.transcript),
				scorecard: normalizeScorecard(raw.scorecard),
				required_action: asText(raw.required_action)
			};
		}
		/**
		* 归一化面试官工作台读模型。
		*
		* 空响应 / 半个字段 / 坏类型都不抛错：界面靠 `configured` 与各字段的空值显示
		* "未提供"，而不是显示 `NaN` / `undefined` / 假数据。
		* @param value - 服务端原始响应。
		* @returns 安全形状。
		*/
		function normalizeInterviewerOverview(value) {
			const raw = asRecord(value);
			const session = asRecord(raw.session);
			const interviews = [];
			if (Array.isArray(raw.interviews)) for (const item of raw.interviews.slice(0, 100)) {
				if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
				interviews.push(normalizeInterviewRow(item));
			}
			let sessionId = asText(session.session_id);
			if (sessionId === "") sessionId = asText(raw.session_id);
			return {
				contract_version: asText(raw.contract_version),
				configured: asBool(raw.configured),
				evaluated_at: asText(raw.evaluated_at),
				actor: normalizeActor(raw.actor),
				session_id: sessionId,
				labels: normalizeLabels(raw.labels),
				counts: normalizeCounts(raw.counts),
				interviews,
				issues: asStringArray(raw.issues, 50)
			};
		}
		/**
		* 归一化一个表单维度。
		* @returns 没有 key 的维度返回 null（没有键就无法生成动态键，fail-closed）。
		*/
		function normalizeFormDimension(value) {
			const raw = asRecord(value);
			const key = asText(raw.key);
			if (key === "") return null;
			const controls = asRecord(raw.controls);
			const score = asRecord(controls.score);
			const scoreMin = asCount(score.min);
			const scoreMax = asCount(score.max);
			return {
				key,
				label: asText(raw.label) || key,
				kind: asText(raw.kind),
				weight: asFiniteNumber(raw.weight),
				question: asText(raw.question),
				assessmentOptions: asStringArray(controls.assessment, 10).filter((item) => ASSESSMENT_VALUES.includes(item)),
				scoreMin: scoreMin > 0 ? scoreMin : 1,
				scoreMax: scoreMax >= Math.max(scoreMin, 1) && scoreMax > 0 ? scoreMax : 5,
				noteRequired: asBool(controls.note_required)
			};
		}
		/** 把 `{key:label}` 之类的映射拍平成展示条目（保持服务端顺序）。 */
		function flattenFields(fields) {
			const out = [];
			for (const [key, value] of Object.entries(fields)) {
				const text = asDisplayText(value);
				if (text === "") continue;
				out.push({
					key,
					label: key,
					value: text
				});
			}
			return out;
		}
		/**
		* 归一化 W1 面评表单 spec（D-89 原形 + `nonce` / `expires_at` / `actor_alias`）。
		*
		* 关键约束：`dimensions` 顺序与键**只**来自服务端；未知 assessment / overall 选项丢弃
		* （不渲染成可选值）；未知 mode 降级为 `ALREADY_SUBMITTED`（只读，fail-closed）；
		* 重复维度键保留第一条（避免同一个键渲染两次），无键维度丢弃。
		* @param value - 服务端原始响应。
		* @returns 安全形状。
		*/
		function normalizeScorecardFormSpec(value) {
			const raw = asRecord(value);
			const actorRaw = asRecord(raw.actor);
			const interviewRaw = asRecord(raw.interview);
			const rubricRaw = asRecord(raw.rubric);
			const transcriptRaw = asRecord(raw.transcript_basis);
			const dimensions = [];
			const seen = /* @__PURE__ */ new Set();
			if (Array.isArray(raw.dimensions)) for (const item of raw.dimensions.slice(0, 100)) {
				const dimension = normalizeFormDimension(item);
				if (dimension === null || seen.has(dimension.key)) continue;
				seen.add(dimension.key);
				dimensions.push(dimension);
			}
			const modeRaw = asText(raw.mode);
			const mode = modeRaw === "CREATE" || modeRaw === "REVISE" || modeRaw === "ALREADY_SUBMITTED" ? modeRaw : "ALREADY_SUBMITTED";
			const currentRaw = raw.current === null || raw.current === void 0 ? null : asRecord(raw.current);
			const transcriptValue = asText(transcriptRaw.value);
			return {
				contract_version: asText(raw.contract_version),
				nonce: asText(raw.nonce),
				expires_at: asText(raw.expires_at),
				actor_alias: asText(raw.actor_alias),
				actor: {
					actor_id: asText(actorRaw.actor_id),
					display_name: asText(actorRaw.display_name)
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
					dimensions: normalizeRubricDimensions(rubricRaw.dimensions)
				},
				dimensions,
				transcript_basis: {
					value: TRANSCRIPT_BASES.includes(transcriptValue) ? transcriptValue : "",
					options: asStringArray(transcriptRaw.options, 5).filter((item) => TRANSCRIPT_BASES.includes(item)),
					locked: asBool(transcriptRaw.locked)
				},
				overall_options: asStringArray(raw.overall_options, 10).filter((item) => OVERALL_VALUES.includes(item)),
				mode,
				current: currentRaw === null ? null : {
					id: asText(currentRaw.id),
					status: asText(currentRaw.status),
					revision_no: asCount(currentRaw.revision_no),
					record_version: asCount(currentRaw.record_version),
					rubric_version_id: asText(currentRaw.rubric_version_id)
				}
			};
		}
		/** 归一化 W1 提交成功的 DB 读回（字段缺失降级为空串/0，界面如实显示"未返回"）。 */
		function normalizeSubmitResult(value) {
			const raw = asRecord(value);
			const nested = asRecord(raw.result);
			const source = raw.scorecard_id !== void 0 ? raw : nested;
			return {
				scorecard_id: asText(source.scorecard_id),
				status: asText(source.status),
				actor_id: asText(source.actor_id),
				record_version: asCount(source.record_version),
				interviewer_id: asText(source.interviewer_id),
				interview_id: asText(source.interview_id),
				replayed: asBool(source.replayed)
			};
		}
		/**
		* 构造 W1 面评提交体（纯函数，键**只**来自 form spec）。
		*
		* 失败一律在本地拦住（不发请求）：缺维度、维度键不在 spec、assessment 未知、
		* score 非法、overall 不在可选集、transcript_basis / nonce 缺失。
		* @param spec - 归一化后的 form spec。
		* @param answers - 人填的答案。
		* @returns 成功给提交体；失败给可读原因。
		*/
		function buildScorecardSubmitBody(spec, answers) {
			if (spec.interview.id === "") return {
				ok: false,
				message: "服务端未返回面试 id（fail-closed，未提交）。"
			};
			if (spec.mode !== "CREATE") return {
				ok: false,
				message: `服务端表单模式为 ${spec.mode}，本版只提交新建面评（未提交）。`
			};
			if (spec.nonce === "") return {
				ok: false,
				message: "服务端未返回一次性 nonce（W1），无法提交（fail-closed）。"
			};
			if (spec.transcript_basis.value === "") return {
				ok: false,
				message: "服务端未返回转写依据（transcript_basis），无法提交（fail-closed）。"
			};
			if (spec.dimensions.length === 0) return {
				ok: false,
				message: "服务端没有返回可填写的 rubric 维度，无法提交（fail-closed）。"
			};
			const overall = asText(answers.overall);
			if (!spec.overall_options.includes(overall)) return {
				ok: false,
				message: spec.overall_options.length === 0 ? "服务端没有返回 overall 选项，无法提交（fail-closed）。" : `overall 必须是服务端给出的选项之一（${spec.overall_options.join(" / ")}）。`
			};
			const dimensions = {};
			for (const dimension of spec.dimensions) {
				const answer = answers.dimensions[dimension.key];
				if (answer === void 0) return {
					ok: false,
					message: `维度 ${dimension.label}（${dimension.key}）还没有作答。`
				};
				const assessment = asText(answer.assessment);
				if (assessment === "") return {
					ok: false,
					message: `维度 ${dimension.label}（${dimension.key}）还没有选择 assessment。`
				};
				if (!dimension.assessmentOptions.includes(assessment)) return {
					ok: false,
					message: dimension.assessmentOptions.length === 0 ? `维度 ${dimension.label}（${dimension.key}）没有服务端枚举选项，不能提交（fail-closed）。` : `维度 ${dimension.label}（${dimension.key}）的 assessment 不在服务端选项内。`
				};
				const scored = assessment === "MET" || assessment === "NOT_MET";
				let score;
				if (answer.score !== void 0 && answer.score !== null) {
					if (!scored) return {
						ok: false,
						message: `维度 ${dimension.label}（${dimension.key}）只有 MET / NOT_MET 才能给 score。`
					};
					if (!Number.isInteger(answer.score) || answer.score < dimension.scoreMin || answer.score > dimension.scoreMax) return {
						ok: false,
						message: `维度 ${dimension.label}（${dimension.key}）的 score 必须是 ${dimension.scoreMin}–${dimension.scoreMax} 的整数。`
					};
					score = answer.score;
				}
				const note = asText(answer.note);
				if (dimension.noteRequired && note === "") return {
					ok: false,
					message: `维度 ${dimension.label}（${dimension.key}）要求填写 note。`
				};
				if (note.length > 2e3) return {
					ok: false,
					message: `维度 ${dimension.label}（${dimension.key}）的 note 不得超过 2000 字。`
				};
				dimensions[dimension.key] = {
					assessment,
					...score !== void 0 ? { score } : {},
					...note !== "" ? { note } : {}
				};
			}
			return {
				ok: true,
				body: {
					interview_id: spec.interview.id,
					...spec.rubric.id !== "" ? { rubric_version_id: spec.rubric.id } : {},
					dimensions,
					transcript_basis: spec.transcript_basis.value,
					overall: answers.overall,
					nonce: spec.nonce
				}
			};
		}
		/**
		* 把非 2xx 响应体解析成可读错误（保留 code / reason_code / detail）。
		*
		* 契约形状优先级：`{error:{code,reason_code,message,detail}}` → `{error:"文本"}` → 原文；
		* 解析不到时仍保留 HTTP 状态码（界面据此显示，不伪装成业务空态）。
		* @param status - HTTP 状态码。
		* @param bodyText - 响应体原文。
		* @returns 可读错误。
		*/
		function parseHttpError(status, bodyText) {
			const text = typeof bodyText === "string" ? bodyText.trim() : "";
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
				const message = asText(error.message) || asText(error.detail);
				const composed = [code, reasonCode].filter((part) => part !== "").join("/");
				return new RecruitmentHttpError(status, code, reasonCode, composed === "" && message === "" ? `宿主返回 HTTP ${status}` : `${composed === "" ? "" : `${composed}：`}${message === "" ? `HTTP ${status}` : message}`, error.detail);
			}
			if (typeof errorRaw === "string" && errorRaw.trim() !== "") return new RecruitmentHttpError(status, "", "", `宿主返回 HTTP ${status}：${errorRaw.trim()}`, void 0);
			return new RecruitmentHttpError(status, "", "", text === "" ? `宿主返回 HTTP ${status}` : `宿主返回 HTTP ${status}：${text.slice(0, 200)}`, void 0);
		}
		/**
		* 判断一次 overview 读取失败是否属于"身份绑定尚未落定"（可重试，不是终态）。
		*
		* 为什么需要它：W0 shell 切换 Demo Actor 时先改 props、再 `await PUT /recruitment/api/actor`；
		* 本组件在 props 变化瞬间就 GET overview，服务端 registry 仍是旧绑定，会返回
		*   403 `ALIAS_MISMATCH / SESSION_ALIAS_MISMATCH`（换身份时），或
		*   409 `DEMO_ACTOR_UNMAPPED`（首次绑定/刷新恢复时）。
		* 这是**时序竞态**，不是业务错误：客户端应有界退避重试，而不是把界面钉死在错误态。
		* 除上述两类之外一律不重试（真 403/404/500 立即如实显示）。
		* @param failure - 捕获到的任意错误。
		* @returns true 表示"绑定可能马上落定，可退避重试"。
		*/
		function isBindingPendingError(failure) {
			if (!(failure instanceof RecruitmentHttpError)) return false;
			if (failure.status === 403 && failure.reasonCode === "SESSION_ALIAS_MISMATCH") return true;
			if (failure.status === 409 && failure.code === "DEMO_ACTOR_UNMAPPED") return true;
			return false;
		}
		/**
		* 用 id 找一条"分配给我的面试"。
		* @param overview - 已归一化的 overview。
		* @param interviewId - 面试 id（来自列表行）。
		* @returns 找不到（含空 id / 未知 id / 空 overview）返回 null，绝不回退到第一行。
		*/
		function selectInterview(overview, interviewId) {
			if (overview === void 0) return null;
			const id = asText(interviewId);
			if (id === "") return null;
			for (const row of overview.interviews) if (row.interview_id === id) return row;
			return null;
		}
		/**
		* 工作台头部统计：服务端 counts 原样透传，**不用列表行长度改写**。
		* @param overview - 已归一化的 overview。
		* @returns 三格统计 + 本地实际行数（单独字段，便于发现"服务端说 1 行、这次给了 2 行"这类偏差）。
		*/
		function deriveWorkspaceStats(overview) {
			return {
				assigned_total: overview.counts.assigned_total,
				open_interview_total: overview.counts.open_interview_total,
				pending_scorecard_total: overview.counts.pending_scorecard_total,
				submitted_scorecard_total: overview.counts.submitted_scorecard_total,
				transcript_ready_total: overview.counts.transcript_ready_total,
				transcript_missing_total: overview.counts.transcript_missing_total,
				row_count: overview.interviews.length
			};
		}
		/**
		* 当前行是否允许打开"提交我的独立面评"。
		*
		* 规则（fail-closed）：
		*   - 必须是本场面试已登记的面试官（role_in_interview === INTERVIEWER）且行有 interview_id；
		*   - 面评状态 NONE / PENDING → true；SUBMITTED / WAIVED → false；未知状态 → false。
		* 注意：这里**不**判断转写是否 READY（转写缺失不影响提交，服务端记 NO_TRANSCRIPT，D-111）。
		* @param row - 一条面试行。
		* @returns 是否可提交。
		*/
		function canSubmitScorecard(row) {
			if (row.interview_id === "") return false;
			if (row.role_in_interview !== ROLE_INTERVIEWER) return false;
			switch (row.scorecard.state) {
				case "NONE":
				case "PENDING": return true;
				case "SUBMITTED":
				case "WAIVED": return false;
				default: return false;
			}
		}
		/**
		* 转写状态的中文文本（TR-D 七条；未知值原样说明，不沉默）。
		* @param state - `transcript.state`。
		* @returns 可展示文本。
		*/
		function transcriptStateText(state) {
			const value = asText(state);
			if (value === "") return "状态未提供";
			return TRANSCRIPT_STATE_TEXT[value] ?? `未知状态（${value}）`;
		}
		/**
		* 面评状态的中文文本（NONE/PENDING/SUBMITTED/WAIVED）。
		* @param state - `scorecard.state`。
		* @returns 可展示文本。
		*/
		function scorecardStateText(state) {
			const value = asText(state);
			if (value === "") return "状态未提供";
			return SCORECARD_STATE_TEXT[value] ?? `未知状态（${value}）`;
		}
		/** 会议绑定状态的中文文本。 */
		function meetingBindingStateText(state) {
			const value = asText(state);
			if (value === "") return "未提供";
			return MEETING_BINDING_TEXT[value] ?? `未知状态（${value}）`;
		}
		/** 简报来源的中文文本（服务端标注什么就说什么）。 */
		function briefSourceText(source) {
			const value = asText(source);
			if (value === "") return "未提供";
			return BRIEF_SOURCE_TEXT[value] ?? `未知来源（${value}）`;
		}
		/** required_action 的中文文本（行状态 chip；只映射服务端枚举，不推断阶段）。 */
		function requiredActionText(action) {
			switch (asText(action)) {
				case "SUBMIT_SCORECARD": return "待提交面评";
				case "REVIEW_SCORECARD": return "面评已提交";
				case "NONE": return "无需面评";
				default: return "状态未提供";
			}
		}
		/** assessment 的展示文本（枚举值原样附后，避免中文吞掉契约值）。 */
		function assessmentText(value) {
			const text = asText(value);
			if (text === "") return "";
			const label = ASSESSMENT_TEXT[text];
			return label === void 0 ? text : `${text}（${label}）`;
		}
		/** overall 的展示文本。 */
		function overallText(value) {
			const text = asText(value);
			if (text === "") return "";
			const label = OVERALL_TEXT[text];
			return label === void 0 ? text : `${text}（${label}）`;
		}
		/**
		* 把 ISO 时间格式化成可读文本；**不做静默时区换算**。
		*
		* - 给了合法 IANA 时区（overview 行里的 `timezone`）→ 用 `Intl` 换算到该时区；
		* - 没给 / 时区非法 → 保留 ISO 原文里的日期与时间，并附上原文的 `Z` / `+08:00` 标记
		*   （宁可显示 `Z`，也不假装这是本地时间）。
		* @param iso - ISO 时间文本（可空/坏类型）。
		* @param timeZone - 可选 IANA 时区（如 `Asia/Shanghai`）。
		* @returns 可展示文本；解析不出返回 ''。
		*/
		function formatSlotTime(iso, timeZone = "") {
			const text = asText(iso);
			const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text);
			if (match === null) return "";
			const year = match[1] ?? "";
			const month = match[2] ?? "";
			const day = match[3] ?? "";
			const hour = match[4] ?? "";
			const minute = match[5] ?? "";
			const zone = asText(timeZone);
			if (zone !== "" && hour !== "") {
				const stamp = Date.parse(text);
				if (!Number.isNaN(stamp)) try {
					return new Intl.DateTimeFormat("sv-SE", {
						timeZone: zone,
						year: "numeric",
						month: "2-digit",
						day: "2-digit",
						hour: "2-digit",
						minute: "2-digit",
						hourCycle: "h23"
					}).format(new Date(stamp));
				} catch {}
			}
			if (hour === "") return `${year}-${month}-${day}`;
			return `${year}-${month}-${day} ${hour}:${minute}${/Z$/i.test(text) ? "Z" : /([+-]\d{2}:\d{2})$/.exec(text)?.[1] ?? ""}`;
		}
		/**
		* 格式化一段面试时间（开始–结束）；同一天只显示一次日期。
		* @param startIso - 开始时间。
		* @param endIso - 结束时间（可为空）。
		* @param timeZone - 可选 IANA 时区。
		* @returns 可展示文本；开始时间解析不出返回 ''。
		*/
		function formatSlotRange(startIso, endIso, timeZone = "") {
			const start = formatSlotTime(startIso, timeZone);
			if (start === "") return "";
			const end = formatSlotTime(endIso, timeZone);
			if (end === "") return start;
			if (start.slice(0, 10) === end.slice(0, 10) && start.length > 10 && end.length > 10) return `${start} – ${end.slice(11)}`;
			return `${start} – ${end}`;
		}
		/**
		* 把授权材料的 `parsed_fields` 拍平成可展示条目（简历材料授权给面试官，原样展示）。
		* 嵌套对象/数组不 json 化（避免 `[object Object]`），只显示标量；空字段丢弃。
		* @param fields - 服务端原样 `fields`。
		* @returns 展示条目（保持服务端键顺序）。
		*/
		function materialFieldEntries(fields) {
			return flattenFields(fields);
		}
		/**
		* 按轮次汇总考察重点（列表页右栏用）；同一轮 focus 去重。
		*
		* 两种口径（不混用）：
		*   * 服务端有轮次字段（task-50）→ 只用 `round_focus.focus_dimensions`；`available=false`
		*     （JOB_BASE 降级）时**不展示**任何"本轮重点"（不编译器把岗位维度冒充轮次重点）。
		*   * 旧端点（`serverFieldsMissing`）→ 保持 W3 旧行为：用 `brief.focus`/`brief.objective` 聚合
		*     （既有测试与旧 Host 兼容），来源标 `LEGACY_BRIEF`。
		* @param rows - 面试行。
		* @returns 按轮次升序的分组（无 focus 的轮次也保留 objective/来源）。
		*/
		function groupRounds(rows) {
			const groups = /* @__PURE__ */ new Map();
			for (const row of rows) {
				const round = row.round_no;
				const legacy = row.round.serverFieldsMissing;
				let group = groups.get(round);
				if (group === void 0) {
					group = {
						round_no: round,
						objective: row.brief.objective,
						focus: [],
						seen: /* @__PURE__ */ new Set(),
						source: legacy ? "LEGACY_BRIEF" : row.round.focus.source,
						title: legacy ? "" : row.round.focus.title,
						available: legacy ? false : row.round.focus.available,
						serverProjection: !legacy
					};
					groups.set(round, group);
				}
				if (group.objective === "") group.objective = row.brief.objective;
				if (legacy) {
					if (group.serverProjection) continue;
					for (const item of row.brief.focus) {
						const key = item.key !== "" ? item.key : item.label;
						if (key === "" || group.seen.has(key)) continue;
						group.seen.add(key);
						group.focus.push(item);
					}
					continue;
				}
				group.serverProjection = true;
				if (!group.available && row.round.focus.available) {
					group.available = true;
					group.source = row.round.focus.source;
					group.title = row.round.focus.title;
				}
				if (!row.round.focus.available) continue;
				if (group.title === "") group.title = row.round.focus.title;
				for (const item of row.round.focus.focusDimensions) {
					const key = item.key !== "" ? item.key : item.label;
					if (key === "" || group.seen.has(key)) continue;
					group.seen.add(key);
					group.focus.push({
						key: item.key,
						label: item.label,
						weight: item.weight,
						required: item.required
					});
				}
			}
			return [...groups.values()].sort((left, right) => left.round_no - right.round_no).map((group) => ({
				round_no: group.round_no,
				objective: group.objective,
				focus: group.focus,
				source: group.source,
				title: group.title,
				available: group.available
			}));
		}
		// src/client/interviewer/http.ts
		/** 宿主只读路由（同源相对路径）。 */
		const OVERVIEW_ENDPOINT = "/recruitment/api/interviewer/overview";
		/** W1 表单 spec / 提交路由。 */
		const SCORECARD_FORM_ENDPOINT = "/recruitment/api/action/scorecard/form";
		const SCORECARD_SUBMIT_ENDPOINT = "/recruitment/api/action/scorecard/submit";
		/** 同源标记头（宿主侧 `x-recruitment-request: 1` 才放行）。 */
		const REQUEST_HEADER = "x-recruitment-request";
		/** 服务端唯一接受的 session 身份头（值只来自 props，不读 localStorage）。 */
		const SESSION_HEADER = "X-DSH-Session";
		/**
		* 统一请求封装：网络错误 / 非 2xx / 坏 JSON 都变成可读错误。
		* @param url - 同源相对路径。
		* @param sessionId - DSH session id（服务端用它解析绑定的演示身份）。
		* @param init - fetch 参数（方法/头/体/signal）。
		* @returns 解析后的 JSON（空体为 undefined）。
		* @throws {RecruitmentHttpError} 网络失败（status 0）或非 2xx（保留契约字段）。
		*/
		async function requestJson(url, sessionId, init) {
			const headers = {
				[REQUEST_HEADER]: "1",
				[SESSION_HEADER]: sessionId
			};
			if (init.headers !== void 0) for (const [key, value] of Object.entries(init.headers)) headers[key] = value;
			let response;
			try {
				response = await fetch(url, {
					...init,
					headers,
					credentials: "same-origin",
					cache: "no-store"
				});
			} catch (failure) {
				throw new RecruitmentHttpError(0, "NETWORK_ERROR", "NETWORK_UNREACHABLE", `网络请求失败：${failure instanceof Error ? failure.message : String(failure)}`, void 0);
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
				throw new RecruitmentHttpError(response.status, "INVALID_RESPONSE", "NOT_JSON", "宿主返回的不是 JSON", void 0);
			}
		}
		/**
		* 读取一次面试官工作台投影（`GET /recruitment/api/interviewer/overview`）。
		*
		* 缺 session / alias 时**不发请求**（fail-closed）：没有身份就没有"我的分配"，
		* 发出去只会让服务端返 403/409，还会把界面引到错误分支。
		* @param options - sessionId / alias / 可选 interviewId / signal。
		* @returns 归一化后的 overview。
		* @throws {RecruitmentHttpError} `SESSION_HEADER_REQUIRED`（本地拦截）或服务端错误。
		*/
		async function fetchInterviewerOverview(options) {
			const sessionId = options.sessionId.trim();
			const alias = options.alias.trim();
			if (sessionId === "" || alias === "") throw new RecruitmentHttpError(0, "DEMO_ACTOR_UNMAPPED", "SESSION_NOT_BOUND", "当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份", void 0);
			const query = new URLSearchParams({ alias });
			const interviewId = (options.interviewId ?? "").trim();
			if (interviewId !== "") query.set("interview_id", interviewId);
			return normalizeInterviewerOverview(await requestJson(`${OVERVIEW_ENDPOINT}?${query.toString()}`, sessionId, {
				method: "GET",
				...options.signal !== void 0 ? { signal: options.signal } : {}
			}));
		}
		/**
		* 读取 W1 面评表单 spec（含一次性 nonce）。
		* @param options - sessionId / interviewId / 可选 applicationId / signal。
		* @returns 归一化后的 form spec（维度键只来自服务端）。
		* @throws {RecruitmentHttpError} W1 未就绪时 status 为 404/405/501 或 0。
		*/
		async function fetchScorecardFormSpec(options) {
			const sessionId = options.sessionId.trim();
			const interviewId = options.interviewId.trim();
			if (sessionId === "") throw new RecruitmentHttpError(0, "DEMO_ACTOR_UNMAPPED", "SESSION_NOT_BOUND", "当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份", void 0);
			if (interviewId === "") throw new RecruitmentHttpError(0, "INVALID_ARGS", "INTERVIEW_ID_REQUIRED", "缺少面试 id，无法读取面评表单", void 0);
			const query = new URLSearchParams({ interview_id: interviewId });
			const applicationId = (options.applicationId ?? "").trim();
			if (applicationId !== "") query.set("application_id", applicationId);
			const rubricVersionId = (options.rubricVersionId ?? "").trim();
			if (rubricVersionId !== "") query.set("rubric_version_id", rubricVersionId);
			return normalizeScorecardFormSpec(await requestJson(`${SCORECARD_FORM_ENDPOINT}?${query.toString()}`, sessionId, {
				method: "GET",
				...options.signal !== void 0 ? { signal: options.signal } : {}
			}));
		}
		/**
		* 提交本人面评（`POST /recruitment/api/action/scorecard/submit`）。
		*
		* 提交体由 `buildScorecardSubmitBody` 构造（维度键只来自 form spec）；
		* 成功只认 2xx + 服务端 DB 读回，**没有**任何本地"假成功"。
		* @param options - sessionId + 已构造好的提交体。
		* @returns 归一化后的 DB 读回。
		* @throws {RecruitmentHttpError} 403/409（NONCE_*、ALREADY_SUBMITTED…）或其它非 2xx。
		*/
		async function submitScorecard(options) {
			const sessionId = options.sessionId.trim();
			if (sessionId === "") throw new RecruitmentHttpError(0, "DEMO_ACTOR_UNMAPPED", "SESSION_NOT_BOUND", "当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份", void 0);
			return normalizeSubmitResult(await requestJson(SCORECARD_SUBMIT_ENDPOINT, sessionId, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(options.body)
			}));
		}
		/**
		* 判断错误是否表示"W1 面评提交入口尚未就绪"（契约 §2.3：404/405/网络错）。
		*
		* 为什么把 501 也算进去：宿主/隧道对未实现路由有两种常见回答（405/404 与 501）；
		* 只要不是服务端业务拒绝（400/403/409），界面就应显示"未就绪"而不是"提交失败"。
		* @param failure - 捕获到的任意错误。
		* @returns true 表示应按"入口未就绪（W1）"降级。
		*/
		function isScorecardEndpointUnavailable(failure) {
			if (!(failure instanceof RecruitmentHttpError)) return false;
			return failure.status === 0 || failure.status === 404 || failure.status === 405 || failure.status === 501;
		}
		// src/client/interviewer/ScorecardForm.tsx
		/** 把任意错误拆成可展示的 {code,reasonCode,message,status}。 */
		function describeFailure(failure) {
			if (failure instanceof RecruitmentHttpError) return {
				code: failure.code,
				reasonCode: failure.reasonCode,
				message: failure.message,
				status: failure.status
			};
			return {
				code: "",
				reasonCode: "",
				message: failure instanceof Error ? failure.message : String(failure),
				status: 0
			};
		}
		/** 从表单 DOM 里按 role + 维度键找一个控件（键来自 spec；用属性比较避免选择器转义问题）。 */
		function readControl(form, role, key) {
			for (const element of Array.from(form.querySelectorAll(`[data-role="${role}"]`))) if (element.getAttribute("data-dim-key") === key) return element;
			return null;
		}
		/** 一次性 nonce 失效：提示并允许重新取 spec（重新打开表单等价动作）。 */
		const NONCE_PROBLEM_CODES = [
			"NONCE_REQUIRED",
			"NONCE_INVALID",
			"NONCE_EXPIRED",
			"NONCE_ALREADY_USED"
		];
		/**
		* 面评表单。
		* @param props - sessionId / interviewId / applicationId / rubricVersionId / 回调。
		* @returns 表单弹层 JSX。
		*/
		function ScorecardForm(props) {
			const formRef = (0, react.useRef)(null);
			/** 最新回调引用：避免把回调放进 fetch effect 依赖造成循环重取。 */
			const onUnavailableRef = (0, react.useRef)(props.onUnavailable);
			const onCloseRef = (0, react.useRef)(props.onClose);
			const [spec, setSpec] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(true);
			const [loadFailure, setLoadFailure] = (0, react.useState)(void 0);
			const [generation, setGeneration] = (0, react.useState)(0);
			const [assessments, setAssessments] = (0, react.useState)({});
			const [submitting, setSubmitting] = (0, react.useState)(false);
			const [validationError, setValidationError] = (0, react.useState)("");
			const [submitFailure, setSubmitFailure] = (0, react.useState)(void 0);
			const [result, setResult] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				onUnavailableRef.current = props.onUnavailable;
				onCloseRef.current = props.onClose;
			}, [props.onUnavailable, props.onClose]);
			(0, react.useEffect)(() => {
				const onKeyDown = (event) => {
					if (event.key === "Escape") onCloseRef.current();
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				let active = true;
				setLoading(true);
				setLoadFailure(void 0);
				setSubmitFailure(void 0);
				setValidationError("");
				setResult(void 0);
				setAssessments({});
				fetchScorecardFormSpec({
					sessionId: props.sessionId,
					interviewId: props.interviewId,
					applicationId: props.applicationId,
					rubricVersionId: props.rubricVersionId,
					signal: controller.signal
				}).then((value) => {
					if (!active) return;
					setSpec(value);
				}).catch((failure) => {
					if (!active || controller.signal.aborted) return;
					setLoadFailure(failure);
					if (isScorecardEndpointUnavailable(failure)) onUnavailableRef.current();
				}).finally(() => {
					if (active) setLoading(false);
				});
				return () => {
					active = false;
					controller.abort();
				};
			}, [
				props.sessionId,
				props.interviewId,
				props.applicationId,
				props.rubricVersionId,
				generation
			]);
			const submit = (event) => {
				event.preventDefault();
				const currentSpec = spec;
				const form = formRef.current;
				if (currentSpec === void 0) return;
				if (deriveScorecardFields(currentSpec, props.round).mismatch) {
					setValidationError(ROUND_SCHEMA_MISMATCH_TEXT);
					setSubmitFailure(void 0);
					return;
				}
				if (form === null) {
					setValidationError("表单尚未渲染，无法提交。");
					return;
				}
				const answers = {};
				for (const dimension of currentSpec.dimensions) {
					const assessmentElement = readControl(form, "assessment", dimension.key);
					const scoreElement = readControl(form, "score", dimension.key);
					const noteElement = readControl(form, "note", dimension.key);
					const answer = { assessment: assessmentElement?.value ?? "" };
					if (scoreElement !== null && scoreElement.value.trim() !== "") {
						const parsed = Number(scoreElement.value);
						if (Number.isFinite(parsed)) answer.score = parsed;
					}
					if (noteElement !== null && noteElement.value.trim() !== "") answer.note = noteElement.value.trim();
					answers[dimension.key] = answer;
				}
				const built = buildScorecardSubmitBody(currentSpec, {
					dimensions: answers,
					overall: form.querySelector("[data-role=\"overall\"]")?.value ?? ""
				});
				if (!built.ok) {
					setValidationError(built.message);
					setSubmitFailure(void 0);
					return;
				}
				setValidationError("");
				setSubmitFailure(void 0);
				setSubmitting(true);
				submitScorecard({
					sessionId: props.sessionId,
					body: built.body
				}).then((submitted) => {
					setResult(submitted);
					props.onSubmitted();
				}).catch((failure) => {
					const described = describeFailure(failure);
					setSubmitFailure({
						code: described.code,
						reasonCode: described.reasonCode,
						message: described.message
					});
				}).finally(() => setSubmitting(false));
			};
			/** 统一的弹层外壳：`[data-testid="scorecard-form"]` 永远是打开状态下的根锚点。 */
			const shell = (mode, interviewId, children) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				className: "iw-overlay",
				"data-testid": "scorecard-form",
				"data-mode": mode,
				"data-interview-id": interviewId,
				"aria-label": "我的独立面评",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-modal",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": "我的独立面评",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "iw-modaltop",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "我的独立面评" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "iw-x",
							onClick: props.onClose,
							"aria-label": "关闭面评表单",
							children: "×"
						})]
					}), children]
				})
			});
			if (loading) return shell("LOADING", props.interviewId, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "iw-formloading",
				children: "正在读取面评表单…"
			}));
			if (loadFailure !== void 0) {
				const unavailable = isScorecardEndpointUnavailable(loadFailure);
				const described = describeFailure(loadFailure);
				return shell(unavailable ? "UNAVAILABLE" : "ERROR", props.interviewId, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [unavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-notice iw-notice-warn",
					role: "alert",
					"data-testid": "scorecard-unavailable",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "服务端面评提交入口未就绪（W1）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						"读取面评表单失败（HTTP ",
						described.status,
						"）。本表单不会本地假写，也不会显示假成功；W1 端点就绪后重新打开即可。"
					] })]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-errorbox",
					role: "alert",
					"data-testid": "form-load-error",
					"data-code": described.code,
					"data-reason-code": described.reasonCode,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "面评表单读取失败" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: described.message }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							"code：",
							described.code !== "" ? described.code : "（无）",
							" · reason_code：",
							described.reasonCode !== "" ? described.reasonCode : "（无）"
						] })
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-modalend",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "iw-btn",
						onClick: props.onClose,
						children: "关闭"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "submit",
						"data-testid": "submit-scorecard",
						className: "iw-btn iw-btn-blue",
						disabled: true,
						children: "提交我的独立面评"
					})]
				})] }));
			}
			if (spec === void 0) return shell("ERROR", props.interviewId, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "iw-formloading",
				children: "服务端没有返回面评表单（fail-closed）。"
			}));
			const readonly = spec.mode !== "CREATE";
			const nonceProblem = submitFailure !== void 0 && NONCE_PROBLEM_CODES.includes(submitFailure.code);
			const plan = deriveScorecardFields(spec, props.round);
			const plannedFields = plan.fields;
			const submitDisabled = submitting || readonly || spec.dimensions.length === 0 || spec.overall_options.length === 0 || spec.transcript_basis.value === "" || spec.nonce === "" || plan.mismatch || plannedFields.length === 0;
			const scoreEnabled = (key) => assessments[key] === "MET" || assessments[key] === "NOT_MET";
			return shell(spec.mode, spec.interview.id !== "" ? spec.interview.id : props.interviewId, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "iw-modaldesc",
					children: "按本轮 rubric 记录你的独立观察。Agent 不代替面试官提交；提交走 W1 Host Remote Action，写库后回显服务端 DB 读回。"
				}),
				props.round !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-roundctx",
					"data-testid": "scorecard-round-context",
					"data-round-source": props.round.serverFieldsMissing || !props.round.focus.available ? "JOB_BASE" : props.round.focus.source !== "" ? props.round.focus.source : "JOB_BASE",
					"data-round-no": props.round.focus.round_no > 0 ? props.round.focus.round_no : spec.interview.round_no,
					"data-round-available": props.round.focus.available ? "1" : "0",
					"data-round-schema-source": props.round.rubric.source,
					"data-round-dimension-count": props.round.rubric.dimensions.length,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "本轮考察重点（只读）" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-tiny iw-muted",
							children: props.round.serverFieldsMissing || !props.round.focus.available ? "岗位基础（JOB_BASE 降级：服务端未提供该轮配置）" : roundSourceText(props.round.focus.source)
						}),
						props.round.focus.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: props.round.focus.title }),
							props.round.focus.description !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "iw-tiny",
								children: props.round.focus.description
							}) : null,
							props.round.rubric.dimensions.some((dimension) => dimension.mustCover) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "iw-tiny",
								"data-testid": "scorecard-round-must-cover",
								children: ["本轮必覆盖：", props.round.rubric.dimensions.filter((dimension) => dimension.mustCover).map((dimension) => dimension.label).join(" / ")]
							}) : null,
							props.round.rubric.scaleMin !== 0 || props.round.rubric.scaleMax !== 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: "iw-tiny iw-muted",
								children: [
									"本轮评分区间：",
									props.round.rubric.scaleMin,
									"–",
									props.round.rubric.scaleMax
								]
							}) : null
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-tiny iw-muted",
							children: "服务端未提供该轮配置（JOB_BASE 降级）；提交仍按服务端 form spec 的维度键，界面不伪造本轮重点。"
						})
					]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "iw-tiny iw-muted",
					children: [
						"面试：第 ",
						spec.interview.round_no,
						" 轮 · ",
						spec.interview.slot_code !== "" ? spec.interview.slot_code : "（未提供 slot）",
						" · 状态：",
						spec.interview.status !== "" ? spec.interview.status : "（未提供）",
						" · rubric：",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "iw-mono",
							children: spec.rubric.id !== "" ? spec.rubric.id : "（未提供）"
						})
					]
				}),
				readonly ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-notice iw-notice-warn",
					"data-testid": "form-readonly",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
						"该面试已有当前面评（服务端 mode=",
						spec.mode,
						"），本版表单只读。"
					] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "修订提交需要服务端 revision 闭环（supersedes_scorecard_id / expected_record_version），本版不开放，避免本地伪造修订。" })]
				}) : null,
				plan.mismatch ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-notice iw-notice-warn",
					role: "alert",
					"data-testid": "round-schema-mismatch",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: ROUND_SCHEMA_MISMATCH_TEXT }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-tiny",
							children: plan.mismatchText
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-tiny",
							children: "已禁用提交：不写库，避免脏面评。请服务端修正本轮评分表与 form spec 后重试。"
						})
					]
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: "iw-form",
					ref: formRef,
					onSubmit: (event) => {
						event.preventDefault();
						submit(event);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "iw-lockline",
							"data-testid": "transcript-basis",
							children: [
								"转写依据（服务端锁定）：",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: spec.transcript_basis.value !== "" ? spec.transcript_basis.value : "（未提供）" }),
								spec.transcript_basis.locked ? "（locked）" : ""
							]
						}),
						spec.dimensions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-validation",
							role: "alert",
							children: "服务端没有返回可填写的 rubric 维度，无法提交（fail-closed）。"
						}) : null,
						plannedFields.map((field) => {
							const dimension = field.spec;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
								className: "iw-fieldset",
								"data-dim-key": dimension.key,
								"data-field-source": field.overridden ? "ROUND" : "SPEC",
								"data-focus": field.focus ? "1" : "0",
								"data-must-cover": field.mustCover ? "1" : "0",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("legend", { children: [
										field.label,
										"（",
										dimension.key,
										"）",
										field.focus ? " · 本轮重点" : "",
										field.mustCover ? " · 本轮必覆盖" : ""
									] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										className: "iw-fieldhelp",
										children: [
											"类型：",
											dimension.kind !== "" ? dimension.kind : "未提供",
											" · 权重：",
											field.weight,
											field.overridden ? ` · 本轮 effective schema（origin=${field.origin !== "" ? field.origin : "未提供"}）` : ""
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "iw-field",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "assessment：" }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												"data-role": "assessment",
												"data-dim-key": dimension.key,
												"aria-label": `维度 ${dimension.label} 的 assessment`,
												defaultValue: "",
												disabled: readonly,
												onChange: (event) => setAssessments((previous) => ({
													...previous,
													[dimension.key]: event.target.value
												})),
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "",
													children: "请选择"
												}), dimension.assessmentOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: option,
													children: assessmentText(option)
												}, option))]
											}),
											dimension.assessmentOptions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: "iw-fieldhelp",
												children: "服务端未给该维度的 assessment 枚举（不可提交，fail-closed）。"
											}) : null
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "iw-field",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											"score（仅 MET / NOT_MET，",
											dimension.scoreMin,
											"–",
											dimension.scoreMax,
											" 的整数）："
										] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "number",
											"data-role": "score",
											"data-dim-key": dimension.key,
											"aria-label": `维度 ${dimension.label} 的 score`,
											min: dimension.scoreMin,
											max: dimension.scoreMax,
											step: 1,
											disabled: readonly || !scoreEnabled(dimension.key)
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "iw-field",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											"note（",
											dimension.noteRequired ? "必填" : "可选",
											"，≤2000 字）："
										] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
											"data-role": "note",
											"data-dim-key": dimension.key,
											"aria-label": `维度 ${dimension.label} 的 note`,
											rows: 2,
											maxLength: 2e3,
											disabled: readonly
										})]
									})
								]
							}, dimension.key);
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
							className: "iw-fieldset",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: "综合结论（overall）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "iw-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "overall：" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										"data-role": "overall",
										"aria-label": "overall 综合结论",
										defaultValue: "",
										disabled: readonly || spec.overall_options.length === 0,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: spec.overall_options.length === 0 ? "服务端未提供 overall 选项（fail-closed）" : "请选择"
										}), spec.overall_options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: option,
											children: overallText(option)
										}, option))]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "iw-fieldhelp",
										children: "枚举只来自服务端；选择 REJECT 时服务端要求拒绝理由（本版表单未提供该输入，可能被服务端拒绝——不本地编造）。"
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "iw-modalend",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "iw-btn",
								onClick: props.onClose,
								children: "取消"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								"data-testid": "submit-scorecard",
								className: "iw-btn iw-btn-blue",
								disabled: submitDisabled,
								children: submitting ? "正在提交…" : "提交我的独立面评"
							})]
						})
					]
				}),
				validationError !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "iw-validation",
					role: "alert",
					"data-testid": "form-validation-error",
					children: validationError
				}) : null,
				submitFailure !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-errorbox",
					role: "alert",
					"data-testid": "submit-error",
					"data-code": submitFailure.code,
					"data-reason-code": submitFailure.reasonCode,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "提交失败（服务端返回）" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: submitFailure.message }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							"code：",
							submitFailure.code !== "" ? submitFailure.code : "（无）",
							" · reason_code：",
							submitFailure.reasonCode !== "" ? submitFailure.reasonCode : "（无）"
						] }),
						nonceProblem ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "iw-btn iw-btn-sm",
							"data-testid": "scorecard-refetch",
							onClick: () => {
								setSpec(void 0);
								setGeneration((value) => value + 1);
							},
							children: "重新获取表单（新 nonce）"
						}) }) : null
					]
				}) : null,
				result !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-result",
					"data-testid": "submit-result",
					"data-scorecard-id": result.scorecard_id,
					"data-status": result.status,
					"data-actor-id": result.actor_id,
					"data-record-version": String(result.record_version),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "提交成功：服务端 DB 读回" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["scorecard_id：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: result.scorecard_id !== "" ? result.scorecard_id : "（服务端未返回）" })] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							"status：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: result.status !== "" ? result.status : "（服务端未返回）" }),
							" · record_version：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: result.record_version }),
							" · replayed：",
							result.replayed ? "是" : "否"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["actor_id：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: result.actor_id !== "" ? result.actor_id : "（服务端未返回）" })] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							"interviewer_id：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: result.interviewer_id !== "" ? result.interviewer_id : "（服务端未返回）" }),
							" · interview_id：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: result.interview_id !== "" ? result.interview_id : "（服务端未返回）" })
						] }),
						result.scorecard_id === "" || result.status === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "服务端读回不完整（缺 scorecard_id/status），请勿仅凭本回显认定已写库。" }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "已重新读取「我的面试」（overview reload）。" })
					]
				}) : null
			] }));
		}
		// src/client/interviewer/styles.ts
		/** 工作台样式（字符串，由组件用 `<style>` 注入一次）。 */
		const INTERVIEWER_CSS = `
.iw-root{
  --iw-bg:#f8f9fb;--iw-surface:#fff;--iw-text:#29384d;--iw-sub:#64738a;--iw-dim:#8b97a8;
  --iw-border:#e7ebf1;--iw-border2:#d6dfeb;--iw-blue:#496cad;--iw-blue2:#365891;--iw-bluebg:#edf3fc;
  --iw-green:#347b65;--iw-greenbg:#eaf6f0;--iw-amber:#97743b;--iw-amberbg:#fcf6e9;
  --iw-red:#a45450;--iw-redbg:#fff0ef;--iw-shadow:0 4px 22px rgba(40,55,80,.027);--iw-radius:14px;
  box-sizing:border-box;min-height:100%;padding:26px 30px 44px;background:var(--iw-bg);color:var(--iw-text);
  font-family:Inter,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.65;
  -webkit-font-smoothing:antialiased;
}
.iw-root *,.iw-root *::before,.iw-root *::after{box-sizing:border-box}
.iw-root h1,.iw-root h2,.iw-root h3,.iw-root p,.iw-root ul,.iw-root li,.iw-root figure{margin:0;padding:0}
.iw-root ul{list-style:none}
.iw-root h1{font-size:24px;line-height:1.45;font-weight:720;letter-spacing:-.7px}
.iw-root h2{font-size:17px;line-height:1.5;font-weight:680;letter-spacing:-.3px}
.iw-root h3{font-size:14px;font-weight:680}
.iw-root small{font-size:12px}
.iw-root button{font:inherit;cursor:pointer}
.iw-root button:disabled{opacity:.45;cursor:not-allowed}
.iw-root button:focus-visible,.iw-root select:focus-visible,.iw-root input:focus-visible,.iw-root textarea:focus-visible{outline:2px solid #92afe3;outline-offset:2px}
.iw-root code,.iw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;overflow-wrap:anywhere}

/* ---------- 版式骨架 ---------- */
.iw-view{max-width:1218px;margin:0 auto;min-width:0}
.iw-actorline{font-size:11px;color:var(--iw-dim);margin-bottom:10px;overflow-wrap:anywhere}
.iw-actorline strong{color:var(--iw-sub);font-weight:670}
.iw-cap{font-size:11px;font-weight:720;letter-spacing:.65px;color:#8290a2}
.iw-headline{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:22px;flex-wrap:wrap}
.iw-headline .iw-sub{color:var(--iw-sub);font-size:13px;margin-top:7px;max-width:720px}
.iw-headline-main{min-width:0}
.iw-gridwork{display:grid;grid-template-columns:minmax(0,1.73fr) minmax(273px,.78fr);gap:19px;align-items:start}
.iw-detailgrid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(260px,.77fr);gap:19px;align-items:start}
.iw-min{min-width:0}
.iw-aside,.iw-detailaside{display:flex;flex-direction:column;gap:15px;min-width:0}
.iw-back{border:0;background:transparent;color:#7c8aa0;padding:0;margin-bottom:16px;font-size:12px}
.iw-back:hover{color:var(--iw-blue2);text-decoration:underline}

/* ---------- 卡片 ---------- */
.iw-paper{background:var(--iw-surface);border:1px solid var(--iw-border);border-radius:var(--iw-radius);box-shadow:var(--iw-shadow);min-width:0}
.iw-hero{padding:24px 26px}
.iw-hero h2{font-size:22px;margin-top:6px}
.iw-hero p{font-size:13px;color:var(--iw-sub);margin-top:7px;max-width:560px}
.iw-asidecard{padding:20px}
.iw-asidecard h2{font-size:14px;margin-bottom:10px}
.iw-actionbox{padding:18px 19px}
.iw-actionbox strong{font-size:13px;display:block;margin-bottom:6px}
.iw-actionbox p{font-size:12px;color:#718096;line-height:1.85;margin-top:5px}
.iw-detailmain{padding:24px 26px}
.iw-insight{background:#f6f8fb;border:1px solid #edf1f6;border-radius:12px;padding:16px 18px}
.iw-insight h3{font-size:13px}
.iw-insight p{margin-top:7px;font-size:13px;color:#516177;line-height:1.9}
.iw-divider{height:1px;background:var(--iw-border);margin:18px 0}
.iw-note{background:#fcf6e9;border:1px solid #f3e9d7;border-radius:10px;padding:10px 12px;color:#8a6a34;font-size:12px;line-height:1.8;margin-top:10px}
.iw-notice{padding:16px 18px;border-radius:12px;border:1px solid var(--iw-border);background:#fff;margin:0 0 14px}
.iw-notice strong{display:block;font-size:13px;line-height:1.7}
.iw-notice p{font-size:12px;color:var(--iw-sub);margin-top:6px}
.iw-notice-warn{background:#fff9ee;border-color:#f3e9d7;color:#8a6a34}
.iw-notice-error{background:var(--iw-redbg);border-color:#f2d8d5;color:var(--iw-red)}
.iw-notice-error p{color:#9a615c}
.iw-empty{padding:22px 20px;color:var(--iw-sub);font-size:13px}
.iw-muted{color:var(--iw-sub)}
.iw-tiny{font-size:11px;line-height:1.8}
.iw-dimtext{color:var(--iw-dim)}

/* ---------- 统计 ---------- */
.iw-metrics{display:flex;flex-wrap:wrap;gap:0;margin-top:19px;padding:17px 0 14px;border-top:1px solid var(--iw-border);border-bottom:1px solid var(--iw-border)}
.iw-metric{flex:1 1 0;min-width:96px;border-right:1px solid #edf0f4;padding:0 14px}
.iw-metric:first-child{padding-left:0}
.iw-metric:last-child{border:0}
.iw-metric strong{font-size:22px;line-height:1.3;font-weight:680;color:#394e6b;display:block}
.iw-metric small{display:block;font-size:11px;color:#8190a3;margin-top:6px}

/* ---------- 列表 ---------- */
.iw-sectionhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:24px 1px 11px;flex-wrap:wrap}
.iw-sectionhead h2{font-size:14px}
.iw-sectionhead small{color:var(--iw-dim)}
.iw-list{padding:4px 0}
.iw-appitem{width:100%;border:0;background:transparent;text-align:left;display:flex;align-items:center;gap:12px;padding:15px 16px;border-bottom:1px solid #eff1f5;color:inherit;border-radius:0}
.iw-appitem:last-child{border-bottom:0}
.iw-appitem:hover{background:#fafbfd}
.iw-av{width:35px;height:35px;flex:none;display:grid;place-items:center;border-radius:11px;background:#edf2f7;color:#56718e;font-size:13px;font-weight:680}
.iw-rowmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.iw-rowtitle{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:13px;font-weight:680}
.iw-rowdesc{font-size:11px;color:#8490a3;overflow-wrap:anywhere}
.iw-chev{color:#a8b3c2;font-size:18px;flex:none}
.iw-rowstate{flex:none}

/* ---------- chip / 标签 ---------- */
.iw-chip{display:inline-flex;align-items:center;gap:5px;border-radius:7px;padding:4px 8px;background:#f2f4f7;color:#66768a;font-weight:650;font-size:11px;white-space:nowrap;max-width:100%}
.iw-chip-blue{background:var(--iw-bluebg);color:var(--iw-blue2)}
.iw-chip-green{background:var(--iw-greenbg);color:var(--iw-green)}
.iw-chip-amber{background:var(--iw-amberbg);color:var(--iw-amber)}
.iw-chip-red{background:var(--iw-redbg);color:var(--iw-red)}
.iw-labels{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.iw-dot{width:7px;height:7px;border-radius:100%;background:#bdc7d3;flex:none;display:inline-block;margin-top:7px}
.iw-dot-blue{background:#7899d4}
.iw-dot-green{background:#6fae93}
.iw-dot-amber{background:#d3aa68}
.iw-dot-red{background:#c98378}

/* ---------- 考察重点 ---------- */
.iw-criteria{display:flex;flex-direction:column;margin-top:4px}
.iw-criteriarow{display:flex;gap:9px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #eff2f5;font-size:12px;color:#69788d;overflow-wrap:anywhere}
.iw-criteriarow:last-child{border-bottom:0}
.iw-criteriarow strong{font-size:12px;color:var(--iw-text);font-weight:670}
.iw-criteriaweight{margin-left:auto;color:var(--iw-dim);font-size:10px;white-space:nowrap;padding-left:8px}
.iw-subhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:20px 0 10px;flex-wrap:wrap}
.iw-subhead h2{font-size:14px}
.iw-subhead small{color:var(--iw-dim)}

/* ---------- 折叠块 ---------- */
.iw-collapse{margin-top:10px;padding:14px 16px}
.iw-collapse summary{cursor:pointer;font-weight:670;font-size:12px;color:#566780}
.iw-collapse > div{margin-top:12px}
.iw-sourcebox{padding:15px;background:#fbfcfd;border:1px solid var(--iw-border);border-radius:11px;white-space:pre-wrap;color:#53647a;font-size:12px;line-height:1.9;overflow-wrap:anywhere;max-height:320px;overflow:auto}
.iw-materials{display:flex;flex-direction:column;gap:0}
.iw-materialrow{display:grid;grid-template-columns:minmax(90px,150px) minmax(0,1fr);gap:10px;padding:8px 0;border-bottom:1px solid #f1f3f6;font-size:12px}
.iw-materialrow:last-child{border-bottom:0}
.iw-materialrow dt{color:var(--iw-sub);font-weight:650;overflow-wrap:anywhere}
.iw-materialrow dd{margin:0;color:#4c5c72;overflow-wrap:anywhere;white-space:pre-wrap}

/* ---------- 两个独立分支（材料 / 面评） ---------- */
.iw-branch{margin-top:14px;padding:17px 18px}
.iw-branch strong.iw-branchtitle{display:block;font-size:13px;margin-bottom:5px}
.iw-branchstate{font-size:12px;color:#4c5c72;margin-top:3px}
.iw-branch .iw-tiny{color:var(--iw-sub);margin-top:4px}
.iw-branch-sep{border:0;border-top:1px solid var(--iw-border);margin:12px 0 10px}
.iw-inlineactions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px}
.iw-roundgroup{padding:10px 0;border-bottom:1px solid var(--iw-border);min-width:0}
.iw-roundgroup:last-child{border-bottom:0}
.iw-roundgroup strong{font-size:12px;display:block;overflow-wrap:anywhere}
.iw-loading{padding:10px 0;color:var(--iw-sub);font-size:13px}

/* ---------- 按钮 ---------- */
.iw-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--iw-border2);background:#fff;color:#566780;padding:9px 13px;min-height:36px;border-radius:9px;font-size:12px;font-weight:660;transition:background .15s}
.iw-btn:hover{background:#f5f8fd}
.iw-btn-blue{background:var(--iw-blue);color:#fff;border-color:var(--iw-blue)}
.iw-btn-blue:hover{background:var(--iw-blue2)}
.iw-btn-sm{min-height:30px;padding:5px 10px;font-size:11px}
.iw-x{border:0;background:#f3f5f8;border-radius:8px;font-size:20px;color:#66768c;line-height:1;height:30px;width:30px;flex:none}

/* ---------- 表单弹层 ---------- */
.iw-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(27,37,53,.26);overflow:auto}
.iw-modal{width:min(560px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;border-radius:15px;box-shadow:0 20px 70px rgba(25,38,60,.18);padding:24px 25px;min-width:0}
.iw-modaltop{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}
.iw-modaltop h2{font-size:19px}
.iw-modaldesc{color:#7a899b;font-size:12px;margin-top:7px;line-height:1.8}
.iw-form{margin-top:14px;min-width:0}
.iw-fieldset{border:1px solid var(--iw-border);border-radius:11px;padding:12px 14px 14px;margin:0 0 11px;min-width:0}
.iw-fieldset legend{font-size:12px;font-weight:680;color:#53657c;padding:0 4px;overflow-wrap:anywhere}
.iw-field{margin-top:10px;min-width:0}
.iw-field label,.iw-field > span{display:block;font-size:11px;color:#6d7c91;margin-bottom:3px}
.iw-field select,.iw-field input,.iw-field textarea{width:100%;border:1px solid var(--iw-border2);background:#fff;border-radius:8px;padding:7px 9px;color:var(--iw-text);font-size:12px;font-family:inherit}
.iw-field textarea{resize:vertical;line-height:1.7}
.iw-field input:disabled,.iw-field select:disabled,.iw-field textarea:disabled{background:#f7f9fb;color:#8b97a8}
.iw-fieldhelp{font-size:10px;color:var(--iw-dim);margin-top:3px}
.iw-modalend{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:18px;flex-wrap:wrap}
.iw-lockline{font-size:11px;color:var(--iw-sub);margin:10px 0;overflow-wrap:anywhere}
.iw-result{margin-top:14px;padding:14px 16px;border:1px solid #cfe6d9;background:var(--iw-greenbg);border-radius:11px;color:#2f5d4d;font-size:12px;line-height:1.9;overflow-wrap:anywhere}
.iw-result strong{display:block;font-size:13px;margin-bottom:4px}
.iw-result code{font-size:11px;color:#315f50}
.iw-errorbox{margin-top:14px;padding:13px 15px;border:1px solid #f2d8d5;background:var(--iw-redbg);border-radius:11px;color:var(--iw-red);font-size:12px;line-height:1.85;overflow-wrap:anywhere}
.iw-errorbox strong{display:block;font-size:12px;margin-bottom:4px}
.iw-validation{margin-top:12px;padding:10px 12px;border-radius:9px;background:#fff9ee;border:1px solid #f3e9d7;color:#8a6a34;font-size:12px;overflow-wrap:anywhere}
.iw-formloading{padding:10px 0;color:var(--iw-sub);font-size:13px}

/* ---------- 断点 ---------- */
@media (max-width:1100px){
  .iw-root{padding:24px 22px 40px}
  .iw-gridwork{grid-template-columns:minmax(0,1.4fr) minmax(255px,.78fr)}
  .iw-detailgrid{grid-template-columns:minmax(0,1.3fr) minmax(240px,.7fr)}
}
@media (max-width:850px){
  .iw-root{padding:20px 18px 34px}
  .iw-gridwork,.iw-detailgrid{grid-template-columns:1fr}
  .iw-aside,.iw-detailaside{display:grid;grid-template-columns:1fr 1fr;gap:13px}
  .iw-headline{align-items:flex-start}
  .iw-headline h1{font-size:21px}
  .iw-modal{width:100%;padding:20px 18px}
  .iw-materialrow{grid-template-columns:minmax(0,1fr)}
  .iw-materialrow dt{padding-top:2px}
}
@media (max-width:570px){
  .iw-root{padding:16px 13px 28px}
  .iw-hero{padding:19px 16px}
  .iw-hero h2{font-size:20px}
  .iw-hero p{font-size:12px}
  .iw-metric{padding:0 9px;min-width:78px}
  .iw-metric strong{font-size:18px}
  .iw-metric small{font-size:10px}
  .iw-aside,.iw-detailaside{display:flex;flex-direction:column}
  .iw-detailmain{padding:18px 15px}
  .iw-appitem{padding:13px 11px;gap:9px;flex-wrap:wrap}
  .iw-rowstate{margin-left:auto}
  .iw-sectionhead{margin-top:20px}
  .iw-headline{gap:9px}
  .iw-headline h1{font-size:20px}
  .iw-overlay{padding:9px}
  .iw-modal{padding:17px 14px;max-height:calc(100vh - 18px)}
  .iw-modalend{justify-content:stretch}
  .iw-modalend .iw-btn{flex:1 1 auto}
  .iw-chip{white-space:normal;text-align:left}
}

/* ---------- 轮次级考察重点 / 本轮评分表（W3b，task-50） ---------- */
.iw-roundcard,.iw-schema{margin-top:15px;padding:17px 19px}
.iw-roundtitle{font-size:15px;font-weight:650;color:var(--iw-text);margin:2px 0 6px;overflow-wrap:anywhere}
.iw-roundcard .iw-subhead,.iw-schema .iw-subhead{margin-top:0}
.iw-roundcard .iw-criteria{margin-top:8px}
.iw-roundcard .iw-criteriarow{align-items:flex-start;gap:8px;flex-wrap:wrap}
.iw-roundcard .iw-chip,.iw-schema .iw-chip{margin-left:6px}
.iw-roundcard .iw-notice,.iw-schema .iw-notice{margin-top:10px}
.iw-schemalist{margin-top:10px;display:flex;flex-direction:column;gap:9px;min-width:0}
.iw-schemarow{border:1px solid var(--iw-border);border-radius:10px;padding:10px 12px;min-width:0;
  display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere;word-break:break-word}
.iw-schemarow-main{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0}
.iw-schemarow-main strong{overflow-wrap:anywhere}
.iw-schemarow-chips{display:flex;flex-wrap:wrap;gap:5px}
.iw-roundctx{margin:10px 0 2px;padding:11px 13px;border:1px solid var(--iw-border);border-radius:10px;
  background:var(--iw-bluebg);min-width:0;overflow-wrap:anywhere}
.iw-roundctx strong{display:block;font-size:12px;margin-bottom:3px}
.iw-roundctx p{margin:2px 0}
@media (max-width:570px){
  .iw-roundcard,.iw-schema{padding:14px 13px}
  .iw-schemarow{padding:9px 10px}
  .iw-roundcard .iw-criteriarow,.iw-schemarow-main,.iw-schemarow-chips{min-width:0}
}
`;
		// src/client/interviewer/InterviewerWorkspace.tsx
		/**
		* 身份绑定竞态的退避序列（毫秒）：W0 shell 先改 alias props、再 await PUT /actor，
		* 服务端 registry 落定前的 403/409 属于可重试时序；7 次约 3.2s，足够覆盖本地 PUT 往返，
		* 又不至于让真正的未绑定错误长时间被 loading 掩盖。
		*/
		const BINDING_RETRY_DELAYS_MS = [
			400,
			400,
			450,
			450,
			500,
			500,
			500
		];
		/** 把任意错误拆成可展示字段（网络层失败 status=0）。 */
		function describeError(failure) {
			if (failure instanceof RecruitmentHttpError) return {
				code: failure.code,
				reasonCode: failure.reasonCode,
				message: failure.message,
				status: failure.status
			};
			return {
				code: "",
				reasonCode: "",
				message: failure instanceof Error ? failure.message : String(failure),
				status: 0
			};
		}
		/** 候选人头像首字（空名不造字，用 '?' 明确表示"服务端未提供"）。 */
		function candidateInitial(displayName) {
			const text = displayName.trim();
			if (text === "") return "?";
			const first = Array.from(text)[0];
			return first === void 0 ? "?" : first;
		}
		/** 行状态 chip 的中文（只映射服务端字段，不推断阶段）。 */
		function rowStatusText(row) {
			if (row.scorecard.state === "SUBMITTED") return "面评已提交";
			if (row.scorecard.state === "WAIVED") return "面评已豁免";
			if (row.required_action === "SUBMIT_SCORECARD") return "待提交面评";
			return requiredActionText(row.required_action);
		}
		/** 行状态 chip 的颜色（蓝=待我做，绿=已完成，琥珀=已豁免/待定）。 */
		function rowStatusClass(row) {
			if (row.scorecard.state === "SUBMITTED") return "iw-chip-green";
			if (row.scorecard.state === "WAIVED") return "iw-chip-amber";
			if (row.required_action === "SUBMIT_SCORECARD") return "iw-chip-blue";
			return "";
		}
		/** 行副标题：岗位 · 轮次目标 · 时间（缺什么就显示"未提供"，不编造）。 */
		function rowSummaryText(row) {
			const jobText = row.job.title !== "" ? row.job.title : row.job.code !== "" ? row.job.code : "岗位未提供";
			const objective = row.brief.objective !== "" ? row.brief.objective : row.brief.source === "NONE" ? "无本轮简报" : "本轮目标未提供";
			const time = formatSlotTime(row.scheduled_start_at, row.timezone);
			return `${jobText} · ${objective} · ${time !== "" ? time : "待安排"}`;
		}
		/** 授权材料不可用时的说明（服务端 reason 优先，空则给通用事实）。 */
		function materialsUnavailableText(row) {
			const reason = row.materials.reason;
			if (reason !== "") return `材料暂不可用（服务端 reason：${reason}）。`;
			if (row.materials.resume !== null) return "材料暂不可用（服务端未给出原因）。";
			return "服务端未绑定可读的简历材料（不展示占位内容）。";
		}
		/** 打开"提交我的独立面评"的按钮被禁用的原因（说清事实，不给假按钮）。 */
		function openScorecardDisabledReason(row) {
			if (row.scorecard.state === "SUBMITTED") return "本轮面评已提交；修订需要服务端 revision 闭环，本版不开放。";
			if (row.scorecard.state === "WAIVED") return "本轮面评已豁免，不再重复提交。";
			if (row.role_in_interview !== "INTERVIEWER") return "当前身份不是这场面试的登记面试官，不能提交面评。";
			return "服务端未把该行标记为“待提交面评”，本版不开放提交。";
		}
		/** 一条列表行（整行可点，进入详情）。 */
		function InterviewListItem({ row, onSelect }) {
			const candidateName = row.candidate.display_name !== "" ? row.candidate.display_name : "（候选人未提供）";
			const roundLabel = row.round_no > 0 ? `第 ${row.round_no} 轮` : "轮次未提供";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "iw-appitem",
				"data-testid": "interviewer-row",
				"data-interview-id": row.interview_id,
				"data-scorecard-state": row.scorecard.state,
				"data-transcript-state": row.transcript.state,
				onClick: () => onSelect(row.interview_id),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "iw-av",
						"aria-hidden": true,
						children: candidateInitial(candidateName)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "iw-rowmain",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "iw-rowtitle",
							children: [candidateName, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "iw-chip iw-chip-blue",
								children: roundLabel
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "iw-rowdesc",
							children: rowSummaryText(row)
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: `iw-chip ${rowStatusClass(row)} iw-rowstate`,
						children: rowStatusText(row)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "iw-chev",
						"aria-hidden": true,
						children: "›"
					})
				]
			}) });
		}
		/**
		* 本轮考察重点卡（task-50 `round_focus`）。
		*
		* 两条硬规则：
		*   * `available=true` 才渲染标题/描述/重点维度/问题；`available=false`（JOB_BASE 降级）只显示
		*     降级说明 + 服务端 reason，**绝不**把岗位 Rubric 维度冒充"本轮重点"。
		*   * 旧的 `brief.focus` 不再重复渲染成"本轮考察重点"（由本卡承担）；旧端点降级（
		*     `serverFieldsMissing`）时才回退显示 brief focus，并明确标注"旧 brief 来源"。
		*/
		function RoundFocusCard({ row }) {
			const round = row.round;
			const focus = round.focus;
			const legacy = round.serverFieldsMissing;
			const displaySource = legacy || !focus.available ? "JOB_BASE" : focus.source;
			const sourceText = !focus.available ? round.conflict ? "轮次配置不适用（冲突，详见下方）：按 JOB_BASE 降级，不伪造本轮重点" : roundSourceText("JOB_BASE", legacy) : roundSourceText(focus.source, legacy);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "iw-paper iw-roundcard",
				"data-testid": "round-focus-card",
				"data-source": displaySource,
				"data-round-no": row.round_no,
				"data-available": focus.available ? "1" : "0",
				"data-dimension-count": round.rubric.dimensions.length,
				"data-rubric-version-id": round.rubric.rubricVersionId,
				"data-server-fields-missing": legacy ? "1" : "0",
				"data-conflict": round.conflict ? "1" : "0",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "iw-subhead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "本轮考察重点" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
							"第 ",
							row.round_no > 0 ? row.round_no : "?",
							" 轮 · 只读 · 服务端权威"
						] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "iw-tiny iw-muted",
						"data-testid": "round-focus-source",
						"data-source": displaySource,
						children: ["来源：", sourceText]
					}),
					focus.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-roundtitle",
							"data-testid": "round-focus-title",
							children: focus.title !== "" ? focus.title : "（服务端未提供本轮标题）"
						}),
						focus.description !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-tiny",
							"data-testid": "round-focus-description",
							children: focus.description
						}) : null,
						focus.focusDimensions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-muted iw-tiny",
							children: "服务端未提供本轮重点维度（不伪造）。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "iw-criteria",
							"data-testid": "round-focus-dimensions",
							children: focus.focusDimensions.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "iw-criteriarow",
								"data-focus-key": item.key,
								"data-must-cover-key": item.key,
								"data-required": item.required ? "1" : "0",
								"data-in-rubric": item.inRubric ? "1" : "0",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "iw-dot iw-dot-blue",
										"aria-hidden": true
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
											index + 1,
											". ",
											item.label
										] }),
										item.required ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-chip iw-chip-blue",
											children: "模板必覆盖"
										}) : null,
										!item.inRubric ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-chip iw-chip-amber",
											children: "不在评分维度"
										}) : null
									] }),
									item.weight !== 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "iw-criteriaweight",
										children: ["权重 ", item.weight]
									}) : null
								]
							}, item.key !== "" ? item.key : `${item.label}-${index}`))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
							className: "iw-paper iw-collapse",
							"data-testid": "round-questions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [
								"本轮建议问题（",
								focus.questions.length,
								"）"
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: focus.questions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "iw-muted iw-tiny",
								children: "服务端未提供本轮建议问题（不伪造）。"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "iw-sourcebox",
								children: focus.questions.map((question) => `• ${question.text}`).join("\n")
							}) })]
						})
					] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "iw-notice iw-notice-warn",
						"data-testid": "round-focus-degraded",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "JOB_BASE 降级（服务端未提供该轮配置）" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: roundFocusDegradedText(round) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "评分维度见下方「本轮评分表 · effective schema」（岗位底座）。" })
						]
					}),
					legacy && row.brief.focus.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "iw-paper iw-collapse",
						"data-testid": "legacy-brief-focus",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [
							"旧 brief 考察重点（",
							row.brief.focus.length,
							"，非轮次配置 · 来源：",
							briefSourceText(row.brief.source),
							"）"
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-tiny iw-muted",
							children: "旧端点没有 round_focus；以下为 brief 来源，不能当作轮次配置。"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "iw-criteria",
							children: row.brief.focus.map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "iw-criteriarow",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "iw-dot iw-dot-blue",
									"aria-hidden": true
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.label })]
							}, item.key !== "" ? item.key : `${item.label}-${index}`))
						})] })]
					}) : null,
					round.conflict && round.conflictReason !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "iw-notice iw-notice-warn",
						"data-testid": "round-conflict",
						children: round.conflictReason
					}) : null
				]
			});
		}
		/**
		* 本轮评分表（`effective_rubric`）只读表：维度 key/kind/weight/重点/必覆盖/来源。
		*
		* `available=false` → 显示"服务端明确无可用评分标准"（不渲染空占位维度）。
		*/
		function RoundRubricTable({ row }) {
			const round = row.round;
			const rubric = round.rubric;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "iw-paper iw-schema",
				"data-testid": "round-scorecard-schema",
				"data-source": rubric.source !== "" ? rubric.source : "JOB_BASE",
				"data-rubric-version-id": rubric.rubricVersionId,
				"data-scale-min": rubric.scaleMin,
				"data-scale-max": rubric.scaleMax,
				"data-field-count": rubric.dimensions.length,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "iw-subhead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "本轮评分表 · effective schema" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: ["只读 · ", roundSourceText(rubric.source, round.serverFieldsMissing)] })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "iw-tiny iw-muted",
						children: [
							"分数区间：",
							rubric.scaleMin === 0 && rubric.scaleMax === 0 ? "服务端未提供分数区间" : `${rubric.scaleMin}–${rubric.scaleMax}`,
							" · submission rubric：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "iw-mono",
								children: rubric.submissionRubricVersionId !== "" ? rubric.submissionRubricVersionId : "（未提供）"
							})
						]
					}),
					!rubric.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "iw-notice iw-notice-warn",
						"data-testid": "round-schema-unavailable",
						children: rubric.reason !== "" ? rubric.reason : "服务端明确未提供本轮可用评分标准（不伪造维度）。"
					}) : null,
					rubric.available && rubric.dimensions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "iw-muted iw-tiny",
						children: "服务端未提供评分维度（不伪造）。"
					}) : null,
					rubric.dimensions.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "iw-schemalist",
						children: rubric.dimensions.map((dimension) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "iw-schemarow",
							"data-field-key": dimension.key,
							"data-origin": dimension.origin,
							"data-required": dimension.required ? "1" : "0",
							"data-focus": dimension.focus ? "1" : "0",
							"data-must-cover": dimension.mustCover ? "1" : "0",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "iw-schemarow-main",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: dimension.label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "iw-mono iw-tiny",
										children: dimension.key
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "iw-tiny iw-muted",
									children: [
										"kind=",
										dimension.kind !== "" ? dimension.kind : "未提供",
										" · weight=",
										dimension.weight
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "iw-schemarow-chips",
									children: [
										dimension.focus ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-chip iw-chip-blue",
											children: "本轮重点"
										}) : null,
										dimension.mustCover ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-chip iw-chip-green",
											children: "本轮必覆盖"
										}) : null,
										dimension.origin !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-chip",
											children: dimension.origin
										}) : null,
										!dimension.required ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-chip iw-chip-amber",
											children: "服务端标非必答"
										}) : null
									]
								}),
								dimension.question !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "iw-tiny iw-muted",
									children: dimension.question
								}) : null
							]
						}, dimension.key))
					}) : null
				]
			});
		}
		/** 列表页（V-I1）。 */
		function ListView({ overview, stats, rounds, onSelect }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("header", {
				className: "iw-headline",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-headline-main",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "iw-cap",
							children: "INTERVIEW WORKSPACE"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: "我的面试" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-sub",
							children: "只显示分配给我的面试与轮次工作。候选人是招聘业务对象，不是系统用户。"
						})
					]
				})
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "iw-gridwork",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-min",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "iw-paper iw-hero",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "iw-cap",
									children: "当前分配"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h2", { children: [stats.assigned_total, " 项面试工作"] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "Agent 已按本轮招聘标准准备面试简报与建议问题。你负责面试和自己的独立评价。" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "iw-metrics",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "iw-metric",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: stats.open_interview_total }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "待完成面试" })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "iw-metric",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: stats.pending_scorecard_total }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "待提交面评" })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "iw-metric",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: stats.submitted_scorecard_total }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "已提交面评" })]
										})
									]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "iw-sectionhead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "分配给我的工作" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: "按 Interview 分配，不按候选人账号" })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
							className: "iw-paper iw-list",
							children: overview.interviews.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "iw-empty",
								"data-testid": "interviewer-empty",
								children: "分配给你的面试：0 条（服务端按 Interview 分配过滤）"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: overview.interviews.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InterviewListItem, {
								row,
								onSelect
							}, row.interview_id !== "" ? row.interview_id : `row-${row.round_no}-${row.candidate.display_name}`)) })
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
					className: "iw-aside",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "iw-paper iw-asidecard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "分配轮次与考察重点" }), rounds.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-muted iw-tiny",
							children: "打开分配给你的面试后查看对应轮次的考察标准。"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: rounds.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "iw-roundgroup",
							"data-testid": "round-focus-group",
							"data-round-no": group.round_no,
							"data-source": group.source,
							"data-available": group.available ? "1" : "0",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [
									"第 ",
									group.round_no,
									" 轮",
									group.title !== "" ? ` · ${group.title}` : group.objective !== "" ? ` · ${group.objective}` : ""
								] }),
								!group.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "iw-muted iw-tiny",
									"data-testid": "round-focus-group-degraded",
									children: group.source === "LEGACY_BRIEF" ? "旧 brief 来源（服务端未提供轮次配置），按 brief 展示，不代表本轮专属重点。" : "JOB_BASE 降级（服务端未提供该轮配置）；不展示伪造的考察重点。"
								}) : null,
								group.available && group.focus.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "iw-muted iw-tiny",
									children: "服务端未提供考察重点。"
								}) : null,
								group.focus.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "iw-criteria",
									children: group.focus.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "iw-criteriarow",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "iw-dot iw-dot-blue",
												"aria-hidden": true
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.label }),
											item.required ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "iw-chip iw-chip-blue",
												children: "必覆盖"
											}) : null
										]
									}, `${group.round_no}-${item.key}-${item.label}`))
								}) : null
							]
						}, `round-${group.round_no}`)) })]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "iw-paper iw-asidecard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "独立评价" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-muted iw-tiny",
							children: "默认不展示其他面试官的主观评分和私人备注。后续轮次只接收授权的客观摘要。"
						})]
					})]
				})]
			})] });
		}
		/** 详情页（V-I2），含两个独立分支卡片。 */
		function DetailView({ overview, row, labels, endpointUnavailable, onBack, onOpenScorecard }) {
			const candidateName = row.candidate.display_name !== "" ? row.candidate.display_name : "（候选人未提供）";
			const jobText = row.job.title !== "" ? row.job.title : row.job.code !== "" ? row.job.code : "岗位未提供";
			const roundText = row.round_no > 0 ? `第 ${row.round_no} 轮` : "轮次未提供";
			const objectiveText = row.brief.objective !== "" ? row.brief.objective : "";
			const actorText = overview.actor.display_name !== "" ? overview.actor.display_name : "（身份显示名未提供）";
			const briefText = row.brief.briefing !== "" ? row.brief.briefing : row.brief.objective;
			const canSubmit = canSubmitScorecard(row);
			const materialFields = row.materials.resume !== null ? materialFieldEntries(row.materials.resume.fields) : [];
			const scheduleText = formatSlotRange(row.scheduled_start_at, row.scheduled_end_at, row.timezone);
			const subtitle = [
				jobText,
				roundText,
				objectiveText !== "" ? objectiveText : "本轮目标未提供",
				`当前身份：${actorText}`
			].filter((part) => part !== "").join(" · ");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "iw-back",
					onClick: onBack,
					"data-testid": "back-to-my-interviews",
					children: "← 返回我的面试"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: "iw-headline",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "iw-headline-main",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "iw-cap",
								children: "INTERVIEW WORKSPACE"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: candidateName }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "iw-sub",
								children: subtitle
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: `iw-chip ${rowStatusClass(row)}`,
						children: rowStatusText(row)
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-detailgrid",
					"data-testid": "interviewer-detail",
					"data-interview-id": row.interview_id,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "iw-min",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "iw-paper iw-detailmain",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "iw-insight",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "本轮面试简报" }),
										briefText !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: briefText }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
											"服务端未提供本轮简报",
											row.brief.reason !== "" ? `（${row.brief.reason}）` : "",
											"。"
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-tiny iw-muted",
											children: [
												"来源：",
												briefSourceText(row.brief.source),
												row.brief.template_version_id !== "" ? ` · template_version：${row.brief.template_version_id}` : "",
												row.brief.reason !== "" ? ` · reason：${row.brief.reason}` : ""
											]
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoundFocusCard, { row }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoundRubricTable, { row }),
								row.round.serverFieldsMissing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
									className: "iw-paper iw-collapse",
									"data-testid": "legacy-brief-questions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [
										"旧 brief 建议问题（",
										row.brief.questions.length,
										"，非轮次配置）"
									] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: row.brief.questions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "iw-muted iw-tiny",
										children: "服务端未提供建议问题。"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "iw-sourcebox",
										children: row.brief.questions.map((question) => `• ${question}`).join("\n")
									}) })]
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
									className: "iw-paper iw-collapse",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: "查看招聘方接收的简历材料" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: row.materials.available && row.materials.resume !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										className: "iw-tiny iw-muted",
										children: [
											"授权依据：",
											row.materials.authorization !== "" ? row.materials.authorization : "（服务端未提供）",
											" · parse_status：",
											row.materials.resume.parse_status !== "" ? row.materials.resume.parse_status : "（未提供）",
											" · parser：",
											row.materials.resume.parser_name !== "" ? row.materials.resume.parser_name : "（未提供）",
											row.materials.resume.parser_version !== "" ? ` @ ${row.materials.resume.parser_version}` : ""
										]
									}), materialFields.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "iw-muted iw-tiny",
										children: "服务端未提供可展示的结构化字段（不展示占位文本）。"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", {
										className: "iw-materials",
										children: materialFields.map((field) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "iw-materialrow",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: field.label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: field.value })]
										}, field.key))
									})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "iw-muted iw-tiny",
										children: materialsUnavailableText(row)
									}) })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "iw-paper iw-branch",
									"data-testid": "transcript-branch",
									"data-transcript-state": row.transcript.state,
									"data-reason-code": row.transcript.reason_code,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
											className: "iw-branchtitle",
											children: "材料分支 · Transcript"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-branchstate",
											children: [
												"转写状态：",
												transcriptStateText(row.transcript.state),
												"（",
												row.transcript.state !== "" ? row.transcript.state : "服务端未提供",
												"）"
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-tiny",
											children: [
												"reason_code：",
												row.transcript.reason_code !== "" ? row.transcript.reason_code : "（服务端未提供）",
												" · 会议绑定：",
												meetingBindingStateText(row.transcript.meeting_binding_state),
												" · 会议数：",
												row.transcript.meetings_total
											]
										}),
										row.transcript.state !== "READY" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "iw-note",
											children: "转写缺失不影响你提交面评；服务端会以 NO_TRANSCRIPT 记录并进入人工决策（D-111 / 服务端契约负责）。"
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "iw-tiny iw-muted",
											children: "本卡片只展示转写事实；前端不判断 S8→S9 / S9→S10 能否推进（G3-B 由服务端阶段闸门负责）。"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: "iw-paper iw-branch",
									"data-testid": "scorecard-branch",
									"data-scorecard-state": row.scorecard.state,
									"data-scorecard-id": row.scorecard.scorecard_id,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
											className: "iw-branchtitle",
											children: "面评分支 · 我的独立评价"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-branchstate",
											children: [
												"面评状态：",
												scorecardStateText(row.scorecard.state),
												"（",
												row.scorecard.state !== "" ? row.scorecard.state : "服务端未提供",
												"）"
											]
										}),
										row.scorecard.scorecard_id !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-tiny",
											children: ["scorecard_id：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "iw-mono",
												children: row.scorecard.scorecard_id
											})]
										}) : null,
										row.scorecard.status !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-tiny",
											children: [
												"status：",
												row.scorecard.status,
												" · revision_no：",
												row.scorecard.revision_no,
												" · record_version：",
												row.scorecard.record_version
											]
										}) : null,
										row.scorecard.submitted_at !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-tiny",
											children: ["submitted_at：", formatSlotTime(row.scorecard.submitted_at, row.timezone)]
										}) : null,
										row.scorecard.transcript_basis !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-tiny",
											children: ["transcript_basis：", row.scorecard.transcript_basis]
										}) : null,
										row.scorecard.overall !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: "iw-tiny",
											children: ["overall：", row.scorecard.overall]
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "iw-tiny iw-muted",
											children: "只显示你本人的面评；其他面试官的主观评分与私人备注默认不展示。"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "iw-divider" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "iw-inlineactions",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											"data-testid": "open-scorecard",
											className: "iw-btn iw-btn-blue",
											disabled: !canSubmit || endpointUnavailable,
											onClick: () => onOpenScorecard(row),
											children: "提交我的独立面评"
										}),
										endpointUnavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-tiny iw-muted",
											"data-testid": "scorecard-unavailable-note",
											children: "服务端面评提交入口未就绪（W1）"
										}) : null,
										!canSubmit && !endpointUnavailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "iw-tiny iw-muted",
											children: openScorecardDisabledReason(row)
										}) : null
									]
								})
							]
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
						className: "iw-detailaside",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "iw-paper iw-actionbox",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "面试安排" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: scheduleText !== "" ? scheduleText : "时间未提供" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "iw-tiny iw-muted",
									children: [
										"时区：",
										row.timezone !== "" ? row.timezone : "（服务端未提供）",
										" · 面试状态：",
										row.status !== "" ? row.status : "（未提供）",
										" · slot：",
										row.slot_code !== "" ? row.slot_code : "（未提供）"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "iw-tiny",
									children: ["会议绑定：", meetingBindingStateText(row.transcript.meeting_binding_state)]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "iw-tiny",
									children: ["转写状态：", transcriptStateText(row.transcript.state)]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "iw-tiny",
									children: ["面试 id：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "iw-mono",
										children: row.interview_id !== "" ? row.interview_id : "（未提供）"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "iw-labels",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "iw-chip iw-chip-blue",
											children: ["provenance：", labels.provenance !== "" ? labels.provenance : "未提供"]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "iw-chip",
											children: ["trigger：", labels.trigger !== "" ? labels.trigger : "未提供"]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "iw-chip iw-chip-green",
											children: ["connection：", labels.connection !== "" ? labels.connection : "未提供"]
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "iw-tiny iw-muted",
									children: ["服务端评估时间（as_of）：", overview.evaluated_at !== "" ? overview.evaluated_at : "（未提供）"]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
							className: "iw-paper iw-actionbox",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "信息可见范围" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "可查看分配给你的面试、本轮 Rubric、授权材料；其他面试官的主观评分与私人备注默认不展示。" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "iw-tiny iw-muted",
									children: "Provenance / trigger / connection 由服务端按租户现算，前端不重贴标签。"
								})
							]
						})]
					})]
				})
			] });
		}
		/** 未绑定身份的 fail-closed 提示（不显示任何面试）。 */
		function UnboundBlock({ missingSession, missingAlias, parts }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "iw-notice iw-notice-warn",
				"data-testid": "actor-unmapped",
				"data-code": parts !== void 0 && parts.code !== "" ? parts.code : "DEMO_ACTOR_UNMAPPED",
				"data-reason-code": parts !== void 0 ? parts.reasonCode : "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "iw-cap",
						children: "INTERVIEW WORKSPACE"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "当前 Session 尚未绑定演示身份（fail-closed）：请先在顶部选择身份" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: missingSession ? "未取得 DSH Session（localStorage 无 dsh.sessions.current），本视图不会用默认身份读数据。" : missingAlias ? "尚未选择 Demo 身份（alias 为空），本视图不会用默认身份读数据。" : "服务端返回 409 DEMO_ACTOR_UNMAPPED；本视图不显示任何面试。" }),
					parts !== void 0 && parts.message !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["服务端说明：", parts.message] }) : null
				]
			});
		}
		/** 读取失败提示（不是"0 条"）。 */
		function OverviewErrorBlock({ parts, onRetry }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "iw-notice iw-notice-error",
				role: "alert",
				"data-testid": "overview-error",
				"data-code": parts.code,
				"data-reason-code": parts.reasonCode,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["读取「我的面试」失败（不是“0 条”）：", parts.message] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						"HTTP ",
						parts.status,
						" · code：",
						parts.code !== "" ? parts.code : "（无）",
						" · reason_code：",
						parts.reasonCode !== "" ? parts.reasonCode : "（无）"
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "故障不会被显示成空分配；请重试，或先在顶部选择 Demo 身份。" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "iw-btn iw-btn-sm",
						onClick: onRetry,
						"data-testid": "overview-retry",
						children: "重试"
					})
				]
			});
		}
		/** 数据库未配置提示（服务端 configured=false；不给假数据）。 */
		function NotConfiguredBlock({ overview }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "iw-notice",
				"data-testid": "overview-not-configured",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "数据库未配置，暂时读不到面试工作" }),
					overview.issues.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["缺少：", overview.issues.join("；")] }) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "这是配置故障，不是“0 条分配”。" })
				]
			});
		}
		/**
		* 面试官工作台（main 面板内容）。
		* @param props - sessionId / alias（只来自 W0 shell）。
		* @returns 工作台 JSX（列表或详情，单页内切换）。
		*/
		function InterviewerWorkspace(props) {
			const sessionId = (props.sessionId ?? "").trim();
			const alias = (props.alias ?? "").trim();
			const missingSession = props.sessionId === null || sessionId === "";
			const missingAlias = props.alias === null || alias === "";
			const missingBinding = missingSession || missingAlias;
			const [overview, setOverview] = (0, react.useState)(void 0);
			const [loadFailure, setLoadFailure] = (0, react.useState)(void 0);
			const [loading, setLoading] = (0, react.useState)(!missingBinding);
			/** true = 正在等待 shell 的 PUT /actor 落定（loading 文案切换成"正在绑定演示身份…"）。 */
			const [bindingPending, setBindingPending] = (0, react.useState)(false);
			const [generation, setGeneration] = (0, react.useState)(0);
			const [selectedId, setSelectedId] = (0, react.useState)("");
			const [formTarget, setFormTarget] = (0, react.useState)(null);
			const [endpointUnavailable, setEndpointUnavailable] = (0, react.useState)(false);
			/** 重新 GET 服务端（提交成功后 / 手动重试都走这里，绝不本地改计数）。 */
			const reload = (0, react.useCallback)(() => {
				setGeneration((value) => value + 1);
			}, []);
			(0, react.useEffect)(() => {
				setSelectedId("");
				setFormTarget(null);
				setEndpointUnavailable(false);
			}, [sessionId, alias]);
			(0, react.useEffect)(() => {
				if (missingBinding) {
					setOverview(void 0);
					setLoadFailure(void 0);
					setBindingPending(false);
					setLoading(false);
					return;
				}
				const controller = new AbortController();
				let active = true;
				let timer;
				setLoading(true);
				setBindingPending(false);
				/** 可被 Abort 打断的等待（卸载/身份变化立即返回，不留下悬挂的定时器）。 */
				const delay = (ms) => new Promise((resolve) => {
					timer = setTimeout(() => {
						timer = void 0;
						resolve();
					}, ms);
					controller.signal.addEventListener("abort", () => {
						if (timer !== void 0) {
							clearTimeout(timer);
							timer = void 0;
						}
						resolve();
					}, { once: true });
				});
				const load = async () => {
					for (let attempt = 0;; attempt += 1) try {
						const value = await fetchInterviewerOverview({
							sessionId,
							alias,
							signal: controller.signal
						});
						if (!active) return;
						setOverview(value);
						setLoadFailure(void 0);
						setBindingPending(false);
						return;
					} catch (failure) {
						if (!active || controller.signal.aborted) return;
						if (isBindingPendingError(failure) && attempt < BINDING_RETRY_DELAYS_MS.length) {
							setBindingPending(true);
							await delay(BINDING_RETRY_DELAYS_MS[attempt] ?? 450);
							if (!active || controller.signal.aborted) return;
							continue;
						}
						setOverview(void 0);
						setLoadFailure(failure);
						setBindingPending(false);
						return;
					}
				};
				load().finally(() => {
					if (active) setLoading(false);
				});
				return () => {
					active = false;
					controller.abort();
					if (timer !== void 0) {
						clearTimeout(timer);
						timer = void 0;
					}
				};
			}, [
				sessionId,
				alias,
				generation,
				missingBinding
			]);
			const stats = (0, react.useMemo)(() => overview !== void 0 ? deriveWorkspaceStats(overview) : void 0, [overview]);
			const rounds = (0, react.useMemo)(() => overview !== void 0 ? groupRounds(overview.interviews) : [], [overview]);
			const errorParts = loadFailure !== void 0 ? describeError(loadFailure) : void 0;
			const unbound = missingBinding || errorParts !== void 0 && errorParts.code === "DEMO_ACTOR_UNMAPPED";
			const selectedRow = overview !== void 0 && selectedId !== "" ? selectInterview(overview, selectedId) : null;
			const openScorecard = (row) => {
				setFormTarget(row);
			};
			const closeScorecard = () => {
				setFormTarget(null);
			};
			const handleSubmitted = () => {
				reload();
			};
			const handleUnavailable = () => {
				setEndpointUnavailable(true);
			};
			const showWorkspace = !unbound && !loading && errorParts === void 0 && overview !== void 0 && overview.configured === true;
			const showEmptyState = showWorkspace && overview !== void 0 && selectedId !== "" && selectedRow === null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "iw-root",
				"data-testid": "interviewer-workspace",
				"data-alias": alias,
				"data-session-id": sessionId,
				"data-count-assigned": stats !== void 0 ? stats.assigned_total : 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { dangerouslySetInnerHTML: { __html: INTERVIEWER_CSS } }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "iw-view",
					children: [
						unbound ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("header", {
							className: "iw-headline",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "iw-headline-main",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "iw-cap",
										children: "INTERVIEW WORKSPACE"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", { children: "我的面试" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "iw-sub",
										children: "只显示分配给我的面试与轮次工作。候选人是招聘业务对象，不是系统用户。"
									})
								]
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UnboundBlock, {
							missingSession,
							missingAlias,
							parts: errorParts
						})] }) : null,
						!unbound && overview !== void 0 && overview.actor.actor_id !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "iw-actorline",
							"data-testid": "interviewer-actor-line",
							"data-actor-id": overview.actor.actor_id,
							"data-alias": overview.actor.alias !== "" ? overview.actor.alias : alias,
							children: [
								"当前身份：",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: overview.actor.display_name !== "" ? overview.actor.display_name : "（服务端未提供 display_name）" }),
								"（",
								overview.actor.alias !== "" ? overview.actor.alias : alias,
								"）"
							]
						}) : null,
						!unbound && loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-loading",
							"data-testid": "interviewer-loading",
							"data-binding-pending": bindingPending ? "1" : "0",
							children: bindingPending ? "正在绑定演示身份…" : "正在读取面试工作…"
						}) : null,
						!unbound && !loading && errorParts !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(OverviewErrorBlock, {
							parts: errorParts,
							onRetry: reload
						}) : null,
						!unbound && !loading && errorParts === void 0 && overview !== void 0 && !overview.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NotConfiguredBlock, { overview }) : null,
						showEmptyState ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "iw-notice iw-notice-warn",
							"data-testid": "interview-detail-missing",
							children: "该面试已不在你的分配中（服务端读回），本视图不会展示别人的面试。"
						}) : null,
						showWorkspace && overview !== void 0 && stats !== void 0 ? selectedRow !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailView, {
							overview,
							row: selectedRow,
							labels: overview.labels,
							endpointUnavailable,
							onBack: () => setSelectedId(""),
							onOpenScorecard: openScorecard
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ListView, {
							overview,
							stats,
							rounds,
							onSelect: (interviewId) => {
								if (interviewId === "") return;
								setEndpointUnavailable(false);
								setSelectedId(interviewId);
							}
						}) : null,
						formTarget !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScorecardForm, {
							sessionId,
							interviewId: formTarget.interview_id,
							applicationId: formTarget.application_id,
							rubricVersionId: formTarget.rubric !== null ? formTarget.rubric.rubric_version_id : "",
							round: formTarget.round,
							onClose: closeScorecard,
							onSubmitted: handleSubmitted,
							onUnavailable: handleUnavailable
						}, `${formTarget.interview_id}-${formTarget.application_id}`) : null
					]
				})]
			});
		}
		// src/client/shell/RecruitmentShell.tsx
		const ALIAS_OPTIONS = [
			{
				value: "recruiter",
				label: "Recruiter"
			},
			{
				value: "interviewer_a",
				label: "Interviewer A"
			},
			{
				value: "interviewer_b",
				label: "Interviewer B"
			}
		];
		/** 从 DSH 的 localStorage 取当前 session id（Gate 0 实测键/形状）。 */
		function readSessionId() {
			try {
				const raw = localStorage.getItem("dsh.sessions.current");
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				return typeof parsed.sessionId === "string" && parsed.sessionId !== "" ? parsed.sessionId : null;
			} catch {
				return null;
			}
		}
		/** 受控 alias 选择：只 PUT alias；session id 走受控 header，不传 actor UUID。 */
		async function putBinding(sessionId, alias) {
			const res = await fetch("/recruitment/api/actor", {
				method: "PUT",
				credentials: "same-origin",
				headers: {
					"content-type": "application/json",
					"x-dsh-session": sessionId,
					"x-recruitment-request": "1"
				},
				body: JSON.stringify({ alias })
			});
			return {
				ok: res.ok,
				body: await res.text()
			};
		}
		async function getBinding(sessionId) {
			const res = await fetch("/recruitment/api/actor", {
				credentials: "same-origin",
				headers: {
					"x-dsh-session": sessionId,
					"x-recruitment-request": "1"
				}
			});
			if (!res.ok) return null;
			const body = await res.json();
			if (typeof body.alias !== "string" || typeof body.actor_id !== "string") return null;
			return body;
		}
		const COLORS = {
			bg: "#f4f6f9",
			card: "#ffffff",
			border: "#e3e8ef",
			text: "#16233a",
			sub: "#64748b",
			blue: "#2f6feb",
			blueBg: "#eef4ff"
		};
		/** 顶部按钮（视图切换 / Human Attention）。 */
		function TabButton(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				onClick: props.onClick,
				style: {
					border: `1px solid ${props.active ? "#c7d8f2" : COLORS.border}`,
					background: props.active ? COLORS.blueBg : "#fff",
					color: props.active ? COLORS.blue : COLORS.sub,
					fontWeight: props.active ? 700 : 500,
					borderRadius: 999,
					padding: "6px 13px",
					fontSize: 12,
					cursor: "pointer"
				},
				children: props.label
			});
		}
		/**
		* 产品外壳。没有渠道注入 props：session id 从 DSH localStorage 取，alias 由人选择后 PUT 到服务端。
		* @returns 两个工作视图 + 顶部身份/注意力入口。
		*/
		function RecruitmentShell() {
			const [sessionId, setSessionId] = (0, react.useState)(null);
			const [alias, setAlias] = (0, react.useState)(null);
			const [binding, setBinding] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)("");
			const [view, setView] = (0, react.useState)("recruiting");
			const [attentionOpen, setAttentionOpen] = (0, react.useState)(false);
			const [attention, setAttention] = (0, react.useState)(null);
			const openAttention = () => {
				setAttentionOpen(true);
				setAttention({
					data: void 0,
					error: void 0
				});
				fetch("/recruitment/api/overview", {
					credentials: "same-origin",
					headers: { "x-recruitment-request": "1" }
				}).then(async (res) => {
					if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
					return await res.json();
				}).then((data) => setAttention({ data })).catch((error) => setAttention({ error: error instanceof Error ? error.message : String(error) }));
			};
			(0, react.useEffect)(() => {
				const sid = readSessionId();
				setSessionId(sid);
				if (sid === null) {
					setNotice("未取得 DSH Session（localStorage 无 dsh.sessions.current）；写入将 fail-closed。");
					return;
				}
				getBinding(sid).then((found) => {
					if (found === null) {
						setNotice("Demo Actor 未绑定：请选择身份；未绑定前所有写操作 fail-closed。");
						return;
					}
					setBinding(found);
					setAlias(found.alias);
				});
			}, []);
			const onSelectAlias = (next) => {
				setAlias(next);
				if (sessionId === null) {
					setNotice("未取得 DSH Session，无法绑定 Demo Actor。");
					return;
				}
				putBinding(sessionId, next).then((result) => {
					if (!result.ok) {
						setBinding(null);
						setNotice(`Demo Actor 绑定失败（${result.body.slice(0, 160)}）；未绑定前写入 fail-closed。`);
						return;
					}
					setNotice("");
					getBinding(sessionId).then((found) => setBinding(found));
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					height: "100%",
					minHeight: 0,
					display: "flex",
					flexDirection: "column",
					background: COLORS.bg,
					color: COLORS.text
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							flexWrap: "wrap",
							padding: "10px 16px",
							background: COLORS.card,
							borderBottom: `1px solid ${COLORS.border}`
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: {
									fontSize: 14,
									marginRight: 4
								},
								children: "Recruitment"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									color: COLORS.sub,
									fontSize: 11
								},
								children: "AGENT WORKSPACE"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabButton, {
								active: view === "recruiting",
								label: "招聘工作台",
								onClick: () => setView("recruiting")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TabButton, {
								active: view === "interviewer",
								label: "面试官工作台",
								onClick: () => setView("interviewer")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: openAttention,
								style: {
									border: `1px solid ${COLORS.border}`,
									background: "#fff",
									borderRadius: 999,
									padding: "6px 12px",
									fontSize: 12,
									cursor: "pointer",
									color: COLORS.sub
								},
								children: "Human Attention"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								style: {
									fontSize: 11,
									color: COLORS.sub,
									display: "flex",
									alignItems: "center",
									gap: 6
								},
								children: ["Demo Actor", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									"aria-label": "选择 Demo Actor",
									value: alias ?? "",
									onChange: (event) => onSelectAlias(event.target.value),
									style: {
										fontSize: 12,
										padding: "5px 8px",
										border: `1px solid ${COLORS.border}`,
										borderRadius: 8,
										background: "#fff"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										disabled: true,
										children: "未绑定"
									}), ALIAS_OPTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: option.value,
										children: option.label
									}, option.value))]
								})]
							}),
							binding !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 10,
									color: COLORS.sub
								},
								children: [
									"actor ",
									binding.actor_id.slice(-8),
									" · ",
									binding.display_name ?? ""
								]
							}) : null
						]
					}),
					notice !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "7px 16px",
							fontSize: 11,
							color: "#92400e",
							background: "#fff7e6",
							borderBottom: "1px solid #f3d9a4"
						},
						children: notice
					}) : null,
					attentionOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						id: "human-attention",
						role: "dialog",
						"aria-label": "Human Attention",
						onClick: (event) => {
							if (event.target === event.currentTarget) setAttentionOpen(false);
						},
						style: {
							position: "fixed",
							inset: 0,
							background: "rgba(15,23,42,.35)",
							zIndex: 50
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
							style: {
								position: "absolute",
								right: 0,
								top: 0,
								bottom: 0,
								width: "min(540px, 94vw)",
								background: "#fff",
								boxShadow: "-12px 0 32px rgba(15,23,42,.18)",
								overflow: "auto",
								padding: "16px 18px",
								color: COLORS.text
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
										style: { fontSize: 16 },
										children: "Human Attention"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 11,
											color: COLORS.sub
										},
										children: "全局唯一人工处理入口（聚合既有业务记录）"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										"aria-label": "关闭 Human Attention",
										onClick: () => setAttentionOpen(false),
										style: {
											border: 0,
											background: "transparent",
											fontSize: 20,
											cursor: "pointer"
										},
										children: "×"
									})
								]
							}), attention?.error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								style: {
									color: "#b91c1c",
									fontSize: 12
								},
								children: ["读取失败：", attention.error]
							}) : attention?.data === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									color: COLORS.sub,
									fontSize: 12
								},
								children: "读取中…"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontSize: 12,
									lineHeight: 1.7
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										style: { color: COLORS.sub },
										children: [
											"actor：",
											attention.data.actor?.display_name ?? "未知",
											" · 标签：",
											attention.data.labels?.provenance ?? "?",
											" / ",
											attention.data.labels?.trigger ?? "?",
											" / ",
											attention.data.labels?.connection ?? "?"
										]
									}),
									[
										["pending_decisions", "待决策"],
										["my_interviews", "我的面试"],
										["overdue_scorecards", "逾期/缺面评"],
										["pending_reviews", "待复核材料"],
										["waiting_human_tasks", "等待人工的任务"],
										["connector_incidents", "连接器异常"]
									].map(([key, label]) => {
										const items = attention.data?.lists?.[key] ?? [];
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
											style: { marginTop: 10 },
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: { fontWeight: 700 },
												children: [
													label,
													"（",
													items.length,
													"）"
												]
											}), items.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												style: { color: COLORS.sub },
												children: "没有"
											}) : items.slice(0, 12).map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: {
													borderTop: `1px solid ${COLORS.border}`,
													padding: "4px 0"
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
														style: { fontSize: 10 },
														children: item.id ?? "?"
													}),
													" · ",
													item.stage_code ?? "",
													" ",
													item.required_action ?? "",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														style: { color: COLORS.sub },
														children: item.reason ?? ""
													})
												]
											}, `${key}-${item.id ?? index}`))]
										}, key);
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
										style: { marginTop: 14 },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												style: { fontWeight: 700 },
												children: "未分配（全租户共享）"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												style: { color: COLORS.sub },
												children: attention.data.unassigned?.note ?? ""
											}),
											[
												"pending_decisions",
												"pending_reviews",
												"waiting_human_tasks",
												"connector_incidents"
											].map((key) => {
												const items = attention.data?.unassigned?.[key] ?? [];
												return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: { marginTop: 6 },
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: key }),
														"（",
														items.length,
														"）",
														items.slice(0, 8).map((item, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
															style: { color: COLORS.sub },
															children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
																	style: { fontSize: 10 },
																	children: item.id ?? "?"
																}),
																" ",
																item.reason ?? ""
															]
														}, `u-${key}-${item.id ?? index}`))
													]
												}, `u-${key}`);
											})
										]
									})
								]
							})]
						})
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							flex: 1,
							minHeight: 0,
							overflow: "auto"
						},
						children: view === "recruiting" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RecruitingWorkspace, {
							sessionId: sessionId ?? "",
							alias: alias ?? "recruiter"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InterviewerWorkspace, {
							sessionId,
							alias
						})
					})
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
			}, RecruitmentShell));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 10,
				label: "招聘工作台"
			}, PanelIcon));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
