# 实验记录规范（所有实验一律照此）

**为什么有这份规范**：本项目已经吃过"只有结论、没有过程"的亏——
事后无法判断一条结论是跑出来的、猜出来的、还是子代理说的。
**每个实验必须留下可以独立复核的完整材料，不是摘要。**

---

## 目录结构（固定）

```
dsh/dsh-recruitment/evidence/experiments/<YYYY-MM-DD>-<kebab-名字>/
  README.md         ← 这个实验是什么、怎么跑、结果是什么、暴露了什么
  transcript.txt    ← 完整会话：USER / REASONING / TOOL-CALL（含完整参数）/ TOOL-RESULT（含完整返回）
  dialogue-only.txt ← 只有 USER + 完整 REASONING + 完整 ASSISTANT（去掉工具返回，便于人读）
  commands.txt      ← 复现命令原文（含 profile、env、路径）
  db-readback.txt   ← 数据库读回原文（有写库时必须有）
```

## 硬要求

1. **transcript 必须完整**：不许节选、不许摘要、不许"..."。
   一个实验的 transcript 少说几千行，这是正常的——审计要的就是原始材料。
2. **命令必须是可复制的原文**，不是"我跑了 xxx"。
3. **有写库就必须有 db-readback**：`psql` 原文输出，敏感字段可打码，但不许只写结论。
4. **暴露的问题必须写进 README**，包括"我一开始判断错了什么"。
   只写成功不写错误的实验记录，等于没有记录。
5. **不许把 summary 当 transcript**。summary 可以写，但必须同时附完整 transcript。

## 怎么生成 transcript

会话日志在 `$DSH_HOME/sessions/--<cwd 转义>--/<session-id>/session.v3.jsonl.zstd`（zstd 压缩）。
用 Python + `zstandard` 解压，按事件类型摊平：

```python
# 事件类型 → transcript 段落
# user/message      → ### USER
# assistant/message → ### REASONING / ### ASSISTANT / ### TOOL-CALL <name>
# tool/result       → ### TOOL-RESULT <error-code>
```

生成脚本参考：本仓库 `work/` 下的临时脚本（不入库），或直接照上面的事件映射自己写。
