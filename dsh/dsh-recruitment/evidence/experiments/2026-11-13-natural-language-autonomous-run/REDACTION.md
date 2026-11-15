# 红线清理说明（2026-11-15）

本目录原先包含 `transcript.txt` / `dialogue-only.txt`，经独立复核确认含真实会议/候选人内容，违反 R7。

- 两个文件已从当前 HEAD 与 git 历史中移除（历史已重写；原分支备份 `backup/pre-pii-rewrite-e4973991`）。
- 本目录保留的 `README.md` / `commands.txt` / `db-readback.txt` 仅作实验过程记录；如仍引用被移除文件，以“已删除（PII）”为准，不再复原。
- 新增 `.gitignore` 规则：实验 evidence 下的 `transcript.txt` / `dialogue-only.txt` 不再入库。
- 以后真实会议产物只允许保存 id、字节数、sha256、脱敏摘要。
