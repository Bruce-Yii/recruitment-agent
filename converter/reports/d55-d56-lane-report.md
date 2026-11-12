# D-55 / D-56 lane report（转换器遗留缺陷）

范围：`converter/src/**`、`converter/tests/**`、`converter/reports/**`。
未改：`converter/verify/**`、`converter/fallback/**`、`converter/review/**`、`dsh/`、`db/`、`docs/`。未 commit / push。

## 1. D-55：同一 URL 在正文出现两次

### 1.1 修前复现（独立校验器 `converter/verify/cli.py`，两遍转换器）

`唐乐-简历.pdf`

```
V2_char_identity  ok=false
第1页字符不恒等：原件 2799 个非空白字符，输出 2825 个（缺 无；多 't'×4, 'h'×3, '/'×3, '.'×2, 'i'×2, 'a'×2, 'c'×1, 'u'×1, ...共 16 种）
failed: [V2_char_identity]  exit 1
```

`tangle-resume.pdf`

```
V2_char_identity  ok=false
第1页字符不恒等：原件 1836 个非空白字符，输出 1887 个（缺 无；多 't'×8, '6'×5, '/'×5, 'i'×4, 'h'×4, 's'×4, '.'×3, 'a'×3, ...共 20 种）
failed: [V2_char_identity]  exit 1
```

多出的正是 26 / 51 个字符，等于两条 URI 的长度。转换器输出里同一个 URI 出现两次：

```
唐乐      blocks=23  paragraph: ...在线访问：https://zhitu.kralai.tech/ ｜ ...
                      link     : [https://zhitu.kralai.tech/](<https://zhitu.kralai.tech/>)
tangle    blocks=44  paragraph: 职途 AI ... 项目展示：https://tl66666.github.io/ztai/static/showcase.html
                      link     : [https://tl66666.github.io/ztai/static/showcase.html](<...>)
```

（原始 JSON：`reports/_d55/tang-before.json` / `tangle-before.json`；
校验器判定：`reports/_d55/verifier-before-{tang,tangle}.json`；摘录：`d55-before-after.txt`。）

根因与 D-55 一致：URL 印在一整行中文里，`get_text("words")` 把整行当一个词，词中心点落在
link 注解矩形外 → `link_block()` 绑不上 → fallback 再生成 `[URL](<URL>)`。

### 1.2 改法（`converter/src/pdf_reader.py`，+17 行）

fallback 循环前先把本页原生 block 文本合成"可见文字"（空白无关，且把
`[label](<href>)` 还原成 label——href 不是印出来的字），URI 已在其中就不再生成 fallback 块。
基线只算本页原生 block，不含本循环刚生成的 fallback 记录（避免前缀 URI 依赖遍历顺序）。

```python
+        visible = re.sub(r"\s", "", _LINK_MD_RE.sub(
+            r"\1", "\n".join(b["text"] for b in page_blocks)))
         seen_fallback = set()
         for rect, uri in rects:
             if uri in used_uris or uri in seen_fallback:
                 continue
             seen_fallback.add(uri)
+            if re.sub(r"\s", "", uri) in visible:
+                continue
             label = ...
```

`_LINK_MD_RE` 与 `content.link_md()` 的写法一致（3 行，含注释）。

### 1.3 修后（同样两份，独立校验器）

```
唐乐-简历.pdf      passed=true   summary 8 passed / 0 failed / 0 skipped
  V2: 1/1 页字符恒等（链接 label 计入、href 不计；URL-as-label 豁免 0 条；声明剔除 0/0）
  V3: 输出 4 条 href 全部真实；原件 5 条真实 URI 未出现在输出中 1 条（A5 recall，仅告知）
tangle-resume.pdf  passed=true   summary 8 passed / 0 failed / 0 skipped
  V2: 1/1 页字符恒等
  V3: 输出 0 条 href；原件 1 条真实 URI 未出现在输出中 1 条（A5 recall，仅告知）
exit 0 / exit 0
```

（完整判定：`reports/_d55/verifier-after-{tang,tangle}.json`。）

### 1.4 全量

45 份（`corpus/batch2-picked.json`，与 L 线同一集合，每份跑两遍转换器）：

```
TOTAL 45  passed=45  failed=0  checks_skipped=0      exit 0
```

日志：`reports/_d55/45-sweep.log`；逐份：`45-sweep.jsonl`。

**额外 84 份**（`corpus/manifest.jsonl` 77 + synthetic 7，不是 L 线的 45 集合）：

```
TOTAL 84  passed=83  failed=1  checks_skipped=2      exit 1
FAIL talent_pool-28  V2: 原件 1531 → 输出 1542，多 11 字（'GitHub'×6 + '作品集网站'×5）
```

（`checks_skipped=2` 来自 `synthetic-encrypted` 的 V1/V2：原件加密、空密码解不开，
校验器按"基准不可得"记 skipped，不算通过；该份文件本身 passed。）

