# tenant-config/tool-contracts.md · `recruitment_config_role` / `_team` / `_pipeline`

**契约版本**：`tenant-config 1.0.0`（2026-11-14）
**状态**：本 lane 交付（**待独立复核**；实现者不验收自己的工作 —— 铁律 R8）
**覆盖范围**：三个工具的十个动作（角色 4 / 团队 6 / 流水线 6，其中 list/get 同名），
外加一张迁移 `db/migrations/0014_tenant_config.sql`。
**实现**：`src/domain/tenant-config.ts`（校验 / 幂等 / 版本并发，单一实现）+
`src/tools/config-role.ts`、`src/tools/config-team.ts`、`src/tools/config-pipeline.ts`
（胶水：入参分派 / 事务与身份 / R4 标签 / 渲染）+ `src/tools/config-shared.ts`（三工具共用的 schema 碎片）。
**测试**：`test/integration/tenant-config.test.ts`（真库 C1–C19，每条读库回验）、
`test/unit/tenant-config-validate.test.ts`（不连库：五项服务端校验 + 两个 schema 未放宽）。
**填的是哪个缺口**：`db/verify.sql:311`（Pipeline Template = DEFERRED）、`:313`（Stage = DEFERRED）、
`:315`（Stage Activity Template = DEFERRED），以及 `recruitment.role` 只有 code+name
（`db/migrations/0001_init.sql:374`）、**没有任何 team 表**（实测 `recruitment` 下无 `%team%`）。
**方向**：企业情况各不相同 —— **配置是数据，不是代码**。本契约不写死任何一家企业的组织或流程，
只定义"企业自己建"的最小写路径与它们必须满足的约束。
**与其它契约冲突时**：阶段码权威仍是 `contracts/STAGE-CODES.md`（本契约不新增/不改名任何阶段码）；
`docs/03 §2` 的"模板更新不静默改写已开始的申请"是本契约钉版本（而非钉 code）的依据。

---

## 0. 它不做什么（先写边界，避免"通用后端"膨胀成第二套平台）

| # | 不做 | 为什么 |
|---|---|---|
| 1 | **不做权限判定**（不实现 RBAC 求值） | 本契约只存"这个角色能碰到哪类动作"（9 个能力码）。"某人能不能看某条某部门的记录"不属于 v1.0；一旦在这一层写判定式，就无法回头做真正的鉴权。 |
| 2 | 不建 / 不改 `actor`、`department` | 那是 identity 线与 0002 种子的事。团队只**引用**已存在的部门与 HUMAN 账号。 |
| 3 | 不建 `interview_template_version` | 面试模板由面试线产出；流水线阶段只**引用具体版本**（钉版本，见 §5.3）。 |
| 4 | 不把模板**应用**到申请 | Pipeline Instance 仍是 `application.current_stage_code`（`db/verify.sql:312` MAPPED）。本契约只造模板，不做"模板 → 申请"的切换。 |
| 5 | 不做阶段活动模板（Stage Activity Template） | `db/verify.sql:315` 仍 DEFERRED；docs/03 §7 把它列在 10.0 后续对象里。 |
| 6 | 不发 `DELETE` | 0014 给 5 张新表挂了 `fn_block_delete`。""移除成员"" = `is_active=false`（软关闭），历史保留。 |
| 7 | 不 last-write-wins、不自动重试 | 版本不一致 → `VERSION_CONFLICT` 且零写入；"重读后再决定"交回调用方。 |
| 8 | 不做角色/团队/流水线的**版本链**（revision 表） | 只保留 `record_version` + `is_active` 两条审计轴。要历史请走 event/audit 线，不在配置表里发明第二套历史。 |
| 9 | 不接受 `tenant_id` / `actor_id` 入参 | 身份只来自插件配置（`cordis.patch.yml` 的 `database.tenant_id/actor_id`）。入参 schema 里没有这两个键（单测机检）。 |

---

## 1. 工具与动作矩阵

