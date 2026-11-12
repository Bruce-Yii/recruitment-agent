# dsh-pdf-fix — 对 `@zhtx2026/dsh-pdf` 的两行修复

**来源**：`@zhtx2026/dsh-pdf@0.1.1`（npm，原作者 zhtx2024），本地分叉。
**原则**：不重写，只改一处；其余文件保持上游原样。

---

## 1. 上游的问题（实测，不是推测）

上游 `lib/pdf-core.js` 的 `extractText()`：

```js
const pdf = parsePdfObjects(buf);                       // 自研页树解析器，无条件先跑
const fonts = scanFonts(pdf);
const embeddedAll = fonts.length > 0 && fonts.every(f => f.embedded);
return embeddedAll
  ? await extractTextPdfjs(buf, page, withPosition)     // 字体全内嵌 -> pdfjs
  : extractTextOwn(buf, page, withPosition);            // 否则 -> 另一个自研解析器
```

两个后果：

1. `parsePdfObjects` 在真实 PDF 上直接抛错 —— `no pages found (unsupported page tree)`，以及一处 `RangeError: Maximum call stack size exceeded`。
2. 字体非全内嵌时走 `extractTextOwn`，没有 ToUnicode 处理，返回 **0 字符**。

## 2. 修复

```js
// [FORK 2026-11-12] 原实现先跑自研 parsePdfObjects（在真实简历上 6/10 崩溃），
// 再按"字体是否全内嵌"决定用哪个引擎（非内嵌时走自研解析器 -> 0 字符）。
// pdfjs 路径本身可处理非内嵌字体（有 ToUnicode 时），因此统一走 pdfjs。
return await extractTextPdfjs(buf, page, withPosition);
```

只改 `extractText` 的引擎选择。**`pdfInfo` / `renderPage` / 自研解析器代码全部保留未动**（其他调用方行为不变）。

## 3. 实测（10 份真实简历 PDF）

样本：`resume-talent-pool` 真实简历 6 份（中/英，1–11 页）+ Odoo `applicant_cvs` 公开样本 4 份。

| 引擎 | 有效抽取 | 总字符 | 错误 |
|---|---|---|---|
| PyMuPDF 1.28.0 | 10 / 10 | 39,702 | 0 |
| `dsh-pdf` 上游原版 | **2 / 10** | 9,294 | 6 次崩溃 + 2 次 0 字符 |
| **`dsh-pdf` 本修复** | **10 / 10** | **48,123** | **0** |

改后平均耗时 **86 ms/份**。

逐份对照（字符数）：

| 文件 | 页 | PyMuPDF | 原版 | 改后 |
|---|---|---|---|---|
| 陈黄勇_产品经理_系统策划_编导_简历.pdf | 1 | 2,475 | 4,647 | 4,793 |
| 陈黄勇_游戏产品经理_系统策划_简历.pdf | 1 | 2,475 | 4,647 | 4,793 |
| resume.pdf | 1 | 1,810 | ERR | 2,026 |
| 个人简历-中国石油大学（华东）-孙光宇.pdf | 1 | 1,695 | ERR | 1,937 |
| 个人简历李江华（中文）.pdf | 11 | 6,853 | 0 | 7,873 |
| Byronlee's resume（English）.pdf | 11 | 16,226 | 0 | 16,950 |
| Cecile_Donth_CV.pdf | 1 | 2,227 | ERR | 2,684 |
| David_Armstrong_CV.pdf | 1 | 1,736 | ERR | 2,035 |
| David_Billy_CV.pdf | 1 | 2,431 | ERR | 2,933 |
| Enrique_Jones_CV.pdf | 1 | 1,774 | ERR | 2,099 |

## 4. 仍未覆盖

- **扫描件（纯图片页）依旧抽不出文字** —— 没有文本层，任何引擎都读不到；必须渲染成图再 OCR/视觉模型。
- `pdfInfo` 仍会调用自研 `parsePdfObjects`，在部分 PDF 上可能失败（本次未改，因为文本抽取是主线）。
- 未做 CJK 断行/双栏重排，输出是 pdfjs 的原始行序。

## 5. 安装

```powershell
# 先移除上游版本，避免同名冲突
& 'D:\12412\npm-global\dsh.ps1' plugin --profile <profile> remove '@zhtx2026/dsh-pdf'
# 以本地链接安装本修复
& 'D:\12412\npm-global\dsh.ps1' plugin --profile <profile> add link:'D:\12412\dsh工作区\projects\recruitment-os\dsh\dsh-pdf-fix'
```

依赖（`pdfjs-dist`、`@napi-rs/canvas`）由 profile 提供；若 profile 使用 `nodeLinker: hoisted`，
需在插件目录下建 junction 让 `PKG_ROOT/node_modules/pdfjs-dist` 可解析（上游是自包含假设）。
