# 语料隔离区（corpus-quarantine）

这里放**从真实语料里移出来的文件**，不参与回归。移动必须记账，不得直接删除。

## 规则

1. 只有「**不可能承载内容**」的文件才允许移入本区（0 字节 / 只有空白 / 明显是占位符）。
   **读不出来不等于坏文件**——reader 缺陷、超时、格式不支持都不许往这里丢。
2. 每次移动必须在本文件追加一条记录：原路径、大小、sha256、判定依据、移动日期。
3. 移入本区后，回归门槛跑法必须重新跑一次全量，确认 R-1 的分母变化是**唯一的**变化。
4. 本目录文件**不入库**（`.gitignore`），本 README 入库。

## 记录

### 2026-11-14 · 排版经历.pdf

| 项 | 值 |
|---|---|
| 原路径 | `resume-talent-pool/.snap-cache/research/content/xllee226-create__My-works/ca69e3a3d8299cad2ed38becdaa01d581d3ff6b7/社团经历/排版经历.pdf` |
| 大小 | 2 字节 |
| 内容 | 仅 `0d 0a`（CRLF），无任何文件魔数 |
| sha256 | `7EB70257593DA06F682A3DDDA54A9D260D4FC514F645237F5CA74B08F8DA61A6` |
| 判定依据 | JPEG 需 3 字节、PDF 需 `%PDF-`、PNG 需 8 字节签名；2 字节装不下任何受支持格式，**是空占位文件，不是损坏文档** |
| 处理 | 移入本区，语料从 52 份变 51 份 |
| 记账人 | 总控 |

**判定为什么不改 reader**：`EMPTY_FILE` 这个错误码本身是对的——它准确回答了"为什么读不出来"。问题在语料侧：一份 2 字节的占位文件不该出现在"真实简历"里。改语料，不改判定逻辑。

### 2026-11-15 · 从真实语料派生的 synthetic 目录 PDF（6 份）+ zero_text（1 份）

**判定**：`converter/corpus/build_synthetic.py` 旧实现从真实语料 manifest 取 `text_rich` 原件，派生
`image_only_* / encrypted / corrupted / platform_noise`——目录标 `synthetic`，内容却是**真实候选人材料**
（`corrupted.pdf` 的 OCR 已读出姓名/手机/邮箱）。这违反 R7 与 `docs/21 §8`「目录名叫合成 ≠ 数据是合成的」。
本区只做隔离，不删除；同时重写 `build_synthetic.py` 为**纯自生成假简历**，回归不再依赖真实材料。

| 文件 | 字节 | sha256 | 判定依据 |
|---|---:|---|---|| `corrupted.pdf` | 367312 | `86EE00DD415FF977C23B9DA4DFC9AC7955FFA634737E2FA18D2CC211FF978282` | 旧 build_synthetic 从真实语料派生；移出回归 |
| `encrypted.pdf` | 1089908 | `7755B946BA8E4351CC5C24A1B86745B6A7453893EC07CA71986F807DD0424F76` | 旧 build_synthetic 从真实语料派生；移出回归 |
| `image_only_1.pdf` | 26095654 | `D33176D0B22C0889D5C7BEDB8F23A3E4A1B05A6A23BB5AD336A6C3FAF59604FD` | 旧 build_synthetic 从真实语料派生；移出回归 |
| `image_only_2.pdf` | 26095654 | `9D8CEA119989C762E384418872FF359E2F6AF23FFABD610CB29E03CD9FD329E8` | 旧 build_synthetic 从真实语料派生；移出回归 |
| `image_only_3.pdf` | 5487947 | `0113658D1EFADEE0D215B386360EBED2EF4339EAE923EB71A41F35D2A645864A` | 旧 build_synthetic 从真实语料派生；移出回归 |
| `platform_noise.pdf` | 256228 | `C6CEB2EEF64DFC3FAC4061A06A54F6576DC85659731387F036F2506B7D640893` | 旧 build_synthetic 从真实语料派生；移出回归 |
| `zero_text.pdf` | 518 | `C0F69688976A2ADD4EAA69BB33B5D01BE3365B04E0EE66DD883980E7D190A715` | 旧 build_synthetic 从真实语料派生；移出回归 |

