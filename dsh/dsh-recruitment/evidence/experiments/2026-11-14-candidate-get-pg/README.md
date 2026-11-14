# `candidate_get` 从 fixture stub 改成真库读（2026-11-14）

**根因**：早期为了让模型"看见能力边界"先占了位，返回值来自早期占位文件 `src/tools/stubs.ts`（**已删除**，属历史引用；当时内容见 git 历史）里写死的人，
`stub=true` / `provenance=FIXTURE`。产品里"查候选人"会给出一个**编造的人** —— 这是假能力，不是占位。
没有"stub 清零清单"，所以它一直没被排期清掉（根因 B/C）。

---

## 1. 改了什么

| 项 | 旧 | 新 |
|---|---|---|
| 数据源 | `CANDIDATE_STUBS`（写死的假人） | `recruitment.candidate` + `recruitment.application` + `recruitment.job` |
| 租户 | 无（stub 不分租户） | 只来自插件配置 `database.tenant_id`，模型传不进来 |
| 状态 | `status: ACTIVE/ARCHIVED`（**与库不符**：库里是 `ACTIVE/MERGED`） | `identity_status: ACTIVE/MERGED` + `record_version` |
| 申请 | 假的三条 | 真实申请，带 `job_code` / `job_title` / `stage_code` / `lifecycle_status` |
| 溯源 | `provenance: FIXTURE` + `stub: true` | `source: 'DATABASE'`（不再有 stub 概念） |
| 未找到 | 列出一串 stub id | `NOT_FOUND: CANDIDATE_NOT_FOUND`，**绝不回退样例数据** |
| 参数校验 | 任意字符串 | 非 UUID → `INVALID_ARGS: NOT_A_UUID`（在起连接池之前就拒） |
| 只读性 | "源码里没写 INSERT" | `begin transaction read only`（写语句直接 25006） |
| PII | 默认脱敏 | 默认脱敏，`include_contacts=true` 才给原文，且输出永远带 `visible` |

**顺手删掉 `src/tools/stubs.ts`（该文件现已删除，属历史引用）**：改完后全仓库零引用（`src/` + `test/` 全扫过）。
假数据从代码里消失，就不存在"以后又被人 import 回来"的可能。

## 2. 测试

```
node --test test/integration/candidate-get.test.ts
ℹ tests 7 / pass 7 / fail 0 / skipped 0
```

7 条用例（全部真库 + `inRolledBackTx` 回滚，不污染 `ra_s6s7`）：

1. 真库读回：姓名/状态/申请/岗位 code 与 title 逐个对；
2. 联系方式默认脱敏、`include_contacts=true` 才给原文（并断言脱敏值 ≠ 原文）；
3. **租户隔离**：同一个 id 换租户 → `CANDIDATE_NOT_FOUND`（不是"查到了别人的"）；
4. MERGED 且有指向 → 输出 `merged_into_candidate_id`（顺带把 `ck_candidate_merged_fields`
   要求 `merge_id` 非空的坑踩了：先插 `candidate_merge` 再标 MERGED）；
5. 未知 id → NOT_FOUND；
6. 非 UUID 在起连接池之前就被拒；
7. 未配置时注册同名工具，调用报 NOT_CONFIGURED。

全量：**tests 715 / pass 715 / fail 0 / skipped 0**（改动前 708，新增 7 条）。

## 3. 浏览器验收（DSH 0.2.2 + 隔离 home）

真浏览器里让模型自己调：

```
工具调用 | recruitment_candidate_get · 11111111-1111-4111-8111-000000000601
调用结果如下（原样贴出）：
display_name: 演示候选人-张样例
```

截图：`browser-candidate-get-ok.png`。

**DB 读回**（同一时刻 psql）：

```
11111111-1111-4111-8111-000000000601 | 演示候选人-张样例 | ACTIVE | 1
application …701 -> job …401 (DEMO-BE-001 后端工程师（演示）) @ S7 / ACTIVE
```

→ 界面显示与库一致；工具在**运行中的 Web 入口**可达（R2）。

## 4. 两个踩过的真坑（记下来免得再踩）

1. **`uq_candidate_active_email` / `uq_candidate_active_phone`**：测试夹具写死邮箱/手机，
   第二个用例就 `23505`。→ 夹具按 UUID 生成唯一值。
2. **`ck_candidate_phone_normalized`**：手机号必须全数字，我一开始拿 UUID 的十六进制当手机号，
   `a-f` 直接 23514。→ 映射成数字。**`ck_candidate_merged_fields`**：MERGED 必须同时有
   `merged_into_candidate_id` **和** `merge_id`（且 `merge_id` 有 FK 到 `candidate_merge`）。
