import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL('D:/12412/dsh工作区/projects/recruitment-agent/dsh/dsh-recruitment/src/index.ts').href);
const registered = [];
mod.apply({ tools: { register: (t) => registered.push(t) } }, {
  converter: {
    python_bin: 'D:/Python3.12.9/python.exe',
    converter_dir: 'D:/12412/dsh工作区/projects/recruitment-agent/converter',
    allowed_roots: ['D:/12412/dsh工作区/projects/resume-talent-pool'],
  },
});
const tool = registered.find((t) => t.name === 'recruitment_resume_read');
// 存在、是 PDF、但不在 allowed_roots 内 → 必须 FORBIDDEN
const outside = 'D:/12412/Documents/Invoice-ML9UJ3DY-0001.pdf';
try { await tool.execute({ path: outside }, {}); console.log('BAD: accepted outside root'); }
catch (e) { console.log('FORBIDDEN test:', String(e.message).slice(0, 120)); }
// 配置缺失 → 仍注册，但调用 NOT_CONFIGURED
const r2 = [];
mod.apply({ tools: { register: (t) => r2.push(t) } }, {});
console.log('unconfigured tools:', r2.map((t) => t.name).join(', '));
try { await r2[0].execute({ path: outside }, {}); console.log('BAD: unconfigured accepted'); }
catch (e) { console.log('NOT_CONFIGURED test:', String(e.message).slice(0, 140)); }
