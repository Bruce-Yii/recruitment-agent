# 17 · 决策台账（唯一权威源）

**来源**：旧仓 `work/control/DECISIONS-2026-11-12.md`（**旧仓**，冻结只读；2026-11-14 随旧工作区移到 `D:\12412\dsh工作区\archive\recruitment-os-legacy-work\control\`）。下面是该文件 **530 行的逐字副本**，未改一字。
> 按 **D-82**：本仓内引用一律指向**本文件 + 编号**，不要再指向 `work/control/`（那个目录在本仓从未存在过）。
**新增裁定**（2026-11-13 起）在 [附录 A](#附录-a--2026-11-13-起新增的裁定)；**引用路径修正**在 [附录 B](#附录-b--引用路径修正2026-11-13)。

---

## 0. 这份文件怎么用（先读这三条）

1. **它是唯一权威源。** 任何裁定不在这里 = 视为未决定（R5）。新裁定**当天追加**到附录 A，不要只写在 commit message 或聊天里。
2. **`docs/16-design-rationale.md` §8 只是索引**，只挑影响架构的十几条；冲突时以本文件为准。
3. **引用格式**：`docs/17-decision-ledger.md` + 裁定编号（**不要写行号**，行号会随追加漂移）。

### 0.1 一次真实事故：这份台账曾经被截断

2026-11-13 发现：新仓里曾有一份 `work/decisions/DECISIONS-2026-11-12.md`，
**只有 82 行**（= 原文前 82 行，到 D-20 为止），而多份契约引用它时写的行号
（D-21 `:88`、D-22 `:96`、D-33 `:196-214`、D-46 `:299-315`…）**全部超出 82 行**。
一度被误判为"26 条裁定已永久丢失"。

**实际没丢**：原件 530 行完整保存在旧仓 `work/control/` 下，行号与所有引用逐字吻合。
教训有两条：

- **复制文件不是迁移。** 新仓那份是复制时被截断的；没有人校验过行数。
- **台账不要放 `work/`。** 旧仓的 `work/` 是不入库的过程目录，所以新仓从未真正"拥有"这份台账。
  这就是为什么本文件在 `docs/`（入库）。

---

# 决策台账 · 2026-11-12（总控裁定）

> 按 R5：裁定必须落文档，否则视为未决定。
> 以下 8 条由总控直接裁定，**不再上抛**；只有涉及产品范围变更的才需要产品负责人。

---

## A 线（PDF 读取器）2 条

### D-19 · `pdf_reading_order_unverified` 维持 HARD

**冲突**：参考实现 `batch.py` 把 `pdf_reading_order_` 整族当 SOFT；`doc 11` A4 要求"页字 <800 必须 HARD"。

**裁定：维持 HARD。** 理由：
- 顺序错 → 公司/职位/时间可能错配 → 直接影响筛选结论，这是招聘侧最危险的错误
- 40%（34/84）HARD 不是失败，是**语料真实质量**的反映（77 份里混了 PRD、行业报告、课程讲义）
- 但要求两条配套：
  1. 该 issue **必须带证据块**（哪些 block 顺序异常），让人一眼能判断
  2. 人工队列要支持"**仅顺序问题**"快速放行，不能让人逐个读 40 份

**不改回 SOFT 的理由**：SOFT 意味着系统自己认定"不影响"，而顺序问题恰恰是最难自动判断影响的。

### D-20 · 章节词表未命中 → 一律 `unreadable`，不写 `absent`

**裁定：维持现设计。** 理由：
- `absent` 的语义是"原文确实没提"，词表没命中推不出这个结论
- `unreadable` 的代价是进人工队列，`absent` 的代价是**误淘汰**——后者不可接受
- 补一条回归测试：**未知标题写法 → work/education 必须是 unreadable**，不得 absent

**不做**：不扩词表到无限（会变成猜）。词表是封闭集合这件事要写进 CONTRACT，让下游知道。

---

## B 线（PG Schema）6 条

### D-13 · 领域对象数 = **36**，回抄 docs/03

docs/03 §1 标题写"三十四个业务对象"，表体实为 36 行。**以表体为准 = 36**，回抄标题。

### D-14 · 7 个缓做对象维持缓做，但**必须补 seed**

缓做：Prospect / Pipeline Template / Stage / Stage Activity Template / Offer / Talent Pool / Source Thread —— 全部落在 Deferred 阶段，同意。

**但**：`business_config.stage_catalog` 现在**没有任何配置行**，P1 第一次查阶段目录会是空表。
→ **必须补 `0002_seed.sql`**：最小 stage_catalog + 一个 demo job + 一个 rubric version。否则联调必返工。

### D-15 · `intake_record` / `intake_asset` / `candidate_merge` 保留，定位为**支撑实体**

它们不在 §1 的 36 行里，但来自 docs/03 正文，且不变量 2（合并保留历史）与 §5 Intake 模型依赖它们。
**裁定**：保留表；在 SCHEMA.md 明确区分「业务对象（36）」vs「支撑实体（3）」；不把它们算成第 37–39 个业务对象。

### D-16 · v1.0 不新增阶段产物表

- Screening Result → `decision(scope='SCREENING')` ✅
- Evaluation Summary / Next Round Brief → **派生不落表**（v1.0）；要求：同一输入可复算出同一结果
- Calendar Event → `meeting.calendar_event_id` ✅
- Source Event → `event_inbox` 标准化列 ✅

若 P3 要求 Brief 版本化持久化，先改 docs/03 再开 `0002`，**不得先建表后补文档**。

### D-17 · canonical 粒度 = **每会议一个**（v1.0）

`transcript_artifact.is_canonical` 用部分唯一索引（每 meeting 一个 canonical）。`transcript_set` 实体留到 0002。

### D-18 · actor 写入必须 `SET LOCAL` + 统一封装

**裁定**：
- 所有状态迁移必须 `SET LOCAL recruitment.actor_id = '<uuid>'`（**不能**用 `SET`，连接池会泄漏给下一个请求 → 责任人记错，静默错误）
- 插件统一封装 `withActor(tx, actorId)`，UPDATE 后 `RETURNING record_version`，不缓存旧版本号
- 这条写进 C 线的调用约定，且必须有测试

---

## 需要产品负责人（不是总控）的 1 条

### P-1 · 顺序类 HARD 的规模是否可接受

按 D-19，84 份语料里 34 份（40%）会进人工队列。这是**产品侧的运营成本**：
- 接受 → 维持 D-19
- 不接受 → 只能降级为 SOFT，代价是可能带着错配的经历进筛选

**默认按 D-19 执行**；若产品负责人另有口径再改。

---

## 第二批裁定（2026-11-13 00:40）

### D-21 · 当前 Rubric 版本用显式指针，不用 max(version_no)

**问题**：`rubric_version` 表没有 `is_current` 列，`job` 也没有指向当前版本的字段。H 线只能用"只有一行"来表达。

**裁定**：新增 `job.current_rubric_version_id`（外键到 `rubric_version`，可空）。
**理由**：`max(version_no)` 在"回滚到旧版本"时会撒谎——回滚后 max 仍是新版本。当前版本是**业务状态**，必须显式记录。

### D-22 · 阶段 code 唯一口径 = S1–S12

**问题**：seed 用 S1–S12（来自 docs/01），C 线 CONTRACT.md 用 APPLIED/SCREENING/INTERVIEW/OFFER/REJECTED 五档。

**裁定**：**S1–S12 为唯一口径**；五档粗粒度值作废，`CONTRACT.md` 必须改。
**理由**：粗粒度值无法表达 S6（简历接入）与 S7（初筛）的区别，而这正是本系统的核心。

### D-23 · 建真表 `stage_catalog`，并给 `application.current_stage_code` 加外键

**问题**：阶段目录现在存在 `business_config` 的 JSON 里，`application.current_stage_code` 只有正则约束 → **写进一个不存在的 code 不会报错**，联调时会出现"查得到申请、查不到阶段名"的静默不一致。

**裁定**：`0004` 建 `stage_catalog(code PK, name, sort_order, in_v1_scope)`，种 12 行，`application.current_stage_code` 加外键。
**理由**：脏 code 是静默错误，必须在数据库层拦住。

---

## 第三批裁定 · 文本→结构化契约（2026-11-13 00:55）

G 线提出 6 个口径问题，逐条裁定：

### D-24 · 输入必须带 `#doc` 文档头（采纳）

**理由（G 线用真实跑批证明）**：阅读顺序不可信这个事实**不在 `issues` 里**，而在 `meta.order_verified=false`。模型看不到它，就会在"顺序不可信"的文档上**合法地写 `absent`**——这正是 doc 11 §9.11-7 的红线。

**裁定**：输入适配器必须供 `#doc`（含 `pages / completeness / issues / unread_pages / order_verified`）。块行格式不变：`#id | page | text`。

### D-25 · `education` 也用条目数组（采纳）

**理由**：§9.1 归属与 §9.4 时间线对教育同等成立；单字符串装不下 3 段学历。
**裁定**：`education` 与 `work_experience` 同为条目数组，每条带 `block_ids`。

### D-26 · 允许第 13 个 label `research`（采纳）

**理由**：真实语料里「科研经历」独立成章，12 项无处安放；与 `publication`（论文）语义不同。
**裁定**：保留 13 个 label，但 `labels.md` §5 必须维护 converter 九类 → 契约 13 类的映射表（G 线已做）。

### D-27 · `block_ids` 用字符串（采纳）

**理由**：它对应输入里的 `#12`，是**标识符**不是数量；字符串避免下游误当索引做算术。
**裁定**：保持字符串。

### D-28 · 受保护属性：不设值字段，但加"已识别类型"清单（折中采纳）

**问题**：G 线把受保护属性做成"只禁止、不给位置"——隔离最强，但审计看不到"系统识别到了年龄/性别"。
**裁定**：
- **绝不给值字段**（年龄/性别/婚育/籍贯/民族/照片的值一律不落输出）
- 允许顶层加 `protected_attributes_detected: string[]`，**只记类型名**（如 `["age","gender"]`），供审计
- 该清单**明确标注"永不作为筛选特征"**，且下游不得读取

### D-29 · 字段 `state` 以模型层为准，但必须保留 `converter_state` 并受硬校验约束（关键裁定）

**问题（G 线发现）**：同一份 PDF，converter 判 `education=unreadable`，契约允许 `education=present`（条目有学校、日期为 null）。两种都诚实，但下游看到的状态不同。

**裁定**：
1. **最终 `state` 由模型层给出**——否则模型层没有价值（converter 现在 42%/53% unreadable，正是要改的）
2. 但结果里**必须同时保留 `converter_state`**，供审计比对
3. **升级有门槛**：模型把 `unreadable` 升级为 `present` 时，**每一条 entry 必须通过硬校验**（公司/学校 + 至少一个时间或职位，且值均为原文子串）；任何一条不过 → 回退到 `converter_state`
4. **每次升级记一条 `state_upgrade` 事件**（字段名、converter_state、final_state、依据的 block_ids），用于后续质量复核

**理由**：既不放弃模型层的价值，也不允许它无证据地推翻转换器的判断。

---

## 第四批裁定 · 序列化与校验（2026-11-13 00:45）

### D-30 · 值匹配改为"连续块拼接匹配"，但不放宽逐字要求

**问题（F 线实测）**：块粒度是视觉行。真实数据里 `#6` 结尾「…佣金结算及分账」、`#7` 开头「中台等复杂业务。」是同一句话；PDF 连字符断行还会把 `semantics` 断成 `seman-` / `tics`。只允许"单块子串"会让真实模型频繁失败。

**裁定**：
1. 允许 `value` 匹配 **引用块按序拼接后的文本**
2. 但引用块必须**连续且有序**（`block_ids` 相邻），否则拒绝
3. 匹配时允许三种**归一化**：去掉块内 `⏎`、折叠空白、**跨块连字符断行**（`seman-` + `tics` → `semantics`）
4. **归一化只用于匹配，不改原文**——原始块文本永远保留（doc 11 A2 字符恒等不受影响）
5. 归一化规则必须**固定且写进契约**，不允许"语义相等"

### D-31 · 覆盖率必须"每块恰好归入一个 section"，不是"被引用过就算"

**问题（F 线实测）**：模型只要把剩余 id 全塞进 `block_ids` 就能刷满覆盖率（基线 `covered=103/103` 就是这样），所以覆盖率 100% 不能证明抽取完整。

**裁定**：
1. 覆盖率 = 每个 block **恰好出现在一个 section 的 `block_ids`** 里（重复出现 = 拒绝）
2. `ignored` 的块必须带 `reason`，且**不得被任何字段引用**
3. 字段引用的块**必须属于该字段所在 section**（`contact` 类字段除外）
4. 覆盖率证明的是"没漏块"，**不证明"处理对了"**——后者只能靠下游复核或模型兜底层（doc 12 ③），不得用覆盖率冒充

### D-32 · 校验层不得放宽规则去迁就模型

**问题**：F 线指出"正确改法是让 converter 合并换行，或让契约带 `raw_value` + 归一化字段，**不能**放宽规则 2 去允许语义相等"。

**裁定**：采纳。任何"为了让模型通过"而放宽校验的改动，一律视为**作弊**，必须驳回。规则 2（值必须可回查）不可放宽。

### 附 · 两处需要清理的历史问题（F 线如实报告）

1. `test/harness.mjs` 被 `node --test` 当作测试跑，且它调 `ctx.plugin({...})` 未传 config → `NOT_CONFIGURED` 抛错。**修复**：改为不被测试发现，或补 config。
2. `test/harness.mjs` §E 的"禁止 fs/child_process"扫描命中 `src/tools/converter.ts`——但该文件**本来就要**起子进程调 Python。**修复**：把 converter.ts 加进白名单，并在扫描规则里写明理由。

---

## 第五批裁定 · 权限与工作台（2026-11-13 01:05）

### D-33 · v1.0 不做 RBAC，改"全局可见 + 个人工作台"

**产品负责人裁定（2026-11-13）**：
- **不做权限矩阵**。v1.0 所有人**全局可见**（能看到所有候选人/岗位/面试）
- 但每个人有**属于自己的工作界面**——因为职责不同
- **暂时不做那么多角色**

