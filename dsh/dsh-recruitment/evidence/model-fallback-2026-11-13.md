# 模型兜底接线（DSH 版）· 真实运行证据（2026-11-13）

**证据来源**：会话日志原文（不是模型转述），
`D:\12412\dsh-home\sessions\--D-12412-dsh~5DE5~4F5C~533A-projects-recruitment-agent--\<session>\session.v3.jsonl.zstd`，
用 `zstandard` 解压后按 `type=="tool/call"` / `"tool/result"` 抓取。

**结论**（按 D-81，不含"已打通"这种话）：

1. `recruitment_page_image` / `recruitment_model_text_merge` 两个工具都从真实 headless 运行时被调用过
   （`request/header.tools` 共 34 个工具，两个新工具都在里面）。
2. `read_image` 在 headless 里**可用**，但有一个硬前提：**当前路由的模型必须声明 image 输入**。
   `beam-free` 不声明 → 被 route gate 拒绝（原文见 §2）；`longcat-2.5-free` 声明
   `input: [text, image]` → 通过，工具结果里真的带回一个 1653×2339 的 image block（§3）。
3. `recruitment_model_text_merge` 在 agent 自己看图转写后返回 `accepted=true`，`blocks 0 -> 1`。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 入口 | `dsh --profile rec-agent-test "<task>"`（headless，单轮） |
| profile 配置 | `D:\12412\dsh-home\profiles\rec-agent-test\cordis.patch.yml`（本轮给 `allowed_roots` 加了一行临时目录） |
| 插件 | `@recruitment/dsh-recruitment`（`link:` 到本仓） |
| sandbox | `permission/preset=workspace-write`、`sandbox/mode=workspace-write`（两条会话都有这条记录） |
| 输入 PDF | 现场合成的 image-only PDF（`%TEMP%` 产物，**已删除、按设计不入库**；sha256 见下行） |
| PDF sha256 | `4aa2ce4fcedfb8d6a861be631b4907c8c500726b67c5c4748f014d452b6e8b38` |

---

## 2. Run A：`beam-free` —— read_image 被 route gate 拒绝（这是停止条件，不是我的推测）

会话 `session-b3eb1ae2-0a51-4450-a0a4-1a9e821a4f8c`，`request/header.config`：
`{"provider":"opencode-go-openai-key2","model":"beam-free","maxTokens":131072}`。

```json
{"type":"tool/result","seq":22,"time":1794508029703,"data":{"turn":1,"step":2,"message":{"source":{"kind":"tool","callId":"call-11cdf97c-7af9-42a9-9d44-5a704dc4d250"},"content":[{"type":"tool-result","toolCallId":"call-11cdf97c-7af9-42a9-9d44-5a704dc4d250","content":[{"type":"text","text":"Error: cannot read \"C:\\Users\\12412\\AppData\\Local\\Temp\\dsh-fallback-render-p7kn76m4\\page-0001@200dpi.png\" as an image: model \"beam-free\" does not declare image input; switch to an image-capable model to read images"}],"isError":true}],"role":"user","id":"14bfb025-684c-47cf-b167-2e7561d843bd"}},"sourceEventSeqs":[21],"surfaceOp":"append"}
```

报错位置：`dsh-tool-fs` 的 `assertImageCapableRoute()` —— 它要求 `resolveModelInfo(provider, model)`
的 `inputModalities` 显式包含 `"image"`。`beam-free` 在 profile 里没有 `input` 字段，pi-ai 的默认值是
`["text"]`（`DEFAULT_INPUT = ["text"]`），所以拒绝。

**没有**把这当成"read_image 不可用"就收工：这是一条**模型路由能力**问题，换一条声明了 image 的路由即可，
不需要（也不允许）回到"插件自己调模型"。

---

## 3. Run B：`longcat-2.5-free` —— 渲染 → 看图 → 合并，三段原文

overlay patch（一次性，不写进 profile；现场文件已删除、按设计不入库）：

```yaml
- id: agent-default-model
  config:
    provider: opencode-go-openai
    model: longcat-2.5-free
```

会话 `session-9f65c819-cdc4-4774-a0c6-7fda7097b940`，`request/header.config`：
`{"provider":"opencode-go-openai","model":"longcat-2.5-free","maxTokens":262144}`。

