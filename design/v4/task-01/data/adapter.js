/**
 * Recruitment OS · 数据适配层（Task 03 升级版：真连后端 + 4 个确认卡写入口 + 上传轮询进度）
 * 导出 createApi({ mode, baseUrl })，支持 'mock' | 'http' 双模式。
 *
 * 契约依据：
 * - design/v4/contracts/api-samples/*.json
 * - design/v4/contracts/available-actions.md
 * - design/v4/contracts/client-plugin-contract.md
 *
 * 硬规则：
 * - http 模式所有请求同源（credentials: 'same-origin'）+ 带 x-recruitment-request: 1，前端绝不传 actor
 * - 所有写操作带 confirmation_text（人的确认原话）
 * - job/create 绝不传 headcount（HC 由需求单维护）
 * - 未接通动作抛出 NOT_AVAILABLE，前台提示「这项还差最后一步，稍后开放」
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./mock.js'));
  } else {
    root.createApi = factory(root.RecruitmentMock).createApi;
    root.RecruitmentAdapter = factory(root.RecruitmentMock);
  }
})(typeof self !== 'undefined' ? self : this, function (MockMod) {
  'use strict';

  const UNAVAILABLE_MSG = '这项还差最后一步，稍后开放';

  const STAGE_LABEL_MAP = {
    S1: '需求立项',
    S2: '职位发布',
    S3: '岗位标准',
    S4: '寻访触达',
    S5: '候选人投递',
    S6: '简历接入',
    S7: '初筛评估',
    S8: '面试安排',
    S9: '面试记录',
    S10: '三面终审',
    S11: 'Offer 待确认',
    S12: '录用归档'
  };

  function createNotAvailableError(actionOrResource) {
    const err = new Error(UNAVAILABLE_MSG);
    err.code = 'NOT_AVAILABLE';
    err.userMessage = UNAVAILABLE_MSG;
    err.target = actionOrResource;
    return err;
  }

  function formatShortTime(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function calcHoursSince(iso) {
    if (!iso || typeof iso !== 'string') return 0;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 3600000));
  }

  function stageLabelOf(code, lifecycle) {
    if (lifecycle && lifecycle !== 'ACTIVE' && lifecycle !== 'HIRED') return '已结束';
    const c = String(code || '').toUpperCase();
    return STAGE_LABEL_MAP[c] || '推进中';
  }

  function createApi(options) {
    const cfg = Object.assign({ mode: 'mock', baseUrl: '' }, options || {});
    const mode = cfg.mode === 'http' ? 'http' : 'mock';
    const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
    const store = MockMod.createMockStore();

    // ---------------- Shared Mock Command Parser (Chat stays mock until host SSE lands) ----------------
    function parseCommandMock(rawText, ctx) {
      const t = String(rawText || '').trim();
      const candidates = (ctx && ctx.candidates) || store.state.candidates;
      const roles = (ctx && ctx.roles) || store.state.roles;
      const activeCandId = ctx && ctx.activeCandId;
      const getRole = (id) => roles.find((r) => r.id === id) || roles[0] || { id: '', name: '在招岗位' };
      const getCand = (id) => candidates.find((c) => c.id === id);

      if (!t || candidates.length === 0) return { kind: 'noop' };

      const exactMention = candidates.find((c) => t.includes(c.name));
      if (!exactMention && t.includes('林同学')) {
        const lins = candidates.filter((c) => c.name.startsWith('林'));
        if (lins.length > 1) {
          return {
            kind: 'disambig',
            message: {
              role: 'ai',
              text: `当前有 ${lins.length} 位姓林的候选人，为避免误操作，请点选你要处理的那一位：`,
              origCmd: t,
              disambig: lins.map((x) => ({
                id: x.id,
                label: `${x.name} · ${getRole(x.roleId).name.split('（')[0]}（${x.stage}）`
              }))
            }
          };
        }
      }

      const mentioned =
        exactMention ||
        candidates.find((c) => t.includes(c.name.slice(0, 1) + '同学') || t.includes(c.name.slice(0, 2)));
      const c = mentioned || (activeCandId ? getCand(activeCandId) : candidates[0]);

      if (
        (t.includes('通过') || t.includes('初筛')) &&
        (t.includes('约') || t.includes('一面')) &&
        (t.includes('字节') || t.includes('竞品') || t.includes('加急'))
      ) {
        return {
          kind: 'open_modal',
          modal: { type: 'compound', candId: c.id, pinText: '字节 Offer 周五截止 · 加急' },
          message: {
            role: 'ai',
            text: '已将你的连环指令拆解为 3 步（推进一面 + 置顶竞品加急 + 匹配明天 15:00 空闲时段），在居中确认卡点一次即可全部执行。',
            tag: '3 步复合编排'
          }
        };
      }
      if (t.includes('设置') || t.includes('外部连接') || t.includes('自动化边界')) {
        return {
          kind: 'navigate',
          nav: { space: 'settings', activeCandId: null },
          message: { role: 'ai', text: '已为你打开工作空间设置，可查看飞书/邮箱连接状态与自动化边界。' }
        };
      }
      if (t.includes('字节') || t.includes('竞品') || t.includes('期望') || t.includes('到岗')) {
        return {
          kind: 'action',
          actionName: 'pin_constraint',
          payload: {
            candId: c.id,
            candidateId: c.candidateId || c.id,
            text: t.length > 6 ? t : '字节 Offer 周五截止 · 期望 45k',
            kind: 'red',
            source: 'CHAT',
            confirmationText: t
          },
          openCandId: c.id,
          message: {
            role: 'ai',
            text: `已将竞品 Offer 与薪资预期置顶到 ${c.name} 档案头部，并同步提醒面试官。`,
            tag: '已置顶约束'
          }
        };
      }
      if (t.includes('对比')) {
        const jobId = t.includes('Java') ? (roles.find((r) => r.name.includes('Java')) || roles[0]).id : roles[0].id;
        return {
          kind: 'navigate',
          nav: { space: 'jobs', activeJobId: jobId, activeCandId: null, jobTab: 'compare' },
          message: { role: 'ai', text: `已进入「${getRole(jobId).name}」并切换到同池对比视图。` }
        };
      }
      if (t.includes('人才库') || t.includes('捞人')) {
        return {
          kind: 'navigate',
          nav: { space: 'talent', activeCandId: null },
          message: { role: 'ai', text: '已为你切换至人才库。' }
        };
      }
      if (t.includes('改期') || t.includes('换面试官') || t.includes('换给') || t.includes('改到')) {
        const targetC = mentioned || candidates.find((x) => x.id === 'zhou') || c;
        const ownerM = t.match(/换给([^，,。\s]{2,4})/);
        return {
          kind: 'open_modal',
          modal: { type: 'reschedule', candId: targetC.id, newOwner: ownerM ? ownerM[1] : '张工' },
          message: {
            role: 'ai',
            text: `已为 ${targetC.name} 准备好改期与更换面试官确认卡（自动重新绑定飞书妙记归属），确认即可同步双方。`,
            tag: '改期换人'
          }
        };
      }
      if (t.includes('留个提醒') || t.includes('留提醒') || t.includes('重点问') || t.includes('交接提醒')) {
        const noteM = t.match(/(?:提醒|问)[：:\s]*([^。；;]+)/);
        const noteText = noteM ? noteM[1].trim() : t;
        return {
          kind: 'action',
          actionName: 'add_handoff_iq',
          payload: {
            candId: c.id,
            candidateId: c.candidateId || c.id,
            interviewId: c.nextInterviewId || undefined,
            text: noteText,
            source: 'CHAT',
            confirmationText: t
          },
          openCandId: c.id,
          message: {
            role: 'ai',
            text: `已将这条专属追问置顶写入 ${c.name} 的面试简报，面试官切到「面试官」视角即可第一眼看到。`,
            tag: '已写入面试交接'
          }
        };
      }
      if (t.includes('周报') || t.includes('汇报') || t.includes('进展汇总')) {
        return {
          kind: 'navigate',
          nav: { space: 'report', activeCandId: null },
          message: {
            role: 'ai',
            text: '已根据最新 HC 与候选人实时状态生成本周招聘进展汇报，右侧可直接一键复制发飞书群。',
            tag: '已生成周报'
          }
        };
      }
      if (t.includes('感谢信') || t.includes('婉拒')) {
        return {
          kind: 'open_modal',
          modal: { type: 'thankyou', candId: c.id },
          message: { role: 'ai', text: `已为 ${c.name} 拟好礼貌婉拒邮件，核对无误点一下确认即可发出。` }
        };
      }
      if (t.includes('催') && t.includes('面评')) {
        return {
          kind: 'open_modal',
          modal: { type: 'nudge' },
          message: { role: 'ai', text: '已准备好给王工的飞书提醒，确认即可发出。' }
        };
      }
      if (t.includes('新建岗位')) {
        const nm = t.replace(/.*新建岗位[：:\s]*/, '').split(/[，,\s]/)[0] || '前端架构师';
        return {
          kind: 'open_modal',
          modal: { type: 'new_job', name: nm, hc: 1 },
          message: { role: 'ai', text: `已准备好「${nm}」的岗位创建单。` }
        };
      }
      if (t.includes('跳轮') || t.includes('直通终审')) {
        const rm = t.match(/(?:原因|因为)[是为：:\s]*([^，,。；;]+)/);
        return {
          kind: 'open_modal',
          modal: { type: 'skip', candId: c.id, reason: rm ? rm[1] : '' },
          message: { role: 'ai', text: `已弹出 ${c.name} 的跳轮确认单。` }
        };
      }
      if (t.toLowerCase().includes('offer')) {
        if (c.stage === '初筛评估') {
          return {
            kind: 'message_only',
            message: { role: 'ai', text: `${c.name} 还在初筛阶段，不能直接发 Offer。` }
          };
        }
        return {
          kind: 'open_modal',
          openCandId: c.id,
          modal: { type: 'offer', candId: c.id },
          message: { role: 'ai', text: `已为 ${c.name} 套用 Offer 邮件模板，确认即可发送。` }
        };
      }
      if (t.includes('调剂') || t.includes('转')) {
        return {
          kind: 'open_modal',
          modal: { type: 'transfer', candId: c.id },
          message: { role: 'ai', text: `已准备好 ${c.name} 的跨岗调剂单。` }
        };
      }
      if (t.includes('加面')) {
        return {
          kind: 'open_modal',
          modal: { type: 'add_round', candId: c.id },
          message: { role: 'ai', text: `已为 ${c.name} 准备好专项加面日程卡。` }
        };
      }
      if (t.includes('通过')) {
        const nextStage = c.stage === '初筛评估' ? '一面安排' : '三面终审';
        return {
          kind: 'action',
          actionName: 'pass',
          payload: { candId: c.id, fromCommand: true, confirmationText: t },
          openCandId: c.id,
          message: { role: 'ai', text: `已将 ${c.name} 推进至「${nextStage}」。`, tag: `流转至 ${nextStage}` }
        };
      }
      if (t.includes('岗位标准') || t.toLowerCase().includes('jd') || t.includes('原始信息')) {
        const jobId = roles[0].id;
        return {
          kind: 'navigate',
          nav: { space: 'jobs', activeJobId: jobId, activeCandId: null, jobTab: 'rubric' },
          message: {
            role: 'ai',
            text: `已打开「${getRole(jobId).name}」的考核标准与完整原始 JD。`,
            tag: '岗位标准与 JD'
          }
        };
      }
      if (t.includes('待办') || t.includes('已代办')) {
        const tab = t.includes('已代办') ? 'autodone' : 'pending';
        return {
          kind: 'navigate',
          nav: { space: 'inbox', activeCandId: null, inboxTab: tab },
          message: {
            role: 'ai',
            text: `已为你切回「今日待办 · ${tab === 'autodone' ? 'Agent 已代办' : '等你拍板'}」。`
          }
        };
      }
      if (t.includes('在招岗位') || t.includes('所有岗位')) {
        return {
          kind: 'navigate',
          nav: { space: 'jobs', activeJobId: null, activeCandId: null },
          message: { role: 'ai', text: '已为你展开全部在招岗位的 6 阶段流程总览。' }
        };
      }
      if (t.includes('面试官视角') || t.includes('用人经理视角') || t.includes('HR视角') || t.includes('HR 视角')) {
        const rv = t.includes('面试官') ? 'interviewer' : t.includes('经理') ? 'hm' : 'hr';
        return {
          kind: 'set_role_view',
          roleView: rv,
          message: {
            role: 'ai',
            text: `已为你切换至「${rv === 'interviewer' ? '面试官' : rv === 'hm' ? '用人经理' : 'HR 推进'}」视角。`,
            tag: '切换视角'
          }
        };
      }
      if (t.includes('妙记') || t.includes('录音')) {
        return {
          kind: 'open_doc_tab',
          openCandId: activeCandId ? null : c.id,
          docTab: 'transcript',
          message: { role: 'ai', text: `已为你切换至 ${c.name} 的飞书妙记录音转写。` }
        };
      }
      if (t.includes('深色') || t.includes('暗色') || t.includes('浅色')) {
        const next = t.includes('浅色') ? 'light' : 'dark';
        return {
          kind: 'set_theme',
          theme: next,
          message: { role: 'ai', text: `已切换至${next === 'dark' ? '深色' : '浅色'}外观。` }
        };
      }
      if (t.includes('收起侧边栏') || t.includes('收起导航')) {
        return { kind: 'set_rail', collapsed: true, message: { role: 'ai', text: '已收起最左侧导航栏，随时可按 \\ 或点左上角图标展开。' } };
      }
      if (t.includes('展开侧边栏') || t.includes('展开导航')) {
        return { kind: 'set_rail', collapsed: false, message: { role: 'ai', text: '已展开最左侧导航栏。' } };
      }
      if (t.includes('收起对话')) {
        return { kind: 'set_chat', collapsed: true, message: { role: 'ai', text: '已收起对话栏，随时可按 [ 或点左下角展开。' } };
      }
      if (t.includes('看') || mentioned) {
        return {
          kind: 'open_candidate',
          openCandId: c.id,
          message: { role: 'ai', text: `已顺着「${getRole(c.roleId).name} / ${c.name}」为你展开完整简历与审阅画布。` }
        };
      }
      return {
        kind: 'message_only',
        message: { role: 'ai', text: '你可以直接说「看林同学初筛」「对比候选人」「给陈同学发 Offer」或「林同学有字节 Offer 周五截止，期望 45k」。' }
      };
    }

    // ---------------- MOCK MODE (unchanged behavior vs Task 01) ----------------
    if (mode === 'mock') {
      const s = store.state;
      const getRole = (id) => s.roles.find((r) => r.id === id) || s.roles[0];
      const getCand = (id) => s.candidates.find((c) => c.id === id);

      return {
        mode: 'mock',
        async getBootstrap() {
          return store.clone({
            actor: s.actor,
            roles: s.roles,
            candidates: s.candidates,
            autoDone: s.autoDone,
            nudgePending: s.nudgePending,
            nudgeItem: s.nudgeItem,
            messages: s.messages,
            connectors: s.connectors,
            autoRules: s.autoRules,
            slaConfig: s.slaConfig,
            options: s.options
          });
        },
        async getToday(params) {
          const rv = (params && params.roleView) || s.actor.roleView || 'hr';
          const pending = s.candidates.filter((c) => {
            if (c.stage === '已结束' || c.stage === '录用归档') return false;
            if (rv === 'interviewer') return c.stage.includes('面');
            if (rv === 'hm') return c.stage === '初筛评估' || c.stage === '三面终审';
            return true;
          });
          return store.clone({
            pendingCandidates: pending,
            nudgePending: s.nudgePending,
            nudgeItem: s.nudgeItem,
            autoDone: s.autoDone,
            stuckTasks: []
          });
        },
        async getJob(jobId) {
          const job = getRole(jobId);
          return store.clone({ job, candidates: s.candidates.filter((c) => c.roleId === job.id) });
        },
        async getApplication(id) {
          const cand = getCand(id);
          return cand ? store.clone(cand) : null;
        },
        async getInterview(id) {
          const cand = getCand(id);
          if (!cand) return null;
          const job = getRole(cand.roleId);
          return store.clone({
            application: cand,
            assigned: cand.rounds[cand.rounds.length - 1] || null,
            prevSummary: cand.summary,
            rubricRef: job.rubric,
            iqs: cand.iqs,
            notes: cand.notes
          });
        },
        async submit(actionName, payload) {
          const p = payload || {};
          const hm = store.nowHM();
          if (actionName === 'set_actor') {
            s.actor.roleView = p.roleView || 'hr';
            return { ok: true, actor: store.clone(s.actor) };
          }
          if (actionName === 'pass') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            const isScreen = c.stage === '初筛评估';
            c.stage = isScreen ? '一面安排' : '三面终审';
            c.hours = 0;
            c.timeline.unshift({ t: hm, d: p.fromCommand ? `对话指令推进至「${c.stage}」` : `人工拍板推进至「${c.stage}」` });
            return { ok: true, candidate: store.clone(c), nextStage: c.stage };
          }
          if (actionName === 'skip') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.stage = '三面终审';
            c.hours = 0;
            c.rounds.push({ t: '三面终审（跳轮）', s: '待拍板', d: `确认原话：${p.reason}` });
            c.timeline.unshift({ t: hm, d: `人工原话跳轮直通终审（${p.reason}）` });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'reschedule') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            const calConn = s.connectors.find((x) => x.id === 'cal');
            if (calConn && !calConn.connected && !p.forceReconnect) return { ok: false, connectorDown: 'cal', candidate: store.clone(c) };
            if (calConn && p.forceReconnect) calConn.connected = true;
            const newOwner = p.newOwner || '张工';
            const lastR = c.rounds[c.rounds.length - 1];
            const slotShort = `${p.slot.split(' ')[0]} ${p.slot.split(' ')[1]}`;
            if (lastR) {
              lastR.t = `二面 · ${newOwner}`;
              lastR.s = `改期 · ${slotShort}`;
              lastR.d = `已替换面试官为 ${newOwner}，重新绑定飞书妙记归属并通知候选人。`;
            }
            c.pinned = [{ t: `改期至 ${slotShort} · ${newOwner}`, kind: 'neutral' }];
            c.timeline.unshift({ t: hm, d: `临时换面试官为 ${newOwner} 并改期至 ${p.slot}（飞书日程与妙记已同步）` });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'thankyou') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.timeline.unshift({ t: hm, d: '已通过企业邮箱发送礼貌婉拒邮件' });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'nudge') {
            s.nudgePending = false;
            s.autoDone.unshift({ id: 'a' + Date.now(), t: '刚刚', text: '已向王工发送飞书催交面评提醒', undone: false });
            return { ok: true, nudgePending: false, autoDone: store.clone(s.autoDone) };
          }
          if (actionName === 'offer') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            if (c.offerStatus === 'SENT') return { ok: false, duplicate: true };
            const mailConn = s.connectors.find((x) => x.id === 'mail');
            if (mailConn && !mailConn.connected && !p.forceReconnect) return { ok: false, connectorDown: 'mail', candidate: store.clone(c) };
            if (mailConn && p.forceReconnect) mailConn.connected = true;
            c.offerStatus = 'SENT';
            c.stage = 'Offer 待确认';
            c.timeline.unshift({ t: hm, d: '已发送正式 Offer 邮件，等待确认' });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'offer_accept') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            const r = getRole(c.roleId);
            c.offerStatus = 'ACCEPTED';
            c.stage = '录用归档';
            r.hcFilled = Math.min(r.hcTotal, r.hcFilled + 1);
            c.timeline.unshift({ t: hm, d: '候选人已回复邮件正式接受 Offer' });
            return { ok: true, candidate: store.clone(c), role: store.clone(r) };
          }
          if (actionName === 'offer_decline') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            const r = getRole(c.roleId);
            c.offerStatus = 'DECLINED';
            c.stage = '已结束';
            c.timeline.unshift({ t: hm, d: '候选人已婉拒 Offer，申请关闭归档（HC 未占用）' });
            return { ok: true, candidate: store.clone(c), role: store.clone(r) };
          }
          if (actionName === 'transfer') {
            const c = getCand(p.candId);
            const t = getRole(p.targetId);
            if (!c || !t) return { ok: false };
            const cl = store.clone(c);
            cl.id = c.id + '_x' + Date.now().toString().slice(-3);
            cl.roleId = t.id;
            cl.stage = '一面安排';
            cl.timeline.unshift({ t: hm, d: `从「${getRole(c.roleId).name}」跨岗调剂至「${t.name}」` });
            s.candidates.unshift(cl);
            return { ok: true, clonedCandidate: store.clone(cl), targetRole: store.clone(t) };
          }
          if (actionName === 'compound') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.stage = '一面安排';
            c.hours = 0;
            c.pinned.unshift({ t: p.pinText, kind: 'red' });
            c.rounds.push({ t: '一面（业务与基础）', s: `已约 · ${p.slot.split(' ')[0]} ${p.slot.split(' ')[1]}`, d: `已通过飞书日历锁定 ${p.slot}，并提醒面试官竞品加急。` });
            c.timeline.unshift({ t: hm, d: `联动完成：通过初筛 + 置顶「${p.pinText}」+ 锁定一面日程（${p.slot}）` });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'add_round') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            const calConn = s.connectors.find((x) => x.id === 'cal');
            if (calConn && !calConn.connected && !p.forceReconnect) return { ok: false, connectorDown: 'cal', candidate: store.clone(c) };
            if (calConn && p.forceReconnect) calConn.connected = true;
            c.rounds.splice(Math.max(1, c.rounds.length - 1), 0, {
              t: p.label || '加面 · 交叉核实',
              s: `已约 · ${p.slot.split(' ')[0]}`,
              d: `已锁定 ${p.slot} · ${p.focus || '核实并发状态回滚深度'}`
            });
            c.timeline.unshift({ t: hm, d: `已插入专项加面并锁定飞书日程（${p.slot}）` });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'reject') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.stage = '已结束';
            c.timeline.unshift({ t: hm, d: `关闭申请（原因：${p.reason}）` });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'batch_reject') {
            (p.ids || []).forEach((id) => {
              const c = getCand(id);
              if (c) {
                c.stage = '已结束';
                c.timeline.unshift({ t: hm, d: `批量关闭申请（${p.reason}）` });
              }
            });
            return { ok: true, count: (p.ids || []).length };
          }
          if (actionName === 'scorecard') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.rounds.push({ t: '本轮面评', s: '4.5 分 · 推荐', d: p.summary });
            c.stage = '三面终审';
            c.timeline.unshift({ t: hm, d: '面试官提交结构化面评（4.5 分 · 推荐）' });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'new_job') {
            const nm = String(p.name || '前端架构师').trim();
            const hc = Math.max(1, Number(p.hc || 1));
            const id = 'j' + Date.now();
            const newRole = { id, name: nm, dept: '技术部', hcTotal: hc, hcFilled: 0, rubricVersion: 'V1', rubric: ['核心架构与 0-1 落地', '工程化与稳定性', '跨团队推动能力'] };
            s.roles.unshift(newRole);
            return { ok: true, role: store.clone(newRole) };
          }
          if (actionName === 'toggle_connector') {
            const co = s.connectors.find((x) => x.id === p.id);
            if (!co) return { ok: false };
            co.connected = !co.connected;
            return { ok: true, connector: store.clone(co) };
          }
          if (actionName === 'toggle_rule') {
            const ar = s.autoRules.find((x) => x.id === p.id);
            if (!ar || ar.locked) return { ok: false };
            ar.silent = !!p.silent;
            return { ok: true, rule: store.clone(ar) };
          }
          if (actionName === 'undo_auto_done') {
            const it = s.autoDone.find((x) => x.id === p.id);
            if (!it) return { ok: false };
            it.undone = true;
            return { ok: true, item: store.clone(it) };
          }
          if (actionName === 'star') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.starred = !c.starred;
            return { ok: true, starred: c.starred };
          }
          if (actionName === 'toggle_iq') {
            const c = getCand(p.candId);
            if (!c || !c.iqs[p.index]) return { ok: false };
            c.iqs[p.index].done = !!p.done;
            return { ok: true };
          }
          if (actionName === 'save_notes') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.notes = p.notes || '';
            return { ok: true };
          }
          if (actionName === 'pin_constraint') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.pinned.unshift({ t: p.text, kind: p.kind || 'red' });
            c.timeline.unshift({ t: hm, d: '置顶竞品 Offer 与薪资预期约束' });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'add_handoff_iq') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            c.iqs.unshift({ t: p.text, done: false, fromHandoff: true });
            c.timeline.unshift({ t: hm, d: `为下一轮面试官留下专属追问：${p.text}` });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'restore_snapshot') {
            if (p.roles) s.roles = store.clone(p.roles);
            if (p.candidates) s.candidates = store.clone(p.candidates);
            if (typeof p.nudgePending === 'boolean') s.nudgePending = p.nudgePending;
            return { ok: true };
          }
          throw createNotAvailableError(actionName);
        },
        async sendCommand(text, ctx) {
          return parseCommandMock(text, ctx);
        },
        async uploadResume(file, jobId) {
          const fileName = typeof file === 'string' ? file : (file && file.name) || s.options.defaultDemoPdf;
          const newCand = store.buildUploadedMockCandidate(fileName, jobId || 'pm');
          s.candidates.unshift(newCand);
          const autoEntry = { id: 'a' + Date.now(), t: '刚刚', text: `自动解析导入的「${fileName}」并完成 4 项岗位标准对齐`, undone: false };
          s.autoDone.unshift(autoEntry);
          return store.clone({ taskId: 'mock_' + Date.now(), status: 'COMPLETED', candidate: newCand, autoEntry, fileName, mockUpload: true });
        },
        async getTaskStatus(taskId) {
          return { taskId, status: 'COMPLETED', errorSummary: null };
        }
      };
    }

    // ---------------- HTTP MODE (Real api-samples/*.json + available-actions.md) ----------------
    async function httpRequest(path, init) {
      const headers = Object.assign({ 'x-recruitment-request': '1' }, (init && init.headers) || {});
      if (init && init.body && typeof init.body === 'string' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(baseUrl + path, Object.assign({ credentials: 'same-origin' }, init || {}, { headers }));
      if (res.status === 404 || res.status === 501) {
        throw createNotAvailableError(path);
      }
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text().catch(() => '');
      if (!res.ok) {
        const msg = (body && typeof body === 'object' && (body.error_summary || body.message || (body.error && body.error.message))) || '暂时无法完成这项操作，请稍后再试';
        const err = new Error(msg);
        err.code = 'HTTP_ERROR';
        err.userMessage = msg;
        throw err;
      }
      return body;
    }

    function normalizeJobFromApi(raw, rubricObj) {
      const j = raw || {};
      const rInfo = rubricObj || j.rubric || {};
      const dims = Array.isArray(rInfo.dimensions) ? rInfo.dimensions : [];
      const counts = j.application_counts || {};
      return {
        id: String(j.job_id || j.id || ''),
        code: j.code || '',
        name: j.title || j.name || '未命名岗位',
        dept: j.department_name || j.dept || '招聘团队',
        hcTotal: Number(j.headcount != null ? j.headcount : counts.total || 1),
        hcFilled: Number(j.filled_count != null ? j.filled_count : 0),
        rubricVersion: `V${rInfo.version_no || 1}`,
        rubricApproved: Boolean(rInfo.approved || (j.rubric && j.rubric.approved)),
        rubric: dims.map((d) => `${d.label || d.key}${d.weight ? `（权重 ${Math.round(d.weight * 100)}%）` : ''}`),
        jd: {
          meta: `${j.department_name || ''} · ${j.code || ''}`.replace(/^ · | · $/g, ''),
          duties: j.description_md || '暂无原始岗位职责描述',
          reqs: j.requirements_md || '暂无原始任职要求',
          bonus: ''
        }
      };
    }

    function normalizeAppSummaryOrDetail(rawRoot) {
      const isEnvelope = Boolean(rawRoot && rawRoot.application);
      const a = isEnvelope ? rawRoot.application : rawRoot || {};
      const cand = a.candidate || {};
      const job = a.job || {};
      const mat = (isEnvelope && rawRoot.resume && rawRoot.resume.material) || a.material || {};
      const fieldStates = mat.field_states || {};
      const screening = a.screening || {};
      const evalObj = screening.evaluation || {};
      const progress = a.progress || {};
      const nextStep = progress.next_step || {};
      const evRubric = isEnvelope && rawRoot.screening_evidence && rawRoot.screening_evidence.rubric ? rawRoot.screening_evidence.rubric : {};
      const dims = Array.isArray(evRubric.dimensions) ? evRubric.dimensions : [];

      const criteria = dims.map((d) => {
        const key = String(d.key || 'c1');
        let s = '待核实';
        let lv = 'amber';
        if (key.includes('work')) {
          s = fieldStates.work_experience === 'present' ? '已匹配' : '未提及';
          lv = fieldStates.work_experience === 'present' ? 'green' : 'red';
        } else if (key.includes('edu')) {
          s = fieldStates.education === 'present' ? '已匹配' : '未提及';
          lv = fieldStates.education === 'present' ? 'green' : 'red';
        } else if (evalObj.verdict === 'PASS') {
          s = d.kind === 'NICE_TO_HAVE' ? '需面试核实' : '已匹配';
          lv = d.kind === 'NICE_TO_HAVE' ? 'amber' : 'green';
        }
        return { k: key, t: d.label || key, s, lv };
      });

      const resumeObj = (isEnvelope && rawRoot.resume) || {};
      const resumeSections = [];
      if (Array.isArray(resumeObj.work_entries) && resumeObj.work_entries.length) {
        resumeSections.push({
          title: '工作经历',
          items: resumeObj.work_entries.map((w) => ({
            k: (criteria.find((x) => x.k.includes('work')) || criteria[0] || { k: 'c1' }).k,
            co: w.title ? `${w.company || ''} · ${w.title}` : w.company || '工作经历',
            time: w.start ? `${w.start} – ${w.end || '至今'}` : '',
            t: w.title ? `担任 ${w.title}` : '简历原件已提取该段经历'
          }))
        });
      }
      if (Array.isArray(resumeObj.education_entries) && resumeObj.education_entries.length) {
        resumeSections.push({
          title: '教育背景',
          items: resumeObj.education_entries.map((e) => ({
            k: (criteria.find((x) => x.k.includes('edu')) || criteria[0] || { k: 'c1' }).k,
            time: e.start ? `${e.start} – ${e.end || ''}` : '',
            t: e.text || ''
          }))
        });
      }
      if (Array.isArray(resumeObj.evidence_samples) && resumeObj.evidence_samples.length) {
        resumeSections.push({
          title: '简历原文摘录',
          items: resumeObj.evidence_samples.map((ev) => ({
            k: (criteria[0] || { k: 'c1' }).k,
            t: ev.quote || ''
          }))
        });
      }

      const rawInterviews = Array.isArray(a.interviews) ? a.interviews : [];
      const rounds = rawInterviews.map((iv, i) => ({
        t: `第 ${iv.round_no || i + 1} 轮面试`,
        s: iv.status === 'COMPLETED' ? '通过' : iv.status === 'POST_INTERVIEW' ? '待收面评' : '已排期',
        d: (iv.round_focus && iv.round_focus.reason) || (Array.isArray(iv.interviewers) && iv.interviewers.length ? `面试官：${iv.interviewers.map((x) => x.display_name).join('、')}` : '已排期')
      }));

      const rawTranscripts = isEnvelope && Array.isArray(rawRoot.transcript_runs) ? rawRoot.transcript_runs : [];
      const transcript = rawTranscripts.length
        ? rawTranscripts.map((tr) => ({ k: 'c1', ts: tr.timestamp || '', t: tr.summary || tr.text || '已同步转录', ctx: tr.context || '' }))
        : [{ k: 'c1', t: '还没有转录' }];

      const timeline = isEnvelope && Array.isArray(rawRoot.timeline)
        ? rawRoot.timeline.map((ev) => ({ t: formatShortTime(ev.at), d: ev.label || '状态更新' }))
        : [];

      const assetId = mat.asset_id || mat.resume_version_id || '';
      const nextIv = rawInterviews.find((iv) => iv.status === 'SCHEDULED') || rawInterviews[rawInterviews.length - 1];

      return {
        id: String(a.application_id || a.id || ''),
        candidateId: String(cand.candidate_id || ''),
        nextInterviewId: nextIv ? String(nextIv.interview_id || '') : '',
        name: cand.display_name || a.name || '候选人',
        roleId: String(job.job_id || a.roleId || ''),
        stage: stageLabelOf(a.current_stage_code, a.lifecycle_status),
        stageCode: a.current_stage_code || 'S6',
        hours: calcHoursSince(a.stage_entered_at),
        starred: false,
        edu: Array.isArray(resumeObj.education_entries) && resumeObj.education_entries[0] ? resumeObj.education_entries[0].text : '',
        exp: mat.entry_counts ? `${mat.entry_counts.work || 0} 段工作经历` : '',
        source: job.code || '',
        pinned: Array.isArray(a.pinned) ? a.pinned : [],
        summary: [screening.reason, nextStep.label].filter(Boolean).join(' · ') || `当前处于「${stageLabelOf(a.current_stage_code, a.lifecycle_status)}」`,
        criteria,
        resumeSections,
        materialUrl: assetId ? `${baseUrl}/recruitment/api/material/${encodeURIComponent(assetId)}/content` : '',
        transcript,
        rounds,
        iqs: [],
        notes: '',
        timeline,
        labels: isEnvelope ? rawRoot.labels || null : null
      };
    }

    function normalizeSettingsFromApi(raw) {
      const conns = (raw && raw.connections) || {};
      const st = (raw && raw.settings) || {};
      const sla = st.sla_thresholds || {};
      return {
        connectors: [
          { id: 'mail', name: '企业邮箱（收简历与发 Offer）', desc: conns.email && conns.email.state ? `当前状态：${conns.email.state}` : '邮箱连接状态', connected: Boolean(conns.email && conns.email.state === 'CONNECTED') },
          { id: 'cal', name: '飞书日历（自动读取空闲时段）', desc: conns.feishu_calendar && conns.feishu_calendar.state ? `当前状态：${conns.feishu_calendar.state}` : '飞书日历状态', connected: Boolean(conns.feishu_calendar && conns.feishu_calendar.state === 'CONNECTED') },
          { id: 'min', name: '飞书妙记（面试录音转写同步）', desc: conns.feishu_minutes && conns.feishu_minutes.state ? `当前状态：${conns.feishu_minutes.state}` : '飞书妙记状态', connected: Boolean(conns.feishu_minutes && conns.feishu_minutes.state === 'CONNECTED') }
        ],
        autoRules: [
          { id: 'r1', name: 'Agent 静默代办', desc: '允许低风险解析与归档任务在后台静默执行', silent: Boolean(st.agent_silent_delegation) }
        ],
        slaConfig: {
          screenH: Number(sla.screening_hours || 24),
          scorecardH: Number(sla.scorecard_hours || 48),
          offerH: 72
        }
      };
    }

    const baseOptions = store.clone(store.state.options);

    return {
      mode: 'http',

      async getBootstrap() {
        const [ovRes, recRes, setRes] = await Promise.allSettled([
          httpRequest('/recruitment/api/overview'),
          httpRequest('/recruitment/api/recruiting/overview'),
          httpRequest('/recruitment/api/settings')
        ]);

        const ov = ovRes.status === 'fulfilled' && ovRes.value ? ovRes.value : {};
        const rec = recRes.status === 'fulfilled' && recRes.value ? recRes.value : {};
        const st = setRes.status === 'fulfilled' && setRes.value ? setRes.value : {};
        const normSettings = normalizeSettingsFromApi(st);

        const roles = Array.isArray(rec.jobs) ? rec.jobs.map((j) => normalizeJobFromApi(j)) : [];
        const candidates = Array.isArray(rec.applications) ? rec.applications.map((a) => normalizeAppSummaryOrDetail(a)) : [];

        return {
          actor: {
            id: (rec.actor && rec.actor.actor_id) || (ov.actor && ov.actor.actor_id) || '',
            name: (rec.actor && rec.actor.display_name) || (ov.actor && ov.actor.display_name) || '招聘团队',
            roleView: 'hr'
          },
          roles,
          candidates,
          autoDone: [],
          nudgePending: false,
          nudgeItem: store.clone(store.state.nudgeItem),
          messages: [
            { role: 'ai', text: '已连接真实后端服务。可正常浏览真实岗位、候选人档案，并提交已接通的确认卡与简历上传。' }
          ],
          connectors: normSettings.connectors,
          autoRules: normSettings.autoRules,
          slaConfig: normSettings.slaConfig,
          options: baseOptions
        };
      },

      async getToday() {
        const ov = await httpRequest('/recruitment/api/overview');
        const lists = ov.lists || {};
        const unassigned = ov.unassigned || {};
        return {
          pendingCandidates: [],
          nudgePending: false,
          nudgeItem: store.clone(store.state.nudgeItem),
          autoDone: [],
          stuckTasks: Array.isArray(unassigned.waiting_human_tasks) ? unassigned.waiting_human_tasks : [],
          counts: ov.counts || {},
          lists
        };
      },

      async getJob(jobId) {
        const data = await httpRequest(`/recruitment/api/recruiting/jobs/${encodeURIComponent(jobId)}`);
        return {
          job: normalizeJobFromApi(data.job || data, data.rubric),
          candidates: Array.isArray(data.applications) ? data.applications.map((a) => normalizeAppSummaryOrDetail(a)) : []
        };
      },

      async getApplication(id) {
        const data = await httpRequest(`/recruitment/api/recruiting/applications/${encodeURIComponent(id)}`);
        return normalizeAppSummaryOrDetail(data);
      },

      async getInterview(id) {
        const detail = await httpRequest(`/recruitment/api/interviewer/interviews/${encodeURIComponent(id)}`);
        return detail;
      },

      async submit(actionName, payload) {
        const p = payload || {};
        const confirmationText = String(p.confirmationText || p.reason || `确认执行：${actionName}`).trim();

        switch (actionName) {
          case 'transfer':
            return httpRequest('/recruitment/api/action/application/transfer', {
              method: 'POST',
              body: JSON.stringify({
                application_id: p.candId,
                target_job_id: p.targetId,
                confirmation_text: confirmationText
              })
            });
          case 'pin_constraint':
            return httpRequest('/recruitment/api/action/candidate/constraint', {
              method: 'POST',
              body: JSON.stringify({
                action: 'PIN',
                application_id: p.candId,
                text: String(p.text || '').slice(0, 500),
                source: p.source || 'CHAT',
                confirmation_text: confirmationText
              })
            });
          case 'add_handoff_iq':
            return httpRequest('/recruitment/api/action/candidate/constraint', {
              method: 'POST',
              body: JSON.stringify(Object.assign(
                {
                  action: 'HANDOFF',
                  application_id: p.candId,
                  text: String(p.text || '').slice(0, 500),
                  source: p.source || 'CHAT',
                  confirmation_text: confirmationText
                },
                p.interviewId ? { interview_id: p.interviewId } : {}
              ))
            });
          case 'new_job': {
            // IMPORTANT (available-actions.md): headcount is explicitly rejected (400 UNSUPPORTED_FIELD).
            // HC is maintained on requisitions; new job rubric starts in PENDING status.
            const body = {
              title: String(p.name || '未命名岗位').trim(),
              confirmation_text: confirmationText
            };
            if (p.dept) body.dept = p.dept;
            if (p.requisitionId) body.requisition_id = p.requisitionId;
            const res = await httpRequest('/recruitment/api/action/job/create', {
              method: 'POST',
              body: JSON.stringify(body)
            });
            return {
              ok: true,
              role: {
                id: String(res.job_id || ''),
                code: res.code || '',
                name: body.title,
                dept: p.dept || '招聘团队',
                hcTotal: 1,
                hcFilled: 0,
                rubricVersion: '待审批',
                rubric: []
              }
            };
          }
          case 'pass':
          case 'reject':
          case 'skip':
          case 'offer_accept':
          case 'offer_decline':
            return httpRequest('/recruitment/api/decision/record', {
              method: 'POST',
              body: JSON.stringify({
                application_id: p.candId,
                action: actionName,
                reason: p.reason || '',
                confirmation_text: confirmationText
              })
            });
          case 'reschedule':
          case 'add_round':
            return httpRequest('/recruitment/api/action/interview/schedule', {
              method: 'POST',
              body: JSON.stringify({
                application_id: p.candId,
                mode: actionName,
                round_label: p.label || '',
                focus: p.focus || '',
                replace_interviewer: p.newOwner || '',
                slot: p.slot || '',
                confirmation_text: confirmationText
              })
            });
          case 'scorecard':
            return httpRequest('/recruitment/api/action/scorecard/submit', {
              method: 'POST',
              body: JSON.stringify({
                application_id: p.candId,
                summary: p.summary || '',
                confirmation_text: confirmationText
              })
            });
          case 'offer':
          case 'thankyou':
            return httpRequest('/recruitment/api/action/email/send', {
              method: 'POST',
              body: JSON.stringify({
                application_id: p.candId,
                template: actionName,
                level: p.level || '',
                salary: p.salary || '',
                confirmation_text: confirmationText
              })
            });
          case 'toggle_rule':
            return httpRequest('/recruitment/api/action/settings/write', {
              method: 'POST',
              body: JSON.stringify({
                agent_silent_delegation: Boolean(p.silent),
                confirmation_text: confirmationText
              })
            });
          case 'set_actor':
            // Per client-plugin-contract.md §2: identity comes from host cookie, frontend does not send actor.
            return { ok: true };
          case 'batch_reject': {
            const raw = await httpRequest('/recruitment/api/action/decision/batch-reject', {
              method: 'POST',
              body: JSON.stringify({
                application_ids: Array.isArray(p.ids) ? p.ids : [],
                reason: p.reason || '',
                confirmation_text: confirmationText
              })
            });
            const results = (Array.isArray(raw.results) ? raw.results : []).map((r) => ({
              applicationId: String(r.application_id || ''),
              ok: r.ok === true || r.status === 'ok' || r.status === 'succeeded' || r.status === 'rejected',
              message: r.message || (r.ok ? '已关闭申请' : '当前状态无法关闭'),
              actionId: r.action_id || undefined
            }));
            return {
              ok: true,
              actionId: raw.action_id || (results.find((x) => x.ok && x.actionId) || {}).actionId,
              results
            };
          }
          case 'restore_snapshot':
          case 'undo': {
            const actionId = p.actionId || p.action_id || '';
            const res = await fetch(`${baseUrl}/recruitment/api/action/undo`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'x-recruitment-request': '1' },
              body: JSON.stringify({ action_id: actionId, confirmation_text: confirmationText })
            });
            const body = await res.json().catch(() => ({}));
            if (res.status === 409) {
              const code = String(body.code || body.reason_code || (body.error && body.error.code) || '').toUpperCase();
              const msg = code.includes('ALREADY_UNDONE')
                ? '这条已经撤销过了'
                : code.includes('WINDOW_EXPIRED')
                  ? '超过 5 分钟，不能再撤销'
                  : code.includes('SUPERSEDED')
                    ? '这条已经被后续操作覆盖，不能撤销'
                    : '当前状态已变化，无法撤销';
              return { ok: false, undone: false, message: msg };
            }
            if (!res.ok) {
              const err = new Error('暂时无法撤销，请稍后刷新核对');
              err.code = 'HTTP_ERROR';
              err.userMessage = '暂时无法撤销，请稍后刷新核对';
              throw err;
            }
            return { ok: true, undone: body.status === 'undone' || res.ok, message: '已撤销' };
          }
          // Remaining unimplemented actions -> NOT_AVAILABLE human copy
          case 'nudge':
          case 'compound':
          case 'star':
          case 'save_notes':
          case 'toggle_iq':
          case 'undo_auto_done':
          case 'toggle_connector':
          default:
            throw createNotAvailableError(actionName);
        }
      },

      async sendCommand(text, ctx) {
        return parseCommandMock(text, ctx);
      },

      /**
       * T3-2 & T3-3: Real raw-byte upload -> returns task_id immediately.
       * POST /recruitment/api/intake/upload?job_id=<uuid>
       * Headers: x-file-name, x-recruitment-request: 1; Body: raw file bytes.
       */
      async uploadResume(file, jobId) {
        if (!file || typeof file === 'string') {
          throw new Error('请选择一份本地简历文件后再上传');
        }
        const qs = jobId ? `?job_id=${encodeURIComponent(jobId)}` : '';
        const res = await fetch(`${baseUrl}/recruitment/api/intake/upload${qs}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'x-recruitment-request': '1',
            'x-file-name': encodeURIComponent(file.name || 'resume.pdf'),
            'Content-Type': file.type || 'application/octet-stream'
          },
          body: file
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data.error_summary || '简历上传未能提交，请检查文件后重试';
          const err = new Error(msg);
          err.userMessage = msg;
          throw err;
        }
        return {
          taskId: String(data.task_id || data.id || ''),
          status: String(data.status || 'PENDING'),
          fileName: file.name || 'resume.pdf'
        };
      },

      /**
       * T3-3: Poll GET /recruitment/api/tasks/status?task_id=<uuid>
       * Never expose raw error_code to UI; return human-readable errorSummary.
       */
      async getTaskStatus(taskId) {
        const data = await httpRequest(`/recruitment/api/tasks/status?task_id=${encodeURIComponent(taskId)}`);
        const task = (data && data.task) || data || {};
        const rawStatus = String(task.status || 'RUNNING').toUpperCase();
        const isDone = rawStatus === 'COMPLETED' || rawStatus === 'SUCCEEDED' || rawStatus === 'DONE';
        const isFailed = rawStatus === 'FAILED' || rawStatus === 'ERROR' || rawStatus === 'CANCELLED';
        return {
          taskId: String(task.task_id || taskId),
          status: isDone ? 'COMPLETED' : isFailed ? 'FAILED' : 'RUNNING',
          applicationId: task.application_id ? String(task.application_id) : null,
          candidateName: task.candidate_name || null,
          errorSummary: isFailed ? (task.error_summary || '简历解析未能完成，请检查文件格式或重新上传') : null
        };
      }
    };
  }

  return {
    createApi,
    createNotAvailableError,
    UNAVAILABLE_MSG
  };
});