**总控落地口径**：
1. **不建** `role` / `permission` / `actor_role` 的授权判定链路；不做工具级权限检查
2. 角色**降级为标签**：只用于"我的工作台"过滤和界面展示，**不用于拦截**
3. **个人工作台**按"分配给我的"过滤，例如：
   - 我的待办任务
   - 我负责的面试
   - 我参与的岗位
   - 我最近看过的候选人
4. 数据层保留 `actor_id` 字段（用于归属与审计），但**不校验**
5. 原计划的"权限矩阵"任务**撤销**，不派发

**风险登记**：这是**有意的产品降级**。将来要开权限时，需要补：数据范围判定、工具级检查、审计。当前不预留"假接口"（不写永远返回 true 的 `can()` 之类）。

---

## 第六批裁定 · 0004 阶段目录与既有脚本冲突（2026-11-13 01:20）

### D-34 · 授权修改 `db/verify.sql` 的 2 处夹具（冲突 1）

**问题**：`verify.sql:398` 的夹具用 `current_stage_code='SCREENING'`，该值已被 **D-22** 作废、不在 S1–S12，加了外键后**必然违反**。
证据：加 0004 前 `VERIFY PASS`；加 0004 后 `违反外键约束 fk_application_stage_catalog`。

**裁定**：**授权修改** `db/verify.sql` 两处：
1. 给夹具租户种同一份 stage_catalog
2. `'SCREENING'` → `'S7'`

**理由**：夹具本身用了一个已作废的值，是夹具错，不是外键错。改完必须仍 `VERIFY PASS`，且除这两处外不得有其它改动。

### D-35 · `stage_catalog` 用 uuid 主键 + tenant_id + unique(tenant_id, code)（覆盖 D-23 字面）

**问题**：D-23 字面写 `code` 主键；但 SCHEMA.md §1 与 `verify.sql` STRUCT-01/02/03 要求每张表单列 uuid `id` + NOT NULL `tenant_id` + tenant 外键。

**裁定**：**采纳实现方的偏离**。理由：外键指向 `(tenant_id, code)` 拦脏 code 的强度不变，且目录按租户隔离更符合多租户模型。**D-23 的字面表述以此条为准。**

### D-36 · 运营类表（0003）也必须用单列 `id` 主键

**问题**：`0003_review_queue.sql` 三张表主键叫 `run_id` / `item_id` / `audit_id`，导致 `verify.sql` STRUCT-01 失败（"这些表的主键不是单列 id"）。这是**跨 lane 冲突**，与 0004 无关。

**裁定**：**要求 0003 改成单列 `id`**，外键相应改指向。
**理由**：一条约定必须一条到底，否则 STRUCT-01 就成了摆设；"运营表可以例外"这种豁免一旦开口，以后每张新表都会要求例外。
**代价**：0003 需要一次机械改名，I 线回传后派修正。

### D-37 · `application.current_stage_code` 默认值改为 `'S6'`

**裁定**：**采纳**。D-22 已作废五档值，保留 `'SCREENING'` 默认值会让"不写阶段就插入"永远撞外键，等于换个方式静默失败。

---

## 第七批裁定 · 身份解析（2026-11-13 01:35）

K 线提出 5 个口径 + 3 个结构性发现，逐条裁定：

### D-38 · 身份类的"推不出"一律进人工（补 K 指出的编号错位）

K 线指出任务书把 **D-20** 当身份口径引用，但 D-20 实际是"章节词表未命中 → unreadable"（A 线）。它按同构原则引用，**判断正确、编号错误**。

**裁定**：新立本条——身份判定中**任何推不出唯一结论的情况，一律 fail-closed 到人工**，不得写 absent/不匹配。适用于：`unknown` provenance、姓名 `unreadable`、弱匹配。

### D-39 · "待人工"不进 `candidate.identity_status`（P-1）

**理由（K 线的结构性论证）**：`uq_candidate_active_email/phone` 的谓词写死 `identity_status='ACTIVE'`（`0001:755-758`）。一旦引入第三个非 MERGED 值，同号两条档案可并存，**N26 守的唯一性当场失效**。

**裁定**：待人工状态挂在 `review_queue` 上，`candidate` 保持 ACTIVE；**不加新的 CHECK 值**。

### D-40 · v1.0 接受拆分关闸（P-2）

**裁定**：v1.0 **不支持撤销合并**（`SPLIT_REQUIRES_SCHEMA` 409）。界面必须明说"暂不支持撤销合并"，否则 HR 会去手工改库——那比不支持更危险。

### D-41 · 自动合并必须记 `SYSTEM` actor（P-3）

**裁定**：`decided_by_actor_id` 非空，自动合并记 `SYSTEM` actor；`D-14` 的 seed 必须补这个 actor。**不写 actor 的自动决策一律拒绝**。

### D-42 · 弱匹配产生人工队列（P-5）

**裁定**：姓名 + 公司/学校全同 → **产生人工复核项**（不自动合并）。
**理由**：漏合并的代价（两个档案）远小于错合并的代价（两个人的经历混在一起、评价挂错人）。

### D-43 · v1.0 demo 用 `MANUAL_ONLY`（P-6）

**裁定**：v1.0 演示阶段身份解析只做**人工闸门**；`AUTO_HIGH_CONFIDENCE` 等 S7 验收通过后再开。

### D-44 · 拆分需要新增审计载体（待办，不阻塞 v1.0）

**问题（K 线 G-3）**：`candidate_merge` 整行不可 UPDATE、无 split 语义列；`candidate` 无 `status_changed_*`，`fn_row_guard` 也不管 `identity_status`。→ **`MERGED→ACTIVE` 数据库拦不住，且不产生任何审计**。

**裁定**：后续迁移新增不可变 `candidate_split` 表 + 扩展 guard。**在此之前拆分一律 409**（与 D-40 一致）。登记为待办，v1.0 不阻塞。

### D-45 · 夹具不得插两条同号 ACTIVE

**问题（K 线发现）**：`uq_candidate_active_email/phone` 使两条 ACTIVE 不可能同时持有同一强标识（`23505`）。
**裁定**：写夹具/测试时必须遵守；"同手机号自动合并"只能通过"一条持有 + 来料证明另一条是重复档"或"来料自带两个强标识交叉印证"两种形态表达。

---

## 第八批裁定 · 身份规则简化（2026-11-13 01:55）

### D-46 · 撤销 D-42，姓名差异不做闸门（产品负责人纠正）

**我错在哪**：K 线提出"同手机号 + 不同姓名一律人工"，我还认了，并编造了"家庭共用手机号 / 父母代投 / 猎头转发"三个场景来论证。

**产品负责人纠正（2026-11-13）**：真实招聘场景里**简历上的姓名就是候选人本人**——HR 不会用别人名字，候选人不会不填自己名字，猎头转发的也是候选人自己的简历。**那三个场景不成立。**

**真实原因只有两种**：
1. **姓名写法差异**（高概率）：`张三` / `张 三` / `张三(Zhang San)` / 全半角 / 曾用名 / 英文名
2. 手机号填错（低概率）

**裁定（撤销 D-42）**：
1. 姓名先**归一化**：去空格、全半角、大小写、中英文对照、常见后缀（`(Zhang San)`）
2. 归一化后相同 → **自动合并**
3. 归一化后确实不同 → **不合并、不阻断**：新建档案 + 标记 `possible_duplicate`（低优先级提示），**不占人工队列**
4. **D-42 的"弱匹配产生人工队列"作废**

**教训**：把罕见情况做成闸门，会让 99% 的正常简历承担成本。设计风险时先问"这在真实场景里会发生吗、多大概率"，不能凭想象堆防御。

---

## 第九批裁定 · 队列与筛选（2026-11-13 02:15）

### D-47 · 0003 的表豁免 `fn_row_guard`（STRUCT-05），但必须保留自己的守卫

**问题（I 线）**：`verify.sql` 的 STRUCT-05 要求"有 status 列的表必须有 `fn_row_guard` 触发器"。但：
- `conversion_run` 是 **append-only**（根本没有 UPDATE 路径）
- `review_queue` 用**专用状态机**（`fn_review_transition_allowed`）+ `review_audit` 留痕

给它们套 `fn_row_guard` 需要加 `status_changed_*` 并向 `event_inbox` 写事件——**为过检查而接一条永不执行的触发器，属 R2 假接线**。

**裁定**：**豁免这两张表**，并在 `verify.sql` 的 STRUCT-05 里写明豁免理由 + 指向各自的真实守卫（`trg_conversion_run_immutable` / `trg_review_queue_before_update` / `trg_review_queue_audit`）。
**授权修改 `db/verify.sql` 的 STRUCT-05**。

### D-48 · S-1 已由 0004 解决（J 线信息滞后）

J 线说"`job` 没有 `current_rubric_version_id` 列"。**0004 已经加了**（D-21）。
**裁定**：J 线的 `current(job, as_of)` 推导规则**作废**，直接用 `job.current_rubric_version_id`；该列为空时返回 `NO_RUBRIC`，**不回退推导**。

### D-49 · 修 S-3：版本不得跨 job 引用（新迁移 0005）

**问题（J 线，最该修）**：`application.rubric_version_id` / `job_version_id` 只做 `(id, tenant_id)` 外键，**能指向别的 job 的版本** → "钉版本"形同虚设。
**裁定**：新迁移 `0005`：
1. `rubric_version` / `job_version` 加 `unique (id, job_id)`
2. `application` 改成复合外键 `(rubric_version_id, job_id)` 与 `(job_version_id, job_id)`

### D-50 · R-VAL-14 暂时降级为告警

**问题**：`payload_hash` 的 canonical_json 覆盖范围与序列化规则没有共享实现，写侧读侧各写一份会互相误判。
**裁定**：在共享实现落地前，R-VAL-14 **降级为告警**，不得据此拒绝。登记待办。

### D-51 · 统一工具错误格式为 `Error: <CODE>: <compact-json>`

**问题（J 线）**：包拿不到结构化 `error.info`，现有 3 个 stub 的错误消息格式不统一。
**裁定**：一次性统一 `errors.ts`：`Error: <CODE>: <compact-json>`。对现有 stub 是破坏性变更，**允许**（它们本来就是 stub）。

---

## 第十批裁定 · 身份规则再简化（2026-11-13 02:30）

### D-52 · 撤销 D-46 的归一化与"可能重复"机制

**我错在哪**：D-46 里我又编了一堆场景——`张三 / 张 三 / 张三(Zhang San) / 全半角 / 曾用名` 五种"高概率"姓名差异，还加了"手机号填错（少一位多一位）"。

**产品负责人纠正（2026-11-13）**：
1. 姓名差异**只有前两种可能**（`张三` / `张 三`），而且**模型结构化时不会搞错**，所以连归一化都不需要
2. **手机号填错不关我们的事**——"你觉得我们是神仙吗"

**裁定（D-46 作废）**：
1. 手机号 / 邮箱 **trim 后精确匹配** → 同一候选人
2. **姓名不参与合并判定**
3. **不做**：姓名归一化、手机号纠错、"possible_duplicate" 标记、为姓名差异建人工队列
4. 一个手机号对应两个名字这种极罕见情况 → 以最新简历姓名为准，HR 发现不对自己改，**不设特例**

**教训（第二次）**：我连续两次把罕见情况做成机制。**设计前先问：这在我们这里会发生吗？发生了是不是本来就该人管？**

---

## 第十一批裁定 · 版本绑定（2026-11-13 02:45）

### D-53 · D-49 的 2 列外键改为 3 列（含 tenant_id）

**问题（0005 线实测）**：D-49 写 `(rubric_version_id, job_id) → rubric_version (id, job_id)`，2 列**不含 tenant_id**。但 `db/verify.sql` 的 **STRUCT-07** 断言"凡 conkey 超过 1 列的复合外键必须含 tenant_id"（豁免 `source_revision` / `transcript_revision`）→ 0005 一跑 STRUCT-07 必 FAIL，而验收又要求 verify.sql 仍 PASS。**两条按字面不可能同时成立。**

**裁定**：**采纳 3 列**——`(tenant_id, rubric_version_id, job_id) → rubric_version (tenant_id, id, job_id)`，`job_version` 同构。
**理由**：强度**严格强于** D-49（同 job + 同租户同时物理保证），D-49 要拦的行为照样拦（实测 23503）。**D-49 的字面以此条为准。**

### D-54 · 下游三张表的 rubric 引用漏洞单开 0006

**问题（0005 线发现，如实登记）**：`interview_template_version.rubric_version_id`、`interview_record.rubric_version_id`、`scorecard.rubric_version_id` 仍是 2 列外键 → **仍可引用别的岗位的 rubric**（评分卡能拿别的岗位的标准打分）。

**为什么不在 0005 修**：这三张表**没有 `job_id` 列**，job 要经 `interview → application` 反查，纯外键做不到（需生成列或触发器）——**是设计决策，不是迁移技巧**。

**裁定**：单开 `0006` + 新裁定。**登记为待办，不混进 0005。**

---

## 第十二批裁定 · 校验器与转换器缺陷（2026-11-13 02:55）

### D-55 · 转换器真 bug：同一 URL 在正文出现两次

**发现者**：独立校验器（L 线）扫全量 45 份，`TOTAL 45 passed=43 failed=2`。

**两份失败**：
- `唐乐-简历.pdf`：2799 → 2825 字，多出的 26 字 = `https://zhitu.kralai.tech/` 印了两遍
- `tangle-resume.pdf`：1836 → 1887 字，同上（`.../showcase.html`）

**根因**：URL 印在一整行中文里（被当成一个"词"），词中心点落在链接注解矩形外 → 绑不上 → 走 fallback 又生成一个 `[URL](<URL>)` 块 → **同一个 URL 在正文出现两次**。

**裁定**：这是**真缺陷**，必须修（不是"设计如此"）。
**修法**：fallback 生成 link 块前，先检查该 URI 的文本是否已出现在同页任何 block 里；已出现则不再生成 fallback 块。
**注意**：我此前把这个"多出字符"解释为"无可见文字的链接用 URL 保留，属设计"——**解释错了一半**：保留是对的，重复是错的。

### D-56 · 给 conftest 加 `--no-corpus` 开关

**问题（L 线）**：既有 `tests/conftest.py` 的语料守卫会让 `pytest tests/` 直接 exit 2，任何不依赖语料的测试都跑不起来。
**裁定**：conftest 增加 `--no-corpus` 开关；不传时保持现在的 fail-fast 行为（不许静默 skip）。

---