**为什么是"一工具多动作"而不是十个工具名**：本仓既有 22 个工具都是"一工具一动作"，
但配置域的动作集合是 3 类实体 × 4–6 个动作。全拆开是 16 个工具名，每个都只是同一张表的
不同侧面。任务书允许"一个工具的多种 operation"，且**动作分派在服务端**（`operation` 是封闭
枚举，未列出的值在 `parseContractArgs` 就被 `OUT_OF_RANGE` 拒绝）。
若要回到一工具一动作：`runRoleOperation` / `runTeamOperation` / `runPipelineOperation` 已按动作
拆好，包一层薄 wrapper 即可，**不需要改 domain**。

| 工具 | 动作 | 结论 `status` |
|---|---|---|
| `recruitment_config_role` | `create` / `update` / `get` / `list` | `CREATED` / `UNCHANGED` / `UPDATED` / `OK` |
| `recruitment_config_team` | `create` / `update` / `add_member` / `remove_member` / `get` / `list` | 同上 |
| `recruitment_config_pipeline` | `create` / `update` / `add_stage` / `add_stage_template` / `get` / `list` | 同上 |

`status` 语义（封闭集，`src/tools/config-shared.ts` 的 `CONFIG_STATUSES`）：

| 值 | 含义 | 库里的证据 |
|---|---|---|
| `CREATED` | 新建了一行（团队 = 团队行；add_member = 成员行） | 行存在且 `record_version=1` |
| `UNCHANGED` | **幂等命中**：内容与库里完全一致 → **零写** | 版本不变、`updated_at` 不变 |
| `UPDATED` | 真的改了 | 版本 +1（或成员 `is_active` 变了） |
| `OK` | 只读动作 | 无写入（跑在 `begin transaction read only` 里） |

---

## 2. 入参（每个动作的必填项）

工具入参只有标量 / 字符串数组（`src/tools/args.ts` 的 `ParamKind`）；
**没有嵌套对象入参**，所以"阶段列表"是逐条 `add_stage`。

### 2.1 `recruitment_config_role`

| 动作 | 必填 | 可选 |
|---|---|---|
| `create` | `code`、`name`、`permission_scopes`（>=1） | `description` |
| `update` | `role_id`、`expected_record_version` | `name`、`permission_scopes`、`description`、`clear_description` |
| `get` | `role_id` | — |
| `list` | — | `include_inactive` |

### 2.2 `recruitment_config_team`

| 动作 | 必填 | 可选 |
|---|---|---|
| `create` | `code`、`name`、`department_id` | `description`、`member_actor_ids`、`member_team_role` |
| `update` | `team_id`、`expected_record_version` | `name`、`description`、`clear_description`、`department_id`、`is_active` |
| `add_member` | `team_id`、`member_actor_id` | `team_role` |
| `remove_member` | `team_id`、`member_actor_id` | — |
| `get` | `team_id` | `include_inactive_members` |
| `list` | — | `include_inactive`、`include_inactive_members` |

> `member_actor_id` 不叫 `actor_id`：`actor_id` 是**执行身份**保留键，出现在入参里会被
> `TENANT_OR_ACTOR_NOT_ALLOWED` 拒绝（`src/tools/args.ts:116`）。

### 2.3 `recruitment_config_pipeline`

| 动作 | 必填 | 可选 |
|---|---|---|
| `create` | `code`、`name` | `description` |
| `update` | `pipeline_template_id`、`expected_record_version` | `name`、`description`、`clear_description`、`is_active` |
| `add_stage` | `pipeline_template_id`、`stage_code`、`expected_record_version` | `sort_order`、`interview_template_version_ids`、`is_required` |
| `add_stage_template` | `stage_id`、`interview_template_version_id`、`expected_record_version` | `is_required` |
| `get` | `pipeline_template_id` | — |
| `list` | — | `include_inactive` |

`sort_order` 不传 = 追加到末尾（当前 max + 1，上限 100）。

---

## 3. 出参

三个工具的出参是同一个骨架：

```json
{
  "tool": "recruitment_config_role",
  "contract_version": "1.0.0",
  "operation": "create",
  "status": "CREATED",
  "role": { "...": "见下" },
  "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" }
}
```

