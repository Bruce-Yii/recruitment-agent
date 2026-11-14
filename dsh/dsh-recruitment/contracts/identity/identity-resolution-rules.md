# 身份解析与合并规则（S6 的一部分 · candidate identity resolution）

**日期**：2026-11-13
**范围**：S6（简历接入与处理）的一部分——「身份解析与合并」：一份新材料进来后，**它是谁、要不要并到已有档案、并错了怎么拆**。
**不管**：材料怎么进来（S6 接入 / Intake 三层）、进来以后怎么筛（S7）。本文只裁决身份。
**状态**：规则已闭环，可判定；**3 处依赖库变更（§13 G-1/G-3/G-4），未落地前对应动作必须 fail-closed**，见 §13。
**性质**：合同。不含实现代码、不含 DDL。所有「必须/不得」都是可判定的断言，不是建议。

---

## 0. 一句话

> **只有「可考来源的强标识」能自动证明两个人是同一个人；姓名、公司、学校一律只能产生"待人工"，不能产生"已合并"。**
> 合错人的代价不是一条脏数据，而是**把 A 的经历、面试评价、拒绝理由写进 B 的档案，并且这两个人都不知道**。因此本文件里所有拿不准的分支，默认落到「待人工」，没有一个分支默认落到「合并」。

三条与本文冲突时以本文为准的上位口径：`docs/11-pdf-acceptance-criteria.md §9.7`、`db/SCHEMA.md §8 不变量 2`、`docs/17-decision-ledger.md`（D-7/D-15/D-18/D-19/D-20）。

---

## 1. 术语（后文只用这几个词）

| 词 | 定义 | 不是 |
|---|---|---|
| **强标识** | 规范化后能唯一指向一个自然人的联系方式：`phone`、`email`；以及 `platform_id` / `verified_profile`（v1.0 不接，见 §13 G-5） | 姓名、公司、学校、职位、城市、经历、语义相似 |
| **弱标识** | 姓名、公司、学校、经历、语义相似 | 任何可用于自动合并的依据 |
| **标识的可考来源** | 该字段值能回指到**块级 provenance** 与**原文坐标**（page+bbox+原件 sha256） | 「HR 说过」「系统里本来就有」 |
| **解析尝试（attempt）** | 一次「这份材料是谁」的判定及其依据；**这是审计单位**，不是 candidate 行 | candidate 的 status |
| **存活档（survivor）** | `identity_status='ACTIVE'` 的那一条档案；读路径的终点 | 最新创建的那条 |
| **等价类** | `{x} ∪ {所有 merged_into 链最终指向 x 的档案}` | 一条 SQL join 出来的行集（必须去重） |

> 术语纪律：本文说「合并」只用 `merge`；说「拆开」只用 `split`；**「关联」(`LINK`) 不是合并**——新材料命中已有档案是关联，不写 merge 记录（§11 E6，最常见实现错误见 §12-①）。

---

## 2. 归一化（比较键）· IR-N

归一化**只用于比较**，**不得回写原文**（原文与证据 `raw` 必须原样保留，`doc11 §2 A3`）。这条容易被误读成「反正要归一化，就把库里也改成规范形」——不行，那会把「原件写了什么」抹掉。

| # | 函数 | 判定式（给输入能算出唯一输出） | 依据 |
|---|---|---|---|
| IR-N1 | `norm_email(s)` | ① 去首尾空白与零宽字符；② 若形如 `显示名 <a@b>` 只取尖括号内；③ `toLowerCase()`；④ 结果须匹配 `^[^\s@]+@[^\s@]+\.[^\s@]+$` 且 `= lower(btrim(该值))`。**不做** Gmail 点号折叠、**不做** `+tag` 折叠 | `SCHEMA §1`（`ck_candidate_email_normalized`）；`0001 L742-745` |
| IR-N2 | `norm_phone(s)` | ① 删 `[\s\-().·/]`；② 去前导 `00`；③ 去前导 `86`（仅当剩余 ∈ `^1[3-9]\d{9}$`）；④ 若剩余匹配 `^1[3-9]\d{9}$` → `"+86"+剩余`；⑤ 否则若原串带显式国际前缀（`+` 或 `00`）→ `"+"+剩余`；⑥ 否则 → 裸数字且置 `region_ambiguous=true`；⑦ 结果须匹配 `^\+?[0-9]{5,20}$` | `ck_candidate_phone_normalized`；`0001 L746-747` |
| IR-N3 | `norm_name(s)` / `norm_org(s)` | NFC → NFKC（**仅此两键**）→ 去零宽/不可见 → 折叠空白 → **删除全部空白** → Latin `toUpperCase()`。长度 1..200。**不做**拼音化、首字母、繁简转换、曾用名推断 | `ck_candidate_name`；`docs/03 §6.2` |
| IR-N4 | `region_ambiguous` | `true` 时该电话**不得**单独作为自动合并依据（只可作人工复核时的提示）。理由：8 位固话在两地重复是常态 | 本文；`docs/03 §6.1`（强标识必须"可靠"） |
| IR-N5 | **写入端必须存规范形** | 写进 `candidate.normalized_phone/email` 的必须是 `norm_*()` 的**输出**，不是来料原样（`+86 138-0000-1234` / `13800001234` / `Zhang.San@Example.COM` 一律先归一）。理由：`ck_candidate_phone_normalized` 只校验字符集与长度（`0001 L747`），**不保证规范形**，而唯一索引比较的是**存储值**——写入不归一，`uq_candidate_active_phone` 形同虚设 | `§5.3 L2-b`、§12-⑭ |

**归一化失败 ≠ 字段缺失**：归一化失败 → 该字段 `state=unreadable`（不是 `absent`），理由同 `D-20` 的同构：推不出「没有」，只能推出「读不准」。

---

## 3. 标识分级与用途矩阵 · IR-S

| 标识 | 类别 | 可否自动合并 | 可否产生待人工 | 可否用来选主档方向 | 依据 |
|---|---|---|---|---|---|
| `email`（非共享邮箱，格式通过） | 强 | ✅ 需过 §4 闸门 | ✅ | ⚠️ 仅作方向平局前的**并列比较**，不作独立依据（§6） | `docs03 §6.1`、`FR-C2`、`doc11 §9.7` |
| `phone`（`region_ambiguous=false`） | 强 | ✅ 需过 §4 闸门 | ✅ | 同上 | 同上 |
| `phone`（`region_ambiguous=true`） | 准强 | ❌ | ✅ | ❌ | `IR-N4` |
| 共享邮箱（`jobs@`、`hr@`、配置化共享清单） | 弱 | ❌ | ✅（`SHARED_MAILBOX`） | ❌ | 本文 IR-C5 |
| `name` | 弱 | ❌ **永不** | ✅（作为**必需的一致项**参与自动判定，但不独立成立，§5.4 D12） | ❌ | `docs03 §6.2`、`FR-C3` |
| `company` / `school` | 弱 | ❌ | ✅ | ❌ | 同上 |
| `experience` / 语义相似 / 模型相似度 | 弱 | ❌ | ✅（只作原因码，不构成理由） | ❌ | `docs03 §6.2`、`FR-C3` |
| `platform_id` / `verified_profile` | 强（v1.0 未接） | ❌ 未定义 | ✅ | ❌ | §13 G-5 |

**分级铁律**：**弱标识永远不能替代强标识的配额**。三个弱标识同时一致（姓名+公司+学校）也不自动合并——只产生待人工。

---

## 4. 来源闸门：什么时候一个字段「算数」· IR-G

> 这一节是 `doc11 §9.7` 的机械化。原文是判据，这里给谓词。

字段级谓词（对某一侧、某一字段 `f`）：

