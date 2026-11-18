# 前端任务书 03 · 真连后端 + 确认卡接入口 + 上传进度

> 收件人：前端实现窗口（云端，只能读仓库）。发件人：总控。日期：2026-11-19。
> 前置：任务 01（数据适配层）与任务 02（画布）已通过并入库。
> **仓库就是事实来源**：接口契约看 `design/v4/contracts/available-actions.md`，样例看 `contracts/api-samples/`。

---

## 0. 红线（不变）

1. 视觉与交互不许改（v4 已定版）。
2. 不新增按钮/开关；不显示内部 id / 字段名 / 哈希 / 错误码。
3. 拿不准的字段 → 写进 `INTERFACE-NEEDS-2.md`，**不许猜、不许造接口**。

---

## 1. 本轮四件事

### T3-1 真连后端（把 `mode: 'http'` 跑通）
- 用真实接口把三屏跑通：**招聘总览 / 岗位页 / 候选人页**；
- 请求必须带 `x-recruitment-request: 1`，身份靠同源 cookie，**前端不传 actor**；
- 字段对不上时，以 `contracts/api-samples/*.json` 为准；仍缺的列进 `INTERFACE-NEEDS-2.md`（写清"我要什么、现在缺什么"）。

### T3-2 确认卡接上已就绪的写入口
以下四个后端接口**已经可用**（见 `contracts/available-actions.md`），把确认卡提交接到它们：
- 跨岗调剂 → `POST /recruitment/api/action/application/transfer`
- 置顶约束 / 下一轮交接 → `POST /recruitment/api/action/candidate/constraint`
- 新建岗位 → `POST /recruitment/api/action/job/create`（注意：**`headcount` 会被拒**，HC 由需求单维护）
- 上传简历 → `POST /recruitment/api/intake/upload?job_id=<uuid>`（原始字节 + `x-file-name`）
提交必须带 `confirmation_text`（人的原话）；按钮点下去立刻进入 loading + disabled，防连点。

### T3-3 上传后的进度与失败原因
- 上传拿到 `task_id` 后，**顶部轻提示条**显示"正在解析"，轮询 `GET /recruitment/api/tasks/status`；
- 解析失败时显示**人话原因**（接口已提供 `error_code` / `error_summary`，**不要把错误码直接显示**）；
- **绝不允许**"解析没完成却显示已入库"。

### T3-4 未接通动作的人话兜底
批量不通过、催办、复合指令、星标、面评草稿、撤销 —— 后端**还没做**。
这些按钮点下去显示一句人话（如"这项还差最后一步，稍后开放"），**不许报错、不许假装成功**，也不许因此改按钮的视觉。

---

## 2. 交付

```
<被改动的文件，保持仓库相对路径>
INTERFACE-NEEDS-2.md     # 还缺什么（逐条：我要什么 / 现在缺什么 / 影响哪一屏）
NOTES.md                 # 改了什么、哪些没自测（如实写，不许编）
```

---

## 3. 我这边的验收

1. 真 Host + 真库：三屏能打开、数据真实（截图 1440/390）；
2. 四类确认卡各真点一次 → 落库，psql 独立读回；
3. 上传一次 → 顶部提示 → 完成后候选人出现；失败一次 → 人话原因、不显示成功；
4. 未接通动作 → 人话提示，无报错、无假成功；
5. 视觉与 `design-tokens.md` 一致。