### 3.1 `recruitment_page_image`

```json
{"type":"tool/call","seq":16,"time":1794508167705,"data":{"turn":1,"step":1,"callId":"call_24ecd383773c49f79fcd34f0","name":"recruitment_page_image","arguments":"{\"path\":\"C:\\\\Users\\\\12412\\\\AppData\\\\Local\\\\Temp\\\\recruitment-r7-synthetic\\\\synthetic-resume-r7.pdf\",\"page\":1}"}}
```

```json
{"type":"tool/result","seq":17,"time":1794508168185,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call_24ecd383773c49f79fcd34f0"},"content":[{"type":"tool-result","toolCallId":"call_24ecd383773c49f79fcd34f0","content":[{"type":"text","text":"page image: C:\\Users\\12412\\AppData\\Local\\Temp\\dsh-fallback-render-alot6hpe\\page-0001@200dpi.png\npage=1 dpi=200 pixels=1653x2339 page_size_pt=595x842\nsource_sha256=4aa2ce4fcedfb8d6a861be631b4907c8c500726b67c5c4748f014d452b6e8b38\n\nnext: call read_image with file_path = image_path to read the page yourself."}],"isError":false}],"role":"user","id":"af585577-2e38-4ec3-8ab1-ee33c0040e8a"}},"sourceEventSeqs":[16],"surfaceOp":"append"}
```

`isError:false` 且渲染参数（dpi / 像素 / 页面尺寸 / 源 sha256）都在 —— 输出过了注册表的 schema 校验
（否则会是 `INVALID_TOOL_OUTPUT`）。

### 3.2 `read_image`（同一张图，真返回了 image block）

```json
{"type":"tool/call","seq":22,"time":1794508171841,"data":{"turn":1,"step":2,"callId":"call_ea04e950b2a04c5188d99920","name":"read_image","arguments":"{\"file_path\":\"C:\\\\Users\\\\12412\\\\AppData\\\\Local\\\\Temp\\\\dsh-fallback-render-alot6hpe\\\\page-0001@200dpi.png\"}"}}
```

```json
{"type":"tool/result","seq":23,"time":1794508171878,"data":{"turn":1,"step":2,"message":{"source":{"kind":"tool","callId":"call_ea04e950b2a04c5188d99920"},"content":[{"type":"tool-result","toolCallId":"call_ea04e950b2a04c5188d99920","content":[{"type":"text","text":"<path>C:\\Users\\12412\\AppData\\Local\\Temp\\dsh-fallback-render-alot6hpe\\page-0001@200dpi.png</path>\n<type>image</type>\n<content>\nimage/png image, 1653x2339 px, 325169 bytes\n</content>"},{"type":"image","attachment":{"attachmentId":"sha256:9b2066e895f17d7d833646da1e65aae4d16db168156559f97cc40800afb7c598","mediaType":"image/png","bytes":325169,"width":1653,"height":2339,"name":"page-0001@200dpi.png"}}],"isError":false}],"role":"user","id":"715c901c-87ec-4ee8-a683-5f353e957d80"},"meta":{"path":"C:\\Users\\12412\\AppData\\Local\\Temp\\dsh-fallback-render-alot6hpe\\page-0001@200dpi.png"}},"sourceEventSeqs":[22],"surfaceOp":"append"}
```

### 3.3 `recruitment_model_text_merge`（agent 自己读出来的 text 原样回传）

```json
{"type":"tool/call","seq":27,"time":1794508189693,"data":{"turn":1,"step":3,"callId":"call_a387da5aa1be4efba9ecfbd6","name":"recruitment_model_text_merge","arguments":"{\"path\":\"C:\\\\Users\\\\12412\\\\AppData\\\\Local\\\\Temp\\\\recruitment-r7-synthetic\\\\synthetic-resume-r7.pdf\",\"page\":1,\"text\":\"【合成样例 · 非真实简历】\\n示例 候选人甲\\n\\n求职意向：后端工程师（演示数据）\\n电话：138-0000-0000    邮箱：demo.candidate@example.invalid\\n城市：示例市    工作年限：5 年\\n\\n工作经历\\n2021. 07 – 2024. 06    示例科技有限公司    后端工程师\\n· 负责订单服务拆分，接口 P99 从 480ms 降到 120ms\\n· 主导对账任务从单体迁移到消息队列，日处理 200 万单\\n2019. 07 – 2021. 06    示例数据服务中心    开发工程师\\n· 维护报表导出服务，覆盖 12 个业务线\\n\\n教育背景\\n2015. 09 – 2019. 06    示例大学    计算机科学与技术    本科\\n\\n技能\\nPython / TypeScript / PostgreSQL / 消息队列 / 单元测试\\n\\n自我评价\\n习惯先写失败用例再改代码；对数据一致性有洁癖。\"}"}}
```

