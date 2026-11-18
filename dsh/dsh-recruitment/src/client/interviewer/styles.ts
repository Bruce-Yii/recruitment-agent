// Interviewer Workspace 的 scoped 样式（全部 `.iw-*`，不污染宿主页面）。
//
// 视觉真值：`work/v561/index.html`（`:root` token + `.paper/.chip/.metric/.appitem/.criteria`
// 等规则）+ `work/d5/spec/shots/{1440-interviewer-work-B,1440-interviewer-detail-B,
// 1440-scorecard-modal,390-interviewer-work-B}.png`。只搬 token 与卡片语言，不搬原型的
// 业务状态机；颜色语义沿用原型：蓝=进行中/可操作，绿=已完成，琥珀=需要人或待定，红=失败。
//
// 断点（照原型 media query）：
//   * 基础（≥1100）：列表/详情两栏（主栏 1.73fr + 右栏 273px 起）；
//   * ≤1100：收窄内容 padding 与右栏最小宽；
//   * ≤850：单栏（右栏下沉成 2 列小卡），表单弹层全宽；
//   * ≤570：紧凑（1 列、字号降一档、列表 chip 可换行）。
// 390 宽不横向溢出：所有容器 `min-width:0`，长 id/哈希用 `overflow-wrap:anywhere`。