| 键 | 何时出现 |
|---|---|
| `role` / `team` / `pipeline` | 单对象动作（create/update/get/add_member/remove_member/add_stage/add_stage_template） |
| `roles` / `teams` / `pipelines` | `list` |
| `labels` | **恒有**（R4 三维标签，走 `buildThreeAxisLabels` 这一份实现；演示租户 = `FIXTURE`） |

"可能没有"的字段一律**省略键**（不用 `null`）：`description`、`created_by_actor_id`。
**不用 `null` 占位**是 DSH 出参 schema 的硬限制（不支持 `type` 数组 / `type:'null'`）。

`role`：`role_id, code, name, description?, permission_scopes[], is_active, record_version, created_by_actor_id?, created_at, updated_at`
`team`：`team_id, code, name, department_id, department_name, description?, is_active, record_version, members[], created_at, updated_at`
`team.members[]`：`actor_id, display_name, team_role, is_active, added_at`
`pipeline`：`pipeline_template_id, code, name, description?, is_active, record_version, stages[], created_at, updated_at`
`pipeline.stages[]`：`stage_id, stage_code, stage_name, sort_order, interview_templates[]`
`pipeline.stages[].interview_templates[]`：`interview_template_version_id, template_code, version_no, is_required`

---

## 4. 错误（`Error: <CODE>: <compact-json>`，与 stage-advance 同一手法）

| code | reason_code（封闭集） | 何时 |
|---|---|---|
| `INVALID_ARGS` | `PERMISSION_SCOPES_NOT_ARRAY` / `PERMISSION_SCOPE_NOT_STRING` / `PERMISSION_SCOPE_UNKNOWN` / `PERMISSION_SCOPES_EMPTY` / `UUID_LIST_*` / `ID_NOT_UUID` / `EXPECTED_RECORD_VERSION_INVALID` / `CODE_FORMAT_INVALID` / `NAME_*` / `DESCRIPTION_*` / `TEAM_ROLE_UNKNOWN` / `NO_CHANGES_REQUESTED` / `SORT_ORDER_INVALID` / `SORT_ORDER_EXHAUSTED` / `MISSING_REQUIRED_FOR_OPERATION` / `UNKNOWN_PARAM` / `OUT_OF_RANGE` / `MISSING_REQUIRED` | 入参不合规（**在写库之前**拒绝） |
| `NOT_FOUND` | `ROLE_NOT_FOUND` / `TEAM_NOT_FOUND` / `TEAM_MEMBER_NOT_FOUND` / `PIPELINE_NOT_FOUND` / `PIPELINE_STAGE_NOT_FOUND` | 对象不存在**或不属于当前租户**（不区分，避免探测） |
| `VERSION_CONFLICT` | `ROLE_RECORD_VERSION_MISMATCH` / `TEAM_RECORD_VERSION_MISMATCH` / `PIPELINE_RECORD_VERSION_MISMATCH` / `CONCURRENT_UPDATE` | 版本不一致（含 `40001` / `40P01` 映射）；**零写入** |
| `INVALID_REFERENCE` | `DEPARTMENT_NOT_FOUND` / `ACTORS_NOT_FOUND` / `ACTOR_NOT_HUMAN` / `STAGE_CODE_UNKNOWN` / `TEMPLATE_VERSION_NOT_FOUND` | 引用了不存在/跨租户的对象（`STAGE_CODE_UNKNOWN` 附带 `available_stage_codes`） |
| `ALREADY_EXISTS` | `ROLE_CODE_TAKEN` / `ROLE_CODE_RACE` / `TEAM_CODE_TAKEN` / `TEAM_CODE_RACE` / `TEAM_MEMBER_ROLE_DIFFERS` / `TEAM_MEMBER_RACE` / `PIPELINE_CODE_TAKEN` / `PIPELINE_CODE_RACE` / `PIPELINE_STAGE_EXISTS` / `STAGE_TEMPLATE_DUPLICATED` | 业务键已存在且内容不同；或并发下唯一键冲突 |
| `INVARIANT_VIOLATION` | `*_INSERT_NO_ROW` / `*_VANISHED` | 库返回与写入不一致（不该发生；发生时整笔回滚） |
| `NOT_CONFIGURED` | — | 插件配置缺 `database.*`（工具照常注册，调用即报） |

