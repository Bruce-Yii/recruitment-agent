/**
 * Recruitment OS · 数据适配层（data/adapter.js）
 * 导出 createApi({ mode, baseUrl })，支持 'mock' | 'http' 双模式。
 *
 * - mock 模式：使用 data/mock.js，页面行为与原型逐屏一致。
 * - http 模式：仅对接后端已真实存在的接口；未实现的接口抛出 code='NOT_AVAILABLE'，
 *   由页面以自然业务语言提示「这项暂时还没接通」，绝不崩溃。
 * - 本轮明确不做：聊天流式/SSE、上传简历真实接口（均继续走 mock）。
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

  function createNotAvailableError(actionOrResource) {
    const err = new Error('这项暂时还没接通');
    err.code = 'NOT_AVAILABLE';
    err.userMessage = '这项暂时还没接通';
    err.target = actionOrResource;
    return err;
  }

  function createApi(options) {
    const cfg = Object.assign({ mode: 'mock', baseUrl: '' }, options || {});
    const mode = cfg.mode === 'http' ? 'http' : 'mock';
    const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
    const store = MockMod.createMockStore();

    // ---------------- Shared Mock Command Parser (Task 01: chat stays mock) ----------------
    function parseCommandMock(rawText, ctx) {
      const t = String(rawText || '').trim();
      const candidates = (ctx && ctx.candidates) || store.state.candidates;
      const roles = (ctx && ctx.roles) || store.state.roles;
      const activeCandId = ctx && ctx.activeCandId;
      const getRole = (id) => roles.find((r) => r.id === id) || roles[0];
      const getCand = (id) => candidates.find((c) => c.id === id);

      if (!t) return { kind: 'noop' };

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
            text: `已将你的连环指令拆解为 3 步（推进一面 + 置顶竞品加急 + 匹配明天 15:00 空闲时段），在居中确认卡点一次即可全部执行。`,
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
          payload: { candId: c.id, text: '字节 Offer 周五截止 · 期望 45k', kind: 'red' },
          openCandId: c.id,
          message: {
            role: 'ai',
            text: `已将竞品 Offer 与薪资预期置顶到 ${c.name} 档案头部，并同步提醒面试官。`,
            tag: '已置顶约束'
          }
        };
      }
      if (t.includes('对比')) {
        const jobId = t.includes('Java') ? 'java' : 'pm';
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
          payload: { candId: c.id, text: noteText },
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
          payload: { candId: c.id, fromCommand: true },
          openCandId: c.id,
          message: { role: 'ai', text: `已将 ${c.name} 推进至「${nextStage}」。`, tag: `流转至 ${nextStage}` }
        };
      }
      if (t.includes('岗位标准') || t.toLowerCase().includes('jd') || t.includes('原始信息')) {
        const jobId = t.includes('Java') ? 'java' : t.includes('算法') ? 'algo' : 'pm';
        return {
          kind: 'navigate',
          nav: { space: 'jobs', activeJobId: jobId, activeCandId: null, jobTab: 'rubric' },
          message: {
            role: 'ai',
            text: `已打开「${getRole(jobId).name}」的考核标准 V1 与完整原始 JD。`,
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
      if (
        t.includes('面试官视角') ||
        t.includes('用人经理视角') ||
        t.includes('HR视角') ||
        t.includes('HR 视角')
      ) {
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
        return {
          kind: 'set_rail',
          collapsed: true,
          message: { role: 'ai', text: '已收起最左侧导航栏，随时可按 \\ 或点左上角图标展开。' }
        };
      }
      if (t.includes('展开侧边栏') || t.includes('展开导航')) {
        return {
          kind: 'set_rail',
          collapsed: false,
          message: { role: 'ai', text: '已展开最左侧导航栏。' }
        };
      }
      if (t.includes('收起对话')) {
        return {
          kind: 'set_chat',
          collapsed: true,
          message: { role: 'ai', text: '已收起对话栏，随时可按 [ 或点左下角展开。' }
        };
      }
      if (t.includes('看') || mentioned) {
        return {
          kind: 'open_candidate',
          openCandId: c.id,
          message: {
            role: 'ai',
            text: `已顺着「${getRole(c.roleId).name} / ${c.name}」为你展开完整简历与审阅画布。`
          }
        };
      }
      return {
        kind: 'message_only',
        message: {
          role: 'ai',
          text: '你可以直接说「看林同学初筛」「对比 AI 产品经理候选人」「给陈同学发 Offer」或「林同学有字节 Offer 周五截止，期望 45k」。'
        }
      };
    }

    // ---------------- MOCK MODE ----------------
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
          const list = s.candidates.filter((c) => c.roleId === job.id);
          return store.clone({ job, candidates: list });
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
            c.timeline.unshift({
              t: hm,
              d: p.fromCommand ? `对话指令推进至「${c.stage}」` : `人工拍板推进至「${c.stage}」`
            });
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
            if (calConn && !calConn.connected && !p.forceReconnect) {
              return { ok: false, connectorDown: 'cal', candidate: store.clone(c) };
            }
            if (calConn && p.forceReconnect) calConn.connected = true;
            const newOwner = p.newOwner || '张工';
            const lastR = c.rounds[c.rounds.length - 1];
            const slotShort = `${p.slot.split(' ')[0]} ${p.slot.split(' ')[1]}`;
            if (lastR) {
              lastR.t = `二面 · ${newOwner}`;
              lastR.s = `改期 · ${slotShort}`;
              lastR.d = p.forceReconnect
                ? `已替换面试官为 ${newOwner}，重新绑定飞书妙记归属。`
                : `已替换面试官为 ${newOwner}，重新绑定飞书妙记归属并通知候选人。`;
            }
            c.pinned = [{ t: `改期至 ${slotShort} · ${newOwner}`, kind: 'neutral' }];
            c.timeline.unshift({
              t: hm,
              d: p.forceReconnect
                ? `重连后已改期至 ${p.slot} 并更换面试官为 ${newOwner}`
                : `临时换面试官为 ${newOwner} 并改期至 ${p.slot}（飞书日程与妙记已同步）`
            });
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
            s.autoDone.unshift({
              id: 'a' + Date.now(),
              t: '刚刚',
              text: '已向王工发送飞书催交面评提醒',
              undone: false
            });
            return { ok: true, nudgePending: false, autoDone: store.clone(s.autoDone) };
          }
          if (actionName === 'offer') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            if (c.offerStatus === 'SENT') return { ok: false, duplicate: true };
            const mailConn = s.connectors.find((x) => x.id === 'mail');
            if (mailConn && !mailConn.connected && !p.forceReconnect) {
              return { ok: false, connectorDown: 'mail', candidate: store.clone(c) };
            }
            if (mailConn && p.forceReconnect) mailConn.connected = true;
            c.offerStatus = 'SENT';
            c.stage = 'Offer 待确认';
            c.timeline.unshift({
              t: hm,
              d: p.forceReconnect ? '重连后已安全发送正式 Offer 邮件（防重校验通过）' : '已发送正式 Offer 邮件，等待确认'
            });
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
            c.rounds.push({
              t: '一面（业务与基础）',
              s: `已约 · ${p.slot.split(' ')[0]} ${p.slot.split(' ')[1]}`,
              d: `已通过飞书日历锁定 ${p.slot}，并提醒面试官竞品加急。`
            });
            c.timeline.unshift({ t: hm, d: `联动完成：通过初筛 + 置顶「${p.pinText}」+ 锁定一面日程（${p.slot}）` });
            return { ok: true, candidate: store.clone(c) };
          }
          if (actionName === 'add_round') {
            const c = getCand(p.candId);
            if (!c) return { ok: false };
            const calConn = s.connectors.find((x) => x.id === 'cal');
            if (calConn && !calConn.connected && !p.forceReconnect) {
              return { ok: false, connectorDown: 'cal', candidate: store.clone(c) };
            }
            if (calConn && p.forceReconnect) calConn.connected = true;
            const lbl = p.label || '加面 · 交叉核实';
            const foc = p.focus || '核实并发状态回滚深度';
            c.rounds.splice(Math.max(1, c.rounds.length - 1), 0, {
              t: lbl,
              s: `已约 · ${p.slot.split(' ')[0]}`,
              d: p.forceReconnect ? `已锁定 ${p.slot}` : `已锁定 ${p.slot} · ${foc}`
            });
            c.timeline.unshift({
              t: hm,
              d: p.forceReconnect
                ? `重连后已插入专项加面并锁定飞书日程（${p.slot}）`
                : `已插入专项加面并锁定飞书日程（${p.slot}）`
            });
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
            const newRole = {
              id,
              name: nm,
              dept: '技术部',
              hcTotal: hc,
              hcFilled: 0,
              rubricVersion: 'V1',
              rubric: ['核心架构与 0-1 落地', '工程化与稳定性', '跨团队推动能力']
            };
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
          const autoEntry = {
            id: 'a' + Date.now(),
            t: '刚刚',
            text: `自动解析导入的「${fileName}」并完成 4 项岗位标准对齐`,
            undone: false
          };
          s.autoDone.unshift(autoEntry);
          return store.clone({ candidate: newCand, autoEntry, fileName, mockUpload: true });
        }
      };
    }

    // ---------------- HTTP MODE (Only real §3 endpoints; missing ones throw NOT_AVAILABLE) ----------------
    async function httpRequest(path, init) {
      const res = await fetch(baseUrl + path, Object.assign({
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin'
      }, init || {}));
      if (res.status === 404 || res.status === 501) {
        throw createNotAvailableError(path);
      }
      if (!res.ok) {
        const err = new Error('服务暂时无法响应，请稍后重试');
        err.code = 'HTTP_ERROR';
        err.userMessage = '服务暂时无法响应，请稍后重试';
        throw err;
      }
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    }

    function normalizeRole(raw) {
      return {
        id: String(raw.id || raw.job_id || raw.jobId || 'job'),
        name: raw.name || raw.title || '未命名岗位',
        dept: raw.dept || raw.department || '招聘团队',
        hcTotal: Number(raw.hcTotal != null ? raw.hcTotal : raw.headcount || 1),
        hcFilled: Number(raw.hcFilled != null ? raw.hcFilled : raw.filled_count || 0),
        rubricVersion: raw.rubricVersion || raw.rubric_version || 'V1',
        rubric: Array.isArray(raw.rubric) ? raw.rubric : Array.isArray(raw.criteria) ? raw.criteria : [],
        jd: raw.jd || {
          meta: raw.meta || '',
          duties: raw.duties || raw.description || '暂无原始岗位职责描述',
          reqs: raw.reqs || raw.requirements || '暂无原始任职要求',
          bonus: raw.bonus || ''
        }
      };
    }

    function normalizeApplication(raw) {
      const id = String(raw.id || raw.application_id || raw.applicationId || '');
      const matId = raw.materialId || raw.material_id || id;
      return {
        id,
        name: raw.name || raw.candidate_name || raw.candidateName || '候选人',
        roleId: String(raw.roleId || raw.job_id || raw.jobId || ''),
        stage: raw.stage || raw.stage_label || '初筛评估',
        hours: Number(raw.hours != null ? raw.hours : raw.stage_hours || 0),
        starred: Boolean(raw.starred),
        offerStatus: raw.offerStatus || raw.offer_status || undefined,
        edu: raw.edu || raw.education || '',
        exp: raw.exp || raw.experience_summary || '',
        source: raw.source || raw.channel || '',
        pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
        summary: raw.summary || raw.ai_summary || '',
        criteria: Array.isArray(raw.criteria) ? raw.criteria : [],
        resumeSections: Array.isArray(raw.resumeSections)
          ? raw.resumeSections
          : raw.resume_text
            ? [{ title: '简历原文', items: [{ k: 'c1', t: raw.resume_text }] }]
            : [],
        materialUrl: matId ? `${baseUrl}/recruitment/api/material/${encodeURIComponent(matId)}/content` : '',
        transcript: Array.isArray(raw.transcript) ? raw.transcript : [],
        rounds: Array.isArray(raw.rounds) ? raw.rounds : [],
        iqs: Array.isArray(raw.iqs) ? raw.iqs : [],
        notes: raw.notes || '',
        timeline: Array.isArray(raw.timeline) ? raw.timeline : []
      };
    }

    const baseOptions = store.clone(store.state.options);

    return {
      mode: 'http',

      async getBootstrap() {
        const [actorRes, settingsRes, overviewRes, recruitingRes] = await Promise.allSettled([
          httpRequest('/recruitment/api/actor'),
          httpRequest('/recruitment/api/settings'),
          httpRequest('/recruitment/api/overview'),
          httpRequest('/recruitment/api/recruiting/jobs')
        ]);

        const actorData = actorRes.status === 'fulfilled' && actorRes.value ? actorRes.value : {};
        const settingsData = settingsRes.status === 'fulfilled' && settingsRes.value ? settingsRes.value : {};
        const overviewData = overviewRes.status === 'fulfilled' && overviewRes.value ? overviewRes.value : {};
        const recData = recruitingRes.status === 'fulfilled' && recruitingRes.value ? recruitingRes.value : {};

        const rawRoles = Array.isArray(recData.jobs)
          ? recData.jobs
          : Array.isArray(recData)
            ? recData
            : Array.isArray(overviewData.jobs)
              ? overviewData.jobs
              : [];
        const rawCands = Array.isArray(recData.applications)
          ? recData.applications
          : Array.isArray(overviewData.applications)
            ? overviewData.applications
            : Array.isArray(overviewData.candidates)
              ? overviewData.candidates
              : [];

        return {
          actor: {
            id: actorData.id || 'current_user',
            name: actorData.name || '当前用户',
            roleView: actorData.roleView || actorData.role || 'hr'
          },
          roles: rawRoles.map(normalizeRole),
          candidates: rawCands.map(normalizeApplication),
          autoDone: Array.isArray(overviewData.autoDone) ? overviewData.autoDone : [],
          nudgePending: Boolean(overviewData.nudgePending),
          nudgeItem: overviewData.nudgeItem || store.clone(store.state.nudgeItem),
          messages: [
            {
              role: 'ai',
              text: '已连接真实后端数据。聊天流式与简历上传将在下一轮接入，当前可正常浏览真实岗位、候选人与提交已接通的操作。'
            }
          ],
          connectors: Array.isArray(settingsData.connectors)
            ? settingsData.connectors
            : store.clone(store.state.connectors),
          autoRules: Array.isArray(settingsData.autoRules)
            ? settingsData.autoRules
            : store.clone(store.state.autoRules),
          slaConfig: settingsData.slaConfig || store.clone(store.state.slaConfig),
          options: baseOptions
        };
      },

      async getToday() {
        const [ov, tasks] = await Promise.all([
          httpRequest('/recruitment/api/overview'),
          httpRequest('/recruitment/api/tasks/status').catch(() => ({ stuck: [] }))
        ]);
        const list = Array.isArray(ov.pendingCandidates)
          ? ov.pendingCandidates.map(normalizeApplication)
          : Array.isArray(ov.applications)
            ? ov.applications.map(normalizeApplication)
            : [];
        return {
          pendingCandidates: list,
          nudgePending: Boolean(ov.nudgePending),
          nudgeItem: ov.nudgeItem || store.clone(store.state.nudgeItem),
          autoDone: Array.isArray(ov.autoDone) ? ov.autoDone : [],
          stuckTasks: Array.isArray(tasks.stuck) ? tasks.stuck : []
        };
      },

      async getJob(jobId) {
        const data = await httpRequest(`/recruitment/api/recruiting/jobs/${encodeURIComponent(jobId)}`);
        return {
          job: normalizeRole(data.job || data),
          candidates: Array.isArray(data.applications || data.candidates)
            ? (data.applications || data.candidates).map(normalizeApplication)
            : []
        };
      },

      async getApplication(id) {
        const data = await httpRequest(`/recruitment/api/recruiting/applications/${encodeURIComponent(id)}`);
        return normalizeApplication(data.application || data);
      },

      async getInterview(id) {
        const [detail, form] = await Promise.all([
          httpRequest(`/recruitment/api/interviewer/interviews/${encodeURIComponent(id)}`),
          httpRequest(`/recruitment/api/action/scorecard/form?interview_id=${encodeURIComponent(id)}`).catch(() => null)
        ]);
        return {
          application: detail.application ? normalizeApplication(detail.application) : null,
          assigned: detail.assigned || null,
          prevSummary: detail.prevSummary || detail.previous_summary || '',
          rubricRef: detail.rubricRef || detail.rubric || [],
          scorecardForm: form,
          iqs: Array.isArray(detail.iqs) ? detail.iqs : [],
          notes: detail.notes || ''
        };
      },

      async submit(actionName, payload) {
        const p = payload || {};
        switch (actionName) {
          case 'set_actor':
            return httpRequest('/recruitment/api/actor', {
              method: 'PUT',
              body: JSON.stringify({ role: p.roleView })
            });
          case 'scorecard':
            return httpRequest('/recruitment/api/action/scorecard/submit', {
              method: 'POST',
              body: JSON.stringify({ application_id: p.candId, summary: p.summary, score: p.score || 4.5 })
            });
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
                reason: p.reason || ''
              })
            });
          case 'reschedule':
          case 'add_round':
            return httpRequest('/recruitment/api/action/interview/schedule', {
              method: 'POST',
              body: JSON.stringify({
                application_id: p.candId,
                mode: actionName,
                round_name: p.label || '',
                focus: p.focus || '',
                interviewer: p.newOwner || '',
                slot: p.slot || ''
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
                salary: p.salary || ''
              })
            });
          case 'toggle_connector':
          case 'toggle_rule':
            return httpRequest('/recruitment/api/action/settings/write', {
              method: 'POST',
              body: JSON.stringify({ action: actionName, payload: p })
            });
          default:
            // Endpoints not yet available on backend (see INTERFACE-NEEDS.md)
            throw createNotAvailableError(actionName);
        }
      },

      // §4: Chat stays mock in Task 01
      async sendCommand(text, ctx) {
        return parseCommandMock(text, ctx);
      },

      // §4: Upload stays mock in Task 01 (backend gap G1)
      async uploadResume(file, jobId) {
        const fileName = typeof file === 'string' ? file : (file && file.name) || baseOptions.defaultDemoPdf;
        const newCand = store.buildUploadedMockCandidate(fileName, jobId || 'pm');
        return store.clone({ candidate: newCand, fileName, mockUpload: true, gap: 'G1' });
      }
    };
  }

  return {
    createApi,
    createNotAvailableError
  };
});
