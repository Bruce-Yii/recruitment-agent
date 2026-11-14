#!/usr/bin/env node
// 干净加载门：**在干净检出上 import 插件入口**，证明整张依赖图里的每个模块都已入库。
//
// 为什么需要它（三次真实事故，形态完全一样）：
//   `event-types.ts`（事件注册表）、`media.ts` 的 `MEDIA_RTF`、`test/integration/db.ts` 的
//   `assertPrivateDatabase` —— 都是"某个已入库文件 import 了一个**还没入库**的模块"。
//   本机因为工作树里恰好有那个文件所以全绿，干净检出（CI / 别人 clone）直接
//   `ERR_MODULE_NOT_FOUND`，而 CI 要跑几分钟测试才暴露。
//   import 一秒就能暴露，所以单独设一道门，且**必须是真 import**：
//   只看语法（`--check`）或只看类型都发现不了"模块缺了"。
//
// 为什么不用 `node -e` 内联：多行 JS 在 bash / PowerShell 里的引号规则不一致，
// 本机验不了的守卫等于没有守卫。落成文件，本机与 CI 跑的是同一条命令。
//
// 跑法（仓库根）：node scripts/clean-load.mjs
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENTRY = join(REPO_ROOT, 'dsh', 'dsh-recruitment', 'src', 'index.ts')

let entry
try {
  entry = await import(pathToFileURL(ENTRY).href)
} catch (error) {
  console.error(`clean-load: import 插件入口失败：${ENTRY}`)
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  console.error('')
  console.error('最可能的原因：某个已入库文件 import 了**还没入库**的模块。')
  console.error('这不是"环境问题"，是提交集不自洽。先 git status 看有没有该提交没提交的文件。')
  process.exit(1)
}

// 入口契约：DSH 插件必须有 name / inject / apply。
// 断言这三个不是形式主义——apply 缺失会让插件"加载成功但什么都不做"，
// 那比加载失败更难发现。
const missing = ['name', 'inject', 'apply'].filter((key) => entry[key] === undefined)
if (missing.length > 0) {
  console.error(`clean-load: 入口缺少导出：${missing.join(', ')}`)
  process.exit(1)
}
if (typeof entry.apply !== 'function') {
  console.error('clean-load: 入口的 apply 不是函数')
  process.exit(1)
}
if (!Array.isArray(entry.inject)) {
  console.error(`clean-load: 入口的 inject 不是数组（实际：${typeof entry.inject}）`)
  process.exit(1)
}

console.log(`CLEAN_LOAD OK: ${entry.name} inject=${JSON.stringify(entry.inject)}`)