```
STATE(f)   ∈ {present, absent, unreadable}            # 三态，doc11 §9.2
PROV(f)    ∈ {native_text, ocr_title, agent_read, human_confirmed, unknown}
FORMAT_OK(f)  = norm(f) 存在 ∧ 匹配 IR-N1/N2 的最终正则
EVID_OK(f)    = ∃e ∈ f.evidence，三条件同时成立（D-110，按"可复核"而非"有坐标"）：
                ① SHA_OK(e)     = sha256(原件字节) 独立重算 = e.source_sha256（64 位十六进制）
                ② LOCATOR_UNIQUE(e) = e.locator 在解析结果里解析到**唯一**位置
                ③ QUOTE_LITERAL(e)  = e.quote 在该定位范围的原文里**逐字**命中
                   （只允许契约写死的换行/空白/断连字符归一化；禁止语义匹配、禁止模糊匹配）
                每条证据必须记录 `locator_kind` + `verification_method`；
                **歧义（同一 quote 多处命中且定位器不能唯一定位）⇒ 不通过，转人工
                REVIEW(AMBIGUOUS_EVIDENCE)；禁止取第一条命中**（IR-G8）。
                无坐标格式（RTF/纯文本）**不得仅因缺 bbox 拒收**，只要 ①②③ 成立即可自动。
HARD_CLEAN(f) = 承载 f 的块/页没有 HARD issue；未知 issue code 一律按 HARD（doc11 §1）
AUTO_OK(f)    = STATE=present ∧ PROV=native_text ∧ FORMAT_OK ∧ EVID_OK ∧ HARD_CLEAN
```

**定位器联合类型（D-110）**：`EVID_OK` 的唯一性判定按格式分型，不要求坐标形式统一：

| locator_kind | 定位字段 | 适用 |
|---|---|---|
| `pdf_page_bbox` | `page` + `bbox` 四元组 | PDF 文本层 |
| `docx_part_paragraph` | `part` + `paragraph` | DOCX 段落 |
| `docx_part_table_row` | `part` + `table_id` + `row` | DOCX 表格行 |
| `rtf_paragraph` | `paragraph`（无硬分页时 `page=1` 可不写；有硬分页时 +`page`） | RTF |
| `text_line_offset` | `line` + `offset` | 纯文本 |

`verification_method` 至少区分两种来源：`LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE`（由定位器唯一确定位置）
与 `QUOTE_UNIQUE+SHA256+LITERAL_QUOTE`（无可用坐标时由 quote 全文唯一命中反推位置；多处命中必须转人工）。
下游可按证据强度区分，但**不得仅因缺 bbox 拒收**。

| # | 规则 | 判定式 | 依据 |
|---|---|---|---|
| IR-G1 | 只有 `AUTO_OK` 字段可驱动自动合并 | 自动合并所需**每一侧、每一个**参与匹配的强标识必须 `AUTO_OK`；`EVID_OK` 按本节**定位器联合类型三条件**判定（D-110） | `doc11 §9.7`、`doc11 §2 D3`、`doc11 §9.11 #10`；D-110（2026-11-15 产品负责人裁决） |
| IR-G2 | `ocr_title` / `agent_read` 一律人工 | 参与匹配的字段 `PROV ∈ {ocr_title, agent_read}` → 结论只能是 `REVIEW(PROVENANCE_NOT_AUTOMATABLE)`，**即使值完全相等** | 同上 |
| IR-G3 | `unknown`（含历史迁移数据、手工塞库数据）一律人工 | `PROV` 不可考 ⇒ 视为不可自动。**fail-closed，不是 fail-open** | `doc11 §9.7`；`D-20` 同构（推不出 ≠ 否定） |
| IR-G4 | `human_confirmed` 可自动 | HR 在复核动作里**确认过**的字段视为已核实（等价于 `native_text` + 人工已读），但必须在 attempt 里留下 `confirmed_by` + `confirmed_at` | `docs03 §6.4`（授权 HR 确认） |
| IR-G5 | 文档级阻断 | `resume_version.parse_status ∈ {FAILED}` → 无字段可用；`completeness=unverified` 或 `needs_visual=true` → 全部字段降级为不可自动 | `doc11 §2 B3`、`doc11 §1` |
| IR-G6 | 平台噪声字段不得作标识 | 页眉/水印/二维码里的电话邮箱（`doc11 §9.5`）即便 `native_text` 也不得进 `norm_phone/norm_email`；判定：该块若被标 `platform_noise` → `STATE=absent` | `doc11 §9.5` |
| IR-G7 | 归一化不改原文 | attempt 必须同时保存 `raw` 与 `norm`；库里 `normalized_*` 只是比较键 | `doc11 §2 A3`、`doc11 §9.9` |
| IR-G8 | 证据歧义一律人工（禁止取第一条） | 定位器解析到多处，或 `quote` 在全文多处命中且定位器不能唯一定位 → `REVIEW(AMBIGUOUS_EVIDENCE)`；必须先补第二定位（前/后文、相邻块、章节）或转人工。**不得**按"第一条命中"消解 | D-110（"同一句话出现多次时取第一条，比没有坐标更危险"） |
| IR-G9 | 证据必须可复核且注明种类 | 进入 `AUTO_OK` 的每条证据必须带 `locator_kind` + `verification_method` + `source_sha256`；无坐标格式标注定位器类型，下游可按证据强度区分，但**不得仅因缺 bbox 拒收** | D-110；本节定位器联合类型 |

**来源 × 默认结论**（注意：**通道不决定结论，provenance 决定结论**；下表只是常见组合，判定仍走上面谓词）：

| 来源 | 典型 provenance | 默认结论 | 依据 |
|---|---|---|---|
| 原生文字 PDF（上传 / 邮件附件） | `native_text` | 过 §5 判定，可能自动 | `doc11 §3` |
| 扫描件 / 手机拍照 | `ocr_title` + `needs_visual` | **人工** | `doc11 §3`、`§9.11 #10` |
| 模型结构化补全（原文没有、模型归纳） | `agent_read` | **人工** | `doc11 §2 D2/D3` |
| HR 手工录入 / 复核确认 | `human_confirmed` | 可自动（需 `confirmed_by`） | `IR-G4` |
| 招聘网站导出 PDF | `native_text`（含平台噪声） | 可自动，但噪声字段按 `IR-G6` 剔除 | `doc11 §9.5` |
| 历史迁移数据（无 provenance） | `unknown` | **人工** | `IR-G3` |

---

## 5. 判定过程（给输入必得唯一结论）· IR-D

### 5.1 输入

```
in  = ( tenant_id,
         fields: {email?, phone?, name?, company?, school?}   # 每项带 STATE/PROV/evidence/raw/norm
         owner_candidate?      # 这份材料当前已归属的 candidate（若有）
         policy )              # business_config(identity_policy)
E   = { c ∈ candidate : c.tenant_id = in.tenant_id ∧ c.identity_status='ACTIVE' }   # 只看同租户存活档
```

**跨租户硬门**：`E` 的构造里就没有别的租户——不是「比较后拒绝」，是**根本不进入比较**（`SCHEMA §1 多租户`、`SCHEMA §9.7`、`docs/03 §16.7`）。见 `IR-F2`。

### 5.2 谓词

```
STRONG_EQ(c,f) = (f=email ∧ norm_email(c.存值)=norm_email(in) ∧ IR-N1 通过)
              ∨ (f=phone ∧ norm_phone(c.存值)=norm_phone(in) ∧ ¬region_ambiguous ∧ IR-N2 通过)
HIT        = { c ∈ E : ∃f ∈ {email,phone} · STRONG_EQ(c,f) }      # 强命中集
HIT_SAME_F = 存在某个 f，使 HIT 中 ≥2 条都由同一个 f 命中
NAME_EQ    = STATE(name)=present 且两侧 norm_name 相等
NAME_CONFL = 两侧 STATE=present 且 norm_name 不等
NAME_UNK   = 任一侧 STATE(name) ∈ {absent, unreadable}
WEAK_EQ    = NAME_EQ ∧ ( COMPANY_EQ ∨ SCHOOL_EQ )
ESTABLISHED(c,f) = c 的同字段存值非空 ∧ 格式合法 ∧ **该值能回指到一条可考来源**
                   （G-2 落地前：∃ 该候选人的某份 resume_version 以 `native_text` 给出同一规范值；
                     G-2 落地后：`native_text` 或 `human_confirmed` 均可）
```

