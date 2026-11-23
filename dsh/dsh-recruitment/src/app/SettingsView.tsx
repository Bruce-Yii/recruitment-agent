import React, { useCallback, useEffect, useState } from 'react';
import { fetchAppJson, postWorkspaceSettingWrite } from './api.ts';
import { downloadApplicationsCsv, testWebhook as postWebhookTest } from '../client/external-sync.ts';

type SettingsTabKey = 'connections' | 'automation' | 'org' | 'governance';

interface ConnectorStatusView {
  readonly state?: string;
  readonly status?: string;
  readonly detail?: string;
  readonly message?: string;
  readonly address?: string;
  readonly poll_interval_minutes?: number;
}

interface ScorecardReminderPolicy {
  readonly enabled: boolean;
  readonly overdue_hours: 24 | 48 | 72;
  readonly max_reminders: number;
  readonly channel: 'workbench' | 'feishu' | 'email';
  readonly quiet_hours?: { readonly start: string; readonly end: string };
}

interface BookingInviteDefaults {
  readonly expires_hours: number;
  readonly default_duration_min: 30 | 45 | 60 | 90;
}

interface ExternalWebhookConfigView {
  readonly enabled: boolean;
  readonly url: string;
  readonly events: readonly ('decision.recorded' | 'stage.advanced' | 'booking.confirmed')[];
  readonly secret_set: boolean;
}

const WEBHOOK_EVENT_LABELS: Readonly<Record<string, string>> = {
  'decision.recorded': '录用 / 淘汰终审结论',
  'stage.advanced': '阶段推进',
  'booking.confirmed': '候选人自助预约确认',
};

interface SettingsPayload {
  readonly connections?: {
    readonly email?: ConnectorStatusView;
    readonly feishu_calendar?: ConnectorStatusView;
    readonly feishu_minutes?: ConnectorStatusView;
  };
  readonly settings?: {
    readonly agent_silent_delegation?: boolean;
    readonly sla_thresholds?: { readonly screening_hours: number; readonly scorecard_hours: number };
    readonly auto_screening_enabled?: boolean;
    readonly auto_scorecard_draft_enabled?: boolean;
    readonly scorecard_reminder_policy?: ScorecardReminderPolicy;
    readonly booking_invite_defaults?: BookingInviteDefaults;
    readonly external_webhook_config?: ExternalWebhookConfigView;
  };
  readonly defaults_applied?: readonly string[];
  readonly governance?: {
    readonly skills?: ReadonlyArray<{ readonly id: string; readonly stage: string; readonly title: string }>;
    readonly eval_summary?: {
      readonly passed?: number;
      readonly total?: number;
      readonly pass_k?: string;
      readonly updated_at?: string;
      readonly model_label?: string;
    } | null;
    readonly g3_telemetry?: {
      readonly schema_version?: string;
      readonly paired_guardrails?: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly primaryRate: number | null;
        readonly guardrailRate: number | null;
        readonly status: 'OK' | 'WATCH' | 'NO_DATA';
        readonly note: string;
      }>;
    } | null;
  };
}

interface OrgConfigPayload {
  readonly roles?: ReadonlyArray<{
    readonly id?: string;
    readonly code: string;
    readonly name: string;
    readonly permission_scopes?: readonly string[];
    readonly record_version?: number;
  }>;
  readonly hiring_teams?: ReadonlyArray<{
    readonly id?: string;
    readonly code: string;
    readonly name: string;
    readonly member_count?: number;
    readonly record_version?: number;
  }>;
  readonly pipeline_templates?: ReadonlyArray<{
    readonly id?: string;
    readonly code: string;
    readonly name: string;
    readonly stage_count?: number;
    readonly record_version?: number;
  }>;
}

interface SettingsViewProps {
  readonly sid: string;
  readonly readOnly?: boolean;
}

const DEFAULT_SKILLS = [
  { id: 'recruitment-s6-intake', stage: 'S6', title: '建岗、简历入库与同人判重规范' },
  { id: 'recruitment-s7-screening', stage: 'S7', title: '初筛对照原文出处与人工纠偏规范' },
  { id: 'recruitment-s8-interview', stage: 'S8', title: '面试排期、空闲查询与自助预约规范' },
  { id: 'recruitment-s9-transcript', stage: 'S9', title: '转写复核、面评草稿与面试官隔离规范' },
  { id: 'recruitment-s10-decision', stage: 'S10', title: '多人对比、终审拍板与追责时间线规范' },
] as const;

function formatConnectionLabel(conn?: ConnectorStatusView): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  const raw = String(conn?.state || conn?.status || 'NOT_CONFIGURED').toUpperCase();
  if (raw === 'CONNECTED' || raw === 'READY' || raw === 'CONFIGURED') {
    return { label: '已配置', tone: 'ok' };
  }
  if (raw === 'AUTH_REQUIRED') {
    return { label: '需重新授权', tone: 'warn' };
  }
  if (raw === 'NOT_CONNECTED') {
    return { label: '未连接', tone: 'warn' };
  }
  return { label: '未配置', tone: 'muted' };
}

