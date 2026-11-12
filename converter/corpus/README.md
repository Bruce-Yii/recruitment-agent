# 验收语料（原件不入库）

本目录只保存**语料的定义**，不保存 PDF 原件。

## 为什么原件不在仓库里

- 原件体积大（合成难例单个 25 MB 级）
- 原件是外部材料，不属于代码仓库

**语料的身份是 `sha256`，不是路径。** 换一台机器、换一个目录，只要文件内容相同，`sha256` 就能对上。

## manifest 字段

```json
{
  "id": "talent_pool-01",
  "source": "talent_pool",
  "root": "talent_pool",
  "rel": "2126.../assets/陈黄勇_产品经理_系统策划_编导_简历.pdf",
  "bytes": 1101936,
  "sha256": "92fa1454...",
  "pages": 1,
  "native_chars": 2475,
  "images": 1,
  "tags": ["text_rich"]
}
```

- `root`：语料根的逻辑名（不是机器路径）
- `rel`：该根目录内的相对路径
- `sha256`：**唯一稳定身份**；校验原件是否被替换，就比这个

## 怎么还原成实际路径

由运行者用环境变量声明各逻辑根，程序拼 `root + rel`：

| 逻辑根 | 环境变量 |
|---|---|
| `talent_pool` | `CORPUS_ROOT_TALENT_POOL` |
| `odoo_samples` | `CORPUS_ROOT_ODOO_SAMPLES` |
| `codex_converted` | `CORPUS_ROOT_CODEX_CONVERTED` |
| `synthetic` | `CORPUS_ROOT_SYNTHETIC` |

## 语料构成

| 文件 | 内容 |
|---|---|
| `manifest.jsonl` | **77 份真实 PDF**（30 真实简历 + 17 Odoo 公开 CV + 30 转换件） |
| `synthetic/synthetic-manifest.jsonl` | **7 份合成难例**：`image_only`×3、`encrypted`、`corrupted`、`platform_noise`、`zero_text` |
| `build_corpus.py` | 从真实根目录重建 manifest |
| `build_synthetic.py` | 重建合成难例（需原件，生成到 `synthetic/`） |
| `sanitize_manifest.py` | 把绝对路径改写成 `root + rel` |

## 铁律

- **不得把 PDF 原件提交进仓库**（`.gitignore` 已挡 `corpus/synthetic/*.pdf`）
- **不得在 manifest 里写机器绝对路径**（CI 会检查，出现即红）
- 语料只读：任何转换器实现**不得修改原件**
