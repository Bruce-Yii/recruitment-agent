# `src/document/contracts` —— 统一文档内容契约（U0）

**这一份是唯一权威**。DOCX / 图片 / 未来任何读取器都从这里 import 类型与校验器，
**不要**再在别处声明一套同名的文档类型或校验器（`src/document/readers/types.ts`
里那份是本目录落地之前的临时副本，应当改为 re-export 这里的定义）。

## 三个模块

| 文件 | 作用 | 副作用 |
|---|---|---|
| `types.ts` | docs/19 §2.1 的 TS 落地 + 封闭枚举 + 封闭键集 | 无 |
| `validate.ts` | `validateDocumentContent()`：不抛异常、一次收集全部违反项 | 无（纯函数） |
| `map-converter.ts` | 现有 PDF converter 输出 → `DocumentContent` 的无损映射 + 映射审计 + issue 政策镜像 | 无（纯函数） |

本目录**不读文件、不起子进程、不联网**：任何运行时都可以安全 import。

## 消费姿势（U1/U2/U3）

```ts
import {
  validateDocumentContent,     // 任何 content 进下游前必须 valid === true
  mapConverterToDocumentContent,
  auditConverterMapping,
  type DocumentContent,
  type DocumentBlock,
} from '../contracts/index.ts'
```

1. **读**：读取器产出 `DocumentContent`（PDF 走 `mapConverterToDocumentContent`；DOCX / 图片直接构造）。
2. **验**：`validateDocumentContent(content)`；`valid === false` 时用 `formatViolations()` 报告，
   不要自己再写一套判断。
3. **报**：`completeness` 只有在没有未解除 HARD issue、且 `needs_visual === false` 时才能是 `complete`
   —— 校验器会机械拦截自相矛盾的声明。

## 四条不能妥协的约定

1. **不伪造定位**：PDF 用 `{kind:"pdf", page, bbox?}`；DOCX 用 `{kind:"docx", part, …}`；
   图片用 `{kind:"image", frame?, bbox?}`。**不要求** DOCX / 图片伪造 `page+bbox`。
   PDF 块没有页码时映射写 `page: 0`（哨兵，见 `types.ts`），校验器一定判非法。
2. **不伪装来源**：OCR / 模型读出的文字只能是 `ocr` / `agent_read`，不能标 `native_text`。
3. **失败要能表达**：读失败是**合法内容**（0 块 + HARD issue + `partial`），不是异常；
   但把它写成 `complete` 一定被判非法。
4. **未知一律保守**：未登记的 issue code 按 HARD 处理，动作落 `human_review`
   （与 `converter/src/issues.py` 同一口径，有测试逐 code 比对，漂移会红）。
