// 工具级真实调用测试：不经模型，直接调 execute。
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL('D:/12412/dsh工作区/projects/recruitment-agent/dsh/dsh-recruitment/src/index.ts').href);

const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) } };
mod.apply(ctx, {
  converter: {
    python_bin: 'D:/Python3.12.9/python.exe',
    converter_dir: 'D:/12412/dsh工作区/projects/recruitment-agent/converter',
    allowed_roots: ['D:/12412/dsh工作区/projects/resume-talent-pool', 'D:/12412/dsh工作区/orchestration', 'D:/12412/CodexWorkspace'],
  },
});
console.log('registered tools:', registered.map((t) => t.name).join(', '));

const resumeTool = registered.find((t) => t.name === 'recruitment_resume_read');
const pdf = "D:/12412/dsh工作区/projects/resume-talent-pool/.snap-cache/research/content/Byronlee__byronlee.github.io/c21b3647bb5bea8f3ce3dc22f855bad0c7a28d41/resume/Byronlee's resume（English）.pdf";

// 正例：真实 PDF
const value = await resumeTool.execute({ path: pdf, max_blocks: 3 }, {});
console.log('\n--- LIVE read ---');
console.log('provenance:', value.provenance, 'stub:', value.stub);
console.log('pages:', value.source.pages, 'sha256:', value.source.sha256.slice(0, 12), 'order_verified:', value.source.order_verified);
console.log('blocks returned:', value.blocks.length, 'of', value.block_count);
for (const [k, f] of Object.entries(value.fields)) {
  console.log(`  ${k}: ${f.state}${f.value ? ' = ' + f.value : ''} ${f.reason ? '(' + f.reason + ')' : ''} evidence=${f.evidence.length}`);
}
console.log('screening.eligible:', value.screening.eligible_fields.join(','));
console.log('screening.blocked:', value.screening.blocked_fields.map((b) => b.field).join(','));
console.log('protected_excluded:', value.screening.protected_excluded.join(','));
console.log('issues:', [...new Set(value.issues.map((i) => i.code))].join(','));

// 渲染结果前 20 行
const rendered = resumeTool.output.render({}, value)[0].text.split('\n').slice(0, 20).join('\n');
console.log('\n--- rendered ---\n' + rendered);

// 负例：越界路径必须被拒
for (const bad of ['D:/Windows/System32/drivers/etc/hosts.pdf', 'relative.pdf', 'D:/12412/dsh工作区/projects/recruitment-agent/converter/requirements.txt']) {
  try { await resumeTool.execute({ path: bad }, {}); console.log(`BAD ACCEPTED: ${bad}`); }
  catch (e) { console.log(`rejected [${bad}]: ${String(e.message).slice(0, 90)}`); }
}
