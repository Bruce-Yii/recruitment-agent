// 接线验证：从插件入口 apply() 取工具，跑真实 PDF。
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL('D:/12412/dsh工作区/projects/recruitment-agent/dsh/dsh-recruitment/src/index.ts').href);
const tools = [];
mod.apply({ tools: { register: (t) => tools.push(t) } }, {
  converter: {
    python_bin: 'D:/Python3.12.9/python.exe',
    converter_dir: 'D:/12412/dsh工作区/projects/recruitment-agent/converter',
    allowed_roots: ['D:/12412/dsh工作区/projects/resume-talent-pool'],
  },
});
console.log('注册的工具:', tools.map(t => t.name).join(', '));

const pdf = "D:/12412/dsh工作区/projects/resume-talent-pool/.snap-cache/research/content/Byronlee__byronlee.github.io/c21b3647bb5bea8f3ce3dc22f855bad0c7a28d41/resume/Byronlee's resume（English）.pdf";
const ser = tools.find(t => t.name === 'recruitment_resume_serialize');
const val = tools.find(t => t.name === 'recruitment_structure_validate');

const s = await ser.execute({ path: pdf, max_lines: 6 }, {});
console.log('\n--- serialize ---');
console.log('lines:', s.line_count, 'blocks:', s.block_count, 'split:', s.split_blocks, 'truncated:', s.truncated);
console.log('doc_header:', s.doc_header);
console.log(s.numbered_text);

// 构造一个"模型输出"：一部分正确、一部分故意编造
const modelOutput = {
  prompt_version: '1.0.0',
  schema_version: '1.0.0',
  sections: [{ label: 'contact', block_ids: ['1', '2', '3'], ignored: [] }],
  fields: {
    name: { state: 'present', value: 'Byronlee', block_ids: ['1'] },
    phone: { state: 'present', value: '+8613880156590', block_ids: ['2'] },
    email: { state: 'present', value: 'made.up@nowhere.test', block_ids: ['2'] },   // 编造
    work_experience: { state: 'absent', block_ids: [] },
    education: { state: 'absent', block_ids: [] },
  },
};
const v = await val.execute({ path: pdf, result_json: JSON.stringify(modelOutput) }, {});
console.log('\n--- validate（含编造邮箱）---');
console.log('accepted:', v.accepted, 'rejections:', v.rejection_count);
for (const r of v.rejections.slice(0, 6)) console.log('  ', r.code, '|', r.detail.slice(0, 90));