## 第十三批裁定 · 工作台与提交纪律（2026-11-13 03:10）

### D-57 · D-33 措辞回抄："最近看过" → "最近处理过"

**问题（R 线实证）**：0001–0004 的 DDL 全文**没有** `viewed_*` / `last_view*` / `seen_at` / `read_by` 任何浏览记录列（唯一 `last_readback_at` 是"外部回读"，语义不同）。
**裁定**：D-33 的"我最近看过的候选人"改为"**我最近处理过**的申请"。
**明确禁止**用 `application.updated_at` 代替——`fn_touch` 每次 UPDATE 都改（含系统内部迁移），会把"系统动过"记成"我动过"。

### D-58 · 时钟参数统一叫 `as_of`，不用 `evaluated_at`

**问题（R 线）**：工作台要判"逾期/最近 14 天"，需要时间输入；但兄弟契约 `job-screening/tool-contracts.md` 规定"无时钟、唯一时间输入是 `as_of`"。R 线引入了 `evaluated_at`，**两套口径并存**。
**裁定**：**统一用 `as_of`**（与兄弟契约同名同义）。工作台的 `as_of` 为必填。**不允许两套时间参数名并存**（R5）。

### D-59 · `business_task.owner_actor_id` 单开 0006

**问题（R 线）**：`business_task` 没有 owner/assignee 列，工作台只能用 `created_by_actor_id` 充当"责任人"。
**裁定**：`0006` 加 `business_task.owner_actor_id`（可空，外键到 actor）。
**明确禁止**：不得通过扩展 `business_refs.kind` 来表达责任人（会撞 `screening-rules.md` §6.2 的 7 值封闭集）。

### D-60 · 提交纪律：只提交"已回传 + mtime 稳定"的文件

**我犯的错**：`d50e675` 提交时，0003 对齐那条线**还在写**，把未完成的 0003 / verify.sql / verify-0003 一并提交了。
**裁定（以后固定）**：
1. 只有**该线已回传**且文件 mtime **至少 60 秒未变**，才允许提交
2. 提交前必须 `git status` 逐个确认文件属于哪条线
3. 多线并行时，**按线分批提交**，不 `git add -A`
4. 已发生的混入不回滚（内容无害），但必须在后续提交里修正并说明

### D-61 · 工作台夹具单开一条线

**问题**：R 线的三个用例是"规格期望"，不是实测（`ra_align` 里 interview/interviewer/business_task/approval 均 0 行）。
**裁定**：单开一条线造夹具 F-WB-A/B/C 并实测。**不阻塞契约**（契约已交付）。

---

## 第十四批裁定 · 面试与转写（2026-11-13 03:25）

### D-62 · `schedule` 接受四合一 intent（不拆工具）

**问题（P 线）**：为让"面试官请假"有执行路径，`recruitment_interview_schedule` 需要四个 intent：`CREATE` / `RESCHEDULE` / `CANCEL` / `WITHDRAW_INTERVIEWER`。
**裁定**：**接受四合一**，用 `intent` 枚举区分。
**理由**：拆成 4 个工具会让模型在相似工具间误选；一个工具 + 明确 intent 更可控。语义与错误码逐字沿用。

### D-63 · 错误格式统一（D-51 的落地范围）

**问题（P 线）**：新契约用 `Error: <CODE>: <json>`，与 `CONTRACT.md §2.2` 的散文格式不兼容；`job-screening` 也是同一个未决事项。
**裁定**：**D-51 即刻生效**——一次性统一 `errors.ts` 为 `Error: <CODE>: <compact-json>`，所有契约与实现对齐。**不允许两套错误格式并存**（R5）。

### D-64 · 转写正文读取工具单独立契约

**问题（P 线）**：`recruitment_interview_get` 不返回转写正文，正文与分页需要另一个工具 `recruitment_transcript_read`。
**裁定**：**单独立契约**（S10 的后半），本批不做。登记待办。

### D-65 · 打包 0006：四个 schema 缺口

P 线报的缺口里，有四个必须修，打包进 `0006`：

| # | 缺口 | 修法 |
|---|---|---|
| 1 | `interview.stage_code` 默认 `'INTERVIEW'`，不在 S1–S12 且无外键 | 改默认 `'S8'` + 加外键到 `stage_catalog` |
| 2 | `execution_mandate` 的 CHECK **没禁 `submit_scorecard`** → agent 代填面评库层不拦 | 扩展 CHECK 禁止 `submit_scorecard` |
| 3 | `fk_interview_record_artifact` **未带 tenant_id** → 跨租户引用 artifact 可能成立 | 改成含 tenant_id 的复合外键 |
| 4 | `business_task` 无 `owner_actor_id`（D-59） | 加可空外键 |

**加上 D-54**（下游三张表的 rubric 引用）——它是设计决策（无 job_id 列，需生成列或触发器），**单独 0007**，不混进 0006。

### D-66 · P 线裁决中我直接认可的（不再讨论）

以下 P 线自己裁决的条款，我认可并写进权威：
- 改期 = 改同一行（`uq_interview_slot` 物理禁止两条）
- `RESCHEDULED` 的唯一语义 = 当前无有效时间
- 取消后重排只能走 `RESCHEDULE`
- 只有 `required_scorecard=true` 的面试官占时段
- 绑不上会议不拒绝排期，工具**不做任何外部写**
- v1.0 只接受 `VIDEO`，其余报 `UNSUPPORTED_DELIVERY_MODE`
- `NO_TRANSCRIPT` 只挂在 `get.require_transcript`，不挂 `schedule`
- `transcript_artifact` 一行 = 一次完整回读快照，**不插占位行**
- `NEEDS_VISUAL` 只作 `business_task.error_code`，不进枚举
- **一场面试可以有多个会议**（库只在 meeting 侧唯一）

---

## 第十五批裁定 · 模型兜底（2026-11-13 03:40）

### D-67 · `provenance` 枚举扩为四值，`model_read` 单列

**问题（M 线）**：doc 11 D2 的三元组是 `native_text | ocr_title | agent_read`，但模型兜底产出的是"模型看图转录"，与 `agent_read`（Agent 读）语义不同。M 线做了双标 `provenance="model_read"` + `source_class="agent_read"`，但下游若 `switch(provenance)` 把未知值当"可自动合并"，D3 红线会漏。

**裁定**：**枚举扩为四值**：`native_text` / `ocr_title` / `model_read` / `agent_read`。
**并且**：D3 红线（身份类字段不得驱动自动合并）明确点名 **`ocr_title` / `model_read` / `agent_read` 三者全部适用**，只有 `native_text` 且格式校验通过才可自动。

### D-68 · 渲染按源图 dpi 提示，超大页分块

**问题（M 线实测）**：`image_only_1.pdf` 是 2480×3507 **pt** 的巨型页、内嵌图等效 **72 dpi**。默认 200 dpi 产出 6889×9742（67MP、2.19MB、1.07s）。视觉端点通常把长边压到 ≤4000，压回去正好抹掉要读的小字。

**裁定**：
1. 渲染 dpi 以 **`source_dpi_hint`** 为准（本例 72 就够），**不把 dpi 当性能旋钮**
2. 长边 > 4000px 时**分块渲染**（上下或四宫格），不是硬提 dpi
3. 分块必须记录块坐标，合并时按坐标拼回

### D-69 · 顺序不可信页不合并模型文本

**问题（M 线）**：顺序不可信的页原生文本完整，追加模型文本后同一页有两份内容 → 重复正文。
**裁定**：模型兜底**只用于"没有可用原生文本"的页**（`pdf_no_text` / `unread_visual_page` / `pdf_text_encoding_unread`）。顺序不可信但文本完整的页，**不合并**。

### D-70 · M 线状态如实登记

**BLOCKED 两项**：
1. 真实模型链路（余额不足，0 次真实读取）→ doc 12 §2③ 的"必须用真实 Agent 跑"**未做**
2. 未接线（写范围只有 `fallback/`）

**未证**：图像页无原生文本可比，`overlap=null` → 只能证"没编造、没坏字形、没越界"，**不能证读对了**。
**裁定**：这三条写进权威，**不得**把该层标为"③层已通过"。

---

## 附录 A · 2026-11-13 起新增的裁定

> 格式：裁定 / 理由 / 证据。证据一律给 `文件:行` 或命令输出，不给"我记得"。

### D-71 · 领域写路径用 TypeScript + node-postgres（`pg`），不做 Python sidecar

**裁定**：招聘域的业务写入实现在 `dsh/dsh-recruitment` 插件内，用 `pg@^8.23.1` 连 PG。
Python 只保留在它本来就是正确工具的地方：PDF 解析（PyMuPDF）、OCR（仅标题）、页面渲染。

**理由**：DSH 插件是产品面，业务逻辑不该被拆到子进程；一次工具调用起一个 Python 进程
（~150ms）在演示规模能忍，但会让"一个领域规则"变成"两套实现"。代价是本包不再是零依赖。

**证据**：`dsh/dsh-recruitment/CONTRACT.md:44-49`；commit `677a70a`；
实测从本包目录连 PG 17.11 → `select count(*) from recruitment.stage_catalog` = 12 行。

### D-72 · S6「简历接入」必须有自己的工具

**裁定**：新增写工具 `recruitment_application_intake`，按 `contracts/identity/` 的规则建
`candidate` + `application`。决策类写入（advance/reject）仍然只能由人经
`recruitment_decision_record` 落库。

**理由**：11 个契约工具里没有任何一个创建 candidate/application，而
`recruitment_screening_evaluate` 明确只读、只吃 `application_id`。不补这个工具，链路在 S6→S7 断开。

**证据**：`dsh/dsh-recruitment/contracts/job-screening/tool-contracts.md:12-20`（"只读 / advisory / 不落决策"）。

### D-73 · 阶段码唯一口径 = `stage_catalog`（S1–S12），老仓 `handoff/15` 的编号不是阶段码

**裁定**：S6=简历接入、S7=初筛、S8=面试规划与排期、S9=面试执行与材料获取、
S10=综合评价与招聘决策、S11=Offer 与入职交接。契约里凡写成 S8=筛选 / S11=评价决策的，
**全部改**。老仓 `work/handoff/15-architecture-hv.md` 的 S7 身份解析 / S8 筛选 / S11 评价决策
是**架构编号**，不是阶段码，不得再用。

**理由**：`stage_catalog` 是唯一被外键强制的口径（`application.current_stage_code` → 0004）；
D-22 原文也是按生命周期编号写的（"S6（简历接入）与 S7（初筛）"）。

**证据**：`db/migrations/0002_seed.sql:242-243`；`docs/01-business-lifecycle.md:138/152/186`；
`db/STAGE-CATALOG.md`；`contracts/STAGE-CODES.md`。

### D-74 · `scorecard.items` 是**对象**，不是数组

**裁定**：`items` = 以 rubric 准则 key 为键的对象，保留键 `transcript_basis`；
证据 kind 用 `SEGMENT`（不是 `TRANSCRIPT_SEGMENT`）。

**理由**：① 已提交的 `interview/transcript-rules.md` TR-E2/TR-E3 与
`interview/tool-contracts.md` 两处依赖对象形态；② 对象天然能检出"漏评一维"（key 缺失），
数组要扫描且允许重复 key。

**证据**：`contracts/interview/transcript-rules.md:320-321`；`contracts/interview/tool-contracts.md:209`。

### D-75 · 0007 的范围（决策与面评的完整性缺口）

**裁定**：0007 修五处：
1. `decision.stage_code` 补外键（照 0006 的 `fk_interview_stage_catalog`）；
2. `decision` 的 current 唯一性（部分唯一索引，`stage_code` 可空 → 必须处理 NULL）；
3. `scorecard.rubric_version_id` 必须绑到**该申请的那个岗位**的 rubric；
4. `ai_summary.fk_ai_summary_artifact` 补 tenant_id（同 0006 GAP-3 的改法）；
5. 直接 INSERT 终态行绕过 `status_changed_by_actor_id`（先实测是否真能绕，能才改）。

**理由**：这五处都是"错误写法在库层不报错"，与 0006 同一判据。
特别是第 2 条：`decision` 现在**没有任何唯一约束**，两条互相矛盾的 FINAL 决策可以并存。

**证据**：实测 `decision.stage_code` 的外键数 = 0；全库仅剩 `ai_summary.fk_ai_summary_artifact`
一条多列外键不含 tenant_id；`decision` 只有 PK 与若干 FK，无 unique。

### D-76 · 0006 GAP-4 用复合外键，收紧 D-59 的字面

**裁定**：`business_task.owner_actor_id` 的外键是 `(owner_actor_id, tenant_id) → actor(id, tenant_id)`，
不是 D-59 字面的单列。

**理由**：单列会让甲租户任务的"责任人"指向乙租户的 actor，工作台按 actor 过滤时跨租户可见。
强度严格更强，D-59 要拦的"指向不存在 actor"照样 23503，可空语义不变。

**证据**：`db/migrations/0006_integrity_gaps.sql` §4；`db/verify-0006.sql` G4-01/02/03。

### D-77 · 0006 GAP-3 沿用原约束名

**裁定**：`fk_interview_record_artifact` 改成 3 列后**不改名**。

**理由**：库里只有一条"面试记录→转写版本"外键，改名会让 `SCHEMA.md` 与台账里的名字指向不存在的约束。

**证据**：`db/INTEGRITY-GAPS.md` §5。

### D-78 · 新建租户必须先种 `stage_catalog` 再插面试

**裁定**：任何夹具 / 测试 / 新租户初始化，只要会插 `interview`，必须先把 12 行阶段目录种进该租户。

**理由**：0006 给 `interview.stage_code` 加了 `(tenant_id, stage_code)` 外键；默认值 `'S8'`
只保证"给了一个合法值"，救不了"该租户目录没种"。这是最可能在集成时炸的一条。

**证据**：`db/migrations/0006_integrity_gaps.sql` §1；`db/verify-0006.sql` G1-01/02/03。

### D-79 · 人类闸门复用 DSH 的审批 seam，不自研

**裁定**：写人类动作的工具（S7 决策 / S8 排期 / S10 面评与决策）必须
`inject: ['tools', 'approval']`，在写库**之前**调 `ctx.approval.request({agent, tool, callId, reason, signal})`：
`allow` 才写库，`decided_by_actor_id` 取**审批人**映射的本地 actor，**绝不取模型入参**；
`deny` / `unavailable` / `cancelled` → `BLOCKED_BY_APPROVAL`，不写任何行。

