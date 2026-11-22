# Wave 3 产品设计与验收规范（G-09 候选人自助选时段 · G-14 高清原件逐页预览 · G-15 决策追责时间线）

> **定位**：Wave 3 三项能力的唯一产品与工程真相源（基线 `main@6e003b2`）。本规范不仅定义接口，更定义**产品级验收标准（超越代码全绿）**与暖纸视觉红线。

---

## 一、G-09 · 候选人自助选时段与免登录预约确认（L4 约面减负）

### 1.1 解决的真实痛点
HR 约面时在微信/电话里与候选人、面试官三方反复敲时间，是招聘全链最耗时的手工劳动。本能力让 HR 选出 2–5 个可选时间槽并一键生成**一次性预约链接**发给候选人，候选人免登录点选确认后直接落库成正式面试，无需 HR 二次手工录入。

### 1.2 安全与业务红线（一票否决）
1. **公开页最小信息面**：`GET /recruitment/book/<token>` 仅允许返回岗位标题、面试轮次、时长（分钟）、可选时间槽列表（含 IANA 时区）及链接状态（`OPEN / CONSUMED / EXPIRED`）；**严禁暴露**候选人简历、评分标准、初筛评估、面试官内部 ID 或任何 UUID。
2. **令牌一次性与防篡改（Fail-Closed）**：
   - 令牌为高熵随机串（≥32 字节 hex/base64url），默认 72 小时过期；
   - `POST /recruitment/book/<token>/confirm` 必须校验证明所选时段**严格属于本次邀约白名单**；篡改时间 → `400 SLOT_NOT_ALLOWED`（零写入）；
   - 同一令牌重复提交 → `409 BOOKING_ALREADY_CONFIRMED`（零重复创建面试）；
   - 过期或不存在令牌 → `404 / 410` 诚实提示「预约链接已失效，请联系招聘负责人重新发送」（零写入）。
3. **单事务原子落库**：候选人确认时，在同一事务内锁定邀约行（`OPEN → CONSUMED`）并复用既有面试排期逻辑创建正式 `interview`（操作人归属发起邀约的 HR actor，带 `self_booked` 标记，遵守既有面试官时段冲突检测）。

### 1.3 接口契约
- **HR 生成邀约链接**（回环 + `sameOrigin` + `X-DSH-Session` Recruiter HUMAN actor）：
  - `POST /recruitment/api/action/booking/invite`
  - Body：`{ application_id, round_no, duration_minutes, interviewer_actor_ids: string[], timezone, slots: Array<{ start: string, end: string }>, expires_hours?: number }`（`slots` 2..5 条，带偏移 ISO-8601）
  - Response 200：`{ invite_id, token, booking_url: "/recruitment/book/<token>", expires_at, slots }`
- **候选人公开只读页与确认**：
  - `GET /recruitment/book/<token>`：返回暖纸极简静态 HTML 页面（`--paper #F9F8F5` + `--surface #FFFFFF`，单列居中 max-width 520px，零后台 Chrome），展示岗位、轮次、时长、可选时段与「确认此时段」按钮；
  - `GET /recruitment/api/public/book/<token>`：同源只读 JSON；
  - `POST /recruitment/api/public/book/<token>/confirm`：Body `{ slot_index: number }` → 成功 200 返回 `{ status: "CONFIRMED", interview_id, confirmed_slot }`。

---

## 二、G-14 · 原件预览逐页高清图渲染（L5/L6 阅读体验 · 兑现 V5）

### 2.1 产品体验
在候选人详情页「原件预览」Tab 中，PDF 简历直接以逐页高清图呈现（默认展示第 1 页，提供「上一页 / 下一页」+ `.num` `第 1 / N 页` + 点击缩放 +「下载原件」）；DOCX/RTF/TXT 非 PDF 原件诚实降级为「该格式暂不支持逐页图预览，可下载原件或查看结构化原文」，绝不报错白屏。