> `ESTABLISHED` 是"既有档案那一侧也可考"。注意它**不是**"库里有值"——库里 `normalized_phone` 有值只说明有人写过，不说明是谁、从哪读来的（`candidate` 没有 provenance 列，`IR §13 G-2`）。**G-2 落地前，HR 手工录入的值也证不出来，一律按 `unknown` 处理（`IR-G3`，fail-closed）。**

### 5.3 三条结构引理（先证明，再判定）

| # | 引理 | 为什么必须知道 |
|---|---|---|
| **L1** | 在**写入端存规范形**的前提下，`uq_candidate_active_email/phone` 保证同一强标识最多命中一条 `ACTIVE` | 所以"两条 ACTIVE 同号"这种夹具**插不进去**（§12-⑬） |
| **L2** | ∵ L1 ∴ `size(HIT) ≥ 2` 只有两种成因，且**必须分开处理**：<br>**(a) 两个不同字段各命中一条** = 本次材料自带的邮箱与手机把两条旧档连起来 → **交叉印证，最强的自动合并形态**；<br>**(b) 同一字段命中两条** = 写入端没存规范形（`13800001234` 与 `+8613800001234` 在 CHECK 看来都是合法值，唯一索引拦不住）→ **这是数据质量缺陷，不是业务事实** | 把 (b) 当 (a) 处理，等于用"合并"掩盖一个坏掉的唯一索引——之后每天都会再犯 |
| **L3** | `size(HIT) ≤ 2`（强标识只有两个字段）；`≥3` 说明不变量已被破坏 | 出现即告警，不得继续判定 |

### 5.4 判定（**顺序执行，首个命中即返回**；顺序本身是规则的一部分）

| 步 | 条件 | 结论 | 不变量 |
|---|---|---|---|
| D0 | 同一 `intake_record` 已有 `OPEN` 的 review item | `REVIEW(ALREADY_PARKED)`（复用，不新建） | 幂等 |
| D1 | `HIT = ∅` ∧ `WEAK_EQ` | `REVIEW(WEAK_MATCH)` | 不合并 |
| D2 | `HIT = ∅` ∧ ¬`WEAK_EQ` | `CREATE_CANDIDATE` | 不合并 |
| D3 | `size(HIT) ≥ 3`（L3 被破） | `REVIEW(IDENTITY_INVARIANT_BROKEN)` + 告警 | 不合并 |
| D4 | `HIT_SAME_F`（L2-b） | `REVIEW(DUPLICATE_ACTIVE_STRONG_ID)` + 数据质量告警 | 不合并 |
| D5 | `size(HIT) = 2` ∧ 两个命中字段都 `AUTO_OK` ∧ 三条名字归一后全等 | **`AUTO_MERGE`**（`strong_ids=[email,phone]`,`band=HIGH`） | §6 |
| D6 | `size(HIT) = 2` ∧ 命中字段有 ¬`AUTO_OK` | `REVIEW(PROVENANCE_NOT_AUTOMATABLE)` | 不合并 |
| D7 | `size(HIT) = 2` ∧ 名字冲突 / 未知 | `REVIEW(MERGE_CONFLICT_ID_NAME)` / `REVIEW(NAME_UNVERIFIED)` | 不合并 |
| D8 | `size(HIT) = 1` ∧ 命中字段 ¬`AUTO_OK` | `REVIEW(PROVENANCE_NOT_AUTOMATABLE)` | 不合并 |
| D9 | `size(HIT) = 1` ∧ (`owner_candidate` 为空 ∨ = 命中档) | **`LINK_EXISTING`**（关联材料/申请，**不写 merge**） | 无身份迁移 |
| D10 | `size(HIT) = 1` ∧ `owner=B≠C` ∧ B 的同字段存值非空且 ≠ 来料 | `REVIEW(OWNER_STRONG_ID_CONFLICT)`（同一人的两份材料互相矛盾 → 换号/代投/嫁接口） | 不合并 |
| D11 | `size(HIT) = 1` ∧ `owner=B≠C` ∧ ¬`ESTABLISHED(C,f)` | `REVIEW(PROVENANCE_UNVERIFIABLE_LEGACY)` | 不合并 |
| D12 | `NAME_CONFL` | `REVIEW(MERGE_CONFLICT_ID_NAME)` | 不合并 |
| D13 | `NAME_UNK` | `REVIEW(NAME_UNVERIFIED)` | 不合并 |
| D14 | `policy = MANUAL_ONLY` | `REVIEW(POLICY_MANUAL_ONLY)` | 不合并 |
| D15 | 以上都不成立 | **`AUTO_MERGE`**（`strong_ids=[f]`,`band=HIGH`） | §6 |

**四条顺序理由**（顺序不是排版，是裁决）：

1. **D8 在 D9 之前**：关联虽不是合并，但"把这份材料挂到谁名下"同样是**对'这是谁'的自动判定**，同样受来源闸门约束（`doc11 §9.7` 的立法意图是"身份类字段不得自动驱动对人的归属"，不只是"不得自动合并"）。OCR 手机号命中某人 → 不能自动挂到他名下。
2. **D9 在 D12 之前**：命中已有档案时正确动作是**关联**；合并的前提是"两条既有档案"。写反了就会在每次重复投递时写一条 merge 记录，制造假历史（§12-①）。
3. **D10 在 D12 之前**：同一人名下两份材料给出两个不同手机号，这是**更强的矛盾信号**，比姓名是否一致更该先拦。
4. **D5 不看旧档 provenance**：交叉印证里，两条相等关系分别由**本次材料的可考字段**确认（`A.email=M.email ∧ B.phone=M.phone`），不依赖旧值怎么进来的；而 D15 的单命中最依赖旧档，因此才需要 `ESTABLISHED`——这正是 `G-2` 的直接后果。

**人工合并（`MANUAL_MERGE`）不在上表**：它不来自自动判定，来自 `REVIEW` 的人工裁决（迁移见 `merge-state-machine.md` T3）。人工合并仍须满足结构前置（两条 `ACTIVE`、同租户、actor 有权、版本匹配），但**允许** `NAME_CONFL`（人已确认是同一人的曾用名/婚姓场景，`IR-C3`）。

**交叉印证合并之后**：本次材料必须挂到 `resolve()` 后的**存活档**上，不得挂在被合并的那一条上（`IR-F11`）。

---

## 6. 合并执行：方向、字段、申请 · IR-M

### 6.1 方向（谁是 survivor）· IR-M1

**自动合并**（`auto_merged=true`）必须由下列**全序**唯一确定方向，禁止任何主观排序（`docs03 §6.4` 的"授权 HR 选主档"只适用于人工合并）：

1. survivor 必须 `identity_status='ACTIVE'`（硬约束，库触发器强制：`fn_candidate_merge_apply`）。
2. 比较 `in-flight application 数`（`lifecycle_status='ACTIVE'` 的条数）：**多者存活**。
3. 相等 → 比较 `created_at`：**早者存活**。
4. 仍相等 → 比较 `id::text`：**字典序小者存活**。

**人工合并**：由人工指定 survivor，但仍须满足第 1 条；方向写入 `match_basis.direction_rule`，取值 `HUMAN_CHOICE`。

**禁止用姓名/完整度/最近活跃度定方向**（`IR-F5`）：那些都是"看起来像"。

### 6.2 字段处理 · IR-M2

| 字段 | 动作 |
|---|---|
| survivor 的 `normalized_email/phone` 为空、被合并方非空 | survivor **采纳**（UPDATE survivor 一次）；记入 `match_basis.field_processing.adopted` |
| 双方同字段都有值且**不同** | **不覆盖**；差异记入 `match_basis.field_processing.conflicts`；值本身留在被合并方行里（被合并方行不动） |
| `display_name` | survivor 保持不变；被合并方姓名记入 `aliases` |
| 被合并方的任何字段 | **一律不改**。它的行是历史事实，`identity_status/merged_into/merge_id` 三列由库触发器写，其余列保持原样 |

