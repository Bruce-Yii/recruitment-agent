// 招聘工作区（W2）视觉层：**V5.6.1 token + 版式**，只在本组件内生效。
//
// 为什么用"组件内注入的 scoped stylesheet"而不是全局 CSS 文件：
//   · 契约禁止新增依赖、禁止改 W0 的外壳；组件必须能在宿主 main 槽位里独立渲染；
//   · 媒体查询（1440 两栏 / ≤1100 收窄 / ≤850 单栏 / ≤570 紧凑）无法用纯内联样式表达；
//   · 全部选择器都带 `rcw-` 前缀，变量也带 `--rcw-` 前缀，**不会污染宿主样式**。
// 视觉 token 逐字取自 `work/v561/index.html` 的 `:root`（见 `work/d5/w2/CONTRACT.md` §5）。

import type { CSSProperties } from 'react'
import type { ChipTone } from './format.ts'

/** V5.6.1 设计 token（与 `work/v561/index.html:4` 的 `:root` 逐字一致）。 */
export const TOKENS = {
  bg: '#f8f9fb',
  surface: '#fff',
  text: '#29384d',
  sub: '#64738a',
  dim: '#8b97a8',
  border: '#e7ebf1',
  border2: '#d6dfeb',
  blue: '#496cad',
  blue2: '#365891',
  bluebg: '#edf3fc',
  green: '#347b65',
  greenbg: '#eaf6f0',
  amber: '#97743b',
  amberbg: '#fcf6e9',
  red: '#a45450',
  redbg: '#fff0ef',
  shadow: '0 4px 22px rgba(40,55,80,.027)',
  radius: '14px',
} as const

/** 根节点内联样式：字体/底色/正文口径（宿主页面里也能独立成立）。 */
export const ROOT_STYLE: CSSProperties = {
  background: TOKENS.bg,
  color: TOKENS.text,
  fontFamily: 'Inter,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif',
  fontSize: 14,
  lineHeight: 1.65,
  minHeight: '100%',
  boxSizing: 'border-box',
  padding: '28px 32px 96px',
  WebkitFontSmoothing: 'antialiased',
}

/** chip 的 class（色档）。 */
export function chipClass(tone: ChipTone): string {
  return tone === 'gray' ? 'rcw-chip' : `rcw-chip rcw-chip-${tone}`
}