### 2.2 接口契约（扩展既有 `src/http/material-content.ts`）
- `GET /recruitment/api/material/<material_id>/page/<page_no>`（`page_no` 为 1-based 正整数，默认 dpi=144）：
  - 严格复用 `material-content.ts` 既有 6 条约束（`sameOrigin` + `withReadOnly` + `resolveMaterialPath` + 零写入）；
  - 渲染逻辑**零重写**，复用 `runFallbackBridge` 调用 `converter/fallback/page_image.py`；
  - 成功返回 `200 image/png`，附响应头 `X-Page-Count: <total_pages>`、`X-Page-Number: <page_no>`、`Cache-Control: no-store`；
  - 非 PDF 返回 `415 UNSUPPORTED_FORMAT`；越界页码返回 `400 PAGE_OUT_OF_RANGE`；临时 PNG 读完响应后及时清理。

---

## 三、G-15 · 决策追责时间线可见界面（L7 强追责差异化）

### 3.1 产品体验与暖纸红线
- 位于候选人详情页底部（面试记录区下方，`1px solid var(--line-soft)` 分隔），**默认折叠**为一行克制标题「决策与流转追责记录（N 条）」，避免首屏信息过载；
- 展开后以极简细线时间线呈现（无卡片套卡片、无厚重胶囊、`.num` 时间戳）：每条包含 **时间 · 事件标题 · 操作人 · 摘要/依据版本**（如「2026-11-22 10:15 · 初筛通过 · 招聘负责人 · 依据岗位标准 v1」），**绝不暴露 UUID、sha256 完整哈希或「证据」二字**。

### 3.2 接口契约（新增只读投影 `src/http/application-trace.ts`）
- `GET /recruitment/api/recruiting/applications/:applicationId/trace`：
  - 复用 `src/domain/trace.ts::loadTrace(client, tenantId, 'APPLICATION', applicationId)`，严格 `withReadOnly` + `sameOrigin` + `X-DSH-Session`；
  - 返回脱敏后的人话时间线 JSON：
    ```json
    {
      "contract_version": "application-trace 1.0.0",
      "application_id": "...",
      "items": [
        { "id": "...", "at": "2026-11-22T10:15:00+08:00", "kind": "DECISION", "title": "初筛通过", "actor_label": "招聘负责人", "detail": "依据岗位标准 v1" }
      ],
      "integrity_ok": true
    }
    ```
  - 若路径非 `/trace`，原样回退 `readApplicationDetail`（不吞申请详情）。

---

## 四、Wave 3 产品级验收标准（不止于代码全绿）

1. **G-09 真人体验与负例闸门**：
   - HR 在候选人排期弹窗生成 3 个可选时段的自助预约链接 → 无登录态新标签打开 `/recruitment/book/<token>` → 页面仅见岗位/轮次/时长/3 个时段（断言页面文本不含简历/评估/UUID）→ 候选人选中第 2 个时段确认 → 页面显示预约成功 → 独立 `psql` 查 `interview` 表确认新增 1 条对应时段记录；
   - **负例必测**：同一令牌再次提交返回 409 且 `interview` 行数不变；篡改非白名单时段返回 400 且零写入；伪造令牌返回 404 友好提示。
2. **G-14 真 PDF 渲染与非 PDF 降级**：
   - 上传 PDF 简历 → 候选人页切到「原件预览」Tab → 真实加载出 `image/png`（`naturalWidth > 0`）且显示页码 `1 / N`；非 PDF 诚实降级不报错。
3. **G-15 追责可读回**：
   - 走完初筛或纠偏后，展开候选人页底部「决策与流转追责记录」→ 按时间顺序看到真实操作人、动作与版本，页面文本零 UUID、零「证据」二字。
4. **底线门禁**：`tsc 0`、`tsdown` 双入口、`server-typecheck 0/0`、`runtime-budget`、`entry-reachability`（`WHITELIST=[]`）、`client-contract-check`、`term-lint` 与 `run-v4.mjs --fresh` 15/15 全绿。