```json
{"type":"tool/result","seq":28,"time":1794508190351,"data":{"turn":1,"step":3,"message":{"source":{"kind":"tool","callId":"call_a387da5aa1be4efba9ecfbd6"},"content":[{"type":"tool-result","toolCallId":"call_a387da5aa1be4efba9ecfbd6","content":[{"type":"text","text":"accepted=true blocks 0 -> 1\na provenance=\"model_read\" block was appended; the body text and needs_visual are unchanged."}],"isError":false}],"role":"user","id":"26cda3ab-c134-4e9c-875f-45712fc3d5d7"}},"sourceEventSeqs":[27],"surfaceOp":"append"}
```

`blocks_before=0` 是因为这一页**没有文本层**：同一次会话里 `recruitment_resume_read` 返回
`blocks: 0 of 0`、`issues: unread_visual_page, pdf_no_text`、`needs_visual: true` —— 正是 D-81 要兜底的那种页。

**为什么这是"看图"而不是 OCR**：转写里出现了视觉小瑕疵（`2021. 07` / `2024. 06`、`–` 而不是 `-`），
而 Run A 里模型擅自跑的 RapidOCR 输出是另一种形态（`2021.07 - 2024.06`、全角斜杠）。两次读数不同，
Run B 的 text 与页面版式一致但夹带视觉伪影 —— 与"模型真的看了图"一致。

---

## 4. 合成 PDF 怎么造的（R7）

生成脚本：原件在 `%TEMP%`（**已删除、按设计不入库**），
同内容副本见 `evidence/model-fallback-synthetic-pdf-2026-11-13.py`（**PDF 本身不入库**）。

1. 用 PyMuPDF + `C:\Windows\Fonts\simhei.ttf` 把**自编**的中文简历样式文本画在 A4 页上（中间产物还有文本层）；
2. 该页在 300 dpi 栅格化成 JPEG（2480×3509）；
3. 把栅格整页嵌进一份新的 A4 PDF，得到**只有图、没有文本层**的 1 页 PDF；
4. 自检输出：`pages=1 text_layer_chars=0 embedded_px=(2480, 3509) bytes=328237`。

内容全部虚构：姓名"示例 候选人甲"、电话 `138-0000-0000`、邮箱 `demo.candidate@example.invalid`
（RFC 2606 的 `.invalid`）、公司/学校都是"示例…"，页面首行就写着"【合成样例 · 非真实简历】"。
**没有用** `platform_noise.pdf` / `image_only_*.pdf`（前者实测是真实简历）。

---

## 5. 仍然没做到 / 已知边界

1. **`beam-free` 不能用 read_image**。要跑看图链路，模型路由必须声明 image 输入
   （本 profile 里只有 `longcat-2.5-free` 声明了）。这是 profile 配置问题，不是插件问题。
2. **合并产物不落盘**：`recruitment_model_text_merge` 每次调用都重新读一遍 PDF，返回的是投影，
   没有持久化的 merged result。所以同一页调两次都会 `accepted=true`，没有幂等（工具描述里已写明）。
3. **临时 PNG 不清理**：agent 要读它，只能留；每次调用留一个 `%TEMP%\dsh-fallback-render-*` 目录。
4. **读图链路依赖 DSH 的 route gate**：模型一旦换成纯文本路由，read_image 立刻不可用。
5. 本轮证据只覆盖 **确定性校验 + 合并**，没有覆盖"拒绝后人工复核"的后续流程（属 S7/DB 侧）。