**理由**：`execute(args, exec)` 的 `exec` 只有 `callId` / `agent?` / `signal` / 传输 token，
**没有"人还是 agent"的信息**。靠工具自己判断等于没有保证。
DSH 自带 `@deepseek-ai/dsh-user-approval`（fail-closed）；headless profile 只有 seam 没有 UI →
请求一律 `unavailable` → 拒绝。于是"无人值守跑批不可能落决策"是**结构性**的，不是纪律性的。

**证据**：`dsh-tools/lib/types/index.d.ts` 的 `ToolExecutionInput`；
`dsh --profile recruitment --dump-config` → `- id: approval` + `- id: ui-approval`；
`docs/18-golden-path.md` §6。

**未做到**：审批人 → `actor_id` 的映射还没实现（v1.0 单用户，取配置里的本地 actor）。

### D-80 · v1.0 不做 `decision` 的客户端幂等键

**裁定**：取消"同一 idempotency key 重试返回同一条决策"这个承诺。
并发与重复的防线改为：`(tenant_id, application_id, decision_scope, stage_code)` 只有一条 current
（0007 的部分唯一索引），冲突 → 23505 → 工具报 `ALREADY_DECIDED`。
文档里"靠 `SELECT … FOR UPDATE` 防双插"的说法删掉——**它锁不到不存在的行**。

**理由**：`decision` 表没有可落幂等键的列；加列要迁移；而"重试同一请求"在工具调用里没有语义。
承诺一个实现不了的幂等比不承诺更糟。

**证据**：`decision` 表无 unique（实测）；`contracts/evaluation/decision-rules.md` DC-38/DC-41 待改。

### D-81 · 模型兜底的"读"由 agent 自己承担，不另起模型调用

**裁定**：`converter/fallback` 的 A（页面渲染）、D（校验）、E（合并）保留复用；
**B（`model_reader` + `pipeline` 的模型调用）在 DSH 里是多余的** —— agent 自己就是模型，
它有视觉能力，应该由插件把页面图交给它读，而不是插件内部再调一次模型。

**理由**：在插件里调模型需要一套独立凭据与配额，且模型看不到工具之外的上下文；
而 agent 本来就在会话里。这符合"复用优先、不重复造模型通道"。

**证据**：`converter/fallback/model_reader.py`（`model_call` 只能注入，包内无 provider SDK）；
`converter/fallback/README.md` §接线状态（BLOCKED：未接线）。

### D-82 · 契约里的 `work/control/…` 引用一律改指本文件

**裁定**：契约中所有 `work/control/DECISIONS-2026-11-12.md:<行号>` 与
`work/decisions/DECISIONS-2026-11-12.md` 的引用，统一改成
`docs/17-decision-ledger.md` + 裁定编号（**去掉行号**）。

**理由**：`work/control/` 在新仓从未存在（实测 `Test-Path` = False），`work/` 也不入库；
行号会随追加漂移。

**证据**：全仓 27 处引用，其中 20 处写的是 `work/control/`。

### D-83 · 两条口径冲突的裁定

**裁定**：
1. **PRD FR-V4（原始备注保护）vs 契约 SC-36（全租户可见）不冲突**：前者管**不可覆盖**
   （`trg_*_immutable`），后者管**可见性**。D-33 的"全局可见 + 个人工作台"继续有效。
2. **PRD FR-V8（Brief 需下一轮已创建并版本化）vs DC-41/42**：**D-16 赢** ——
   Brief 派生不落表，v1.0 不版本化。FR-V8 按 v2 处理，不阻塞 v1.0。

**证据**：`docs/16-design-rationale.md` §6（D-33）；D-16 正文见本文件 §C 线；
`db/migrations/0001_init.sql` 的 `trg_*_immutable`。

---

## 附录 B · 引用路径修正（2026-11-13）

| 之前写的 | 实际情况 | 改成 |
|---|---|---|
| `work/control/DECISIONS-2026-11-12.md:<行号>`（20 处） | 该目录**在本仓库从未存在** | `docs/17-decision-ledger.md` + 编号 |
| `work/decisions/DECISIONS-2026-11-12.md` | 曾是 82 行残本（前 82 行） | 同上；残本已不再作为权威 |
| `work/handoff/15-architecture-hv.md` | 新仓未收录（只在旧仓） | 不再作为阶段码依据，见 D-73 |

**旧仓位置**（只读参考，不要在里面开发）：
`D:\12412\dsh工作区\archive\recruitment-os-legacy-work\control\DECISIONS-2026-11-12.md`（2026-11-14 随旧工作区迁出）

### D-84 · 终局决策不接受"缺面评但逐条确认"的旁路

**裁定**：`ADVANCE(FINAL)` 与 `REJECT` 在缺少任何**必交面试官**的面评时，**一律** `SCORECARD_MISSING`，
**不允许**用 `acknowledged_missing` 绕过；只有 `ADVANCE(STAGE)` 可以带逐条确认推进。
`HOLD` / `WITHDRAW` 永远不被面评缺失阻断。

**理由**：错误淘汰不可逆，给终局开"确认旁路"等于把四道防线降级成"记得点确认"。
方向故意不对称：推进可以保守地少信息，淘汰不行。

**证据**：`contracts/evaluation/decision-rules.md` §4.2.1 + Q-5；`docs/17` D-19（顺序 HARD）同一取向。

### D-85 · 解析层唯一权威契约 = `DocumentContent`（docs/19），`converter` 是它的实现细节

**裁定**：同一层只能有一个真相。`DocumentContent`（docs/19 §2.1）是解析层的**唯一权威契约**；
`converter/` 的现有输出不是与它并列的第二套契约，而是必须被**无损映射**进 `DocumentContent` 的实现细节。
旧的更好就吸收进新契约（page/bbox、字符保真、独立校验器），不保留"两套并行、下游自己挑"。

**理由**：本项目历史上所有大坑都来自"两套权威并存"（`docs/10` vs Notion、`handoff/15` 阶段码 vs `stage_catalog`、
`work/control` 台账残本）。解析层再来一次就是第三次。

**落地**：`dsh/dsh-recruitment/src/document/README.md` 写死映射表与硬断言——
同一份 PDF，`converter` 直出的 block 数/文本/page/bbox 与映射后的 `DocumentContent` **逐项一致**；
`completeness` 只有一套；`issues[].code` 由 U2 消费不得重命名。

**证据**：Issue #3 与 docs/19；用户裁定原话"到底哪个好，就以哪个为准呗，并不是冲突的关系，本质上都是在做这一层"。

---

## 附录 C · 工作方式裁决（2026-11-13 晚，产品负责人对齐）

> 前五条管"做什么"，这五条管"怎么干"。细节与可执行步骤见 `docs/21-agent-operating-model.md`。

### D-86 · 总控 = 整个招聘 Agent 的总控，不是简历层负责人

**裁定**：总控对 S3–S10 全链路负责（岗位/简历/筛选/面试/转写/评价/决策），不是只管简历解析。
总控**独占** `src/index.ts`、`db/migrations/**`、`contracts/**`、`docs/17`、`docs/21` 的写权限；
其他任何子代理不得改，需要改就提需求给总控。

**理由**：接线点、不可逆变更、冻结合同、裁决台账并行写 = 互相覆盖。历史上 `index.ts` 被多 lane 抢改，
导致十条工具只注册了八条、剩下两条"包内存在但入口不可达"（R2 判 BLOCKED）。

**证据**：本轮 `884bc81` 之前 `index.ts` 只注册 8 个工具；`docs/21` §1。

### D-87 · 模块委派必须是两层：Owner 自己再派并发子代理

**裁定**：总控 → 模块 Owner → **Owner 必须再派下一层子代理，且并发**。单层串行不合法。
派发必须写清五件事：写范围、不可碰清单、可执行验收标准、证据要求、停止条件。
Owner 回传必须九项齐全（见 `docs/21` §3.5），缺一项算没回传。

**理由**：效率 + 上下文。S10 lane 三个子代理中途全部 failed，Owner 叫回来续跑才活下来；
如果 Owner 自己串行写三个 80–118KB 的工具，上下文根本撑不住。

**证据**：`docs/21` §3；S10 回传 §1 的三个子代理表。

### D-88 · 验收必须浏览器驱动，CLI 不算验收

**裁定**：任何"端到端通过"的声明，必须在**运行中的 Web 原型里用浏览器真的操作一遍**：
打字 → 发送 → 看工具调用 → 对 DB 读回 → **F5 刷新再看一次**。`node --test` 全绿只算"函数对"，不算验收。

**理由**：用户原话"一条命令能跑完，脑子进水了"。CLI 证明不了 R2（运行入口可达）、证明不了刷新持久化、
证明不了人机闸门在真人通道上长什么样。

**落地**：`evidence/experiments/2026-11-13-web-browser-acceptance/` 是第一个按此标准做的实验记录。
**Agent 不许替人点 approval**（D-79 的边界：闸门价值在于有真人看过）。

**证据**：`docs/21` §4；`s3-02-result.png` + DB 读回一致；`s3-03-after-reload.png` 三项 PERSISTED 全 true。

### D-89 · 动态结构必须在 UI 表单化，不许让模型自由生成

**裁定**：JSON Schema 表达不了的结构（动态维度键、按 `kind` 分片的 `basis_refs`、任意键对象），
**不许**让模型自由拼；必须在 Web UI 渲染成表单，模型只填值。

**理由**：同一根因两次翻车——`scorecard.items` 维度键（弱模型连续 34 次只交保留键）；
`decision.basis_refs`（弱模型把 `AUTHORITY`/`SCORECARD` 的键抄进 `RUBRIC_VERSION`，11 条 violation，
走不到 approval）。prompt 写清楚不算修好，这是可用性问题。

**证据**：`evidence/experiments/2026-11-13-web-browser-acceptance/README.md` §2.4。

### D-90 · 实验记录必须完整可审计；本地与远端必须一致

**裁定**：每次实验落 `evidence/experiments/<日期>-<主题>/`，含目的、被测 commit、命令原文、
**完整 transcript（不许节选）**、DB 读回、失败与翻车、暴露的问题。每个可验收提交立刻 push 到同名远端分支。

**理由**：用户原话"把这一次实验完完整整记录下来，以后方便审计"、"尽量保持本地和远端一致，方便我的 GPT 审查"。
失败记录比成功记录更有价值——它防的是"下次又踩同一个坑"。

**证据**：`docs/21` §6、§7；`evidence/experiments/README.md` 的约定。

### D-91 · 产品实例必须有**自己的 DSH home**，不许复用用户桌面端的 home

**裁定**：本项目的一切"起服务 / 跑原型 / 做浏览器验收"都必须在**独立 `DSH_HOME`** 下进行
（当前 `D:\12412\dsh-home-recruitment`），只在该进程里用进程级环境变量覆盖，**不改用户级 `DSH_HOME`**。

**理由**：`DSH_HOME` 是**用户级环境变量**（`D:\12412\dsh-home`），桌面端和 `dsh` CLI 都读它。
复用它 = 产品的会话、工作区列表、凭据、设置、附件与用户桌面端**全部共用**——
用户打开链接看到的是自己的桌面 DSH，而不是"我们改造的产品"，且测试会话会污染用户的会话库。
（代码层本来就是独立的：`dsh` CLI 在 `D:\12412\npm-global\`，桌面端是 Electron/asar；**共用的只是数据 home**。）

**落地**：
- `D:\12412\dsh-home-recruitment\`：`profiles\recruitment\`（4 个配置文件 + `link:` 到本仓库）、
  `.credentials.yaml`（从桌面 home 复制，密钥不进仓库）、`storages\workspace.json`（只登记 `recruitment-agent`）、
  自有 `sessions\`。
- 隔离验证：新实例首屏 `暂无会话`、工作区只有 `recruitment-agent`、工具可调（`后端工程师/DRAFT` 与 DB 一致）；
  **桌面 home 会话文件数 1291 → 1291 不变**，`workspace.json` 未被写入。

**证据**：`evidence/experiments/2026-11-13-web-browser-acceptance/README.md` §5、`isolated-*.png`。

**教训**：第一次起服务前就该问"这个实例的数据放哪"，而不是顺手复用默认值。

### D-92 · 产品底座 = **项目自带**的 DSH 副本（0.2.2-rc.1），不用全局 CLI、不碰桌面端

**裁定**：产品跑 `D:\12412\recruitment-runtime\` 下 `npm i @deepseek-ai/dsh@0.2.2-rc.1` 装出来的副本，
用它的 `node_modules\.bin\dsh.cmd` 启动。**禁止**用 PATH 上的全局 `dsh`（`D:\12412\npm-global`，0.1.5-rc.3，
2026-09-24 装），**禁止** `npm install -g`，**禁止**把 `DSH_HOME` 指向桌面端的 `D:\12412\dsh-home`。
产品 profile 的定义（`package.json` + `cordis.patch.yml`）**入库**到 `dsh/profile/recruitment/`，
`$DSH_HOME/profiles/recruitment/` 只是它的运行时副本。

**理由**：用户原话"你当时不应该去仓库下一个吗，然后对下载的dsh进行改造"。
用全局 CLI = 产品建在一个**旧版、且不属于项目**的运行时上：版本不可控、来源不可审计、
升级会跟用户其它用途抢同一个安装。桌面端 0.2.2-rc.1 与本产品对齐后，插件 API 才有可比性。

**代价（已实测）**：0.1.5 时代的 provider 段搬到 0.2.2 不通；必须按 0.2.2 的写法重配（见 D-93）。
这就是"零件不通用"的真实成本，不是环境问题。

**证据**：`evidence/experiments/2026-11-14-dsh-022-base/`；`dsh/profile/recruitment/README.md`。

### D-93 · 模型通道现状：只剩免费通道可用，付费通道全部额度用尽

**裁定（2026-11-14 实测，直接打 provider 端点）**：

| provider / model | 结果 |
|---|---|
| `longcat-2.5-free` | ✅ HTTP 200（**唯一支持图片输入的免费模型**） |
| `iceman-contributor-free` | ✅ HTTP 200（不支持 vision） |
| `beam-free` | ⛔ `rate_limit_error` |
| `glm-5.3` / `glm-5.3-flash` | ⛔ `GoUsageLimitError`（月度额度用尽） |
| DeepSeek 官方账号路由 | ⛔ `QUOTA` |
| DeepSeek API key | ⛔ `Insufficient Balance` |

**落地**：产品默认模型 = `opencode-go-openai-key2` / `longcat-2.5-free`。
换模型只改 `cordis.patch.yml` 的 `agent-default-model.model`，且**只对新会话生效**
（旧会话钉住模型选择，症状是 `no adapter registered for provider …`）。

**为什么这条要写进台账**：本项目多次把"额度问题"误判成"代码问题"。
以后任何"模型调不通"，先按本表核对，再怀疑代码。

**证据**：`evidence/experiments/2026-11-14-dsh-022-base/README.md` §3.3。

### D-94 · 产品底座跟到 `0.2.2-rc.3`（与桌面端同版）；升级只升项目副本

**裁定（2026-11-14）**：产品底座 = `@deepseek-ai/dsh@0.2.2-rc.3`（项目目录 `D:\12412\recruitment-runtime` 里的副本）。
`npm dist-tags.latest` 还停在 `0.2.2-rc.1`、新版只在 `next` 上，而**桌面端已自动更新到 rc.3** ——
"与桌面同版"就必须跟到 rc.3。全局 CLI 与桌面端一律不动。

**升级指南结论**：rc.3 的 npm 包自带 `docs/upgrade-guide/`。索引只有 `## v0.2.2-rc.1` 段（rc.1→rc.2 的 19 条破坏性变更），
**没有 `v0.2.2-rc.2` 段 ⇒ rc.2→rc.3 无破坏性变更**。19 条逐条对我们使用面（`ctx.tools.register` + 原始 ToolDefinition、
`ctx.approval`、`cordis.patch.yml`、无 client 半部分）**全部不命中**。Node 最低版本升到 `>=24.9`，本机 `v24.16.0` 满足。