> 别名映射不单独建表：它写在 `candidate_merge.match_basis.field_processing.aliases`（`docs03 §6.4` 要求的"别名映射 + 字段处理"的唯一可用载体，见 §13 G-2）。

### 6.3 历史 Application（不变量 2）· IR-M3

`docs/03 §4 不变量 2` + `SCHEMA §8 INV-2`：**合并不删除历史 Application**。具体到实现：

| 动作 | 规则 |
|---|---|
| `UPDATE application SET candidate_id=...` | **禁止**（`IR-F6`）。这会把"当时投给谁"改写掉，等于篡改历史，且库不拦 |
| 合并后两条档案的申请 | 各自留在原档案下；"这个人的全部申请" = 等价类上所有申请的并集，按 `application.id` 去重 |
| 报表计数 | 必须按 `resolve()` 后的存活档归并，否则同一人的两条申请会被算成两个人的（§12-⑦） |
| 库层保障 | `fk_application_candidate` 为 NO ACTION + `trg_application_no_delete`（`SCHEMA §8 INV-2`，负向测试 `N20`） |

### 6.4 并发与幂等 · IR-M4

| # | 规则 | 依据 |
|---|---|---|
| IR-M4a | 合并命令必须携带**双方** `expected_record_version`；任一不匹配 → `409 VERSION_CONFLICT`，**不重试、不 last-write-wins** | `docs03 §6.7`、`FR-C8`、`docs03 §18` |
| IR-M4b | 同一 `(surviving, merged)` 对只能有一条记录（`uq_candidate_merge_pair`）；重复提交且 `match_basis.command_id` 相同 → 返回既有结果（幂等成功）；不同 `command_id` → `409 MERGE_PAIR_ALREADY_DECIDED` | `0001 L773`、§12-⑧ |
| IR-M4c | 合并必须单事务完成：`SELECT … FOR UPDATE` 两条档 → 校验版本/状态 → `INSERT candidate_merge` → 触发器改被合并方 → `COMMIT`。**不跨事务、不先改状态后补记录** | `docs03 §18`；`IR-F12` |
| IR-M4d | actor 必须 `SET LOCAL recruitment.actor_id`（不是 `SET`，连接池会泄漏） | `D-18` |
| IR-M4e | 合并后 survivor 的 `record_version` 会因 `fn_touch` 自增；调用方**不得缓存旧版本号** | `D-18` |

### 6.5 谁可以执行合并 · IR-M5

| 执行者 | 允许？ | 依据 |
|---|---|---|
| `actor.kind='HUMAN'`（有 `merge_candidate` 权限） | ✅ | `docs03 §6.4` |
| `actor.kind='SYSTEM'`（确定性规则命中，`auto_merged=true`） | ✅ | `D-7`、`FR-C7` |
| `actor.kind='AGENT_WORKER'`（含任何模型/子代理） | ❌ **永不** | `SCHEMA §3 #35`：`execution_mandate` 的 CHECK 明令禁止 `merge_candidate` 出现在 `allowed_actions`（`0001 L1648`）；`APP-07` |

⇒ **模型只能产出「建议合并」，不能产出「合并」**。这条不是策略，是库里写死的 CHECK。因此自动合并的 `decided_by_actor_id` 必须是 `SYSTEM` actor（`IR-M6`）。

### 6.6 记录要求（每条合并都算数）· IR-M6

`candidate_merge` 只允许 `INSERT`（`trg_candidate_merge_immutable`，`0001 L1783/L1789-1792`），所以**写错不能改，只能再写一条补偿记录**——这决定了 `match_basis` 必须一次写全：

```
match_basis = {
  "schema": "identity/1",
  "rule": "HIGH_CONFIDENCE_MULTI_DIM" | "MANUAL_CONFIRM" | "COMPENSATING_SPLIT",
  "decided_via": "AUTO" | "HUMAN",              # 必须与 auto_merged 一致（auto_merged=true ⇔ decided_via="AUTO"）
  "strong_ids": ["email"] | ["phone"] | ["email","phone"],
  "weak_ids": ["name"] | ["name","company"] | ...,
  "provenance": { "email": "native_text", "phone": "native_text" },
  "confidence": { "band": "HIGH"|"MEDIUM"|"LOW" },   # 只有 band，禁止自由数值（IR-F8）
  "blockers": [],
  "attempt_id": "<uuid>",                        # 指向解析尝试（§13 G-4）
  "evidence": [ { "field":"phone", "page":2, "bbox":[..], "source_sha256":"..." } ],
  "direction_rule": "INFLIGHT_APPS|EARLIEST_CREATED|LEXICOGRAPHIC_ID|HUMAN_CHOICE",
  "field_processing": { "adopted": [...], "conflicts": [...], "aliases": [...] },
  "pre_merge_snapshot": { "surviving": {...}, "merged": {...} },   # split 的唯一依据
  "record_versions": { "surviving": 3, "merged": 1 },
  "command_id": "<幂等键>"
}
```

`band` 的判定（无自由参数）：`HIGH` = 1 个强标识 `AUTO_OK` 命中 ∧ 姓名可判定且相等 ∧ `blockers=[]`；`MEDIUM` = 强标识命中但姓名冲突/未知/来源不可自动；`LOW` = 仅弱标识。**置信度不是打分，是这条规则的名字**——写数值就没办法复核它为什么是 0.97。

---

## 7. 拆分（合并错了怎么办）· IR-X

### 7.1 目标语义

`docs03 §6.6` + `FR-C6`：**补偿式 Split，引用原 Merge Record，不抹审计**。
- 存活档 A 与被合并方 B **都恢复为独立档案**（B 回到 `ACTIVE`）。
- **两个方向的 Application 一条都不动**（它们本来就各自指向自己的档案，拆分天然正确，见 `IR-M3`）。
- 原始 merge 记录**保留**，新写一条引用它的拆分记录。

### 7.2 前置条件（全满足才可拆，否则 fail-closed）

| # | 前置 | 不满足时 |
|---|---|---|
| X1 | `B.identity_status='MERGED'` ∧ `B.merged_into_candidate_id=A` ∧ `B.merge_id=R0.id` | `409 SPLIT_STATE_INCONSISTENT` |
| X2 | `R0.match_basis.pre_merge_snapshot` 存在且含双方 `display_name` + 当时 `normalized_email/phone` | `409 SPLIT_SNAPSHOT_MISSING`（历史合并无法精确还原 → 只能人工逐字段恢复并记录，**不得自动猜**） |
| X3 | 要还给 B 的每个强标识，当前**没有**其他 `ACTIVE` 档案持有 | `409 SPLIT_IDENTIFIER_CONFLICT`（人工决定谁保留，禁止先写后吵架） |
| X4 | 传入 `expected_record_version`（A 与 B 各一） | `409 VERSION_CONFLICT` |
| X5 | 执行者是 `HUMAN` 且有权；`reason` 非空 | `403 ACTOR_FORBIDDEN` / `422 REASON_REQUIRED` |
| X6 | 拆分审计载体存在（§13 G-3） | `409 SPLIT_REQUIRES_SCHEMA`（当前 v1.0 **就是**这一条） |

### 7.3 执行顺序（顺序错了会撞唯一索引，§12-③）

```
同一事务：
 1) 释放 A 上「由 B 采纳而来」的强标识（依据 field_processing.adopted + snapshot），必要时置 NULL
 2) UPDATE B: identity_status='ACTIVE'，清 merged_into_candidate_id / merge_id，
              按 snapshot 还原本方原始标识                     ← 必须先做完 1)
 3) INSERT 拆分审计记录（引用 R0.id、操作者、时间、理由、恢复的字段）
 4) COMMIT
```

先 `2)` 后 `1)` → `uq_candidate_active_phone/email` 直接 `23505`（部分唯一索引只覆盖 `ACTIVE` 行）。这个顺序不是风格问题，是唯一能跑通的顺序。

### 7.4 拆分之后

