// 客户端构建：只产出 lib/client.js（CJS，web 平台）。
//
// 为什么要手写 banner/footer：DSH 浏览器侧的模块装载器不认识普通 CJS/ESM 包，
// 它要求每个客户端产物把自己注册进 `window.__ModuleLoader__`：
//
//   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ...; return module.exports } })
//
// `id` 必须等于包名（= 启动图 `__DSH_BOOT__` 里的 entry id），否则工厂注册不上。
// 形状照抄已验证的原型 `dsh-superagent-prototype/tsdown.config.ts`。
//
// 宿主代码（src/index.ts、src/http/*.ts）**不打包**：`main` 仍指向 `src/index.ts`，
// DSH 直接按源码执行，构建只服务浏览器那半边。
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

// CSS 导入：构建器没装 `@tsdown/css`，而客户端组件会自然地写 `import './x.css'`。
// 这里在**解析/加载阶段**把 CSS 变成一个注入模块：模块加载时把样式塞进 document.head（只塞一次），
// 同时默认导出字符串。任何 `import './*.css'` 都能直接工作，不必每轮手工改成字符串注入。
const VIRTUAL_PREFIX = 'recruitment-css-virtual:'

const cssInjectionPlugin = {
  name: 'recruitment-css-injection',
  resolveId(id: string, importer: string | undefined) {
    if (!id.endsWith('.css')) return null
    const file = isAbsolute(id) ? id : resolve(importer === undefined ? process.cwd() : dirname(importer), id)
    // 虚拟 id 不能以 `.css` 结尾：tsdown 的 css-guard 是按扩展名判断的，会抢先报错。
    return `${VIRTUAL_PREFIX}${file}?css`
  },
  load(id: string) {
    if (!id.startsWith(VIRTUAL_PREFIX)) return null
    const file = id.slice(VIRTUAL_PREFIX.length).replace(/\?css$/, '')
    const css = readFileSync(file, 'utf8')
    return [
      `const css = ${JSON.stringify(css)};`,
      `if (typeof document !== 'undefined' && document.querySelector('style[data-recruitment-css]') === null) {`,
      `  const style = document.createElement('style');`,
      `  style.setAttribute('data-recruitment-css', '1');`,
      `  style.textContent = css;`,
      `  document.head.appendChild(style);`,
      `}`,
      `export default css;`,
    ].join('\n')
  },
}

const clientConfig: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  plugins: [cssInjectionPlugin],
  // react / react-dom 由 DSH 的浏览器模块表提供（页面里已有一份），打进产物会变成第二份 React。
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@recruitment/dsh-recruitment", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

// 独立整页 v4（D-167）：ESM + 自包含（react/react-dom 一并打进产物；页面没有宿主模块表）。
// CSS 仍走注入插件（运行时把样式塞进 <head>），因此不要求额外产出 app.css。
const appConfig: UserConfig = {
  entry: { app: 'src/app/main.tsx' },
  outDir: 'lib',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  plugins: [cssInjectionPlugin],
  outputOptions: { entryFileNames: 'app.js' },
}

export default defineConfig([clientConfig, appConfig])