**验证**：rc.3 + 隔离 home + 产品 profile，真浏览器里 `recruitment_job_get` → `后端工程师 / DRAFT`、
`recruitment_candidate_get` → `演示候选人-张样例`，两条 `VERIFY_EXIT=0`，**插件一行代码没改**。

**升级流程**（以后照做，不靠记忆）：看 `npm dist-tags` → 看桌面端 `FileVersion` → 读 `docs/upgrade-guide/README.md`
命中我们使用面的 guide → 只 `npm install` 到项目目录 → 浏览器验证两条 → 记录台账。
升级不过就回滚版本号；`DSH_HOME` 永远用产品自己的。

**证据**：`evidence/experiments/2026-11-14-dsh-022-rc3-upgrade/`。

### D-95 · 人只做**一次**决策：对话里定过就不再点第二次（修正 D-79 的落库闸门）

**裁定（2026-11-14，产品负责人）**：**人只做一次决策**。两种情形都只做一次：
① Agent 主动把问题抛出来问 → 人回答完，**直接执行**，不再弹确认；
② 人自己提出来要办 → 人已决策，**直接执行**，不再弹确认。

`ctx.approval` 不再作为 `recruitment_decision_record` 的**二次确认**闸门。
人机闸门的形态改成**"问一次"**：决策的授权来自人的那一次回答，而不是回答完再点一下按钮。

**落地口径**：
- `human_confirmation.confirmation_method` 增加 **`IN_CHAT`**：表示"人在对话里明确指示过"；
- `IN_CHAT` 必须带 **`confirmation_text`（人的原话，逐字）**，它与 `confirmed_by_actor_id` / `confirmed_at`
  一起进 `confirmation_text_sha256` 的 pre-image；
- 落库时把原话与哈希一起写进 `decision`，**事后可对回会话日志**；
- `decided_by_actor_id` 仍只来自配置的 actor（模型传不进来）；
- `IN_APP_CONFIRM` / `SIGNED_RECORD` 两种旧方式保留（用于确实需要留痕签名的场景），但**不再是默认路径**。

**残余风险（必须写在明处）**：工具本身无法证明"人真的说过这句话"——
Agent 理论上可以编造 `confirmation_text`。缓解是**可审计**而不是**可阻止**：
原话 + 哈希 + 会话日志三者对不上就能查出来。这比"点一下按钮但 Agent 仍可能听错"更强，
但不是密码学意义的证明。若将来要"可阻止"，只能回到 approval 通道（即用户否决的方案）。

**理由（产品负责人原话）**："要么主动提问…问完直接执行，要么人提出来，人决策，相同点就是人只做一次决策。"
重复确认把"人已经说清楚的事"再问一遍，是**摩擦**而不是安全。

**影响面**：`src/tools/decision-record.ts`（STEP 6.5 闸门 + `human_confirmation` schema/pre-image）、
`src/index.ts`（`decision_record` 不再强依赖 `ctx.approval`）、S10 的 headless 验收（`decision` 可落库，
不再 BLOCKED）。**D-79 的其余部分不变**：Agent 不能自己"决定"，只能记录人已经做出的决定。

### D-96 · **否定性结论**必须附覆盖率证明；"空"必须分类，不许当成"没有"

**触发（2026-11-14）**：我把飞书 12 个会议里的 4 个（全是"视频会议录制"，无妙记转写，文件只有 40–87B 表头）
当成全部，得出"缺有语音的会议"的结论；用户一句"我的会议绝对有"推翻——全部 12 个拉下来后找到
3 条真转写（`audio` 6397B / `api_sample` 4485B / `sample_audio` 4485B）。

**根因（四层，一层比一层深）**：

| 层 | 内容 |
|---|---|
| 直接 | 4/12 抽样 → 当全量下结论 |
| 一层 | 没查"为什么是空"：视频会议录制 ≠ 妙记，后者才有 AI 转写 |
| 二层 | 把"**我读出来是空**"当成"**数据是空的**"——违反项目自己的规则："绝不把「没读」表达成「没有」"（`readers/errors.ts` 开篇就写着） |
| 三层（共性） | **否定性结论没有任何证据门槛**：正向结论有 R3（命令原文 + DB 读回），而"没有 X"只要一句话就发布了 |

**裁定（三条，落到机制不是自觉）**：

1. **否定性/排他性结论必须附覆盖率**：写"没有 X"时必须同时给出"查了 N 个候选 / 覆盖哪几类 / 怎么确认查全了"。
   给不出覆盖率，就不许说"没有"，只能说"我查了这些，其中没有"。
2. **"空"必须四分类**，且落到代码而不是注释：
   `NOT_GENERATED`（上游没生成）/ `EMPTY_BY_NATURE`（本来就没有）/ `READER_MISSED`（我读的方式不对）/
   `NO_PERMISSION`（没权限）。四类的下一步完全不同（等生成 / 结束 / 修读取 / 要授权）。
   现有 `TranscriptState` 只有 `MISSING/PENDING/READY/PARTIAL/AUTH_REQUIRED/…`，
   **没有区分"未生成"与"读不到"** —— 这是要补的缺口。
3. **禁止拿"文件大小 / 字段缺失"当判据**：必须读契约字段（`transcript_status`、`is_complete`）；
   连接器的返回里必须显式带"这份材料有没有转写、为什么没有"，不许让调用方靠猜。

**验收增量**：连接器测试必须同时有"转写存在但为空"与"转写未生成"两个 fixture，且两者输出**必须不同**。

**生产后果（为什么这条是 P0）**：这类错误在线上不是"显示错"，而是**业务判断被静默污染**——
connector 报"无转写" → HR 看到"无转写" → 面试官无法基于证据评分 → 决策在缺证据的情况下推进或淘汰。
本项目 16/16 PASS 而 DR/CT/FL/MET 全 0 的历史，就是同一类"没读被当成没有"的后果。

**元问题（对我自己的）**：这一轮我反复出现"抽样 → 下结论"（此前还有 3 次未查库就发布结论）。
不是知识问题，是**工作方式缺陷**：倾向尽快给出结论。机制上唯一的解药就是第 1 条——
**否定性结论先证明覆盖率，否则不许说**。

### D-97 · 真实简历分**两批**：第一批"版式不阻断"，第二批修完版面/图片再严格跑

**裁定（2026-11-14，产品负责人）**：

- **第一批**：直接出结果并继续后面链路。理由：**模型有结构化能力，版面和阅读顺序不重要**——
  左右分栏、图片有没有核过，不影响"把文字抽成字段"。
- **第二批**：把版面分析（阅读顺序）和内容型图片处理都修好之后，再严格跑一遍。

**落地**：`document_read` 的 `assessment` 输出两个阻断位，语义分开、不许混用：

| 字段 | 用途 | 判据 |
|---|---|---|
| `blocking` | **可信筛选**（S7/决策） | 所有 HARD，含版式/顺序/图片（保持原样，不削弱） |
| `blocking_for_structure` | **结构化**（S6 抽取字段） | 只由"文字本身不可用"阻断：空文件、乱码、编码读不出、DOCX 文本框读不出、图片需视觉 |

版式类 HARD（`doc_cross_block_attribution` / `pdf_reading_order_unverified` / `unverified_pdf_image`
/ `resume_attribution_unverified` / `resume_timeline_unparsed`）**只进 `blocking`，不进 `blocking_for_structure`**。

**实测（45 份真实简历，B1–B7）**：

```
严格 blocking           41/45   ← 版式/图片问题，S7 前必须处理
可进结构化（第一批）      39/45   ← 只有 6 份真阻断（文字不可用）
```

→ 第一批可以跑满 39 份，远超"≥20 份"门槛。

**第二批要修的（简历层本职，不是数据问题）**：
1. **版面分析**：`converter/src/cli.py` 里 `layout_backend: None` / `order_verified: False` 是**写死的**——
   从没做几何分栏。要做：按 bbox 聚类成列 → 列内按 y、列间按 x 排 → 自信时写 `order_verified=true`。
2. **图片分类**：现在任何未核图片一刀切 HARD。要区分**装饰性**（照片/logo/二维码/水印 → 记
   `ignored.reason`）与**内容性**（扫描件正文 → 走 D-81 视觉补读：`page_image` + agent `read_image`
   + `model_text_merge`）。只有真读不出才 HARD。

**顺带修的**：`排版经历.pdf` 只有 **2 字节**（空占位文件），旧报错说"content does not match magic bytes"
让人以为是格式问题。现在 <8 字节一律按 `EMPTY_FILE` 报，并写明真实字节数：
`file is 2 bytes (only whitespace/line breaks); too small to be any supported document…`

### D-98 · 原生文本层坏掉 → **整页 OCR 兜底**（不再直接判"读不出"）

**触发**：3 份真实简历（Prabhu / 任悦平 / 诸葛童琳）被 `pdf_text_encoding_unread` 判成"读不出"，
用户逐个打开确认**都是正常简历**——PDF 用自定义字体编码，原生文本层抽出来是乱码。

**裁定**：原生文本层含未解码字形时，**该页整页转图 OCR 重读**，用 OCR 结果替换本页原生块：
- OCR 块 `provenance='ocr'`，**绝不冒充 `native_text`**；
- 页面级 issue 从 HARD `pdf_text_encoding_unread` 降为 SOFT **`pdf_text_recovered_by_ocr`**（恢复标记，不是失败）；
- 身份字段（姓名/电话/公司/时间）仍按"待核证据"处理（`doc_provenance_unverified` / `doc_identity_from_unverified_source` 保留），
  因为 OCR 是机器认字，不是原文。

**为什么用 OCR 而不是视觉模型**：印刷体中文 OCR 准确率更高（~97–99%）、**确定性**（同图同结果）、
**带 bbox**（能指回原文位置）；视觉模型会"顺"文本且无可靠字符级坐标。视觉只留给 OCR 也读不出的
手写/印章/艺术字。

**实测（3 份）**：

| 文件 | 修复前 | 修复后 |
|---|---|---|
| Prabhu Kiran Konda Resume.pdf | 乱码、判"读不出" | **4365 字 / 65 块**，`pdf_text_recovered_by_ocr` SOFT |
| 任悦平-27届产品-研究生.pdf | 乱码、判"读不出" | **2197 字 / 55 块** |
| 诸葛童琳2027届_AIGC运营简历.pdf | 乱码、判"读不出" | **3642 字 / 77 块** |

三份 `blocking_for_structure=false` → 都能进第一批结构化。

**踩到的坑（记下来）**：converter 说 soft、TS 层说 hard —— 因为 `issues.py::ADDED_CODES` 与
`map-converter.ts::CONVERTER_SOFT_ISSUE_CODES` 是**两份镜像清单**，只改一边就会不一致。
已在两边都登记，并在 TS 侧注释里写明"两边必须同步"。

### D-99 · 恢复计划要有**执行器**；真实语料回归进验收门槛

**裁定（2026-11-14，事故审计 ③⑤⑦ 的机制修复）**：

1. **恢复执行器**（`src/document/recovery/execute.ts`）：`plan()` 只出计划不够，系统必须能自己修。
   保守规则：只自动执行 `retry` / `switch_reader` / `vision_read`；**`human_review` 永不自动执行**
   （D-79/D-95：闸门价值在于真人看过）。成功判据三条**同时**成立：
   (a) blocking 变 false 或 HARD 数严格减少；(b) 不出现旧内容没有的新 HARD code（禁止"换病"）；
   (c) **`step.codes`** 里的 code 全部消失（不硬编码任何 code 名，信任 plan 算出的目标）。
   初始就不 blocking → 一步不执行（`skipped_reason='NOT_BLOCKING'`）；PDF 重读无页数证据 →
   `blocked: READER_FACTS_REQUIRED`（不浪费一次真实读取）。

2. **真实语料回归进验收**（`docs/11 §11` + `test/regression/real-corpus.test.ts`）：
   合成 fixture 全绿 ≠ 真实语料可读。三条硬门槛：读取成功率 **≥95%**、
   `blocking_for_structure` 通过率 **≥90%**、失败可归因 **100%**（每条失败必须落在 14 个
   `DocumentReadErrorCode` 之一且 message 回答"为什么"）。语料缺失必须 skip 并写明原因，**skip ≠ 通过**。

3. **错误信息可诊断**：14 个 code 的 message 一律补"为什么"（真实字节数 / 前 8 字节 hex /
   超时值 / 前后 SHA 前缀 / 底层 cause），且**不得含候选人正文**（R7 有断言）。