| 场景 | 结论 | 依据 |
|---|---|---|
| 同 pair 再合并 | **禁止**（`uq_candidate_merge_pair` 已占位）→ `409 MERGE_PAIR_ALREADY_DECIDED`。**不得**用"翻转 survivor 方向"绕过（那会在不可变记录里写一个假方向） | §13 G-6 |
| 需要"其实还是同一个人" | 人工走 0002 演进（`superseded_by` 语义），在此之前**保持已拆分状态**并留工单 | §13 G-6 |
| 拆分后再合并**不同** pair（B 与第三者 C） | 允许，走正常流程 | — |

### 7.5 明令禁止的"拆分"实现（见过就会再犯）

| 伪实现 | 为什么禁止 | 依据 |
|---|---|---|
| 反向 `INSERT candidate_merge(B存活, A被合并)` 当作拆分 | 触发器会把 **A 标成 MERGED**，方向相反；且在不可变审计里写下一个从未发生的事实 | `IR-F7` |
| `DELETE` 被合并方 | 库里 `trg_candidate_no_delete` 直接 `DELETE_FORBIDDEN`（`N20`）；即使能删也破坏 `INV-2` | `SCHEMA §8 INV-2` |
| `UPDATE candidate_merge` 改 `match_basis` 说"其实没合并" | 整行不可 UPDATE（`0001 L1783`） | 同上 |
| 直接把 B 的 `identity_status` 改回 `ACTIVE` 就算拆完 | `fn_candidate_identity_guard` 之所以放行，是因为**存在**一条 merge 记录——它只证明"这条状态变更有出处"，不证明"有拆分决定"（§12-④） | `0001 L172-183` |

---

## 8. 冲突处理 · IR-C

| # | 冲突 | 结论 | 依据 |
|---|---|---|---|
| IR-C1 | **同一手机号 + 两个不同姓名** | `REVIEW(MERGE_CONFLICT_ID_NAME)`；**禁止自动**；不得新建第二条同手机号 ACTIVE（`uq_candidate_active_phone` 会 `23505`，服务层必须把该错误翻译成本结论，而不是把 500 抛给用户） | `docs03 §6.2`、`doc11 §9.7`、`0001 L757` |
| IR-C2 | **同一邮箱 + 两个不同姓名** | 同上（`MERGE_CONFLICT_ID_NAME`） | 同上 |
| IR-C3 | 确为同一人的多个姓名（英文名/曾用名/婚姓） | **允许人工合并**，姓名差异写入 `aliases`；仅凭姓名相似**不得**触发 | `docs03 §6.4`、`IR-F1` |
| IR-C4 | **同姓名 + 不同强标识** | **不合并**。若同时 `WEAK_EQ`（公司或学校也一致）→ `REVIEW(WEAK_MATCH)`；否则 `CREATE_CANDIDATE` 且不打扰人 | `docs03 §6.2`、`FR-C3` |
| IR-C5 | **共享邮箱**（`jobs@`/`hr@`/配置清单命中） | 该 email 降级为弱标识，**不得**作强命中；`REVIEW(SHARED_MAILBOX)`。否则所有投到同一邮箱的人会被并成一个 | 本文；`docs03 §6.1`（强标识须"可靠"） |
| IR-C6 | 电话只差国际区号/分隔符 | 归一化后相等 → 同一（`IR-N2`），不是冲突 | `IR-N2` |
| IR-C7 | **跨租户** | `REJECT_CROSS_TENANT`：永不合并、永不提示、对外 `NOT_FOUND`（不确认对方存在） | `SCHEMA §1`、`docs03 §16.7`、§12-⑫ |
| IR-C8 | 同一个人在两家公司在职（经历冲突） | **不是身份冲突**。经历冲突按 `doc11 §9.8` 多版本冲突处理，不得当作"不是同一个人"的证据 | `doc11 §9.8` |
| IR-C9 | 姓名 `unreadable`（有但读不出） | `REVIEW(NAME_UNVERIFIED)`；**不得**当 `absent`，也**不得**用"姓名缺失"来放宽自动条件 | `doc11 §9.2`、`D-20` 同构 |
| IR-C10 | 同一强标识在本租户命中 0 条、在别的租户命中 1 条 | 对本租户而言就是「无命中」→ `CREATE_CANDIDATE`；**不得**跨租户去"借用"档案 | `IR-C7` |

---

## 9. 禁止事项 · IR-F（每条都给"怎么查出来"）