错误构造沿用 `src/domain/stage-advance.ts:309` 的既有先例（`RecruitmentToolError(code as never, …)`），
因为 `src/tools/errors.ts` 的 code 联合里没有本契约需要的三个码，而该文件属于既有工具层（本 lane 不改）。

---

## 5. 服务端校验（不靠模型自觉；DB 是第二道）

| # | 规则 | 应用层（本契约） | DB 层（0014） |
|---|---|---|---|
| 5.1 | 权限范围取自 **9 个能力码**封闭集，去重 + 排序；新建角色 >=1 | `normalizePermissionScopes` | `ck_role_permission_scopes` + `fn_permission_scopes_valid(jsonb)` |
| 5.2 | `code` 形状 `^[A-Z][A-Z0-9_]{1,40}$`；`name` 1–200；`description` 1–1000 | `requireCode` / `requireName` / `optionalDescription` | `ck_*_code` / `ck_*_name` / `ck_*_description` |
| 5.3 | 阶段必须引用**已存在**的 `stage_catalog` code | `assertStageCodeExists`（错误里给出可用阶段码） | `fk_pipeline_stage_catalog (tenant_id, stage_code) → stage_catalog(tenant_id, code)` |
| 5.4 | 阶段引用的面试模板必须**已存在且同租户**，且钉**具体版本** | `assertTemplateVersionsExist` | `fk_pipeline_stage_template_itv (interview_template_version_id, tenant_id)` |
| 5.5 | 团队成员 actor 必须存在、同租户、`kind='HUMAN'` | `assertHumanActors` | `fk_hiring_team_member_actor_human (actor_id, tenant_id, actor_kind)` + `ck_hiring_team_member_human check (actor_kind='HUMAN')` + `uq_actor_id_tenant_kind` |
| 5.6 | 团队必须挂在**已存在且同租户**的部门下 | `assertDepartmentExists` | `fk_hiring_team_department (department_id, tenant_id)` |
| 5.7 | 同一模板里阶段码不重复、`sort_order` 唯一 | 插入前判重 + 唯一键冲突映射 | `uq_pipeline_stage_code` / `uq_pipeline_stage_order` |
| 5.8 | 同一团队同一 actor 只能有一条**在用**成员 | 插入前判在用行 | 部分唯一索引 `uq_hiring_team_member_active ... where is_active` |
| 5.9 | 租户隔离：所有读写带 `tenant_id` | `where tenant_id = $n`（每个查询） | 每张表都有 `tenant_id` + FK 到 `organization`；跨租户复合引用被复合外键挡 |

> 5.5 的"物理保证"是怎么做的（本仓既有做法，见 `0004_stage_catalog.sql:282` 的
> `fk_job_current_rubric`）：给 `actor` 补 `uq_actor_id_tenant_kind unique (id, tenant_id, kind)`，
> 成员表带一列 `actor_kind`（CHECK 钉死 `'HUMAN'`），复合外键指过去。
> 效果：不存在的 actor / 别的租户的 actor / `SYSTEM` 账号 三种情况都在 INSERT 时被外键拒绝；
> 而且**后续把某个 actor 的 kind 改成非 HUMAN 会被 restrict 挡住**（不能悄悄让团队成员变成机器账号）。

---

## 6. 版本并发语义（`expected_record_version`）

`record_version` 由 `recruitment.fn_touch()`（0001:233）自增，**调用方不许手写**。
写路径统一：`select … for update`（行锁串行化）+ `update … where record_version = $expected`，
0 行 → 先判存在性：不存在 = `NOT_FOUND`，存在 = `VERSION_CONFLICT`（**零写入**）。