/** 组件内注入的样式表（选择器全部 `rcw-` 前缀；token 走 `--rcw-*` 变量）。 */
export const RECRUITING_CSS = `
.rcw-root{
  --rcw-bg:${TOKENS.bg};--rcw-surface:${TOKENS.surface};--rcw-text:${TOKENS.text};--rcw-sub:${TOKENS.sub};
  --rcw-dim:${TOKENS.dim};--rcw-border:${TOKENS.border};--rcw-border2:${TOKENS.border2};
  --rcw-blue:${TOKENS.blue};--rcw-blue2:${TOKENS.blue2};--rcw-bluebg:${TOKENS.bluebg};
  --rcw-green:${TOKENS.green};--rcw-greenbg:${TOKENS.greenbg};--rcw-amber:${TOKENS.amber};--rcw-amberbg:${TOKENS.amberbg};
  --rcw-red:${TOKENS.red};--rcw-redbg:${TOKENS.redbg};--rcw-radius:${TOKENS.radius};--rcw-shadow:${TOKENS.shadow};
  overflow-wrap:break-word;
}
.rcw-root *{box-sizing:border-box}
.rcw-root h1,.rcw-root h2,.rcw-root h3,.rcw-root h4,.rcw-root p,.rcw-root ul,.rcw-root ol{margin:0;padding:0}
.rcw-root ul,.rcw-root ol{list-style:none}
.rcw-root h1{font-size:24px;line-height:1.45;font-weight:720;letter-spacing:-.7px}
.rcw-root h2{font-size:17px;line-height:1.5;font-weight:680;letter-spacing:-.3px}
.rcw-root h3{font-size:14px;font-weight:680}
.rcw-root small{font-size:12px}
.rcw-root button{font:inherit;cursor:pointer}
.rcw-root button:disabled{opacity:.45;cursor:not-allowed}
.rcw-root button:focus-visible,.rcw-root summary:focus-visible,.rcw-root select:focus-visible{outline:2px solid #92afe3;outline-offset:2px}
.rcw-content{max-width:1218px;margin:0 auto}
.rcw-cap{font-size:11px;font-weight:720;letter-spacing:.65px;color:#8290a2}
.rcw-muted{color:var(--rcw-sub)}
.rcw-dim{color:var(--rcw-dim)}
.rcw-tiny{font-size:11px}
.rcw-nowrap{white-space:nowrap}
.rcw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;word-break:break-all}
.rcw-headline{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:22px}
.rcw-headline-left{min-width:0}
.rcw-headline h1{margin-top:4px}
.rcw-headline .rcw-sub{color:var(--rcw-sub);font-size:13px;margin-top:7px}
.rcw-headline-right{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.rcw-grid{display:grid;grid-template-columns:minmax(0,1.73fr) minmax(273px,.78fr);gap:19px;align-items:start}
.rcw-detailgrid{grid-template-columns:minmax(0,1.55fr) minmax(260px,.77fr)}
.rcw-main{min-width:0}
.rcw-aside{display:flex;flex-direction:column;gap:16px;min-width:0}
.rcw-paper{background:var(--rcw-surface);border:1px solid var(--rcw-border);border-radius:var(--rcw-radius);box-shadow:var(--rcw-shadow)}
.rcw-hero{padding:24px 26px}
.rcw-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
.rcw-hero h2{font-size:22px;margin-top:6px}
.rcw-hero .rcw-sub{color:var(--rcw-sub);font-size:13px;margin-top:7px}
.rcw-select{background:#fff;border:1px solid var(--rcw-border2);border-radius:8px;padding:8px 9px;color:#566880;font-size:12px;min-width:135px;max-width:240px}
.rcw-metrics{display:flex;margin-top:20px;padding:18px 0 15px;border-top:1px solid var(--rcw-border);border-bottom:1px solid var(--rcw-border);flex-wrap:wrap}
.rcw-metric{flex:1;min-width:110px;border-right:1px solid #edf0f4;padding:0 14px}
.rcw-metric:first-child{padding-left:0}
.rcw-metric:last-child{border-right:0;padding-right:0}
.rcw-metric strong{display:block;font-size:22px;line-height:1.3;font-weight:680;color:#394e6b}
.rcw-metric small{display:block;font-size:11px;color:#8190a3;margin-top:6px}
.rcw-chip{display:inline-flex;align-items:center;gap:5px;border-radius:7px;padding:4px 8px;background:#f2f4f7;color:#66768a;font-weight:650;font-size:11px;white-space:nowrap}
.rcw-chip-green{background:var(--rcw-greenbg);color:var(--rcw-green)}
.rcw-chip-blue{background:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-chip-amber{background:var(--rcw-amberbg);color:var(--rcw-amber)}
.rcw-chip-red{background:var(--rcw-redbg);color:var(--rcw-red)}
.rcw-chiprow{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.rcw-dot{width:7px;height:7px;border-radius:100%;background:#bdc7d3;flex:none;display:inline-block}
.rcw-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--rcw-border2);background:#fff;color:#566780;padding:9px 13px;min-height:36px;border-radius:9px;font-size:12px;font-weight:660;white-space:nowrap;transition:background .15s}
.rcw-btn:hover{background:#f5f8fd}
.rcw-btn-blue{background:var(--rcw-blue);color:#fff;border-color:var(--rcw-blue)}
.rcw-btn-blue:hover{background:var(--rcw-blue2)}
.rcw-btn-soft{background:var(--rcw-bluebg);border-color:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-btn-sm{min-height:30px;padding:5px 10px;font-size:11px}
.rcw-btn-negative{color:var(--rcw-red)}
.rcw-textbtn{border:0;background:transparent;color:var(--rcw-blue);font-size:12px;font-weight:660;padding:5px 0}
.rcw-textbtn:hover{text-decoration:underline}
.rcw-sectionhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:26px 1px 12px}
.rcw-sectionhead h2{font-size:14px}
.rcw-sectionhead small{color:var(--rcw-dim)}
.rcw-filterbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.rcw-filter{border:1px solid var(--rcw-border);background:#fff;color:#5b708e;font-size:11px;font-weight:650;padding:6px 11px;border-radius:999px}
.rcw-filter-active{background:var(--rcw-bluebg);border-color:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-list{overflow:hidden}
.rcw-appitem{width:100%;border:0;background:#fff;text-align:left;display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #eff1f5;color:inherit}
.rcw-appitem:last-child{border-bottom:0}
.rcw-appitem:hover{background:#fafbfd}
.rcw-av{width:35px;height:35px;flex:none;display:grid;place-items:center;border-radius:11px;background:#edf2f7;color:#56718e;font-size:13px;font-weight:680}
.rcw-rowmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.rcw-rowtitle{font-size:13px;font-weight:680;min-width:0}
.rcw-rowjob{font-weight:590;color:#7b899d;font-size:11px;margin-left:6px}
.rcw-rowmeta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:#8490a3}
.rcw-rowend{display:flex;align-items:center;gap:6px;flex:none}
.rcw-chev{color:#a8b3c2;font-size:18px;margin-left:2px}
.rcw-joblist{padding:6px 0}
.rcw-jobrow{width:100%;border:0;border-bottom:1px solid #f1f2f5;background:transparent;display:flex;align-items:center;gap:10px;padding:12px 4px;text-align:left;color:inherit}
.rcw-jobrow:last-child{border-bottom:0}
.rcw-jobrow:hover{background:#fafbfd}
.rcw-jobrow-active{background:#f3f7fd;border-radius:9px;padding-left:8px;padding-right:8px}
.rcw-jobrow .rcw-av{width:30px;height:30px;border-radius:9px;font-size:12px}
.rcw-jobrow strong{display:block;font-size:12px;font-weight:680}
.rcw-jobrow small{display:block;color:#8190a3;font-size:11px;margin-top:2px}
.rcw-asidecard{padding:20px}
.rcw-asidecard h2{font-size:14px;margin-bottom:8px}
.rcw-kv{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed #eef1f5;font-size:12px}
.rcw-kv:last-child{border-bottom:0}
.rcw-kv .rcw-k{color:#7b899d;flex:none}
.rcw-kv .rcw-v{text-align:right;min-width:0}
.rcw-nextstep{margin-top:18px;padding:16px 18px;border-radius:12px;background:#f6f9fd;border:1px solid #e8eff9}
.rcw-nextstep-main{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}
.rcw-nextstep-main strong{font-size:15px;font-weight:680}
.rcw-nextstep-meta{margin-top:7px;font-size:11px;color:#7787a0;display:flex;gap:12px;flex-wrap:wrap}
.rcw-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:#8490a3;word-break:break-all}
.rcw-inlineactions{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:16px}
.rcw-actionwrap{display:flex;flex-direction:column;gap:4px;min-width:0}
.rcw-pending{font-size:10px;color:#9aa6b6;max-width:220px}
.rcw-divider{height:1px;background:var(--rcw-border);margin:16px 0}
.rcw-insight{padding:17px 18px;border-radius:12px;background:#f6f8fb;border:1px solid #edf1f6}
.rcw-insight h3{font-size:13px}
.rcw-insight p{margin-top:6px;font-size:12px;color:#516177;line-height:1.85}
.rcw-disclosure{margin-top:12px;padding:14px 16px}
.rcw-disclosure summary{cursor:pointer;font-weight:670;font-size:12px;color:#566780;list-style-position:outside}
.rcw-disclosure summary::marker{color:#9aa8ba}
.rcw-disclosure-body{margin-top:13px}
.rcw-subhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:14px 0 8px}
.rcw-subhead h3{font-size:13px}
.rcw-cardrow{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.rcw-smallcard{padding:14px 15px;border:1px solid var(--rcw-border);border-radius:11px;min-width:0}
.rcw-smallcard strong{display:block;font-size:12px}
.rcw-smallcard p{font-size:11px;color:#8190a3;margin-top:5px}
.rcw-tablewrap{overflow-x:auto;border:1px solid var(--rcw-border);border-radius:11px}
.rcw-table{width:100%;border-collapse:collapse;min-width:520px}
.rcw-table th{font-size:11px;color:#8b98a9;text-align:left;font-weight:670;padding:10px 12px;border-bottom:1px solid var(--rcw-border);background:#fafbfd;white-space:nowrap}
.rcw-table td{padding:10px 12px;border-bottom:1px solid #eff1f5;font-size:12px;vertical-align:top}
.rcw-table tr:last-child td{border-bottom:0}
.rcw-sourcebox{padding:14px;background:#fbfcfd;border:1px solid var(--rcw-border);border-radius:11px;white-space:pre-wrap;color:#53647a;font-size:12px;line-height:1.9;word-break:break-word}
.rcw-quote{background:#f2f6fc;border-left:3px solid #92add9;border-radius:0 7px 7px 0;padding:9px 12px;font-size:12px;color:#53667f;margin-top:8px}
.rcw-criteria{display:flex;gap:9px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #eff2f5}
.rcw-criteria:last-child{border-bottom:0}
.rcw-criteria .rcw-dot{margin-top:8px}
.rcw-criteriabody{font-size:12px;color:#69788d;min-width:0}
.rcw-criteriabody strong{color:#4d5f77}
.rcw-timeline{padding:2px 0}
.rcw-timelineitem{padding:9px 0;border-bottom:1px solid #f2f3f6;font-size:12px}
.rcw-timelineitem:last-child{border:0}
.rcw-timelineitem small{display:block;color:#8996a9;margin-top:3px;font-size:11px}
.rcw-alert{border:1px solid #f0d5d2;background:var(--rcw-redbg);color:#8c4642;border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:12px}
.rcw-alert pre{margin:8px 0 0;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;color:#9a5a56}
.rcw-notice{border:1px solid #f3e9d7;background:#fff9ee;color:#987749;border-radius:11px;padding:11px 14px;margin-bottom:16px;font-size:12px;font-weight:650}
.rcw-empty{padding:26px 20px;text-align:center;color:#8b97a8;font-size:12px}
.rcw-loading{padding:22px 20px;color:#7b899d;font-size:12px}
.rcw-back{border:0;background:transparent;color:#7c8aa0;padding:0;margin-bottom:16px;font-size:12px}
.rcw-back:hover{color:var(--rcw-blue)}
.rcw-detailmain{padding:24px 26px}
.rcw-detailaside{gap:15px}
.rcw-detailgrid .rcw-aside{min-width:0}
.rcw-cards-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.rcw-file{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.rcw-badge{font-size:10px;font-weight:720;letter-spacing:.4px;border-radius:6px;padding:3px 7px;background:#f2f4f7;color:#66768a;white-space:nowrap}
.rcw-badge-live{background:var(--rcw-greenbg);color:var(--rcw-green)}
.rcw-badge-fixture{background:var(--rcw-amberbg);color:var(--rcw-amber)}
.rcw-badge-connected{background:var(--rcw-greenbg);color:var(--rcw-green)}
.rcw-badge-not_connected{background:#f2f4f7;color:#66768a}
.rcw-badge-auth_required{background:var(--rcw-redbg);color:var(--rcw-red)}
.rcw-badge-event{background:var(--rcw-bluebg);color:var(--rcw-blue2)}
.rcw-badge-manual{background:var(--rcw-amberbg);color:var(--rcw-amber)}
.rcw-fields-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.rcw-fieldrow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;border-bottom:1px dashed #eef1f5;padding:5px 0;font-size:12px;min-width:0}
.rcw-fieldrow .rcw-fieldkey{color:#7b899d}
.rcw-fieldrow .rcw-fieldval{text-align:right;min-width:0;color:#53647a}
.rcw-stagebar{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.rcw-stageseq{display:flex;align-items:center;gap:5px;font-size:11px;color:#8b98a9;flex-wrap:wrap}
.rcw-stagepill{border-radius:6px;padding:2px 7px;background:#f2f4f7;color:#7b899d}
.rcw-stagepill-now{background:var(--rcw-bluebg);color:var(--rcw-blue2);font-weight:700}
.rcw-stagepill-done{background:var(--rcw-greenbg);color:var(--rcw-green)}
/* ---- W2b 新增（只新增 class，不改既有 token 值）：轮次重点卡 / 人类闸门弹窗 / 写表单 ---- */
.rcw-roundfocus{margin-top:16px;padding:16px 18px;border-radius:12px;background:#f7fafd;border:1px solid #e6eef8}
.rcw-roundfocus-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.rcw-roundfocus-title{margin-top:10px;font-size:15px;font-weight:680;color:#394e6b}
.rcw-roundfocus-desc{margin-top:7px;font-size:12px;color:#516177;line-height:1.85}
.rcw-roundfocus-block{margin-top:10px}
.rcw-roundfocus-list{list-style:decimal inside;margin:0;padding:0}
.rcw-roundfocus-list .rcw-quote{list-style:none;margin-top:6px}
.rcw-roundfocus-note{margin-top:10px;font-size:11px;color:var(--rcw-amber);background:var(--rcw-amberbg);border-radius:8px;padding:8px 10px}
.rcw-roundfocus-degrade{margin-top:10px;font-size:12px;color:#516177;line-height:1.85}
.rcw-roundfocus-degrade p{margin-top:6px}
.rcw-modalscrim{position:fixed;inset:0;background:rgba(41,56,77,.38);display:flex;align-items:flex-start;justify-content:center;padding:48px 18px;z-index:60;overflow-y:auto}
.rcw-modal{width:min(620px,100%);background:var(--rcw-surface);border:1px solid var(--rcw-border2);border-radius:var(--rcw-radius);box-shadow:0 18px 60px rgba(30,45,70,.18);padding:24px 26px}
.rcw-modal h2{font-size:18px;font-weight:720}
.rcw-modal-job{margin-top:6px;font-size:12px;font-weight:650;color:#394e6b}
.rcw-modal-body{margin-top:12px;font-size:12px;color:#516177;line-height:1.9}
.rcw-modal-body p{margin-top:3px}
.rcw-modalfield{display:flex;flex-direction:column;gap:5px;margin-top:12px;font-size:12px;color:#516177;font-weight:600}
.rcw-modalerror{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--rcw-redbg);border:1px solid #f0d5d2;color:#8c4642;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all}
.rcw-textarea,.rcw-input{width:100%;border:1px solid var(--rcw-border2);border-radius:9px;padding:8px 10px;font:inherit;font-size:12px;color:var(--rcw-text);background:#fff}
.rcw-textarea{resize:vertical;min-height:64px;line-height:1.7}
.rcw-textarea:disabled,.rcw-input:disabled{background:#f5f7fa;color:#8b97a8}
.rcw-writeform{margin-top:16px;padding:14px 15px;border:1px solid var(--rcw-border);border-radius:11px}
.rcw-writeform strong{display:block;font-size:12px;margin-bottom:4px}
.rcw-writeform .rcw-btn{margin-top:10px}
/* ---- W2b 新增结束 ---- */
@media (max-width:1100px){
  .rcw-root{padding:24px 24px 88px}
  .rcw-grid{grid-template-columns:minmax(0,1.4fr) minmax(255px,.78fr);gap:16px}
  .rcw-detailgrid{grid-template-columns:minmax(0,1.3fr) minmax(240px,.7fr)}
  .rcw-hero{padding:21px 22px}
  .rcw-detailmain{padding:21px 22px}
}
@media (max-width:850px){
  .rcw-root{padding:20px 18px 74px}
  .rcw-grid,.rcw-detailgrid{grid-template-columns:1fr}
  .rcw-aside{display:grid;grid-template-columns:1fr 1fr}
  .rcw-headline{align-items:flex-start;flex-direction:column;gap:10px}
  .rcw-headline h1{font-size:21px}
  .rcw-headline-right{justify-content:flex-start;width:100%}
  .rcw-cards-grid,.rcw-cardrow{grid-template-columns:1fr}
  .rcw-fields-grid{grid-template-columns:1fr}
}
@media (max-width:570px){
  .rcw-root{padding:16px 13px 56px}
  .rcw-modalscrim{padding:16px 10px}
  .rcw-modal{width:100%;padding:18px 15px}
  .rcw-modal-body{font-size:12px}
  .rcw-headline{margin-bottom:15px}
  .rcw-hero{padding:18px 16px}
  .rcw-hero h2{font-size:20px}
  .rcw-hero-top{flex-direction:column}
  .rcw-select{max-width:100%;width:100%}
  .rcw-aside{display:flex}
  .rcw-metric{min-width:calc(50% - 14px);padding:6px 12px}
  .rcw-metric:nth-child(2n){border-right:0}
  .rcw-metric:nth-child(n+3){border-top:1px solid #edf0f4;margin-top:8px;padding-top:12px}
  .rcw-appitem{padding:13px 12px;gap:10px;align-items:flex-start}
  .rcw-rowend{flex-direction:column;align-items:flex-end;gap:4px}
  .rcw-rowmeta{gap:5px}
  .rcw-detailmain{padding:19px 16px}
  .rcw-asidecard{padding:16px}
  .rcw-table{min-width:460px}
  .rcw-table th:nth-child(3),.rcw-table td:nth-child(3){display:none}
  .rcw-inlineactions{gap:7px}
  .rcw-actionwrap{flex:1 1 45%}
  .rcw-btn{width:100%}
  .rcw-headline-right .rcw-btn{width:auto}
}
`

/** 供组件渲染 `<style>` 用的唯一 key（避免 React 复用警告）。 */
export const STYLE_ELEMENT_KEY = 'rcw-styles'
