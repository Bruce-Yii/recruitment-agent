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
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  // react / react-dom 由 DSH 的浏览器模块表提供（页面里已有一份），打进产物会变成第二份 React。
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@recruitment/dsh-recruitment", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