| 实体 | 版本覆盖范围 | 谁会 bump |
|---|---|---|
| `role` | 本体（name / description / permission_scopes / is_active） | `update` |
| `hiring_team` | 本体（name / description / department_id / is_active） | `update` |
| `hiring_team_member` | 成员行自己的 `record_version` | 软关闭（`is_active=false`） |
| `pipeline_template` | **聚合**：本体 **+ 阶段结构** | `update`、`add_stage`、`add_stage_template` |

为什么团队与流水线的粒度不同：
* 成员是**关系行**（与 0001 的 `actor_role` 同一粒度），各自有 `is_active` / `created_at`，
  不需要版本锁；
* 阶段是**模板本体的组成部分**（改结构 = 改模板），所以两个人同时加阶段时，
  后一个拿旧版本号会被拒 —— 这正是想要的（否则"第几步"会静默错乱）。

`add_stage` / `add_stage_template` 成功后 `record_version +1`，**下一次调用必须用新值**。

---

## 7. 幂等语义（可机检口径：零写 = 版本不动）

| 动作 | 判定 | 结论 |
|---|---|---|
| `create`（role/team/pipeline） | 同 `(tenant, code)` 且**内容完全一致**（团队还要"在用成员集合 + 各自 team_role"一致） | `UNCHANGED`，**零写** |
| `create` | 同 `(tenant, code)` 但内容不同 | `ALREADY_EXISTS`（明确报错，**不静默覆盖企业配置**） |
| `update` | 参数与库里完全一致 | `UNCHANGED`，**零 UPDATE** |
| `add_member` | 已有在用的同一 `actor + team_role` | `UNCHANGED`；角色不同 → `ALREADY_EXISTS`（先 remove 再 add） |
| `remove_member` | 已经是软关闭状态 | `UNCHANGED`；从没加入过 → `NOT_FOUND` |
| `add_stage` | 同模板同 `stage_code` 再加一次 | `ALREADY_EXISTS`（**不是幂等成功**：同一阶段出现两次会让"现在第几阶段"无解） |

集合语义归一化：权限范围与 UUID 列表都**去重 + 排序**后再比较 —— 否则
`["JOB_READ","JOB_WRITE"]` 与 `["JOB_WRITE","JOB_READ"]` 会被判成"内容不同"，幂等就失效了。

---

## 8. 租户隔离（可机检口径）

* 每个查询/写入都带 `tenant_id`，**没有**任何"全局查询后过滤"的路径；
* 跨租户读 → `NOT_FOUND`（不区分"不存在"与"不是你的"，避免探测存在性）；
* 跨租户**引用** → `INVALID_REFERENCE`（部门/actor/模板版本）或 `NOT_FOUND`（阶段 id）；
* 实测：集成测试 C7 / C12 / C17 三个租户隔离用例 + C10 的"别的租户的部门"用例。

---

## 9. 数据库结构（`db/migrations/0014_tenant_config.sql`）

| 对象 | 说明 |
|---|---|
| `recruitment.role` 扩列 | `description` / `permission_scopes jsonb` / `is_active` / `created_by_actor_id` / `record_version` / `updated_at` + `trg_role_touch` |
| `recruitment.hiring_team` | 团队本体（code 唯一、部门复合外键、`record_version`、禁删） |
| `recruitment.hiring_team_member` | 成员（`actor_kind='HUMAN'` 复合外键、`team_role` 封闭集、部分唯一索引、`record_version`、禁删） |
| `recruitment.pipeline_template` | 流水线模板本体（code 唯一、`record_version`、禁删） |
| `recruitment.pipeline_template_stage` | 有序阶段（→ `stage_catalog` 复合外键；顺序/阶段码双唯一） |
| `recruitment.pipeline_template_stage_template` | 阶段 → 面试模板**版本**（多对多；钉版本） |
| `recruitment.actor` | 新增 `uq_actor_id_tenant_kind unique (id, tenant_id, kind)`（5.5 的复合外键被引用键） |

为什么扩 `role` 而**不**新建 `role_template`：`role` 已被 0002 种了 4 行且被
`actor_role.role_id`（0001:389）引用。再建一张模板表会出现"角色"两套概念 —— 企业建了模板，
`actor_role` 仍只能引用旧表，最终不是写死同步胶水就是两套并存漂移。扩列的代价只是旧行的
`permission_scopes` 为空集合（**如实表达"旧行早于权限范围概念"**，不猜一个看起来合理的集合）。

