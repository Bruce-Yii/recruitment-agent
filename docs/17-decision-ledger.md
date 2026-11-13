# 17 · 决策台账（唯一权威源）

**来源**：`D:\12412\dsh工作区\projects\recruitment-os\work\control\DECISIONS-2026-11-12.md`
（旧仓，**冻结只读**）。下面是该文件 **530 行的逐字副本**，未改一字。
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
`D:\12412\dsh工作区\projects\recruitment-os\work\control\DECISIONS-2026-11-12.md`

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