/** 工作台样式（字符串，由组件用 `<style>` 注入一次）。 */
export const INTERVIEWER_CSS = `
.iw-root{
  --iw-bg:#F9F8F5;--iw-surface:#FFFFFF;--iw-text:#191918;--iw-sub:#787772;--iw-dim:#A6A59E;
  --iw-border:rgba(25,25,24,.08);--iw-border2:rgba(25,25,24,.12);--iw-blue:#5B5BD6;--iw-blue2:#4747B8;--iw-bluebg:rgba(91,91,214,.09);
  --iw-green:#18794E;--iw-greenbg:rgba(24,121,78,.09);--iw-amber:#AD5700;--iw-amberbg:rgba(173,87,0,.09);
  --iw-red:#CD2B31;--iw-redbg:rgba(205,43,49,.08);--iw-shadow:0 4px 22px rgba(40,55,80,.027);--iw-radius:14px;
  box-sizing:border-box;min-height:100%;padding:26px 30px 44px;background:var(--iw-bg);color:var(--iw-text);
  font-family:Inter,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.65;
  -webkit-font-smoothing:antialiased;
}
.iw-root *,.iw-root *::before,.iw-root *::after{box-sizing:border-box}
.iw-root h1,.iw-root h2,.iw-root h3,.iw-root p,.iw-root ul,.iw-root li,.iw-root figure{margin:0;padding:0}
.iw-root ul{list-style:none}
.iw-root h1{font-size:24px;line-height:1.45;font-weight:720;letter-spacing:-.7px}
.iw-root h2{font-size:17px;line-height:1.5;font-weight:680;letter-spacing:-.3px}
.iw-root h3{font-size:14px;font-weight:680}
.iw-root small{font-size:12px}
.iw-root button{font:inherit;cursor:pointer}
.iw-root button:disabled{opacity:.45;cursor:not-allowed}
.iw-root button:focus-visible,.iw-root select:focus-visible,.iw-root input:focus-visible,.iw-root textarea:focus-visible{outline:2px solid #92afe3;outline-offset:2px}
.iw-root code,.iw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;overflow-wrap:anywhere}

/* ---------- 版式骨架 ---------- */
.iw-view{max-width:1218px;margin:0 auto;min-width:0}
.iw-actorline{font-size:11px;color:var(--iw-dim);margin-bottom:10px;overflow-wrap:anywhere}
.iw-actorline strong{color:var(--iw-sub);font-weight:670}
.iw-cap{font-size:11px;font-weight:720;letter-spacing:.65px;color:#8290a2}
.iw-headline{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:22px;flex-wrap:wrap}
.iw-headline .iw-sub{color:var(--iw-sub);font-size:13px;margin-top:7px;max-width:720px}
.iw-headline-main{min-width:0}
.iw-gridwork{display:grid;grid-template-columns:minmax(0,1.73fr) minmax(273px,.78fr);gap:19px;align-items:start}
.iw-detailgrid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(260px,.77fr);gap:19px;align-items:start}
.iw-min{min-width:0}
.iw-aside,.iw-detailaside{display:flex;flex-direction:column;gap:15px;min-width:0}
.iw-back{border:0;background:transparent;color:#7c8aa0;padding:0;margin-bottom:16px;font-size:12px}
.iw-back:hover{color:var(--iw-blue2);text-decoration:underline}

/* ---------- 卡片 ---------- */
.iw-paper{background:var(--iw-surface);border:1px solid var(--iw-border);border-radius:var(--iw-radius);box-shadow:var(--iw-shadow);min-width:0}
.iw-hero{padding:24px 26px}
.iw-hero h2{font-size:22px;margin-top:6px}
.iw-hero p{font-size:13px;color:var(--iw-sub);margin-top:7px;max-width:560px}
.iw-asidecard{padding:20px}
.iw-asidecard h2{font-size:14px;margin-bottom:10px}
.iw-actionbox{padding:18px 19px}
.iw-actionbox strong{font-size:13px;display:block;margin-bottom:6px}
.iw-actionbox p{font-size:12px;color:#718096;line-height:1.85;margin-top:5px}
.iw-detailmain{padding:24px 26px}
.iw-insight{background:#f6f8fb;border:1px solid #edf1f6;border-radius:12px;padding:16px 18px}
.iw-insight h3{font-size:13px}
.iw-insight p{margin-top:7px;font-size:13px;color:#516177;line-height:1.9}
.iw-divider{height:1px;background:var(--iw-border);margin:18px 0}
.iw-note{background:#fcf6e9;border:1px solid #f3e9d7;border-radius:10px;padding:10px 12px;color:#8a6a34;font-size:12px;line-height:1.8;margin-top:10px}
.iw-notice{padding:16px 18px;border-radius:12px;border:1px solid var(--iw-border);background:#fff;margin:0 0 14px}
.iw-notice strong{display:block;font-size:13px;line-height:1.7}
.iw-notice p{font-size:12px;color:var(--iw-sub);margin-top:6px}
.iw-notice-warn{background:#fff9ee;border-color:#f3e9d7;color:#8a6a34}
.iw-notice-error{background:var(--iw-redbg);border-color:#f2d8d5;color:var(--iw-red)}
.iw-notice-error p{color:#9a615c}
.iw-empty{padding:22px 20px;color:var(--iw-sub);font-size:13px}
.iw-muted{color:var(--iw-sub)}
.iw-tiny{font-size:11px;line-height:1.8}
.iw-dimtext{color:var(--iw-dim)}

/* ---------- 统计 ---------- */
.iw-metrics{display:flex;flex-wrap:wrap;gap:0;margin-top:19px;padding:17px 0 14px;border-top:1px solid var(--iw-border);border-bottom:1px solid var(--iw-border)}
.iw-metric{flex:1 1 0;min-width:96px;border-right:1px solid #edf0f4;padding:0 14px}
.iw-metric:first-child{padding-left:0}
.iw-metric:last-child{border:0}
.iw-metric strong{font-size:22px;line-height:1.3;font-weight:680;color:#394e6b;display:block}
.iw-metric small{display:block;font-size:11px;color:#8190a3;margin-top:6px}

/* ---------- 列表 ---------- */
.iw-sectionhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:24px 1px 11px;flex-wrap:wrap}
.iw-sectionhead h2{font-size:14px}
.iw-sectionhead small{color:var(--iw-dim)}
.iw-list{padding:4px 0}
.iw-appitem{width:100%;border:0;background:transparent;text-align:left;display:flex;align-items:center;gap:12px;padding:15px 16px;border-bottom:1px solid #eff1f5;color:inherit;border-radius:0}
.iw-appitem:last-child{border-bottom:0}
.iw-appitem:hover{background:#fafbfd}
.iw-av{width:35px;height:35px;flex:none;display:grid;place-items:center;border-radius:11px;background:#edf2f7;color:#56718e;font-size:13px;font-weight:680}
.iw-rowmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.iw-rowtitle{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:13px;font-weight:680}
.iw-rowdesc{font-size:11px;color:#8490a3;overflow-wrap:anywhere}
.iw-chev{color:#a8b3c2;font-size:18px;flex:none}
.iw-rowstate{flex:none}

/* ---------- chip / 标签 ---------- */
.iw-chip{display:inline-flex;align-items:center;gap:5px;border-radius:7px;padding:4px 8px;background:#f2f4f7;color:#66768a;font-weight:650;font-size:11px;white-space:nowrap;max-width:100%}
.iw-chip-blue{background:var(--iw-bluebg);color:var(--iw-blue2)}
.iw-chip-green{background:var(--iw-greenbg);color:var(--iw-green)}
.iw-chip-amber{background:var(--iw-amberbg);color:var(--iw-amber)}
.iw-chip-red{background:var(--iw-redbg);color:var(--iw-red)}
.iw-labels{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.iw-dot{width:7px;height:7px;border-radius:100%;background:#bdc7d3;flex:none;display:inline-block;margin-top:7px}
.iw-dot-blue{background:#7899d4}
.iw-dot-green{background:#6fae93}
.iw-dot-amber{background:#d3aa68}
.iw-dot-red{background:#c98378}

/* ---------- 考察重点 ---------- */
.iw-criteria{display:flex;flex-direction:column;margin-top:4px}
.iw-criteriarow{display:flex;gap:9px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #eff2f5;font-size:12px;color:#69788d;overflow-wrap:anywhere}
.iw-criteriarow:last-child{border-bottom:0}
.iw-criteriarow strong{font-size:12px;color:var(--iw-text);font-weight:670}
.iw-criteriaweight{margin-left:auto;color:var(--iw-dim);font-size:10px;white-space:nowrap;padding-left:8px}
.iw-subhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:20px 0 10px;flex-wrap:wrap}
.iw-subhead h2{font-size:14px}
.iw-subhead small{color:var(--iw-dim)}

/* ---------- 折叠块 ---------- */
.iw-collapse{margin-top:10px;padding:14px 16px}
.iw-collapse summary{cursor:pointer;font-weight:670;font-size:12px;color:#566780}
.iw-collapse > div{margin-top:12px}
.iw-sourcebox{padding:15px;background:#fbfcfd;border:1px solid var(--iw-border);border-radius:11px;white-space:pre-wrap;color:#53647a;font-size:12px;line-height:1.9;overflow-wrap:anywhere;max-height:320px;overflow:auto}
.iw-materials{display:flex;flex-direction:column;gap:0}
.iw-materialrow{display:grid;grid-template-columns:minmax(90px,150px) minmax(0,1fr);gap:10px;padding:8px 0;border-bottom:1px solid #f1f3f6;font-size:12px}
.iw-materialrow:last-child{border-bottom:0}
.iw-materialrow dt{color:var(--iw-sub);font-weight:650;overflow-wrap:anywhere}
.iw-materialrow dd{margin:0;color:#4c5c72;overflow-wrap:anywhere;white-space:pre-wrap}

/* ---------- 两个独立分支（材料 / 面评） ---------- */
.iw-branch{margin-top:14px;padding:17px 18px}
.iw-branch strong.iw-branchtitle{display:block;font-size:13px;margin-bottom:5px}
.iw-branchstate{font-size:12px;color:#4c5c72;margin-top:3px}
.iw-branch .iw-tiny{color:var(--iw-sub);margin-top:4px}
.iw-branch-sep{border:0;border-top:1px solid var(--iw-border);margin:12px 0 10px}
.iw-inlineactions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px}
.iw-roundgroup{padding:10px 0;border-bottom:1px solid var(--iw-border);min-width:0}
.iw-roundgroup:last-child{border-bottom:0}
.iw-roundgroup strong{font-size:12px;display:block;overflow-wrap:anywhere}
.iw-loading{padding:10px 0;color:var(--iw-sub);font-size:13px}

/* ---------- 按钮 ---------- */
.iw-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--iw-border2);background:#fff;color:#566780;padding:9px 13px;min-height:36px;border-radius:9px;font-size:12px;font-weight:660;transition:background .15s}
.iw-btn:hover{background:#f5f8fd}
.iw-btn-blue{background:var(--iw-blue);color:#fff;border-color:var(--iw-blue)}
.iw-btn-blue:hover{background:var(--iw-blue2)}
.iw-btn-sm{min-height:30px;padding:5px 10px;font-size:11px}
.iw-x{border:0;background:#f3f5f8;border-radius:8px;font-size:20px;color:#66768c;line-height:1;height:30px;width:30px;flex:none}

/* ---------- 表单弹层 ---------- */
.iw-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(27,37,53,.26);overflow:auto}
.iw-modal{width:min(560px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;border-radius:15px;box-shadow:0 20px 70px rgba(25,38,60,.18);padding:24px 25px;min-width:0}
.iw-modaltop{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}
.iw-modaltop h2{font-size:19px}
.iw-modaldesc{color:#7a899b;font-size:12px;margin-top:7px;line-height:1.8}
.iw-form{margin-top:14px;min-width:0}
.iw-fieldset{border:1px solid var(--iw-border);border-radius:11px;padding:12px 14px 14px;margin:0 0 11px;min-width:0}
.iw-fieldset legend{font-size:12px;font-weight:680;color:#53657c;padding:0 4px;overflow-wrap:anywhere}
.iw-field{margin-top:10px;min-width:0}
.iw-field label,.iw-field > span{display:block;font-size:11px;color:#6d7c91;margin-bottom:3px}
.iw-field select,.iw-field input,.iw-field textarea{width:100%;border:1px solid var(--iw-border2);background:#fff;border-radius:8px;padding:7px 9px;color:var(--iw-text);font-size:12px;font-family:inherit}
.iw-field textarea{resize:vertical;line-height:1.7}
.iw-field input:disabled,.iw-field select:disabled,.iw-field textarea:disabled{background:#f7f9fb;color:#8b97a8}
.iw-fieldhelp{font-size:10px;color:var(--iw-dim);margin-top:3px}
.iw-modalend{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:18px;flex-wrap:wrap}
.iw-lockline{font-size:11px;color:var(--iw-sub);margin:10px 0;overflow-wrap:anywhere}
.iw-result{margin-top:14px;padding:14px 16px;border:1px solid #cfe6d9;background:var(--iw-greenbg);border-radius:11px;color:#2f5d4d;font-size:12px;line-height:1.9;overflow-wrap:anywhere}
.iw-result strong{display:block;font-size:13px;margin-bottom:4px}
.iw-result code{font-size:11px;color:#315f50}
.iw-errorbox{margin-top:14px;padding:13px 15px;border:1px solid #f2d8d5;background:var(--iw-redbg);border-radius:11px;color:var(--iw-red);font-size:12px;line-height:1.85;overflow-wrap:anywhere}
.iw-errorbox strong{display:block;font-size:12px;margin-bottom:4px}
.iw-validation{margin-top:12px;padding:10px 12px;border-radius:9px;background:#fff9ee;border:1px solid #f3e9d7;color:#8a6a34;font-size:12px;overflow-wrap:anywhere}
.iw-formloading{padding:10px 0;color:var(--iw-sub);font-size:13px}

/* ---------- 断点 ---------- */
@media (max-width:1100px){
  .iw-root{padding:24px 22px 40px}
  .iw-gridwork{grid-template-columns:minmax(0,1.4fr) minmax(255px,.78fr)}
  .iw-detailgrid{grid-template-columns:minmax(0,1.3fr) minmax(240px,.7fr)}
}
@media (max-width:850px){
  .iw-root{padding:20px 18px 34px}
  .iw-gridwork,.iw-detailgrid{grid-template-columns:1fr}
  .iw-aside,.iw-detailaside{display:grid;grid-template-columns:1fr 1fr;gap:13px}
  .iw-headline{align-items:flex-start}
  .iw-headline h1{font-size:21px}
  .iw-modal{width:100%;padding:20px 18px}
  .iw-materialrow{grid-template-columns:minmax(0,1fr)}
  .iw-materialrow dt{padding-top:2px}
}
@media (max-width:570px){
  .iw-root{padding:16px 13px 28px}
  .iw-hero{padding:19px 16px}
  .iw-hero h2{font-size:20px}
  .iw-hero p{font-size:12px}
  .iw-metric{padding:0 9px;min-width:78px}
  .iw-metric strong{font-size:18px}
  .iw-metric small{font-size:10px}
  .iw-aside,.iw-detailaside{display:flex;flex-direction:column}
  .iw-detailmain{padding:18px 15px}
  .iw-appitem{padding:13px 11px;gap:9px;flex-wrap:wrap}
  .iw-rowstate{margin-left:auto}
  .iw-sectionhead{margin-top:20px}
  .iw-headline{gap:9px}
  .iw-headline h1{font-size:20px}
  .iw-overlay{padding:9px}
  .iw-modal{padding:17px 14px;max-height:calc(100vh - 18px)}
  .iw-modalend{justify-content:stretch}
  .iw-modalend .iw-btn{flex:1 1 auto}
  .iw-chip{white-space:normal;text-align:left}
}

/* ---------- 轮次级考察重点 / 本轮评分表（W3b，task-50） ---------- */
.iw-roundcard,.iw-schema{margin-top:15px;padding:17px 19px}
.iw-roundtitle{font-size:15px;font-weight:650;color:var(--iw-text);margin:2px 0 6px;overflow-wrap:anywhere}
.iw-roundcard .iw-subhead,.iw-schema .iw-subhead{margin-top:0}
.iw-roundcard .iw-criteria{margin-top:8px}
.iw-roundcard .iw-criteriarow{align-items:flex-start;gap:8px;flex-wrap:wrap}
.iw-roundcard .iw-chip,.iw-schema .iw-chip{margin-left:6px}
.iw-roundcard .iw-notice,.iw-schema .iw-notice{margin-top:10px}
.iw-schemalist{margin-top:10px;display:flex;flex-direction:column;gap:9px;min-width:0}
.iw-schemarow{border:1px solid var(--iw-border);border-radius:10px;padding:10px 12px;min-width:0;
  display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere;word-break:break-word}
.iw-schemarow-main{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0}
.iw-schemarow-main strong{overflow-wrap:anywhere}
.iw-schemarow-chips{display:flex;flex-wrap:wrap;gap:5px}
.iw-roundctx{margin:10px 0 2px;padding:11px 13px;border:1px solid var(--iw-border);border-radius:10px;
  background:var(--iw-bluebg);min-width:0;overflow-wrap:anywhere}
.iw-roundctx strong{display:block;font-size:12px;margin-bottom:3px}
.iw-roundctx p{margin:2px 0}
@media (max-width:570px){
  .iw-roundcard,.iw-schema{padding:14px 13px}
  .iw-schemarow{padding:9px 10px}
  .iw-roundcard .iw-criteriarow,.iw-schemarow-main,.iw-schemarow-chips{min-width:0}
}

/* Task 06: Constraints, Quick Notes & Local Checklist (v4 design-tokens.md) */
.iw-pin-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.iw-pin-tag{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:99px;background:rgba(205,43,49,.08);color:#CD2B31;font-size:12px;font-weight:550}
.iw-pin-tag.handoff{background:rgba(91,91,214,.09);color:#5B5BD6}
.iw-handoff-badge{font-size:11px;font-weight:650;padding:1px 6px;border-radius:99px;background:#5B5BD6;color:#FFFFFF}
.iw-quicknotes{width:100%;min-height:112px;margin-top:8px;padding:12px 14px;border-radius:12px;border:1px solid rgba(25,25,24,.08);background:#F9F8F5;color:#191918;font:inherit;font-size:13.5px;line-height:1.7;resize:vertical}
.iw-iq-row{display:flex;align-items:flex-start;gap:9px;padding:8px 0;border-bottom:1px solid rgba(25,25,24,.05);font-size:13.5px;cursor:pointer}
.iw-iq-row.done{opacity:.5;text-decoration:line-through}
`