export function SettingsView({ sid, readOnly = false }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('connections');
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [orgData, setOrgData] = useState<OrgConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [l3Open, setL3Open] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Editable L2 form state
  const [screeningHours, setScreeningHours] = useState(24);
  const [scorecardHours, setScorecardHours] = useState(48);
  const [silentDelegation, setSilentDelegation] = useState(false);
  const [autoScreening, setAutoScreening] = useState(true);
  const [autoScorecardDraft, setAutoScorecardDraft] = useState(true);
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderHours, setReminderHours] = useState<24 | 48 | 72>(24);
  const [reminderMax, setReminderMax] = useState(2);
  const [reminderChannel, setReminderChannel] = useState<'workbench' | 'feishu' | 'email'>('workbench');
  const [quietStart, setQuietStart] = useState('20:00');
  const [quietEnd, setQuietEnd] = useState('09:00');
  const [bookingExpires, setBookingExpires] = useState(72);
  const [bookingDuration, setBookingDuration] = useState<30 | 45 | 60 | 90>(60);
  // Issue #60：外部轻量同步（CSV / Webhook）L2 表单状态
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookEvents, setWebhookEvents] = useState<string[]>([]);
  const [webhookSecretSet, setWebhookSecretSet] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = (await fetchAppJson('/recruitment/api/settings', sid)) as SettingsPayload;
      setData(payload);
      const s = payload.settings;
      if (s?.sla_thresholds) {
        setScreeningHours(s.sla_thresholds.screening_hours);
        setScorecardHours(s.sla_thresholds.scorecard_hours);
      }
      if (typeof s?.agent_silent_delegation === 'boolean') {
        setSilentDelegation(s.agent_silent_delegation);
      }
      if (typeof s?.auto_screening_enabled === 'boolean') {
        setAutoScreening(s.auto_screening_enabled);
      }
      if (typeof s?.auto_scorecard_draft_enabled === 'boolean') {
        setAutoScorecardDraft(s.auto_scorecard_draft_enabled);
      }
      if (s?.scorecard_reminder_policy) {
        const p = s.scorecard_reminder_policy;
        setReminderEnabled(Boolean(p.enabled));
        setReminderHours(p.overdue_hours === 48 || p.overdue_hours === 72 ? p.overdue_hours : 24);
        setReminderMax(typeof p.max_reminders === 'number' ? p.max_reminders : 2);
        setReminderChannel(p.channel === 'feishu' || p.channel === 'email' ? p.channel : 'workbench');
        if (p.quiet_hours?.start) setQuietStart(p.quiet_hours.start);
        if (p.quiet_hours?.end) setQuietEnd(p.quiet_hours.end);
      }
      const wh = s?.external_webhook_config;
      if (wh) {
        setWebhookEnabled(Boolean(wh.enabled));
        setWebhookUrl(typeof wh.url === 'string' ? wh.url : '');
        setWebhookEvents(Array.isArray(wh.events) ? [...wh.events] : []);
        setWebhookSecretSet(Boolean(wh.secret_set));
        setWebhookSecret(''); // GET 永不返回明文/哈希；输入框保持空，仅在用户主动填写时轮换
      }
      if (s?.booking_invite_defaults) {
        const b = s.booking_invite_defaults;
        setBookingExpires(typeof b.expires_hours === 'number' ? b.expires_hours : 72);
        setBookingDuration(
          b.default_duration_min === 30 || b.default_duration_min === 45 || b.default_duration_min === 90
            ? b.default_duration_min
            : 60,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载工作台设置失败');
    } finally {
      setLoading(false);
    }
  }, [sid]);

  const loadOrgConfig = useCallback(async () => {
    try {
      const payload = (await fetchAppJson('/recruitment/api/config/org', sid)) as OrgConfigPayload;
      setOrgData(payload);
    } catch {
      // Optional read-only endpoint (Issue #54); degrade calmly when not yet mounted.
      setOrgData(null);
    }
  }, [sid]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (activeTab === 'org') {
      void loadOrgConfig();
    }
  }, [activeTab, loadOrgConfig]);

  const toggleRow = (rowId: string) => {
    setFeedback(null);
    setExpandedRow((cur) => (cur === rowId ? null : rowId));
  };

  const toggleL3 = (rowId: string) => {
    setL3Open((prev) => ({ ...prev, [rowId]: !prev[rowId] }));
  };

  const handleSaveSetting = async (key: string, value: unknown, confirmationText: string) => {
    if (readOnly) return;
    setSavingKey(key);
    setFeedback(null);
    try {
      const res = await postWorkspaceSettingWrite(sid, {
        key,
        value,
        confirmation_text: confirmationText,
      });
      setFeedback({ kind: 'ok', text: `已保存更改（版本 v${res.version_no}）` });
      setExpandedRow(null);
      await loadSettings();
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : '保存设置失败，请稍后重试',
      });
    } finally {
      setSavingKey(null);
    }
  };

  const downloadCsv = async (jobId?: string) => {
    setCsvBusy(true);
    setFeedback(null);
    try {
      await downloadApplicationsCsv(sid, jobId);
      setFeedback({ kind: 'ok', text: 'CSV 已下载（含 UTF-8 BOM，联系方式已脱敏）' });
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'CSV 下载失败' });
    } finally {
      setCsvBusy(false);
    }
  };

  const saveWebhookConfig = async () => {
    const value: Record<string, unknown> = {
      enabled: webhookEnabled,
      url: webhookUrl.trim(),
      events: webhookEvents,
    };
    if (webhookSecret.trim() !== '') value.secret = webhookSecret;
    await handleSaveSetting(
      'external_webhook_config',
      value,
      `配置外部 Webhook 同步：${webhookEnabled ? '开启' : '关闭'}，${webhookEvents.length} 类事件`,
    );
    if (webhookSecret.trim() !== '') {
      setWebhookSecret('');
      setWebhookSecretSet(true);
    }
  };

  const runWebhookTest = async () => {
    setTestBusy(true);
    setFeedback(null);
    try {
      const result = await postWebhookTest(sid);
      setFeedback({
        kind: result.ok ? 'ok' : 'err',
        text: result.ok
          ? `测试推送成功（HTTP ${result.status}，签名已发送）`
          : result.message,
      });
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : '测试推送失败' });
    } finally {
      setTestBusy(false);
    }
  };

  const emailStatus = formatConnectionLabel(data?.connections?.email);
  const feishuCalStatus = formatConnectionLabel(data?.connections?.feishu_calendar);
  const feishuMinStatus = formatConnectionLabel(data?.connections?.feishu_minutes);
  const skillsList =
    data?.governance?.skills && data.governance.skills.length > 0
      ? data.governance.skills
      : DEFAULT_SKILLS;

  return (
    <div className="canvas-inner settings-page" data-testid="settings-page">
      <div className="settings-head">
        <div>
          <h1 className="settings-title">工作台设置</h1>
          <p className="settings-subtitle">
            管理连接接入、自动化与面评提醒策略、组织招聘规范及行为准则。
          </p>
        </div>
        {readOnly ? <span className="settings-readonly-note">当前身份为只读视图</span> : null}
      </div>

      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'connections'}
          className={`settings-tab${activeTab === 'connections' ? ' active' : ''}`}
          data-testid="settings-tab-connections"
          onClick={() => {
            setActiveTab('connections');
            setExpandedRow(null);
            setFeedback(null);
          }}
        >
          连接接入
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'automation'}
          className={`settings-tab${activeTab === 'automation' ? ' active' : ''}`}
          data-testid="settings-tab-automation"
          onClick={() => {
            setActiveTab('automation');
            setExpandedRow(null);
            setFeedback(null);
          }}
        >
          自动化与提醒
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'org'}
          className={`settings-tab${activeTab === 'org' ? ' active' : ''}`}
          data-testid="settings-tab-org"
          onClick={() => {
            setActiveTab('org');
            setExpandedRow(null);
            setFeedback(null);
          }}
        >
          组织与招聘规范
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'governance'}
          className={`settings-tab${activeTab === 'governance' ? ' active' : ''}`}
          data-testid="settings-tab-governance"
          onClick={() => {
            setActiveTab('governance');
            setExpandedRow(null);
            setFeedback(null);
          }}
        >
          行为规范与评测
        </button>
      </div>

      {feedback ? (
        <div
          className={`settings-feedback ${feedback.kind === 'err' ? 'is-err' : 'is-ok'}`}
          data-testid="settings-feedback"
        >
          {feedback.text}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="empty-paper">正在读取设置与连接状态…</div>
      ) : error && !data ? (
        <div className="empty-paper">
          <div>{error}</div>
          <button type="button" className="btn dark" onClick={() => void loadSettings()}>
            重新加载
          </button>
        </div>
      ) : (
        <div className="settings-body">
          {activeTab === 'connections' ? (
            <div className="settings-list">
              <div className="settings-row" data-testid="settings-row-email">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">邮箱收发（IMAP / SMTP）</div>
                    <div className="settings-row-desc">
                      自动拉取渠道投递简历，并在授权后发送面试通知与反馈邮件。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className={`settings-status tone-${emailStatus.tone}`}>
                      {emailStatus.label}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => toggleRow('email')}
                    >
                      {expandedRow === 'email' ? '收起' : '查看'}
                    </button>
                  </div>
                </div>
                {expandedRow === 'email' ? (
                  <div className="settings-l2" data-testid="settings-expand-email">
                    <div className="settings-kv-row">
                      <span>当前探活状态</span>
                      <span>{data?.connections?.email?.detail || emailStatus.label}</span>
                    </div>
                    <div className="settings-kv-row">
                      <span>收件箱地址</span>
                      <span>{data?.connections?.email?.address || '通过宿主环境变量注入'}</span>
                    </div>
                    <button
                      type="button"
                      className="text-action-link muted"
                      data-testid="settings-l3-toggle-email"
                      onClick={() => toggleL3('email')}
                    >
                      {l3Open.email ? '高级参数 ▾' : '高级参数 ▸'}
                    </button>
                    {l3Open.email ? (
                      <div className="settings-l3">
                        邮箱连接凭证由运行环境安全注入，前端不落盘明文密钥；未完成真实回读前永不显示已连接。
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-feishu">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">飞书日历与妙记</div>
                    <div className="settings-row-desc">
                      读取面试官空闲时段与面试会议转写，支持一键生成面评草稿。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className={`settings-status tone-${feishuCalStatus.tone}`}>
                      日历：{feishuCalStatus.label} · 妙记：{feishuMinStatus.label}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => toggleRow('feishu')}
                    >
                      {expandedRow === 'feishu' ? '收起' : '查看'}
                    </button>
                  </div>
                </div>
                {expandedRow === 'feishu' ? (
                  <div className="settings-l2" data-testid="settings-expand-feishu">
                    <div className="settings-kv-row">
                      <span>日历探活</span>
                      <span>{data?.connections?.feishu_calendar?.detail || feishuCalStatus.label}</span>
                    </div>
                    <div className="settings-kv-row">
                      <span>妙记探活</span>
                      <span>{data?.connections?.feishu_minutes?.detail || feishuMinStatus.label}</span>
                    </div>
                    <button
                      type="button"
                      className="text-action-link muted"
                      data-testid="settings-l3-toggle-feishu"
                      onClick={() => toggleL3('feishu')}
                    >
                      {l3Open.feishu ? '高级参数 ▾' : '高级参数 ▸'}
                    </button>
                    {l3Open.feishu ? (
                      <div className="settings-l3">
                        飞书适配器遵循诚实探活原则，需配置成员映射（RECRUITMENT_FEISHU_USER_MAP）并通过真实回调验证。
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-external-sync">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">外部系统轻量同步（CSV / Webhook）</div>
                    <div className="settings-row-desc">
                      {webhookEnabled
                        ? `已开启 · 推送 ${webhookEvents.length} 类终态事件 · ${webhookSecretSet ? '签名密钥已设置' : '尚未设置签名密钥'}`
                        : '未开启 · 可一键导出人话 CSV，或配置签名 Webhook 回写外部系统'}
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className={`settings-status ${webhookEnabled ? 'tone-ok' : 'tone-muted'}`}>
                      {webhookEnabled ? '已开启' : '未开启'}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      data-testid="settings-config-external-sync"
                      onClick={() => toggleRow('external-sync')}
                    >
                      {expandedRow === 'external-sync' ? '收起' : '配置'}
                    </button>
                  </div>
                </div>
                {expandedRow === 'external-sync' ? (
                  <div className="settings-l2" data-testid="settings-expand-external-sync">
                    <div className="settings-kv-row">
                      <span>CSV 导出</span>
                      <button
                        type="button"
                        className="btn"
                        data-testid="settings-csv-download"
                        disabled={csvBusy || readOnly}
                        onClick={() => void downloadCsv()}
                      >
                        {csvBusy ? '导出中…' : '下载全部申请 CSV'}
                      </button>
                    </div>
                    <div className="settings-form-grid">
                      <label className="settings-field">
                        <span>推送开关</span>
                        <select
                          disabled={readOnly}
                          value={webhookEnabled ? 'on' : 'off'}
                          data-testid="settings-webhook-enabled"
                          onChange={(e) => setWebhookEnabled(e.target.value === 'on')}
                        >
                          <option value="off">暂停推送</option>
                          <option value="on">开启推送</option>
                        </select>
                      </label>
                      <label className="settings-field">
                        <span>Webhook 地址（https://；本地测试可用 http://127.0.0.1）</span>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={webhookUrl}
                          data-testid="settings-webhook-url"
                          placeholder="https://ats.example.com/hooks/recruitment"
                          onChange={(e) => setWebhookUrl(e.target.value)}
                        />
                      </label>
                    </div>
                    <div className="settings-toggle-line">
                      <span>订阅事件</span>
                      <div data-testid="settings-webhook-events">
                        {Object.entries(WEBHOOK_EVENT_LABELS).map(([key, label]) => (
                          <label key={key} className="settings-field" style={{ display: 'inline-flex', marginRight: 12 }}>
                            <input
                              type="checkbox"
                              disabled={readOnly}
                              checked={webhookEvents.includes(key)}
                              data-testid={`settings-webhook-event-${key}`}
                              onChange={(e) => setWebhookEvents((prev) =>
                                e.target.checked ? [...prev, key] : prev.filter((k) => k !== key))}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="settings-l2-foot">
                      <button
                        type="button"
                        className="text-action-link muted"
                        data-testid="settings-l3-toggle-external-sync"
                        onClick={() => toggleL3('external-sync')}
                      >
                        {l3Open['external-sync'] ? '高级参数 ▾' : '高级参数 ▸'}
                      </button>
                      <div className="settings-l2-btns">
                        <button
                          type="button"
                          className="btn"
                          data-testid="settings-webhook-test"
                          disabled={readOnly || testBusy || savingKey === 'external_webhook_config'}
                          onClick={() => void runWebhookTest()}
                        >
                          {testBusy ? '推送中…' : '测试推送'}
                        </button>
                        <button type="button" className="btn" onClick={() => setExpandedRow(null)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn dark"
                          data-testid="settings-save-webhook"
                          disabled={readOnly || savingKey === 'external_webhook_config'}
                          onClick={() => void saveWebhookConfig()}
                        >
                          {savingKey === 'external_webhook_config' ? '保存中…' : '保存更改'}
                        </button>
                      </div>
                    </div>
                    {l3Open['external-sync'] ? (
                      <div className="settings-l3 settings-form-grid" data-testid="settings-l3-external-sync">
                        <label className="settings-field">
                          <span>签名密钥（仅在填写时轮换；GET 永不回传明文）</span>
                          <input
                            type="password"
                            disabled={readOnly}
                            value={webhookSecret}
                            data-testid="settings-webhook-secret"
                            placeholder={webhookSecretSet ? '已设置 · 留空则保持不变' : '至少 16 字符'}
                            onChange={(e) => setWebhookSecret(e.target.value)}
                          />
                        </label>
                        <div className="settings-kv-row">
                          <span>签名说明</span>
                          <span>
                            每条推送带 X-Recruitment-Event 与 X-Recruitment-Signature: sha256=&lt;HMAC&gt;；
                            外发失败只记审计，绝不回滚主业务；测试推送返回真实 HTTP 状态码。
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === 'automation' ? (
            <div className="settings-list">
              <div className="settings-row" data-testid="settings-row-sla">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">队列超时阈值（初筛与面评 SLA）</div>
                    <div className="settings-row-desc">
                      初筛超过 {screeningHours} 小时、面评超过 {scorecardHours} 小时后在今日待办标红提示。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-ok">
                      {screeningHours}h / {scorecardHours}h
                    </span>
                    <button type="button" className="btn" onClick={() => toggleRow('sla')}>
                      {expandedRow === 'sla' ? '收起' : '配置'}
                    </button>
                  </div>
                </div>
                {expandedRow === 'sla' ? (
                  <div className="settings-l2" data-testid="settings-expand-sla">
                    <div className="settings-form-grid">
                      <label className="settings-field">
                        <span>初筛超时阈值（小时）</span>
                        <input
                          type="number"
                          min={1}
                          max={720}
                          disabled={readOnly}
                          value={screeningHours}
                          onChange={(e) => setScreeningHours(Number(e.target.value) || 24)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>面评超时阈值（小时）</span>
                        <input
                          type="number"
                          min={1}
                          max={720}
                          disabled={readOnly}
                          value={scorecardHours}
                          onChange={(e) => setScorecardHours(Number(e.target.value) || 48)}
                        />
                      </label>
                    </div>
                    <div className="settings-l2-foot">
                      <button
                        type="button"
                        className="text-action-link muted"
                        data-testid="settings-l3-toggle-sla"
                        onClick={() => toggleL3('sla')}
                      >
                        {l3Open.sla ? '高级参数 ▾' : '高级参数 ▸'}
                      </button>
                      <div className="settings-l2-btns">
                        <button type="button" className="btn" onClick={() => setExpandedRow(null)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn dark"
                          data-testid="settings-save-sla"
                          disabled={readOnly || savingKey === 'sla_thresholds'}
                          onClick={() =>
                            void handleSaveSetting(
                              'sla_thresholds',
                              {
                                screening_hours: Math.max(1, Math.min(720, Math.round(screeningHours))),
                                scorecard_hours: Math.max(1, Math.min(720, Math.round(scorecardHours))),
                              },
                              `调整初筛超时为 ${screeningHours} 小时，面评超时为 ${scorecardHours} 小时`,
                            )
                          }
                        >
                          {savingKey === 'sla_thresholds' ? '保存中…' : '保存更改'}
                        </button>
                      </div>
                    </div>
                    {l3Open.sla ? (
                      <div className="settings-l3">
                        合法范围为 1～720 小时；保存后写入不可变版本链并立即影响待拍板队列排序。
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-reminder">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">面评催交策略</div>
                    <div className="settings-row-desc">
                      {reminderEnabled
                        ? `已开启 · 面试结束 ${reminderHours} 小时后提醒，最多 ${reminderMax} 次`
                        : '已关闭 · 仅在工作台静默标红，不主动发送催交提醒'}
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className={`settings-status ${reminderEnabled ? 'tone-ok' : 'tone-muted'}`}>
                      {reminderEnabled ? '已开启' : '已关闭'}
                    </span>
                    <button type="button" className="btn" onClick={() => toggleRow('reminder')}>
                      {expandedRow === 'reminder' ? '收起' : '配置'}
                    </button>
                  </div>
                </div>
                {expandedRow === 'reminder' ? (
                  <div className="settings-l2" data-testid="settings-expand-reminder">
                    <div className="settings-form-grid">
                      <label className="settings-field">
                        <span>启用状态</span>
                        <select
                          disabled={readOnly}
                          value={reminderEnabled ? 'on' : 'off'}
                          onChange={(e) => setReminderEnabled(e.target.value === 'on')}
                        >
                          <option value="on">开启自动催交</option>
                          <option value="off">暂停催交</option>
                        </select>
                      </label>
                      <label className="settings-field">
                        <span>超时阈值</span>
                        <select
                          disabled={readOnly}
                          value={reminderHours}
                          onChange={(e) => setReminderHours(Number(e.target.value) as 24 | 48 | 72)}
                        >
                          <option value={24}>24 小时</option>
                          <option value={48}>48 小时</option>
                          <option value={72}>72 小时</option>
                        </select>
                      </label>
                      <label className="settings-field">
                        <span>提醒通道</span>
                        <select
                          disabled={readOnly}
                          value={reminderChannel}
                          onChange={(e) =>
                            setReminderChannel(e.target.value as 'workbench' | 'feishu' | 'email')
                          }
                        >
                          <option value="workbench">工作台置顶提醒</option>
                          <option value="feishu">飞书消息</option>
                          <option value="email">邮件提醒</option>
                        </select>
                      </label>
                    </div>
                    <div className="settings-l2-foot">
                      <button
                        type="button"
                        className="text-action-link muted"
                        data-testid="settings-l3-toggle-reminder"
                        onClick={() => toggleL3('reminder')}
                      >
                        {l3Open.reminder ? '高级参数 ▾' : '高级参数 ▸'}
                      </button>
                      <div className="settings-l2-btns">
                        <button type="button" className="btn" onClick={() => setExpandedRow(null)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn dark"
                          data-testid="settings-save-reminder"
                          disabled={readOnly || savingKey === 'scorecard_reminder_policy'}
                          onClick={() =>
                            void handleSaveSetting(
                              'scorecard_reminder_policy',
                              {
                                enabled: reminderEnabled,
                                overdue_hours: reminderHours,
                                max_reminders: Math.max(1, Math.min(5, reminderMax)),
                                channel: reminderChannel,
                                quiet_hours: { start: quietStart, end: quietEnd },
                              },
                              `更新面评催交策略：${reminderEnabled ? '开启' : '关闭'}，${reminderHours}h，上限 ${reminderMax} 次`,
                            )
                          }
                        >
                          {savingKey === 'scorecard_reminder_policy' ? '保存中…' : '保存更改'}
                        </button>
                      </div>
                    </div>
                    {l3Open.reminder ? (
                      <div className="settings-l3 settings-form-grid">
                        <label className="settings-field">
                          <span>最多提醒次数（1–5）</span>
                          <input
                            type="number"
                            min={1}
                            max={5}
                            disabled={readOnly}
                            value={reminderMax}
                            onChange={(e) => setReminderMax(Number(e.target.value) || 2)}
                          />
                        </label>
                        <label className="settings-field">
                          <span>免打扰开始</span>
                          <input
                            type="text"
                            disabled={readOnly}
                            value={quietStart}
                            onChange={(e) => setQuietStart(e.target.value)}
                          />
                        </label>
                        <label className="settings-field">
                          <span>免打扰结束</span>
                          <input
                            type="text"
                            disabled={readOnly}
                            value={quietEnd}
                            onChange={(e) => setQuietEnd(e.target.value)}
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-auto-prep">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">入库自动初筛与转写草稿</div>
                    <div className="settings-row-desc">
                      简历入库后自动对照岗位标准生成初筛参考；导入面试转写后自动起草面评（仍需真人拍板）。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-ok">
                      初筛{autoScreening ? '开' : '关'} · 草稿{autoScorecardDraft ? '开' : '关'}
                    </span>
                    <button type="button" className="btn" onClick={() => toggleRow('auto-prep')}>
                      {expandedRow === 'auto-prep' ? '收起' : '配置'}
                    </button>
                  </div>
                </div>
                {expandedRow === 'auto-prep' ? (
                  <div className="settings-l2" data-testid="settings-expand-auto-prep">
                    <div className="settings-toggle-line">
                      <span>简历入库自动初筛</span>
                      <button
                        type="button"
                        className="btn"
                        disabled={readOnly || savingKey === 'auto_screening_enabled'}
                        onClick={() =>
                          void handleSaveSetting(
                            'auto_screening_enabled',
                            !autoScreening,
                            `${!autoScreening ? '开启' : '关闭'}简历入库自动初筛`,
                          )
                        }
                      >
                        {autoScreening ? '已开启（点击关闭）' : '已关闭（点击开启）'}
                      </button>
                    </div>
                    <div className="settings-toggle-line">
                      <span>转写导入自动生成面评草稿</span>
                      <button
                        type="button"
                        className="btn"
                        disabled={readOnly || savingKey === 'auto_scorecard_draft_enabled'}
                        onClick={() =>
                          void handleSaveSetting(
                            'auto_scorecard_draft_enabled',
                            !autoScorecardDraft,
                            `${!autoScorecardDraft ? '开启' : '关闭'}转写自动生成面评草稿`,
                          )
                        }
                      >
                        {autoScorecardDraft ? '已开启（点击关闭）' : '已关闭（点击开启）'}
                      </button>
                    </div>
                    <div className="settings-toggle-line">
                      <span>允许助手在无风险场景静默代办</span>
                      <button
                        type="button"
                        className="btn"
                        disabled={readOnly || savingKey === 'agent_silent_delegation'}
                        onClick={() =>
                          void handleSaveSetting(
                            'agent_silent_delegation',
                            !silentDelegation,
                            `${!silentDelegation ? '开启' : '关闭'}无风险静默代办`,
                          )
                        }
                      >
                        {silentDelegation ? '已开启（点击关闭）' : '已关闭（点击开启）'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-booking-defaults">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">候选人自助预约默认值</div>
                    <div className="settings-row-desc">
                      发送候选人自助选时段链接时，默认有效 {bookingExpires} 小时、单次面试 {bookingDuration} 分钟。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-ok">
                      {bookingExpires}h · {bookingDuration} 分钟
                    </span>
                    <button type="button" className="btn" onClick={() => toggleRow('booking')}>
                      {expandedRow === 'booking' ? '收起' : '配置'}
                    </button>
                  </div>
                </div>
                {expandedRow === 'booking' ? (
                  <div className="settings-l2" data-testid="settings-expand-booking">
                    <div className="settings-form-grid">
                      <label className="settings-field">
                        <span>链接有效期（24–168 小时）</span>
                        <input
                          type="number"
                          min={24}
                          max={168}
                          disabled={readOnly}
                          value={bookingExpires}
                          onChange={(e) => setBookingExpires(Number(e.target.value) || 72)}
                        />
                      </label>
                      <label className="settings-field">
                        <span>默认面试时长</span>
                        <select
                          disabled={readOnly}
                          value={bookingDuration}
                          onChange={(e) =>
                            setBookingDuration(Number(e.target.value) as 30 | 45 | 60 | 90)
                          }
                        >
                          <option value={30}>30 分钟</option>
                          <option value={45}>45 分钟</option>
                          <option value={60}>60 分钟</option>
                          <option value={90}>90 分钟</option>
                        </select>
                      </label>
                    </div>
                    <div className="settings-l2-foot">
                      <span />
                      <div className="settings-l2-btns">
                        <button type="button" className="btn" onClick={() => setExpandedRow(null)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn dark"
                          data-testid="settings-save-booking"
                          disabled={readOnly || savingKey === 'booking_invite_defaults'}
                          onClick={() =>
                            void handleSaveSetting(
                              'booking_invite_defaults',
                              {
                                expires_hours: Math.max(24, Math.min(168, Math.round(bookingExpires))),
                                default_duration_min: bookingDuration,
                              },
                              `更新候选人自助预约默认值：${bookingExpires} 小时，${bookingDuration} 分钟`,
                            )
                          }
                        >
                          {savingKey === 'booking_invite_defaults' ? '保存中…' : '保存更改'}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === 'org' ? (
            <div className="settings-list">
              <div className="settings-row" data-testid="settings-row-roles">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">角色与权限范围</div>
                    <div className="settings-row-desc">
                      按企业实际组织定义招聘角色能力边界，所有删除操作均为软关闭并保留审计记录。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-muted">
                      {orgData?.roles ? `${orgData.roles.length} 个角色` : '待后端投影接入'}
                    </span>
                  </div>
                </div>
                {orgData?.roles && orgData.roles.length > 0 ? (
                  <div className="settings-l2">
                    {orgData.roles.map((r) => (
                      <div key={r.code} className="settings-kv-row">
                        <span>{r.name}</span>
                        <span>{(r.permission_scopes || []).length} 项权限</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-teams">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">招聘团队</div>
                    <div className="settings-row-desc">
                      维护各业务线的招聘负责人与面试官团队，用于排期与面评权限隔离。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-muted">
                      {orgData?.hiring_teams ? `${orgData.hiring_teams.length} 个团队` : '待后端投影接入'}
                    </span>
                  </div>
                </div>
                {orgData?.hiring_teams && orgData.hiring_teams.length > 0 ? (
                  <div className="settings-l2">
                    {orgData.hiring_teams.map((t) => (
                      <div key={t.code} className="settings-kv-row">
                        <span>{t.name}</span>
                        <span>{t.member_count ?? 0} 位成员</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-pipelines">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">招聘流程与面试模板</div>
                    <div className="settings-row-desc">
                      模板更新不会静默改写进行中的申请，保障每个历史候选人的阶段可复核。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-muted">
                      {orgData?.pipeline_templates
                        ? `${orgData.pipeline_templates.length} 套模板`
                        : '待后端投影接入'}
                    </span>
                  </div>
                </div>
                {orgData?.pipeline_templates && orgData.pipeline_templates.length > 0 ? (
                  <div className="settings-l2">
                    {orgData.pipeline_templates.map((p) => (
                      <div key={p.code} className="settings-kv-row">
                        <span>{p.name}</span>
                        <span>{p.stage_count ?? 0} 个阶段</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === 'governance' ? (
            <div className="settings-list">
              <div className="settings-row" data-testid="settings-row-skills">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">招聘工作说明书（S6–S10 只读视图）</div>
                    <div className="settings-row-desc">
                      对话助手严格遵循纯只读白名单 / 0 写红线，所有落库操作均须经真人确认。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-ok">{skillsList.length} 套生效中</span>
                  </div>
                </div>
                <div className="settings-l2">
                  {skillsList.map((s) => (
                    <div key={s.id} className="settings-kv-row">
                      <span>{s.stage} · {s.title}</span>
                      <span className="settings-mono">{s.id}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="settings-row" data-testid="settings-row-g3-telemetry">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">线上成对质量护栏（G3 只读遥测）</div>
                    <div className="settings-row-desc">
                      主指标与护栏成对展示，防止单向刷高效率指标掩盖误判或橡皮图章风险。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-muted">
                      {data?.governance?.g3_telemetry?.paired_guardrails?.some((g) => g.status === 'WATCH')
                        ? '有关注项'
                        : data?.governance?.g3_telemetry?.paired_guardrails?.some((g) => g.status === 'OK')
                          ? '运行平稳'
                          : '等待样本'}
                    </span>
                  </div>
                </div>
                {data?.governance?.g3_telemetry?.paired_guardrails &&
                data.governance.g3_telemetry.paired_guardrails.length > 0 ? (
                  <div className="settings-l2">
                    {data.governance.g3_telemetry.paired_guardrails.map((g) => {
                      const fmt = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
                      const statusText = g.status === 'WATCH' ? '关注' : g.status === 'OK' ? '正常' : '暂无数据';
                      return (
                        <div key={g.id} className="settings-kv-row" data-testid={`g3-guardrail-${g.id}`}>
                          <span>
                            {g.label}（主 {fmt(g.primaryRate)} / 护栏 {fmt(g.guardrailRate)}）
                          </span>
                          <span>
                            {statusText} · {g.note}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div className="settings-row" data-testid="settings-row-eval">
                <div className="settings-row-main">
                  <div className="settings-row-info">
                    <div className="settings-row-title">模型无关评测基线（Agent Eval）</div>
                    <div className="settings-row-desc">
                      交付与具体模型解耦；切换模型或调整工作说明书前，以 43 例全链路评测（P1–P6）与 G0–G3 分层门禁为准。
                    </div>
                  </div>
                  <div className="settings-row-actions">
                    <span className="settings-status tone-muted">
                      {data?.governance?.eval_summary
                        ? `${data.governance.eval_summary.passed ?? 0}/${data.governance.eval_summary.total ?? 18} 通过`
                        : '暂无本地回归记录'}
                    </span>
                  </div>
                </div>
                {data?.governance?.eval_summary ? (
                  <div className="settings-l2">
                    <div className="settings-kv-row">
                      <span>稳定性指标</span>
                      <span>{data.governance.eval_summary.pass_k || '—'}</span>
                    </div>
                    <div className="settings-kv-row">
                      <span>最近运行时间</span>
                      <span>{data.governance.eval_summary.updated_at || '—'}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