**实测（2026-11-14，全量 52 份真实语料）**：read_ok 50 / failed 2（`EMPTY_FILE` + `TIMEOUT`），
R-1 96.2%、R-2 100%（`blocking_for_structure` 阻断 0 份）、R-3 100%。
**发现并修**：converter 超时 60s 不够（OCR 后单份可达 53s+）→ 提到 180s。

**更正（2026-11-14 复核，D-104）**：上述 50/2、R-1 96.2% 是 **60s 口径/高负载**下的数，
其中 `TIMEOUT` 是**假失败**（reader 没坏，是超时预算不足）。180s 口径复跑全量 52 份为
**read_ok 51 / failed 1（仅 `EMPTY_FILE`）**，**R-1 98.1%**、R-2 100%、R-3 100%，
最慢单份 46.6s（高并发时曾 127s，仍余 53s）。门槛判定从此**强制全量语料**（见 D-104），
默认抽样只作开发回路且必须打印 `SAMPLED — 不构成门槛判定`。

**证据**：`test/document/recovery-execute.test.ts`（20 条）、`test/regression/**`（9 条）、`docs/11 §11`。

### D-100 · 跨块归因要**产出结果**，不能只拦住；版式类阻断与"文字不可用"分开

**裁定（2026-11-14，事故审计 ③⑥）**：

1. **归因引擎**（`quality/checks.ts::attributeExperienceRows`）：对每条"含时间区间的行"产出归属结果
   `{row_block_id, org_block_id, confidence: 'same_row'|'adjacent'|'unresolved', basis, evidence, may_join_same_row, needs_human_check}`。
   `doc_cross_block_attribution` 只在 **`unresolved` 且同页确实存在组织候选**时发 HARD；
   `same_row` / `adjacent` 发 SOFT `doc_attribution_resolved` 并带归属明细。
   **只有 `same_row` 允许下游把公司/时间视为同一行**；`adjacent` 只是"位置相邻"，仍标待核。

2. **版式类 vs 文字不可用分开**：`Assessment.layout_only_blocking` —— 只有版式类 HARD（顺序 / 跨块 / 未核图片）时为 true。
   `blocking` 语义**不削弱**（仍是"有 HARD 就 true"），只增加区分位；`document_read` 已把它输出给模型。

**实测（孙光宇那份真实简历）**：`doc_cross_block_attribution` 4 条 HARD → **0 条**，全部变成
`doc_attribution_resolved` 的 SOFT（3 条 self_subject、1 条 same_row_anchor），`layout_only_blocking=true`。
**顺带发现旧实现是错的**：它给 4 条日期行找的"最近候选组织"全是 **b4（一项竞赛名称）** —— 连线索都错，
只是"拦住了"，没"归因对"。这正是审计 ③ 说的"发现能力 ≫ 解决能力"的具体样本。

**证据**：`test/document/quality.test.ts`（37→50 条）、`src/tools/document-read.ts` 的 `layout_only_blocking` 输出。

**补充（2026-11-14，D-100 续）：DOCX 表格行是精确的行身份，必须判 `same_row`**

真实语料回归暴露的缺口：`doc_cross_block_attribution` 仍有 9 份 / 25 行 HARD，其中 **10 行是 DOCX
表格行**（`一行三格：公司 | 职位 | 时间`）。DOCX 没有 bbox，旧的 `sameVisualRow` 恒为 false，
于是这种**最常见的记录表**100% 掉进 `unresolved`——判据在"几何"上正确，在"事实"上错误：
表格行本身就是精确的行身份，不需要几何证据。

- 新增归属基 `AttributionBasis = 'same_table_row'`（`quality/types.ts`）：同一 `part + table_id + row`
  即同一行；**行内无组织格时归到唯一标题格**。
- 三道歧义保护（缺一即保持 `unresolved`）：表必须 ≥2 行（单行排版表不算表格行身份）、
  同行组织格恰好一个、同行标题格恰好一个。
- 实测（51 份可读语料）：**32 份 / 156 行 → 8 份 / 15 行**（文档 −75%，行 −90.4%）。
- 剩余 15 行是设计上保留的 HARD，不是判据漏：2 行 DOCX 段落（无几何信息，按段落顺序猜相邻会违反
  "不许跨块拼装"）+ 10 行 PDF 只有日期的行（同页组织文本不同排/不相邻）+ 3 行长叙述行。

**风险**：`same_table_row` 依赖转换器给出的 `table_id + row` 坐标；缺坐标即退回 `unresolved`（fail-closed）。
证据：`test/document/quality.test.ts` 归因 9 / 9b / 9c（1 正 + 3 反 + 标题格）。

### D-101 · 人机闸门的事务边界：先兜住（超时 + 服务端上限），两阶段记债

**背景（2026-11-14，验收窗口 P0-2 修复中暴露）**：`scorecard_submit` / `interview_schedule` 的 approval 必须在
**事务内业务校验之后**问人（否则 `ALREADY_SUBMITTED` / `ACTOR_NOT_INTERVIEWER` 这类注定失败的调用会先弹窗，
Agent 可借此刷人的确认；且幂等重放会误弹）。代价是"弹窗到点击"期间连接处于 `idle in transaction`，
原来**没有任何上界**（approval 无超时、PG `idle_in_transaction_session_timeout=0`）。

**裁定**：
1. **approval 等待加 120s 超时**：超时视为 `cancelled` → 回滚 → `FORBIDDEN(APPROVAL_NOT_GRANTED, approval='timeout')`，
   一行不写；超时后原 approval 才 resolve 的，**仍然不采纳**（防竞态写库）。
2. **连接池加服务端硬上限**（`db/pool.ts`）：`idle_in_transaction_session_timeout = 300s`（兜底，不是闸门）；
   同时把**之前定义了却没接线**的 `statement_timeout_ms` 真正下发到会话。
3. **两阶段重构（只读校验 → 关连接 → 问人 → 写事务重校验）是正解，但记债不做**。
   触发条件写死：出现"并发写导致人批准后被 `VERSION_CONFLICT` 拒"的实测案例，或 Web UI 开始高频驱动这两个工具时，必须改。

**证据**：`src/db/pool.ts`、两个工具的闸门注释、102 条闸门测试。

### D-102 · S6–S10 独立验收结论：**半通**，四个关键不变量是假的（2026-11-14）

**独立验收窗口**（`reviewer-s6-s10`，只读、不复用任何人的自述）对简历层**之后**的 12 个工具逐个复核，结论：

> **工具都能从 `apply()` 调到、真连库、测试全绿，但四个关键不变量是假的。**

| # | 问题 | 严重度 | 证据 |
|---|---|---|---|
| 1 | **S6 身份来源闸门失效**：`structured_json` 的 `agent_read` 电话/邮箱被直接 push 进 `strong`；converter 对 OCR 块抽字段仍标 `native_text` | P0 | `application-intake.ts:760/765/775`；合成块实测 `phone.provenance=native_text` |
| 2 | **S8/S10 人机闸门未实现**：`index.ts` 只给 `decision_record` 传 approval；`scorecard_submit` / `interview_schedule` 无闸门 → Agent 可代 HR 交面评 | P0 | 回滚事务实测：scorecard 无 approval 写入 SUBMITTED；DB 中该 actor 正是必交面试官 |
| 3 | **S7 的 `decision(SCREENING)` 无写入路径**：`decision-record.ts` 拒收 SCREENING，DB `decision` 按 scope 只有 `STAGE=1` | P0 | `docs/18:60` 与实现矛盾 |
| 4 | **没有一条申请真正从 S6 走到 S10**：7 条 S6 申请全停 S6；走到 S10 的那条 `resume_version_id IS NULL` | P0 | DB 实况 |

**P1**：0008 的 DEFERRABLE EXCLUDE 在 COMMIT 抛 **23P01**，工具只映射 23505；D-95 的 `confirmation_text` 未进哈希 pre-image 且契约无 `IN_CHAT`；S8 只实现 CREATE（D-62 要求四 intent）；D-98 的 `pdf_text_recovered_by_ocr` 在 `src/db/material.ts` 仍被当 HARD。

**计数**：范围内 12 个工具 **PASS 6 / BLOCKED 6**；Feishu connector 未接线 = BLOCKED 1。

**因此纠正一条先前的表述**：2026-11-14 早先说的"Golden Path 跑通一次"**不成立** ——
那只是 S10 单点写了一条决策，不是端到端。本条以此为准。

**修复安排**：P0-1 / P0-2 / P0-3 各一条修复 lane；P1 四条并入 P0-3 那条 lane。
报告全文：`docs/23-acceptance-review-s6-s10.md`（706 行，含附录 A 命令原文与真实输出）。

### D-103 · S7 的决策落库口径 + 23P01 映射 + D-95 哈希版本化（2026-11-14）

**P0-3 · S7 人决定落库**：`decision_record` 接受 `decision_scope='SCREENING'`（S7 写侧）：
- `stage_code` 由工具写死 `S7`（查 current / 写行 / 写事件 / 出参**共用同一个函数**，避免"查的是一把尺、写的是另一把"）；
- `result ∈ {ADVANCE,HOLD,REJECT,WITHDRAW}`（**S7 不是终局**，`HIRED` 仍拒）；
- 不接受 `interview_id` / `summary_digest`；`missing_disposition` 等 S10 专属字段 → `MUTUALLY_EXCLUSIVE`；
- `basis_refs` 封闭集收窄为 `SCREENING_EVALUATION / RESUME_VERSION / RUBRIC_VERSION / AUTHORITY / SUPERSEDES`；
  `ADVANCE/REJECT` **必须**带 `SCREENING_EVALUATION`，`HOLD/WITHDRAW` 可 0 条（安全方向，与 §4.2.1 同构）；
- 只做**绑定核对**（rubric 版本/hash 对库值、材料存在且是申请钉住那份），**不重算 screening**（S7 是瞬态投影，重算=第二份实现）；
- D-95 闸门不变；唯一性 `(tenant, application, 'SCREENING', 'S7')`。

**P1-1 · 23P01**：0008 的 DEFERRABLE EXCLUDE 在 **COMMIT** 抛 `23P01`，工具原来只映射 23505 → 契约失效。
现在 `23P01` 映射 `ALREADY_DECIDED`，并在 `execute()` 的 catch 再翻一次（COMMIT 在 `withActor` 里，STEP 7 的 try/catch 之外）。

**P1-2 · D-95 哈希版本化**：`confirmation_text` 进 pre-image，但**版本化**：
v1 = 旧四键（无原话时逐字节不变，库里旧 hash 不假红）；v2 = 带原话时算
`{preimage_version:2, 四键, confirmation_text, confirmed_by_actor_id, confirmed_at}`。
服务端规则：**有原话只接受 v2，无原话只接受 v1**；不等 → `CONFIRMATION_TEXT_MISMATCH`。
事件 payload 记 `human_confirmation_preimage_version`（`decision` 表无此列）。

**P1-3 · D-98 的恢复标记在 db 层当 SOFT**：`src/db/material.ts` 新增 `RECOVERY_SOFT_CODES`，
在"未知 code 一律 HARD"**之前**判 SOFT。**这是第三份镜像清单**（`converter/issues.py`、`map-converter.ts`、本表），
三处必须同步——已在注释里写死。

**同步（写范围外）**：`docs/18:60`（S7 没有 `screening_result` 表，Screening Result = `decision(scope='SCREENING')`）、
`contracts/evaluation/tool-contracts.md`（`decision_scope` 不再拒收 SCREENING；`summarize` 仍只服务 S10）。

**已知残余（另开跟进）**：DC-27 的 `basis_refs[SCREENING_DECISION].basis_refs` 嵌套键仍被 parser 按
`UNKNOWN_PARAM` 拒掉（`hasScreeningRejectionBasis` 是死代码）；`screening_evaluate` → `basis_refs` 的组装
仍是 agent 侧手工按 §3.7 拼，工具不出 `basis_refs`。

### D-104 · 门槛判定必须跑全量语料；抽样只作开发回路

**裁定（2026-11-14，总控）**：

1. **门槛判定强制全量**：R-1/R-2/R-3 的达标结论只允许在 `RECRUITMENT_CORPUS_GATE=1` +
   `RECRUITMENT_CORPUS_SAMPLE=all`（52/52）下得出。声明 GATE 却没跑全量 → 测试直接 fail，
   **不允许被默认抽样绕过**。
   理由（算术）：1/52 的坏文件默认抽 20 份命中概率约 38%，即默认跑法下有 62% 的概率
   R-3 是空断言——门槛等于不存在。
2. **抽样保留但降级**：默认 20 份仍可跑，必须打印 `mode = SAMPLED — 不构成门槛判定`
   且 `thresholds = NOT EVALUATED`，断言只作"样本内 smoke"，不得出现任何达标结论。
3. **超时口径跟产品走**：回归用 180s（`RECRUITMENT_CORPUS_TIMEOUT_MS` 可覆盖），
   不再硬编码 60s。60s 下的 `TIMEOUT` 是假失败（D-99 更正：51/1、R-1 98.1%）。
4. **失败必须分类**：`file_unreadable` / `reader_defect` / `reader_failed_or_slow` /
   `not_attempted` 四类分别打印，reader 自身缺陷不得被算成"语料坏了"。

**门槛跑实测**：52/52，read_ok 51 / read_failed 1（`EMPTY_FILE`，2 字节占位文件），
R-1 98.1% PASS、R-2 100% PASS、R-3 100% PASS。

**更正（同日，总控）**：那份 2 字节的 `排版经历.pdf` 是**空占位文件**，不是读不出来的简历——
已按"改语料不改判定"移入 `converter/corpus-quarantine/`（记账含原路径/sha256/判定依据），
语料 52 → 51。隔离后门槛跑：**51/51，read_ok 51 / read_failed 0，R-1 100%、R-2 100%**，
R-3 因无失败样本而 **vacuous**（不冒充通过）。`EMPTY_FILE` 错误码本身不改。

**证据**：`dsh/dsh-recruitment/test/regression/real-corpus.test.ts`、`docs/11 §11.2–§11.4`。

### D-105 · 复用 dsh-superagent 原型的四个部件（研究结论，未采纳其代码）

**裁定（2026-11-14，总控）**：`deepseek-ai/dsh-superagent-prototype`（MIT，研究原型，单 commit）
是同一运行时上的完整参考实现。**只复用形状，不 vendor 代码**，按价值排序：