---

## 10. 注册需要加什么（本 lane **不改** `src/index.ts`）

`src/index.ts` 由总控落地。需要加的是**三行 import + 三处注册**（模式和 `stage-advance` 一致）：

```ts
// ① import（放在 stage-advance 那组旁边，src/index.ts:85 附近）
import { createConfigRoleTool, unconfiguredConfigRoleTool } from './tools/config-role.ts'
import { createConfigTeamTool, unconfiguredConfigTeamTool } from './tools/config-team.ts'
import { createConfigPipelineTool, unconfiguredConfigPipelineTool } from './tools/config-pipeline.ts'

// ② 注册（放在 stage-advance 的注册点旁边，src/index.ts:507 附近；
//    `database` 是 resolveDatabaseConfig 的结果，src/index.ts:319）
...(database.resolved === null
  ? [unconfiguredConfigRoleTool(database.issues),
     unconfiguredConfigTeamTool(database.issues),
     unconfiguredConfigPipelineTool(database.issues)]
  : [createConfigRoleTool(database.resolved),
     createConfigTeamTool(database.resolved),
     createConfigPipelineTool(database.resolved)]),
```

注册后工具总数 22 → 25。**没有 schema/迁移之外的前置条件**：三张表由 0014 建，
身份来自已有 `database.tenant_id/actor_id`。若要"一工具一动作"，见 §1 的拆包说明。

---

## 11. 未决问题 / 本轮刻意没做

1. **`db/verify.sql:311/313` 的 DEFERRED 行没有回抄**：Pipeline Template / Stage 现在有表了
   （`pipeline_template` / `pipeline_template_stage`），但 `verify.sql` 不在本 lane 的写范围
   （任务书限制只改 `db/migrations/0014_*.sql`）。需要总控改 COV 清单：`(12,…) DEFERRED → TABLE`、
   `(14,…) DEFERRED → TABLE`（`fn_block_delete` 计数 STRUCT-06 是从 38 → 50，仍有下限余量）。
2. **角色/团队的创建入口没有 UI/HTTP 路由**：本 lane 只到"工具可执行"（C19 有真实调用证据）。
   从运行中的入口可达（R2）需要总控把三个工具注册进 `src/index.ts` 并在 profile 里启用。
3. **`type:'null'` 不可表达** → 清空描述只能靠 `clear_description: true` 这个显式开关。
   如果以后 DSH 支持 union type，可以合并回 `description: null`。
4. **不做成员 `update`（改 team_role）**：目前语义是"先 remove 再 add"。加
   `update_member` 会把"成员行版本"引入为并发点，本轮刻意不做。
5. **不做阶段重排/删除**：`sort_order` 一旦写入不可改；重排会让"第几步"静默变化。
   需要 `reorder_stages` 这样的显式动作，且必须带版本号，属后续。
6. **不做"模板 → 申请"的切换**（Pipeline Instance）：仍是 `application.current_stage_code`。
7. **不做权限判定**：`permission_scopes` 只是数据，没有任何代码消费它。消费方是后续鉴权线。
8. **`actor_role` 的租户外键缺口是既有缺陷**（`0001:389` 的 `role_id references role(id)` 没有
   `tenant_id`）：本 lane 不修（属既有工具层/迁移之外），但新角色可被 `actor_role` 授权这一点
   在跨租户场景下仍需独立复核。
9. **没有做真实并发两连接用例**（团队/流水线）：版本冲突用"串行 + 旧版本号"覆盖（C5/C16），
   并发竞态路径（`*_RACE` 错误）只有代码路径，没有实测。阶段推进 lane 的 A6 有真并发用例可参照。
10. **迁移在 `ra_s6s7` 已应用**（0014），且在全新库上按 0001→0014 顺序重放过一遍；
    `db/verify.sql` 在该全新库上 PASS（详见 lane 回报的证据）。
