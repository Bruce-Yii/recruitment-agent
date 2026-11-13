# 模型能力实测（2026-11-13，Issue #1 期间）

**为什么要记**：视觉兜底（D-81）一直挂着一个"BLOCKED：模型不支持 image"，但那是**某个模型**不支持，
不是所有模型都不支持。这里把实测结果钉死，避免以后再猜。

| 模型 | 配置里声明 `input: [text, image]` | 实测 | 结论 |
|---|---|---|---|
| `opencode-go-openai-key2` / `beam-free` | 否 | `read_image` 被路由层拒：`model "beam-free" does not declare image input; switch to an image-capable model` | ❌ 不能看图 |
| `opencode-go-openai` / `iceman-contributor-free` | 否（曾误加，已撤） | 上游 400：`model "iceman-contributor-free" not supported for vision` | ❌ 不能看图 |
| **`opencode-go-openai` / `longcat-2.5-free`** | **是** | `recruitment_page_image → read_image` 真返回 image block（`image/png 1653x2339, 325169 bytes`）→ `recruitment_model_text_merge` 返回 `accepted=true blocks 0 -> 1` | ✅ **唯一可用** |

## 结论

1. **视觉兜底不是 BLOCKED，是要选对模型**：只有 `longcat-2.5-free` 声明并支持 image 输入。
   接点在 profile 的 `agent-default-model`，**不在插件代码里**（D-81：不另造模型客户端）。
2. **不要给不支持 vision 的模型硬加 `input: [text, image]`**：那会把"路由层干净拒绝"
   变成"上游 400"，更难排查。iceman 那次就是这样，已撤销。
3. 声明 `input` 与上游真实能力必须一致——**声明是必要条件，不是充分条件**。

## 复现

```powershell
# 1) profile 默认模型设为 longcat-2.5-free
#    D:\12412\dsh-home\profiles\rec-agent-test\cordis.patch.yml
#    - id: agent-default-model
#      config: { provider: opencode-go-openai, model: longcat-2.5-free }

# 2) 跑视觉链
dsh --profile rec-agent-test "调 recruitment_page_image path=<PDF> page=1；拿到 image_path 后调 read_image；再调 recruitment_model_text_merge 合并你读出的文本"
```

实测会话：`session-9f65c819-cdc4-4774-a0c6-7fda7097b940`（longcat 那条），
完整 `tool/call` + `tool/result` 原文见
`dsh/dsh-recruitment/evidence/model-fallback-2026-11-13.md`。