1. **人类闸门 = 领域对象 `Attention` + 面板一行**（`core/model.ts:275`），不是 `ctx.approval`。
   该原型解决的就是我们 D-79 的四个病（headless 无应答者、120s 超时、只认一次点击、跨会话恢复不了）：
   问题是一条可持久化的记录，答完即消失，无超时。**待产品负责人确认后另立决策取代 D-79 的机制。**
2. **工作台面板骨架**：`dsh.client` + `ctx.slots.inject` 三行注册 + 宿主 `registerHttp`。
   已在隔离实例验证：宿主插件 + 客户端插件 + bundle 三层在 DSH 0.2.2-rc.3 + Windows 上可同时工作，零改 DSH 源码。
3. **飞书 Source 四段循环**（`feishu-read/loops/trigger/channel`）：读群历史 → 轮询订阅线程 →
   事件消费 → 回写。我们仍是零 I/O 骨架，卡在真实凭据。
4. **执行器规则**（抄规则不抄代码）：一个工单 = 一个持久 session + 一个目录；后台作业 30 分钟上限；
   人工唤醒可插队槽位；重启带 recovery note。
5. **不抄**：`core/` 的 Eval/Policy/Mandate（我们五事实更贴招聘）、`store.ts` 的单机 SQLite（与 D-5 冲突）。

**可移植性警告（实测）**：该原型是 POSIX-only 写的，`deployment.ts:13` 的绝对路径校验为 `/^\//`，
Windows 上插件直接不激活。我们自己的 DSH 插件凡校验路径处**必须验 Windows 绝对路径**。

**证据**：`work/research/2026-11-14-dsh-superagent-assessment.md`（含 B 档受控试装记录与截图）。

### D-106 · 外部事实的机检层：读位点、事件处置、出站重试、三振

**裁定（2026-11-14，总控；来源 dsh-superagent 原型 `docs/001`/`docs/003`/`docs/006`，
只借规则不借实现）**：R4 的三维标签回答"真不真 / 怎么触发 / 能不能自己读"，
但**回答不了"这次到底读没读、这条事件去了哪"**。缺的是机检层，不是更多标签。
规则落在 `docs/04 §23`（§21.6 定义三振口径，本节不重复定义）。

1. **读位点**（`read_position`）：每个外部来源记录自己的读取位置，**原子推进**；
   有事件未处置时位点不得越过它；重启不得重放已处理事件。与"用 `provider_event_id`
   去重"的关系：去重管重复投递，位点管重放，**两条防线都要**（§15 B 继续有效但不再是唯一防线）。
2. **事件处置**（`event_disposition`）：每条外部事件必须留下 `FILTERED` / `EVALUATED` /
   `FANNED_OUT` 之一，过滤原因取自 6 个封闭值。**禁止用日志代替记录**，禁止静默丢弃。
3. **出站先存后做**：对外消息先落库再发；失败退避 **5s 起翻倍至 300s**；
   同一工作单元同一会话保序，直到三振放行；`dropped` 只有 `CHANNEL_IGNORED` / `CHANNEL_GONE`
   两种，且必须记原因与时间。
4. **三振才报错**：`(kind, item)` 连续 3 次失败才升级为系统问题；
   `AUTH_REQUIRED` / `WAIT_EXTERNAL` / `Later` 不计入连击；一次性网络错误不算。

**V-10 落点裁决（原由 lane 提出，本节一并定）**：`event_disposition` 用**独立子表**，
不在 `event_inbox` 上加列。理由：一条事件可以被重新评估（"重新评估"是既有产品动作），
加列会覆盖历史、丢掉"上次判了什么"，而处置记录本身是审计对象。原型也是独立 `disposition` 表。
**该表尚未建**——需要一条迁移，在建之前任何实现都不许假装处置已记录。

**边界（必须同时读）**：这是**合同，不是已实现能力**。`docs/18 §1` 现在没有执行器 / 队列 /
Outbox，`src/connectors/feishu` 的 `fetchTranscript()` 恒 `BLOCKED`。
实现状态与待验证项见 `docs/03 §21.8`（V-1…V-8）与 `docs/04 §23.6`（V-9…V-16）。
任何"已具备"声明必须先过 `docs/06` E1–E4。

**未定项（不编数）**：V-4 暂停是否顺延 30 分钟上限、V-8 真人排队超时阈值、
V-15 "无处置事件"告警阈值，三个数未定，实现前必须先定。
**V-5 风险**：pg-boss 能否表达"`maxWorkers` + 1 个人工超额槽且不挤掉在跑任务"未验证；
做不到要按 R1 先证候选池不足，**不得在业务层自研调度**。

### D-107 · 视觉补读的执行边界在 agent 侧：`visionRead` 永不注入，`remaining` 即交接

**裁定（2026-11-14，总控）**：`executePlan` 的 `RecoveryCapabilities.visionRead` 在本产品
**永远不注入**。这不是"缺能力待补"，是 D-81 的执行边界在恢复执行器上的体现：

- 视觉补读的既定路径是 agent 侧 `recruitment_page_image` → `read_image` → `recruitment_model_text_merge`，
  **插件内不得新建模型客户端**（D-81）。
- 因此执行器遇到 `vision_read` 步时，正确行为是**原样留在 `remaining`** 并给出 1-based 页号，
  由 agent 执行；不得伪造成功、不得把图像帧号谎报成页码、不得为了"闭环"去调模型。
- `switch_reader` 同理：U1 按内容嗅探每种媒体只注册一个 reader，**没有候选就如实 `failed`**，
  不许把"再读一遍同路径"伪装成换读取器。

**为什么单独立一条**：这个参数看起来像"没接完的接口"，实测上会被反复误读成缺口。上一轮
`wire-recovery` 就把它列为"主要缺口"并给出三个补法（其中一个正是 D-81 明令禁止的）。
留这条是为了让下一个人先读到"这是边界"，而不是先写代码。

**机检面**：`test/document/document-read-wiring.test.ts` 第 6、7 条——vision_read 不可执行时
不调能力、不伪造成功，`vision_pages=[1]` 留给 agent；图像帧补读 `vision_pages=[]`。

**残留（另开，不在本条）**：`switch_reader` 若产品要求真正换读取器，需要 U1 的读取器注册表，
不是工具层自己造。

### D-108 · 申请钉 rubric 版本的口径（F1）：默认钉岗位当前版本，显式入参优先，缺版本时**收下不钉**

**裁定（2026-11-14，总控；回答独立验收的 F1 二选一）**：

1. **写侧**：`application_intake` 建申请时，若岗位的 `job.current_rubric_version_id` 非空且该版本已批准，
   就写入 `application.rubric_version_id`；调用方显式传入 `rubric_version_id` 时以入参为准（须属同一岗位且已批准）。
2. **缺版本时：收下不钉，不拒绝。** 理由：
   - 收到简历是**已经发生的业务事实**，拒绝接入不会让事实不存在，只会让事实分裂到系统外；
   - 企业自建配置的现实是「材料常先到、rubric 后批」，把两者耦合会让接入被流程卡死；
   - 系统已有显式暴露：`application_stage_advance` 返回 `BLOCKED: RUBRIC_NOT_PINNED`，带
     `owner_role`（JOB_HIRING_MANAGER）+ `next_action_code`（PIN_RUBRIC_VERSION），HR 能看到"谁该去批"。
     **静默失败才是问题，显式阻塞不是。**
3. **读侧**：`job_get` 与 `screening_evaluate` 的 "当前版本" 判定**只认 `job.current_rubric_version_id`**，
   不许再按 `version_no` 最大值取（D-21/D-48 已定：当前 ≠ 最新，指针支持回滚）。
4. **补钉**：申请已存在但未钉、岗位之后批准了 rubric 时，`application_stage_advance` 的 T1 前置判定
   在同一事务内补钉，带审计，不绕过 `fn_row_guard`。

**反例（明确不做）**：不因为"缺 rubric"而拒绝 intake；不自动把"最新版本"当成"当前版本"；
不在决策工具里静默补钉（钉版本必须是可审计的独立动作）。

### D-109 · 运行时的认领/租约与 pg-boss 的关系（R1 gap proof）

**裁定（2026-11-14，总控；回答独立验收的治理缺口）**：`src/runtime/**` 的任务认领、租约回收与重试
**使用 PostgreSQL 原生的行锁与条件更新**（`FOR UPDATE SKIP LOCKED` + `lease_expires_at` +
`uq_task_attempt_active_lease`），**没有引入 pg-boss，也没有自研队列**。

1. **为什么这不算违反 R1**：R1 禁止的是"自研通用队列/调度器"。这里用的是 PG 的既有事务与行锁能力，
   没有新建队列、没有新进程、没有新协议；任务状态与业务事实在**同一个库、同一个事务边界**内。

   **更站得住的理由是"状态 owner 唯一"**（独立复核要求补入）：`Task` / `Attempt` / `Session`
   与租约必须在**同一事务边界**原子耦合。引入 pg-boss 会产生**第二个状态 owner**
   （pg-boss 的 job 状态 vs 我们的 task/attempt 状态），两者需要两套对账与两套恢复语义——
   这正是 D-106 里"先存后做 + 对账"要极力避免的分裂。**"派发 vs 队列"这个论证不够硬，
   不要再用它当主要理由。**
2. **与 D-5 的关系**：D-5 说 v1.0 以 PG + pg-boss 为底座。**本条不推翻 D-5**：pg-boss 仍是
   v1.0 的持久任务队列候选，用于「跨天、需要延迟/重试/优先级」的业务任务；runtime 的认领/租约是
   **任务派发语义**（谁在跑、租约何时过期），不是队列语义。两者职责不同，可以并存。
3. **何时必须换成 pg-boss 或等价实现**（触发条件写死，避免"以后再说"）：
   - 需要跨实例公平调度或多优先级队列；
   - 需要延迟投递/定时唤醒超出 PG 轮询能承受的范围；
   - 单轮 tick 的派发吞吐成为瓶颈（实测当前单轮 1 个 Task，远未到）。
4. **不做的**：不在 v1.0 引入 Redis/Kafka/独立调度平台；不为"看起来用了队列"而套一层 pg-boss。

**证据**：`db/migrations/0011_task_runtime.sql`（租约回收索引与唯一约束）、
`src/runtime/task-runtime.ts`（认领/回收）、`contracts/runtime/task-runtime.md`。

**补充（2026-11-14，按独立复核要求补齐四项，缺一不算通过）**：

1. **禁项（出现即必须换实现，不许讨论）**：不做优先级队列、不做延迟投递、不做定时/cron、
   不做多消费者组、不做跨实例调度。只要出现其中任一需求，就必须换 pg-boss 或等价成熟实现，
   **不许在 `src/runtime/**` 里加**。
2. **可测阈值（不是"跨天/瓶颈"这种软话）**：
   - 积压：`business_task` 中 `QUEUED/RETRY_WAIT` 且 `created_at` 早于 5 分钟的条数 > 100 → 触发评估
   - 实例数：同一库上运行中的 tick 进程 > 1 → 必须评估换成 pg-boss（当前是单实例假设）
   - tick 吞吐：单轮 tick 的端到端耗时 p95 > 2s，或连续 3 轮 `NO_CLAIMABLE_TASK` 但积压 > 0 → 触发评估
   以上三项任一触发，都必须重开本条决策，不得"观察一段时间再说"。
