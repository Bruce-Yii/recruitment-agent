# 产品 worker profile：`recruitment-worker`

任务运行时（`src/runtime`）的 **DSH Worker Session** 用哪个 profile，由产品 profile 的
`recruitment.config.runtime.worker_profile` 指定；本目录就是那个 profile 的**受管定义**（入仓），
`$DSH_HOME/profiles/recruitment-worker/` 是它的运行时副本。

## 为什么是 headless + credentials

- **headless**：Router 用 `dsh --profile <worker> --json` 起独立子进程执行一次 Attempt，
  不需要 Web UI。`@deepseek-ai/dsh-headless` 就是官方的「一次性 agent」bundle 组合。
- **重新启用 managed credentials**：`dsh-headless` 默认关掉 credential store，而 worker
  子进程的环境里没有 provider API key；不打开就取不到密钥，Worker 会在第一次模型调用时失败。
  密钥来自 `$DSH_HOME/.credentials.yaml`（**不在**本文件里，也不是环境变量）。

## 模型段

`agent-default-model = opencode-go-openai-key2 / longcat-2.5-free`，与产品 profile
`dsh/profile/recruitment` 的默认模型一致（D-93 实测可用档）。产品 profile 里的
`runtime.model_route` 必须写同一个路由——它只是写进 `agent_session.model_route` 的**标签**，
不参与选模型，写错就是假审计。

## 不变量

- 本文件**不含任何机器路径**：可执行文件、`DSH_HOME`、凭据全部来自环境
  （`dsh_bin` ← `$DSH_INSTALL_DIR/lib/bin.js` 或显式配置；密钥 ← `$DSH_HOME/.credentials.yaml`）。
- 版本跟随项目自带 DSH（`<项目自带 DSH 安装>`，0.2.2-rc.3）；`runtime_version`
  由产品 profile 配置给出，不在这里写死。

## 同步到运行时副本

```powershell
$home = '<产品自己的隔离 DSH_HOME>'   # D-92
New-Item -ItemType Directory -Force "$home\profiles\recruitment-worker" | Out-Null
Copy-Item -Force .\package.json,.\cordis.yml,.\cordis.patch.yml "$home\profiles\recruitment-worker\"
```

同步后用 `$DSH_HOME` 指向该 home、`--profile recruitment-worker --dump-config` 验证组合成功
（不需要模型额度，也不发起任何模型调用）。