| # | 禁止 | 依据 | 违反的可检出信号 |
|---|---|---|---|
| IR-F1 | 用**姓名拼音/首字母/编辑距离/相似度/embedding**参与自动合并或作为合并理由 | `docs03 §6.2`、`FR-C3`、`doc11 §9.11 #10` | `match_basis.weak_ids` 里出现 `name_pinyin`/`name_similarity`；或 `strong_ids=[]` 却 `auto_merged=true` |
| IR-F2 | **跨租户**比较、建议或合并 | `SCHEMA §1`、`docs03 §16.7`、`APP-08` | 任一 `match_basis` 的候选集含不同 `tenant_id`；建议接口返回别租户候选 |
| IR-F3 | 因「看起来像」（同公司同校同城同职位）合并 | `docs03 §6.2` | `rule` 不在 §6.6 允许集合内 |
| IR-F4 | 用 `ocr_title`/`agent_read`/`unknown` 来源的标识自动合并 | `doc11 §9.7`、`doc11 §9.11 #10`、`IR-G2/G3` | `match_basis.provenance` 出现非 `native_text/human_confirmed` 而 `auto_merged=true` |
| IR-F5 | 用姓名/完整度/活跃度**选主档方向** | 本文 `IR-M1` | `direction_rule` 不在枚举内（可选 `HUMAN_CHOICE`，但必须有 actor） |
| IR-F6 | 改写/迁移/**删除** 历史 Application（含改 `candidate_id`） | `SCHEMA §8 INV-2`、`docs03 §6.5` | 合并前后 `application` 行数与内容不变（`verify.sql POS-05` 已断言条数） |
| IR-F7 | 用反向 merge 或 DELETE 冒充 split | `docs03 §6.6`、§7.5 | `candidate_merge` 里出现 `rule=COMPENSATING_SPLIT` 的**正向合并**记录 |
| IR-F8 | 把模型算的相似度分数写进 `confidence` | `docs03 §6.2`、`APP-07` | `confidence` 出现非枚举 `band` 的数值字段 |
| IR-F9 | 证据缺失时"补全"标识（编造手机号/邮箱/姓名） | `doc11 §5 红线 2`、`§9.11 #7` | attempt 里 `norm` 有值而 `raw`/`evidence` 为空 |
| IR-F10 | 把归一化结果**回写**原文或证据 `raw` | `doc11 §2 A3` | `raw ≠ 原件对应块文本` |
| IR-F11 | 对 `MERGED` 档写入新 Application / Resume / Decision | 本文 `IR-M3` | `application.candidate_id` 指向 `identity_status='MERGED'`（写盘前必须 `resolve()`） |
| IR-F12 | 无 `match_basis`、无 attempt 的静默合并 | `doc11 §9.7`、`SCHEMA §8 INV-2` | `ck_candidate_merge_basis` 已拦空对象（`N25`）；attempt 缺失要靠审计发现 |
| IR-F13 | 用"取第一条命中"消解歧义证据 | D-110（`IR-G8`） | 证据 `locator_kind` 为 `text_line_offset`/缺省，而 `verification_method` 声称通过；或实现里出现 `find(...)[0]` 式 quote 取首条 |

---

## 10. 与 `db/SCHEMA.md` 字段对照（逐字段）

### 10.1 `candidate`（`0001 L725-758`）

| 列 | 本文怎么用 | 够不够 |
|---|---|---|
| `display_name` | 比较键之一（`norm_name`），永不单独决定合并 | ✅ |
| `normalized_email` / `normalized_phone` | 强标识比较键；受 `ck_*_normalized` 格式约束 | ✅（但**无 provenance/证据列** → §13 G-2） |
| `identity_status` | `ACTIVE` / `MERGED` 两态（§13 G-1：**不允许**第三个值） | ⚠️ |
| `merged_into_candidate_id` | 读路径指针；**可为链**（A→B→C），§12-② | ✅ |
| `merge_id` | 回指触发本次合并的记录 | ✅ |
| `record_version` | 乐观并发（`IR-M4a`） | ✅ |
| `uq_candidate_active_email/phone`（部分唯一，仅 `ACTIVE`） | 结构上禁止两条 ACTIVE 同强标识；把 `23505` 翻译成 `REVIEW` | ✅ 关键 |
| `trg_candidate_identity_guard` | 身份状态变更必须"有 merge 记录"——**只证明有出处，不证明拆分有决定**（§12-④） | ⚠️ |

### 10.2 `candidate_merge`（`0001 L760-785`）

| 列 / 约束 | 本文要求 | 够不够 |
|---|---|---|
| `surviving_candidate_id` / `merged_candidate_id` | `IR-M1` 全序决定；必须不同（`ck_candidate_merge_distinct`） | ✅ |
| `match_basis`（jsonb，非空对象） | §6.6 全部键；承载依据/置信度/别名/字段处理/snapshot | ✅（**唯一可用的 jsonb 载体**） |
| `auto_merged` | 与 `decided_via` 必须一致；`true` 仅当 `IR-G1` 全过 | ✅ |
| `decided_by_actor_id` | 库允许 auto 时为空（`ck_candidate_merge_actor`）；**契约要求永不为空**（auto 填 SYSTEM actor） | ⚠️ 契约严于库 |
| `decided_at` | 决策时刻；不等于业务发生时间（`docs03 §19`） | ✅ |
| `notes` | 只放自由说明，**不得**承载结构化依据 | ✅ |
| `uq_candidate_merge_pair` | 禁止同 pair 二次合并（`IR-M4b`） | ✅ |
| `trg_candidate_merge_immutable` | 整行不可 UPDATE → 写错只能补偿 | ✅ |
| `fk_candidate_merge`（`candidate.merge_id`） | 双向可回指 | ✅ |
| **缺失** | 拆分记录、`superseded_by`、`source_snapshot` 独立列 | ❌ §13 G-3 / G-6 |

### 10.3 契约严于库的 3 处（必须显式知道，别指望数据库拦）

| # | 库允许 | 契约要求 | 理由 |
|---|---|---|---|
| S-1 | `auto_merged=true` 时 `decided_by_actor_id` 可空 | **必须**是 `SYSTEM` actor | 否则"谁触发"永久丢失（`D-18` 精神） |
| S-2 | `candidate` 的 `merged_into/merge_id` 在 `ACTIVE` 行上可为非空（CHECK 只约束 `MERGED`） | `ACTIVE` 行这两列**必须为空** | 半合并状态会让 `resolve()` 结果不确定（§12-②） |
| S-3 | `application.candidate_id` 可 UPDATE 到任意同租户档案 | **禁止**改到另一档案 | `IR-F6`、`INV-2` |

---

## 11. 10 个判定用例（输入 → 期望结论 → 理由）

记号：`(tenant, 来料字段集, 既有档 E, 来料的归属档 owner)`。`NT` = `native_text` + 格式通过 + 证据齐全；`(可考)` = 该值 `ESTABLISHED`（能回指到某份 `native_text` 简历版本）。**除注明外，全部用例假设 `policy=AUTO_HIGH_CONFIDENCE`**（`MANUAL_ONLY` 时任何 `AUTO_MERGE` 都退化为 `REVIEW(POLICY_MANUAL_ONLY)`，见 D14）。

> **先立一个结构性前提**：`uq_candidate_active_email/phone` 让「两条 `ACTIVE` 同时持有同一手机号」**插不进库**（L1）。所以"同手机号"的真实形态只有两种：**① 一条持有、另一条同字段为空，来料把后者证明成前者的重复档**（D15）；**② 来料自己带两个强标识，各命中一条旧档**（D5 交叉印证）。下表 E1/E2/E9/E10 用 ①，E1 另注 ②。

| # | 输入（关键差异） | 期望结论 | 身份迁移 | 理由 / 依据 |
|---|---|---|---|---|
| **E1** | T1；A 持 `+8613800001234`(可考)、名 `张三`；B **无手机号**、名 `张三`（由一份没写联系方式的材料建档）；来料属 **B**，带 `138 0000 1234`(NT) + `张三`(NT) | **`AUTO_MERGE`**（B 并入 A；方向按 `IR-M1` 全序；`strong_ids=["phone"]`,`band=HIGH`,`rule=HIGH_CONFIDENCE_MULTI_DIM`） | B: `ACTIVE→MERGED` | 命中强标识 `AUTO_OK` ∧ A 侧 `ESTABLISHED` ∧ 姓名归一后相等 ∧ 无阻断 → D8→D15 全过。`doc11 §9.7`、`D-7`、`FR-C7`。**注**：若来料同时带 A 缺的另一个强标识（A 无邮箱、来料邮箱命中另一档 C），则走 **D5 交叉印证**，同为自动 |
| **E2** | T1；A 持 `+8613800001234`(可考)、名 `张三`；B 无手机号、名 `张珊`；来料属 B，带 `13800001234`(NT) + `张珊`(NT) | **`REVIEW(MERGE_CONFLICT_ID_NAME)`**；不写 `candidate_merge`；B 保持 `ACTIVE`；**不得**为"同号"再插一条 ACTIVE（会 `23505`） | 无 | 同强标识 + 姓名冲突 = 真歧义，必须人工（D12 先于 D15）。`doc11 §9.7`、`docs03 §6.2`、`IR-C1` |
| **E3** | T1；`{phone:"13900001111"(NT), name:"李四"(NT)}`；既有 A(`+8613800002222`,`李四`,ACTIVE)；`company/school` 均 `absent`；来料无归属档 | **不合并** → `CREATE_CANDIDATE`，**且不产生 review** | 新材料建新档 `ACTIVE`（无迁移） | 强标识不同 ⇒ `HIT=∅`；弱标识只有姓名 ⇒ `WEAK_EQ=false` ⇒ 不打扰人（`§5.4 D2`、`IR-C4`）。若公司**或**学校也一致 → 改判 `REVIEW(WEAK_MATCH)`，**仍不合并** |
| **E4** | T1；`{name:"王五"(NT)}`，无 email/phone；既有 A(`王五`,ACTIVE) | **不合并** → `CREATE_CANDIDATE` | 新材料建新档 | 只有姓名 = 典型同名不同人。`docs03 §6.2`「姓名只产生 Duplicate Review，不允许 LLM 独立决定合并」；本用例无其他一致弱标识，故连 review 都不产生 |
| **E5** | T1；A 持 `+8613800001234`(可考)、名 `张三`；B 无手机号、名 `张三`；来料属 B，phone `13800001234` 来自 **`ocr_title`**，name `NT` | **`REVIEW(PROVENANCE_NOT_AUTOMATABLE)`**；**即使值完全一致、即使 A 侧可考，也不自动** | 无 | D8 先于 D9/D15。`doc11 §9.7`（OCR/Agent 身份字段只能进人工）、`doc11 §9.11 #10`（红线）；`IR-G2` |
| **E6** | T1；同一人第二次投另一个岗位，来料 `{phone,email,name}` 全 `NT` 且与 A 一致；**A 是唯一档案**，来料无归属档 | **`LINK_EXISTING`**：建第 2 条 `Application`（不同 `job`），不写 merge、不拆、不改 `identity_status` | 无（保持 `ACTIVE`） | `FR-C1`「一人多岗 = 1 Candidate + N Application」；`FR-P1`；`§5.4 D9`。**这正是"把关联当合并"的高发点**（§12-①） |
| **E7** | 已存在合并记录 R0(A←B)，`pre_merge_snapshot` 完整；现在要撤销 | **`SPLIT`（补偿式）**：目标语义为 B 回 `ACTIVE`、A 保留原标识、写引用 R0 的拆分审计、两条 Application 不动。**当前 `0001` 无拆分载体 → 必须 `409 SPLIT_REQUIRES_SCHEMA`**，禁止反向 merge / DELETE 冒充 | B: `MERGED→ACTIVE`（**待 G-3 落地后**才允许） | `docs03 §6.6`、`FR-C6`、`IR-X1..X6`；`WINDOW-B:50` 已把"merge→split 身份不可逆"列为 P0 |
| **E8** | T2 的来料与 T1 的 A 手机号、姓名完全相同 | **`REJECT_CROSS_TENANT`**：永不合并；对 T2 而言就是「无命中」→ `CREATE_CANDIDATE`；**对外不确认 T1 存在**（`NOT_FOUND`，不是「无权访问」） | 无（T1 档案完全不被触碰） | `SCHEMA §1` 复合外键（跨租户引用 `23503`）、`docs03 §16.7`、`APP-08`；建议接口不按租户过滤就是 PII oracle（`WINDOW-B:55`）；`IR-C7` |
| **E9** | T1；A 存 `zhang.san@example.com`(可考)、名 `张三`；B **无邮箱**、名 `张三`；来料属 B，email `Zhang.San@Example.COM`(NT) | **`AUTO_MERGE`**：`norm_email` 后相等 | 一条 `ACTIVE→MERGED` | `IR-N1`③（`toLowerCase`）。库侧 `ck_candidate_email_normalized` 已强制**存**小写，**所以大小写差异只可能出现在来料一侧**；**不做**点号/`+tag` 折叠（§12-⑩） |
| **E10** | T1；A 存 `+8613800001234`(可考)、名 `张三`；B 无手机号；来料属 B，phone `+86 138-0000-1234`(NT) | **`AUTO_MERGE`**：`norm_phone` 后同为 `+8613800001234` | 一条 `ACTIVE→MERGED` | `IR-N2`②③④。**注意**：库里 `13800001234` 与 `+8613800001234` 都能存（`ck_candidate_phone_normalized` 只校验字符集与长度，`0001 L747`），唯一索引**不会**报冲突 → 规范形必须由写入端强制（L2、§12-⑭） |

**覆盖检查**：自动合并(E1/E9/E10，含 E1 注的交叉印证 D5) · 冲突人工(E2) · 强标识不同(E3) · 弱标识不足(E4) · 来源闸门(E5) · 关联≠合并(E6) · 拆分(E7) · 跨租户(E8) —— 任务要求的 10 项全覆盖。

---

## 12. 实现者最容易搞错的 14 个点（①–⑤ 是必须裁决的，已裁决；⑬⑭ 是结构性陷阱）

| # | 容易写成 | 为什么错 | 裁决 |
|---|---|---|---|
| **①** | 「新材料命中已有档案 → 合并」 | 每次重复投递都写一条 merge，制造假历史，且 `uq_candidate_merge_pair` 第二次就 23505 | **关联 ≠ 合并**。`owner_candidate` 为空或等于命中档 → `LINK_EXISTING`（`IR §5.4 D9`） |
| **②** | `resolve()` 只看一跳 `merged_into` | 链是合法的：先 merge A→B，再 merge B→C，A 必须解析到 C。只看一跳会让 A 的读路径停在 MERGED 档上 | **传递解析 + 环检测 + 深度上限 8**；`MERGED` 指针缺失/自指/成环 → `500 IDENTITY_CHAIN_BROKEN`（不得静默返回自身） |
| **③** | 拆分时先激活 B 再释放 A 的标识 | `uq_candidate_active_phone/email` 只覆盖 `ACTIVE`，两步之间两条 ACTIVE 同号 → `23505`，且此时事务已半提交语义 | **先释放后激活**（`IR-X` 7.3），同一事务 |
| **④** | 认为 `fn_candidate_identity_guard` 已经保证"拆分有审计" | 该触发器只检查"存在一条 `merged_candidate_id=本行` 的 merge 记录"（`0001 L176-178`）。拆分时那条记录**本来就在**，所以改回 `ACTIVE` 会被放行，**不产生任何新审计** | 拆分必须有独立审计载体（G-3）；否则 `SPLIT_REQUIRES_SCHEMA`。**不能靠触发器证明合规** |
| **⑤** | 把 `AGENT_WORKER` 当自动合并的执行者 | `execution_mandate` 的 CHECK 明令禁止 `merge_candidate`（`0001 L1648`）；即使绕过 mandate，`ck_candidate_merge_actor` 也只要求"有人" | 自动合并 = 确定性规则 + `SYSTEM` actor；模型只出建议（`IR-M5`） |
| ⑥ | 同邮箱不同姓名自动合并（"邮箱是唯一的"） | 家庭共用邮箱、代投、HR 录错、猎头用自己邮箱转发都会命中 | 一律 `REVIEW`（`IR-C2`）；共享邮箱清单兜住 `jobs@` 类（`IR-C5`） |
| ⑦ | 合并后统计/列表直接 `count(application)` | 同一人的申请散在等价类里，既可能重复计也可能漏计 | 一律按 `resolve()` 归并去重（`IR-M3`） |
| ⑧ | 合并重试当成新请求 | `uq_candidate_merge_pair` 会 23505，把重试变成 500 | 走 `command_id` 幂等：同键返回既有结果，异键 `409 MERGE_PAIR_ALREADY_DECIDED`（`IR-M4b`） |
| ⑨ | 用归一化后的值覆盖 `display_name` / `raw` | 抹掉原件写法，`doc11 §2 A3` 红线，也让 `§9.9` 的"当时看到哪一行"失效 | 归一化只进比较键（`IR-N`、`IR-G7`） |
| ⑩ | 邮箱做 Gmail 点号折叠 / `+tag` 折叠后自动合并 | 折叠规则是**服务商特定语义**；`+tag` 在不同域上意味着不同人（代投/别名），且折叠把"两个人"变成一个 | **禁止折叠**（`IR-N1`）。要支持就得先有 `business_config` 白名单域，属 0002 |
| ⑪ | 把 `region_ambiguous` 的裸固话当强标识 | 8 位号码跨城重复常见，自动合并会把两个城市的两个人并成一个 | 降为弱（`IR-N4`），只能产生 review |
| ⑫ | 跨租户命中时返回「无权访问」 | 这仍然**确认了对方存在**（PII oracle） | 一律 `NOT_FOUND`，且比较阶段就不跨租户（`IR-C7`、`IR-F2`） |
| **⑬** | 「先插两条 ACTIVE 同号档案，再测自动合并」 | **插不进去**：`uq_candidate_active_phone/email` 会 `23505`（L1）。据此写出的测试要么永远跑不到合并分支，要么被改成"关掉唯一索引再测"，把约束测没了 | 自动合并的真实触发形态只有两种：**交叉印证**（D5）与**单命中 + 旧档可考**（D15）。夹具必须按这两种造（E1/E9/E10） |
| **⑭** | 来料原样写进 `normalized_phone`（`+86 138-0000-1234`） | CHECK 只校验字符集与长度（`0001 L747`），三种写法都能存；唯一索引比较**存储值**，于是同一号码可挂两条 ACTIVE，唯一性失效，后续 `size(HIT)` 同字段双命中（L2-b） | **写入端必须先归一**（`IR-N5`）；`HIT_SAME_F` 出现即按数据质量缺陷处理（D4），不得靠合并掩盖 |

---

## 13. 库缺口（本文依赖、但 `0001` 里没有的东西）

> 全部 fail-closed：**缺口未补时对应动作返回明确错误码，不做"近似实现"**。

| # | 缺口 | 影响 | 需要的变更 | 临时口径（v1.0 可用） |
|---|---|---|---|---|
| **G-1** | `candidate.identity_status` CHECK 只允许 `ACTIVE/MERGED`（`0001 L740`）；**"待人工"无处可存** | 不能把 `PENDING_REVIEW` 写进该列 | 见 `merge-state-machine.md §2`：**不建议加**——部分唯一索引谓词是 `identity_status='ACTIVE'`（`0001 L755-758`），一旦存在第三个"非 MERGED"值，同强标识的两条档案可同时存在，唯一性立即失效 | 「待人工」记在 review item 上，档案保持 `ACTIVE`（`merge-state-machine.md §2.2` R1） |
| **G-2** | 强标识**没有来源列**：`candidate.normalized_email/phone` 不带 provenance / 证据 / 采集时间；`resume_version` 整行不可 UPDATE（`0001 L1778`）；`intake_record` 无 jsonb 载荷（`0001 L670-697`） | `IR-G1` 的闸门在"既有档案那一侧"无法当场证明 | 建议 0002 增 `candidate_identity_attempt`（每次解析一行，含字段级 provenance/evidence/decision） | 「既有档那一侧可考」暂用**回扫 `resume_version.parsed_fields` + `evidence`** 判定（`ESTABLISHED`）：能找回同一规范值且来源 `native_text` 才算可考；找回不到（HR 手录、迁移数据）⇒ `unknown` ⇒ 人工（`IR-G3`）。attempt 自身落 `event_inbox.payload`（`provider='internal'`）+ 合并时把 `attempt_id` 写进 `match_basis` |
| **G-3** | **没有拆分审计载体**：`candidate_merge` 整行不可 UPDATE（`0001 L1783`）、无 split 语义列；`candidate` 无 `status_changed_*` 列，`fn_row_guard` 也不管 `identity_status`（`verify.sql STRUCT-05` 只覆盖 `status/lifecycle_status/transcript_status`） | 拆分**无法留审计** → 直接违反 `docs03 §6.6` 与 `INV-2` 的可追溯要求 | 0002 增 `candidate_split`（不可变：`id, tenant_id, merge_id, restored_candidate_id, split_by_actor_id, split_at, reason, restored_fields jsonb, source_sha256`）+ 扩展 identity guard：`MERGED→ACTIVE` 必须存在一条引用它的 split 记录 | **拆分在 0002 之前一律 `409 SPLIT_REQUIRES_SCHEMA`**（`IR-X6`）。这就是 `WINDOW-B:50` 报的 P0，本文件把它写成显式阻塞而不是"以后再说" |
| **G-4** | 没有解析尝试表 | 自动合并的"依据哪些字段"只能挤在 `match_basis` 里；创建新档（`CREATE_CANDIDATE`）时**完全没有**地方记录尝试 | 同 G-2 的 0002 | attempt 落 `event_inbox.payload`，`correlation_id` = attempt_id；**来料侧的待人工**可入工作区已有的 `0003` `review_queue`（`QUEUED` + `machine_result`，`0003:217-264`，未合入），但那里 `run_id NOT NULL` 且一 run 一条，**装不下"两档是否合并"** |
| **G-5** | `platform_id` / `verified_profile` 无列 | `docs03 §6.1` 列的强标识有一半用不了 | 0002 或延后 | 明确声明 v1.0 **不支持**，不得用姓名"模拟"平台 ID |
| **G-6** | 同 pair 拆分后无法再合并（`uq_candidate_merge_pair` 永久占位） | 「拆错了又发现确实同一人」无路可走 | 0002 把该唯一约束改为"每个 pair 只允许一条**当前生效**裁决"，配 `superseded_by_merge_id` | **禁止翻转方向绕过**；返回 `409` 并转人工工单（`IR-X` 7.4） |

---

## 14. 依据索引

| 代号 | 位置 | 本文用它裁定了什么 |
|---|---|---|
| `doc11 §9.7` | `docs/11-pdf-acceptance-criteria.md:192-197` | 来源闸门（`IR-G1/G2`）、自动合并的依据记录 |
| `doc11 §9.2` | 同上 `:160-169` | 三态；`unreadable ≠ absent` |
| `doc11 §9.11 #10` | 同上 `:218` | OCR/Agent 身份字段触发自动合并 = 红线 |
| `doc11 §9.9` | 同上 `:205-207` | 证据必须回指 page+bbox+sha256（`EVID_OK`） |
| `doc11 §2 A3 / §5 红线 2` | 同上 `:48`、`:110` | 归一化不回写原文；不得编造标识 |
| `doc11 §9.8` | 同上 `:199-203` | 多版本冲突 ≠ 身份冲突（`IR-C8`） |
| `SCHEMA §8 INV-2` | `db/SCHEMA.md:173` | 合并不删历史 Application（`IR-M3`、`IR-F6`） |
| `SCHEMA §1 多租户` | 同上 `:19` | 复合外键物理禁止跨租户（`IR-C7`） |
| `SCHEMA §3 #35` + `0001 L1648` | 同上 `:81` | Agent 永不执行合并（`IR-M5`） |
| `SCHEMA §12 N20/N24/N25/N26` | 同上 `:256-262` | 删除/直改身份/无依据合并/重复 ACTIVE 的负向断言 |
| `docs/03 §6.1-6.7` | `docs/03-domain-and-runtime.md:118-128` | 强/弱标识分工、合并记录内容、补偿式 split、`expected_record_version` |
| `docs/03 §19` | 同上 | `decided_at` 不混用时间语义 |
| `D-7` | `AGENTS.md §6` | 高置信多维且无冲突可自动（= `§5.4 D5` 交叉印证 / `D15` 单命中） |
| `D-15` | `docs/17-decision-ledger.md` | `candidate_merge` 是支撑实体，不是第 37 个对象 |
| `D-18` | 同上 `:65` | `SET LOCAL` + 不缓存旧版本号（`IR-M4d/e`） |
| `D-19` | 同上 `:10` | 顺序类 HARD 不降级 → 顺序问题会污染字段证据，收紧 `HARD_CLEAN` |
| `D-20` | 同上 `:23` | 「推不出 ≠ 没有」的同构依据：`unknown` 一律人工（`IR-G3`、`IR-C9`） |
| `FR-C1..C8` / `FR-P1` | `docs/07-PRD.md:111-118`、`:124` | 一人多岗=1 档 N 申请；自动归并的边界 |
| `15-arch §5` | 老仓 `work/handoff/15-architecture-hv.md:141`（新仓未收录；阶段码口径已由 D-22 与 `db/stage_catalog` 取代，见 `contracts/STAGE-CODES.md`） | v1.0 = 强标识 + 人工闸门（对应 `MANUAL_ONLY` 策略） |
| `WINDOW-B:50/55` | `work/window-b/WINDOW-B-FINAL-REPORT.md` | merge→split 不可逆（G-3）、建议接口的 PII oracle（`IR-C7`） |

---

## 15. 需要拍板的口径（我不代决）

| # | 口径 | 我的建议 | 影响 |
|---|---|---|---|
| **P-1** | 「待人工」是否允许写进 `candidate.identity_status` | **不允许**（第三值会让部分唯一索引失效，G-1） | 决定是否要 0002 改 CHECK |
| **P-2** | 拆分在 v1.0 是否允许关闭（`SPLIT_REQUIRES_SCHEMA`） | **接受关闭**，但必须把错误码和工单流程写进 UI 文案，不能让 HR 以为"点了没反应" | `FR-C6` 的交付时点 |
| **P-3** | 自动合并要求 `decided_by_actor_id` 非空（严于库，S-1） | **要求**（否则"谁触发"永久丢失） | 需要 `actor.kind='SYSTEM'` 的系统 actor 先 seed（`D-14` 已要求补 seed） |
| **P-4** | 姓名冲突（同手机不同名）是否**永远**人工 | **永远人工**（`doc11 §9.7` + `docs03 §6.2` 都指向人工；自动合并只会把"曾用名"变成"两个人互相污染"） | 人工队列量 |
| **P-5** | 弱匹配（姓名+公司或学校全同）是否产生 review | **产生**（否则"同一人换手机号"永远发现不了） | 人工队列量，同 `D-19` 的运营成本问题，需产品确认可承受 |
| **P-6** | 是否接受 `identity_policy` 配置（`AUTO_HIGH_CONFIDENCE` / `MANUAL_ONLY`），v1.0 demo 默认哪个 | 建议 **v1.0 demo 用 `MANUAL_ONLY`**（对齐 `15-arch §5`），自动档在 S6 的身份解析验收后打开 | 决定 demo 演示的是哪条路径 |