3. **预算上限**：`src/runtime/**` 的调度相关代码不超过 **1,500 行**；**不新增任何运行时依赖**
   （除 `pg` 与既有 DSH 包）。超预算即视为"自研队列"，按 R1 处理。

   > **修订 D-109.1（2026-11-14，总控；第四轮独立复核指出本条第一天就是红的）**
   >
   > **缺陷不是"实现超了 1,500"，是这一条从来没有可执行的度量口径**：没定义"调度相关代码"
   > 是哪几个文件、也没定义行怎么数，更没有机检。一个无法度量、无法失败的条款不是预算，
   > 是装饰。复核给的两条路里，**选 A（重新定义并批准预算 + 机检），不选 B（维持 1,500）**：
   > B 要么要求把已通过验证的认领/租约代码删掉重写（没有任何证据支持这么做），
   > 要么要求补 pg-boss/DBOS 的 gap proof——而 D-109 上面第 1 条已经论证过真正的理由是
   > **"状态 owner 唯一"**，pg-boss 必然引入第二个 owner，所以 gap proof 是成立的、
   > 缺的从来不是理由而是**度量**。
   >
   > **口径（机器可复算，脚本 `scripts/runtime-budget.mjs`）**：
   > - **计入**：`src/runtime/**` 下所有**有运行时行为的**模块。**故意往大算**——包括容易被
   >   说成"不算调度"的三类：`event-types.ts`（事件名注册表）、`cutover.ts`（启动水位）、
   >   `worker.ts`（DSH 启动器）。把它们排除能让数字立刻好看，但那正是"用定义把预算做小"。
   > - **不计入**：只有两类，理由都是**没有运行时行为**（不是"不属于调度"）：
   >   `evidence/**`（只读证据脚本，不参与产品运行路径）、`types.ts`（纯类型声明）、
   >   `index.ts`（纯 re-export barrel）。
   > - **行数**：物理行数（`\n` 切分，等价 `wc -l`）。
   > - **基线实测（2026-11-14，HEAD `da2c549`）= 3,804 行**。逐文件：`store.ts` 1248 /
   >   `cutover.ts` 459 / `event-types.ts` 391 / `worker.ts` 388 / `event-runtime.ts` 283 /
   >   `routing.ts` 249 / `task-runtime.ts` 224 / `http.ts` 209 / `config.ts` 160 /
   >   `router.ts` 139 / `errors.ts` 54。复核独立计数（`f8f9ef7` 约 3,060 + event-types 391
   >   + cutover 459）与本值一致，口径对得上。
   > - **棘轮规则**：`CEILING = 3,804`（= 当前实测，余量 0）。**增长不是禁止，但必须先改台账**：
   >   ① 新增多少行 ② 为什么必须加 ③ 排除了哪些替代做法 ④ 是否触发本条上面的"换实现"条件。
   >   改完台账再同步脚本里的 `CEILING`。**直接改 `CEILING` 而不改台账 = 把预算重新变成装饰。**
   > - **机检**：CI 的 `plugin` job 跑 `node scripts/runtime-budget.mjs`，超预算 exit 1；
   >   脚本还会校验"每条排除规则必须真的命中文件"（规则失效不许静默通过）。
   > - **不新增运行时依赖**这条不变，仍然有效（当前只有 `@deepseek-ai/cordis` + `pg`）。
   >
   > **仍未做、明确留给后续**：`store.ts` 1,248 行是单文件最大头，需要单独审视里面是否有
   > 非调度职责（health 读数、证据查询、恢复扫描）混入、该不该拆。**拆分不改变总行数**，
   > 所以这不是预算问题，是**可维护性问题**，另开条目处理。
   >
   > **修订 D-109.2（2026-11-14，总控；棘轮第一次真的咬到人）**
   >
   > 建立口径后第一次增长，被机检当场拦下（`runtime-budget: 超预算 20 行（3824 > 3804）`），
   > 走的正是设计好的流程：**先改台账，再改常量**。
   >
   > 1. **新增多少行**：+20 行。`src/runtime/event-types.ts` 391 → 411，合计 3,804 → **3,824**。
   > 2. **为什么必须加**：第 26 个工具 `recruitment_interview_record_verify` 成功后要写一条审计
   >    事实 `interview.record.verified`。**事件类型必须进 `event-types.ts` 的权威注册表**——
   >    不登记就会被语义 Gate 当"未登记事件"拒掉（`SEMANTIC_GATE_REJECTED`），
   >    而这正是 2026-11-14 刚修掉的"假接线"坑（40 条真实事件全被拒）。所以这 20 行是
   >    **注册项 + 生产者/裁决说明**，不是调度逻辑增长。
   > 3. **排除了什么替代做法**：① 复用一个既有事件名（如 `interview.record.imported`）——
   >    会让"导入"与"人工核验"两种事实在审计上不可区分，等于丢事实；② 不登记、让事件走语义
   >    Gate —— 那就是假接线复发；③ 把注册表挪出 `src/runtime/**` 以躲开预算 —— 那是
   >    "用定义把预算做小"，明确禁止。
   > 4. **是否触发换实现条件**（D-109 的禁项与可测阈值）：**没有**。没有优先级队列、没有
   >    延迟投递、没有 cron、没有多消费者组、没有跨实例调度；积压/实例数/tick 吞吐三项阈值
   >    本次均未变化（增长发生在事件注册表，不在认领/租约路径）。
   >
   > **这次咬合本身就是"预算不是装饰"的证据**：如果它没拦住，这 20 行会静默进库，
   > 预算就退回成一句形容词。
   >
   > **修订 D-109.3（2026-11-15，总控；G1 事件自动驱动的预算追认）**
   >
   > 1. **新增多少行**：**+137**。`src/runtime/tick-loop.ts` 120（新文件）+
   >    `src/runtime/config.ts` 160→177（+17：`auto_tick` / `tick_interval_ms` 解析与边界）。
   >    合计 3,824 → **3,961**。
   > 2. **为什么必须加**：G1（P0）——此前 `router.tick()` 只被 `POST /recruitment/runtime/tick`
   >    与 engine_effect 的 launch/delivery 触发，**没有周期驱动**；没人手工发 HTTP 时
   >    `event_inbox` 的 RECEIVED 永远不动，事件驱动是假的。tick-loop 用**专用连接 + PG 会话级
   >    advisory lock**（`recruitment:tick`）做多实例互斥，`setInterval` 防重入，`dispose` 释放锁；
   >    config 两项是运行开关与周期（默认 2000ms，边界 [100, 600000]，非法值 fail-closed）。
   >    **不是调度逻辑扩张**：没有优先级队列、没有延迟投递、没有 cron、没有多消费者组、
   >    没有跨实例调度。
   > 3. **排除了什么替代做法**：① 用 DSH `schedule_*` 当自动派发——那是用户级/宿主定时入口，
   >    G1 明确不接线；② 自建 cron / 外部调度器——D-109 禁项；③ 把 tick 塞进 HTTP route 或
   >    engine_effect kick——仍然是"没人触发就不跑"，不解决事件自动驱动；④ pg-boss/DBOS——第二状态 owner。
   > 4. **是否触发换实现条件**：**没有**。积压/实例数/tick 吞吐三项阈值本次均未变化；多实例
   >    正确性由 advisory lock 提供，跨实例调度未启用（单 tick 顺序吞吐仍在单实例假设内）。
   > 5. **机检**：`node scripts/runtime-budget.mjs` → `PASS（3961 / 3961）`，CEILING 同步
   >    3,824 → 3,961。**G12 若改口径（非注释/非 import 的代码行），必须另立 D-109.4 重算；
   >    不得用拆分或排除规则躲预算。**
4. **文档同步**：`docs/18-golden-path.md §1`（"没有自研队列"那句）与
   `docs/03-domain-and-runtime.md §21.8 V-1` 都已与事实不符，必须同步为本条的口径
   （"用 PG 原生行锁承担任务派发，不引入第二状态 owner"）。

---

## 附录 D · 2026-11-15 产品负责人裁决（证伪复核后）

> 背景：2026-11-15 总控复核推翻了交接包两条声明（工具可用性、S10 决策依据），
> 并把 7 项待裁决重新上抛。以下 3 条是产品负责人当次给出的裁决；`docs/17` 未写 = 未决定（R5）。

### D-110 · 无坐标格式的证据闸门：管"可复核"，不管"有没有坐标"

**裁定**：证据闸门不以 bbox 为门槛，以"第三方能否独立复核"为门槛。三条件同时成立才可自动通过：

1. **原文可核**：引用绑定源文件字节级 `sha256`，独立重算一致；
2. **定位唯一**：定位器解析到原文唯一位置。定位器按格式分型——PDF `page+bbox`；DOCX `part+paragraph`
   或 `part+table_id+row`；RTF `paragraph`（有硬分页时 +`page`）；纯文本 `line/offset`；
3. **原句逐字命中**：`quote` 在定位范围内逐字出现；归一化只允许契约写死的换行/空白/断连字符，禁止语义匹配。

**命中多处 = 歧义，不是通过**：必须补第二定位（前后文/相邻块/章节）或转人工；**禁止取第一条命中**。
证据记录必须带 `locator_kind` + `verification_method`；无坐标格式要标注定位器类型，下游可按证据强度区分，
但**不得仅因缺 bbox 拒收**。

**理由**：坐标是"可追溯"的实现手段，不是目的；目的是任何人拿原文都能核对"这句话确实在那里"。
把手段当目的会把格式差异变成业务阻断（RTF 能读却进不了 S6）。反例：同一句话出现多次时取第一条，
比没有坐标更危险。

**落地**：`contracts/identity/identity-resolution-rules.md` 的 IR-G1 改为定位器联合类型 + 唯一性裁决；
`src/db/identity.ts::toEvidence` 实现三条件；负例补"歧义 quote 必须拒绝/转人工"。

### D-111 · S8→S9 写入口 / S9→S10 记录闸门 / `NO_TRANSCRIPT`

1. **S8→S9**：**允许**补产品写入口（`START`/`COMPLETE` → `IN_PROGRESS`/`POST_INTERVIEW`）。
   "面试已执行"必须是产品记录的事实；转写存在只能作辅助证据，不能替代。若另一边 Web 窗口已有实现，
   先对齐合同再接线，**禁止两套实现**。
2. **S9→S10 是否要求 `interview_record` READY+VERIFIED**：**阶段推进不要求**；`decision` 引用
   `INTERVIEW_RECORD` 时必须 VERIFIED（DC-23 不变）。阶段闸门管"材料处理到可交代"，不是"AI 记录已核验"。
3. **`NO_TRANSCRIPT` 能否进 S10**：**允许**。招聘 agent 的职责是把证据、缺口、风险摆到人面前由人决策，
   不是用技术条件替代人决策。无转写必须分类并显式记录：
   - **确实没有**（未录制/明确不使用转写）：正常进入 S10 人工决策，决策记录 `transcript_state` 与理由；
   - **本来有、我方没取到/取不全**：生成恢复任务，同时在 S10 视图标红"缺什么、已试过什么"，
     **允许人带缺口决策**；不得静默、不得伪造、不得假 READY。
   `decision_record` 必须能携带缺失原因（现有 `missing_disposition` 或等价字段），契约回抄；
   与 `TR-E6`（Evaluation Ready 不要求转写就绪）同向。
   **明确不做**：把"无转写"自动判为不能决策，或自动替人决策。

### D-112 · 配置的产品化：不是"每个用户去设环境变量"

**裁定**：受管配置的交付目标是**部署一次、可审计、可自检**，三层解析、单一来源：

1. 仓库 profile 只放逻辑配置（**零机器路径**）；部署配置 = **配置文件（支持 `${ENV}` 展开）
   + 环境变量 + Web 管理设置页**，优先级写死（显式设置 > 环境变量 > 默认）；Web 设置页写回同一份部署配置。
2. **启动自检 / health**：逐项校验 `python_bin` / `converter_dir` / `allowed_roots` 是否存在、可执行、
   在允许范围；失败逐条列 issue、fail-closed、不猜默认值；health 报每个值的来源层。
3. 错误信息必须可行动（缺什么、怎么补、改哪一层）；禁止静默回退到系统默认路径。
4. 这是**管理员的部署配置**，不写进租户业务数据；变更走版本/审计。

**落地备注（2026-11-15，总控）**：两处受管定义（`dsh/profile/recruitment/cordis.patch.yml`
与插件 bundle `dsh/dsh-recruitment/cordis.patch.yml`）的 converter 已改为 `${RECRUITMENT_*}`
引用，并新增 `feishu.cli`/`feishu.profile`；`skill-filesystem.customSkillDirs` 用 DSH 原生
`!!js process.env.RECRUITMENT_SKILL_DIR`（loader 只对 `!!js` 求值，普通字符串不做 `${ENV}` 插值）。
两份 config 已 `grep '[A-Za-z]:\\'` = **0 行**。缺变量时 fail-closed（converter 逐条列 issue；
feishu 不装配）。L1（干净 env 启动产品 profile + 一次真实读取）留到 G4/G9 验收动作执行。

**理由**：多人使用时"每人改本机文件"不可运维；产品必须让管理员在界面里配、启动时自检、出错能定位。
环境变量展开只是其中一层，不是方案全部。

### 待办（本条未决）

- **WP-3/4/5 是否授权开工**：产品负责人 2026-11-15 已答复"全开" → **M1+M2（G1–G12）开工；M3 不做**。
- D-110/111/112 的合同与代码落地属实现，需对应 WP 授权后派 lane；本裁决只定语义与验收判据。
- **D-111 与 G3=B 的冲突（2026-11-15 复核指令）**：G3=B 把 T3 定为"材料就绪（canonical READY 转写）"、
  T4 加"≥1 份 SUBMITTED 面评"，与 D-111 #1/#3 不一致。按时间优先，**阶段梯子以 G3-B 为准**；
  D-111 #1 的 START/COMPLETE 写入口降级为可选，D-111 #3 限定为"人可带缺口决策、但阶段指针不伪造材料"。
  该口径须与 G3 合同修订**同一提交**回抄。
- **D-113（待编）PDF 底座许可证**：PyMuPDF = AGPL-3.0/商业双许可；网络服务化是否接受 AGPL §13、
  购买商业许可、或换底座，待产品负责人裁决。RapidOCR(Apache) 纳入声明配置不依赖该裁决。
- **入库机器路径**：`dsh/dsh-recruitment/cordis.patch.yml:18-23,48` 与
  `dsh/profile/recruitment/cordis.patch.yml:192-197,243` 仍含机器绝对路径；G9 落地 `${ENV}` 后必须清掉（缺陷修复）。
- **发布闸门（2026-11-15 独立复核 P1）**：G1 `runtime.auto_tick` 在产品 profile 置 **false**（Wave1 复核发现：单独开启会为每份简历自动拉起跑不了业务的 Worker，attempts 耗尽 → 任务 FAILED、简历解析永不完成）。**G2（Worker 能执行业务工具 + 派发前就绪检查）验收同批才翻回 true**；测试需要 tick 时用测试专用 profile/patch 显式开启，不改仓库产品 profile。`n- **D-109.4（2026-11-15，总控；G10 预算追认）**：**+391** 物理行（`event-runtime.ts` 271→617? 以脚本口径 283→629 = +346；`http.ts` +45），合计 3,961→**4,352**。理由：G10 事件处置写入（每条事件终态一行 append-only 处置 + `target_task_ids`）与 health 暴露（无处置数/最老等待秒/内部审计单列）；无队列/调度语义变化，D-109 三项阈值未触发。排除：把处置塞进 `event_inbox` 列（覆盖历史投影）、异步遥测（不落 PG 审计）、外部队列（第二 owner）。机检：`runtime-budget PASS（4352/4352）`；干净归档实测 +391（`work/control/budget-clean-g10`）。G2/G12 的增长另立 D-109.5/6，不用本条兜底。
- **事件处置稳态口径（2026-11-15 裁决）**：`count(events)-count(disposed)` 不要求全表字面 0——`event_inbox` 同时承载 `schema/0001` 触发器的内部审计事件（派发谓词本身排除，0016 回填也不覆盖）。G10 的验收口径是：**in-scope undisposed = 0**，且恒等式 `total = disposed + internal_audit + undisposed`；health 单列 `events_internal_audit`。要求审计事件也写处置会造成语义冲突，不做。
- **D-109.5（2026-11-15，总控；预算度量为代码行 + G12 拆分追认）**：G12 把 `store.ts` 拆成 `store/` 子树后，物理行 3,961→4,275（+314），但**没有新增逻辑**；+314 全是 import/export/签名/委托/模块头等结构行。为不让"拆分"把预算变成装饰，度量切换为 **代码行 = 物理行去掉空行、整行/行尾注释、import/export-from 后的剩余行**。实测：HEAD+G10 代码 3,116 → 加 G12 **3,280（+164）**；CEILING 同步 4,352→**3,280**（代码行口径）。只排除无运行时行为的语法，不排除业务/调度逻辑；排除规则失效仍 exit 2。G2 的增长另立 D-109.6。
- **研究结论（2026-11-15）**：DSH 0.2.2-rc.3 是最新官方版（npm `latest` 反而停在 rc.1，禁止"跟 latest 升级"）；
  Agent Teams 是 rc.2 起的**开发流程**能力（同进程/root 会话、任务真相在 session log、writeScopes 仅建议），
  产品运行时不用；`dsh-superagent-prototype` 是官方研究原型（private、单提交、SQLite 第二 owner），只借 Attention/面板形状。