这 1 份是**修前就存在的同类缺陷，不是本次改动引入**：

- 新旧读取器对 84 份逐份跑转换器，输出逐字节比较：`TOTAL 84 identical=84 changed=0`；
- talent_pool-28 的两条 fallback 块 label 是页面已印的 `GitHub` / `作品集网站`（URI 本身没印），
  不满足 D-55 字面的"该 URI 的文本已出现"，所以本修法不触发、输出不变。
  它的触发原因是词里带坏字形（`�GitHub`），`link_block()` 的 `text.find()` 找不到该词 → fallback。
- 若要修它，需要把检查扩到 **label**，并把因此不再生成的 link 记录挂到含该词的 block 上，
  否则 `tests/test_fidelity.py::test_no_invented_uri`（A5：每条真实 URI 都要出现）会红。
  这已超出 D-55 的裁定文字，且会改变 `block.links` 语义，**没有擅自改**。

45 份的新旧差分：`TOTAL 45 identical=43 changed=2`（只有唐乐 / tangle 变），
84 份差分：`identical=84 changed=0`。

## 2. D-56：`--no-corpus`

`converter/tests/conftest.py`：+37/−5。

- 新增 `pytest_addoption("--no-corpus")`；
- 不传时 `_require_corpus` 行为不变：缺原件 → `pytest.exit(..., returncode=2)`；
- 传了时 `_require_corpus` 直接返回；`corpus_rows` / `real_rows` / `synthetic_rows`
  在 fixture 里 `pytest.skip("--no-corpus：依赖语料原件的用例未运行（skipped 不是 passed）")`，
  依赖它们的 `corpus_results` / `real_results` 随之跳过。

实测（四个方向）：

```
# ① 不带 --no-corpus，语料环境变量未设
$ python -m pytest converter/tests -q
! _pytest.outcomes.Exit: corpus originals unavailable for 84 row(s) ...
no tests ran in 1.26s
exit=2                                    → fail-fast 不变

# ② 带 --no-corpus，语料环境变量未设
$ python -m pytest converter/tests -q --no-corpus
54 passed, 26 skipped in 1.51s
exit=0

# ③ 带 --no-corpus，语料环境变量设好
$ python -m pytest converter/tests -q --no-corpus
54 passed, 26 skipped in 1.42s
exit=0                                    → 开关是"不跑语料用例"，不是"没语料才 skip"

# ④ 不带 --no-corpus，语料环境变量设好（回归）
$ python -m pytest converter/tests -q
80 passed in 58.93s
exit=0                                    （修前基线 77 passed；新增 3 条回归用例）
```

被跳过的 26 条（原因均为上句 `--no-corpus`）：

| 文件 | 条数 | 用例 |
|---|---|---|
| `test_fidelity.py` | 12 | 全部（page coverage / Counter / URI / glyph / shape / completeness / traceability / idempotent / original unchanged / block join / NFKC 等） |
| `test_hard_cases.py` | 5 | `test_scanned_detected` / `test_zero_text_pdf` / `test_encrypted_pdf` / `test_corrupted_pdf` / `test_timeout_is_reported_not_hung` |
| `test_noise_and_review.py` | 1 | `test_platform_noise_excluded_and_recorded` |
| `test_resume_fields.py` | 8 | 用 `corpus_results` 的三态/身份/时间线/受保护属性用例 |

跑起来的不依赖语料用例 54 条，含 `test_verify.py` 24 条、`test_link_fallback.py` 3 条、
`test_noise_and_review.py` 的人读复核 3 条、噪声分类 8 条、OCR/inline 噪声 3 条、
`test_hard_cases.py` 的 tmp_path 失败路径 3 条、`test_resume_fields.py` 纯函数 10 条。

## 3. 新增回归测试（`converter/tests/test_link_fallback.py`，76 行）

1. `test_printed_url_is_not_duplicated_by_fallback`：URL 印在一整行中文里、词中心在注解外 →
   不再生成 link 块，正文里 URL 只出现 1 次。
2. `test_url_without_visible_text_still_kept_as_label`：注解盖在空白处 → 仍生成
   `[URL](<URL>)`（D-55 要求保留的设计）。
3. `test_uri_inside_another_links_href_is_not_visible_text`：短 URI 只是一个已绑定 href 的前缀时
   不能被当成"已印出"（href 不算可见文字）。

## 4. 证据文件

`converter/reports/_d55/`：`45-sweep.{log,jsonl}`、`84-sweep.{log,jsonl}`、
`45-differential.log`、`84-differential.{log,jsonl}`、`trigger-scan.json`、
`verifier-{before,after}-{tang,tangle}.json`、`pytest-*.txt`、
`tang/tangle-{before,after}.json`、`d55-before-after.txt`，以及复跑脚本
`scan_trigger.py` / `sweep.py` / `differential.py` / `evidence.py`。
