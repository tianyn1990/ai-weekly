#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

type ServiceCommand = "setup-macos" | "up" | "down" | "restart" | "status" | "logs";

interface CliArgs {
  command: ServiceCommand;
  projectRoot: string;
  envFilePath: string;
  tunnelName: string;
  tunnelConfigPath: string;
  tunnelHostname?: string;
  tunnelId?: string;
  tunnelCredentialsFile?: string;
  callbackHost: string;
  callbackPort: number;
  logsTail: number;
  launchdEnvFilePath: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecInput {
  command: string;
  args: string[];
}

type CommandRunner = (input: ExecInput) => Promise<CommandResult>;

interface SetupCheck {
  id: string;
  title: string;
  ok: boolean;
  fix?: string;
  detail?: string;
}

interface CloudflaredConfigSummary {
  tunnel?: string;
  credentialsFile?: string;
  hostname?: string;
  service?: string;
}

interface HealthCheckResult {
  ok: boolean;
  detail?: string;
}

const DAEMON_LABEL = "com.ai-weekly.daemon";
const TUNNEL_LABEL = "com.ai-weekly.tunnel";
const DEFAULT_LAUNCHD_ENV_FILE = path.join(os.homedir(), ".config", "ai-weekly", ".env.launchd");
const SAME_LABEL_BOOTSTRAP_RETRY = 3;
const BOOTSTRAP_RETRY_DELAY_MS = 400;
const STARTUP_HEALTH_MAX_ATTEMPTS = 8;
const STARTUP_HEALTH_RETRY_DELAY_MS = 600;

// 该工具的定位是“本地运维控制面”：把分散的手工命令收敛为可复用子命令，
// 降低新机器接入和日常运行的操作复杂度。
async function main() {
  const args = parseArgs(process.argv.slice(2), process.cwd(), process.env);
  switch (args.command) {
    case "setup-macos":
      await runSetupMacos(args);
      return;
    case "up":
      await runUp(args);
      return;
    case "down":
      await runDown(args);
      return;
    case "restart":
      await runDown(args);
      await runUp(args);
      return;
    case "status":
      await runStatus(args);
      return;
    case "logs":
      await runLogs(args);
      return;
  }
}

async function runSetupMacos(args: CliArgs, runner: CommandRunner = defaultCommandRunner) {
  const checks = await collectSetupChecks(args, runner);
  let failed = 0;
  for (const check of checks) {
    if (!check.ok) {
      failed += 1;
    }
    console.log(`[setup] ${check.ok ? "OK" : "FAIL"} ${check.title}${check.detail ? ` (${check.detail})` : ""}`);
    if (!check.ok && check.fix) {
      console.log(`  -> 建议修复：${check.fix}`);
    }
  }
  if (failed > 0) {
    throw new Error(`setup_failed: ${failed} 项未通过，请按提示修复后重试`);
  }
  console.log("[setup] 已通过，下一步可执行：pnpm run services:up");
}

async function runUp(args: CliArgs, runner: CommandRunner = defaultCommandRunner) {
  assertMacOS();
  // 先保证日志目录存在，避免 launchd 启动后因为日志路径缺失直接失败。
  await fs.mkdir(path.join(args.projectRoot, "outputs", "service-logs"), { recursive: true });
  await fs.mkdir(path.join(os.homedir(), "Library", "LaunchAgents"), { recursive: true });
  await ensureTunnelConfig(args);
  const launchdEnvFilePath = await ensureLaunchdEnvFile(args);

  const daemonPlist = renderLaunchAgentPlist({
    label: DAEMON_LABEL,
    command: buildDaemonCommand(args, launchdEnvFilePath),
    projectRoot: args.projectRoot,
    stdoutPath: path.join(args.projectRoot, "outputs", "service-logs", "daemon.out.log"),
    stderrPath: path.join(args.projectRoot, "outputs", "service-logs", "daemon.err.log"),
  });
  const tunnelPlist = renderLaunchAgentPlist({
    label: TUNNEL_LABEL,
    command: buildTunnelCommand(args, launchdEnvFilePath),
    projectRoot: args.projectRoot,
    stdoutPath: path.join(args.projectRoot, "outputs", "service-logs", "tunnel.out.log"),
    stderrPath: path.join(args.projectRoot, "outputs", "service-logs", "tunnel.err.log"),
  });

  const daemonPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
  const tunnelPlistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${TUNNEL_LABEL}.plist`);
  await fs.writeFile(daemonPlistPath, daemonPlist, "utf-8");
  await fs.writeFile(tunnelPlistPath, tunnelPlist, "utf-8");

  await bootoutIfExists(DAEMON_LABEL, runner);
  await bootoutIfExists(TUNNEL_LABEL, runner);
  await waitForServiceStopped(DAEMON_LABEL, runner);
  await waitForServiceStopped(TUNNEL_LABEL, runner);
  await bootstrapAgent(daemonPlistPath, runner);
  await bootstrapAgent(tunnelPlistPath, runner);
  await kickstartAgent(DAEMON_LABEL, runner);
  await kickstartAgent(TUNNEL_LABEL, runner);

  await waitForStartupHealth(args);
  console.log(`[services] started: ${DAEMON_LABEL}, ${TUNNEL_LABEL}`);
  await runStatus(args, runner);
}

async function runDown(_args: CliArgs, runner: CommandRunner = defaultCommandRunner) {
  assertMacOS();
  await bootoutIfExists(DAEMON_LABEL, runner);
  await bootoutIfExists(TUNNEL_LABEL, runner);
  console.log(`[services] stopped: ${DAEMON_LABEL}, ${TUNNEL_LABEL}`);
}

async function runStatus(args: CliArgs, runner: CommandRunner = defaultCommandRunner) {
  assertMacOS();
  const daemon = await queryLaunchAgent(DAEMON_LABEL, runner);
  const tunnel = await queryLaunchAgent(TUNNEL_LABEL, runner);
  const localHealthUrl = `http://${args.callbackHost}:${args.callbackPort}/health`;
  const localHealth = await checkHttpHealth(localHealthUrl);
  const hostname = args.tunnelHostname ?? (await detectTunnelHostname(args.tunnelConfigPath));
  // 公网探测不是强制成功条件；其价值是快速发现“本地服务正常但外网不可达”的隧道问题。
  const publicHealth = hostname ? await checkHttpHealth(`https://${hostname}/health`) : { ok: false, detail: "missing_hostname" };

  console.log(`[status] daemon=${daemon.state}${daemon.pid ? ` pid=${daemon.pid}` : ""}`);
  console.log(`[status] tunnel=${tunnel.state}${tunnel.pid ? ` pid=${tunnel.pid}` : ""}`);
  console.log(`[health] local=${localHealth.ok ? "ok" : "fail"} (${localHealthUrl})${localHealth.detail ? ` ${localHealth.detail}` : ""}`);
  if (hostname) {
    console.log(
      `[health] public=${publicHealth.ok ? "ok" : "fail"} (https://${hostname}/health)${
        publicHealth.detail ? ` ${publicHealth.detail}` : ""
      }`,
    );
  } else {
    console.log("[health] public=skip (未找到 tunnel hostname，请检查 config 或环境变量)");
  }
}

async function runLogs(args: CliArgs) {
  const targets = [
    path.join(args.projectRoot, "outputs", "service-logs", "daemon.out.log"),
    path.join(args.projectRoot, "outputs", "service-logs", "daemon.err.log"),
    path.join(args.projectRoot, "outputs", "service-logs", "tunnel.out.log"),
    path.join(args.projectRoot, "outputs", "service-logs", "tunnel.err.log"),
  ];
  for (const filePath of targets) {
    console.log(`\n===== ${filePath} =====`);
    const content = await readTail(filePath, args.logsTail);
    console.log(content.length > 0 ? content : "(empty)");
  }
}

async function collectSetupChecks(args: CliArgs, runner: CommandRunner): Promise<SetupCheck[]> {
  // 检查顺序按“平台 -> 依赖 -> 配置 -> 运行资产”组织，方便用户按输出顺序逐项修复。
  const checks: SetupCheck[] = [];
  checks.push({
    id: "platform",
    title: "运行平台为 macOS",
    ok: process.platform === "darwin",
    fix: "请在 macOS 机器执行 setup:macos；其他平台将使用后续 Linux/systemd 方案。",
    detail: process.platform,
  });

  for (const binary of ["node", "pnpm", "cloudflared", "sqlite3"]) {
    const exists = await commandExists(binary, runner);
    checks.push({
      id: `binary_${binary}`,
      title: `已安装 ${binary}`,
      ok: exists,
      fix: `请先安装 ${binary} 并确保命令可执行（可通过 which ${binary} 验证）。`,
    });
  }
  const cloudflaredExists = checks.find((item) => item.id === "binary_cloudflared")?.ok === true;
  if (cloudflaredExists) {
    const tunnelProbe = await probeTunnelExists(args.tunnelName, runner);
    checks.push({
      id: "tunnel_exists",
      title: `cloudflared tunnel 已存在 (${args.tunnelName})`,
      ok: tunnelProbe.ok,
      fix: `可执行 cloudflared tunnel login && cloudflared tunnel create ${args.tunnelName}`,
      detail: tunnelProbe.detail,
    });
  }

  const envExists = await fileExists(args.envFilePath);
  checks.push({
    id: "env_file",
    title: `存在环境文件 ${args.envFilePath}`,
    ok: envExists,
    fix: "执行 cp .env.local.example .env.local 并填入真实配置。",
  });
  checks.push({
    id: "launchd_env_target",
    title: "launchd 专用 env 文件路径已配置",
    ok: true,
    detail: args.launchdEnvFilePath,
    fix: `可通过 AI_WEEKLY_LAUNCHD_ENV_FILE 覆盖默认值（当前默认 ${DEFAULT_LAUNCHD_ENV_FILE}）。`,
  });

  checks.push({
    id: "env_source_target_conflict",
    title: "env 源文件与 launchd 目标文件分离",
    ok: !isEnvSourceSameAsLaunchdTarget(args.envFilePath, args.launchdEnvFilePath),
    detail: `source=${args.envFilePath}, target=${args.launchdEnvFilePath}`,
    fix: "请将 AI_WEEKLY_ENV_FILE 指向项目 .env.local，并保留 AI_WEEKLY_LAUNCHD_ENV_FILE 指向 ~/.config/ai-weekly/.env.launchd。",
  });

  const pathProtected = isLikelyTccProtectedPath(args.envFilePath);
  checks.push({
    id: "env_source_path_risk",
    title: "源 env 文件路径风险提示",
    ok: true,
    detail: pathProtected
      ? `检测到 ${args.envFilePath} 位于可能受 macOS TCC 保护目录，services:up 会自动同步到 ${args.launchdEnvFilePath}`
      : `${args.envFilePath}（低风险路径）`,
    fix: `若遇到 operation not permitted，请执行 pnpm run services:up 重新同步 launchd env 文件。`,
  });

  const mergedEnv = await loadEnvFromFile(args.envFilePath);
  for (const key of ["FEISHU_CALLBACK_AUTH_TOKEN", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "REVIEW_CHAT_ID"]) {
    const ok = Boolean(mergedEnv[key] && mergedEnv[key]?.trim().length);
    checks.push({
      id: `env_${key}`,
      title: `已配置 ${key}`,
      ok,
      fix: `请在 ${args.envFilePath} 中补齐 ${key}。`,
    });
  }

  await ensureTunnelConfig(args, mergedEnv);
  const configExists = await fileExists(args.tunnelConfigPath);
  checks.push({
    id: "tunnel_config",
    title: `存在 cloudflared config (${args.tunnelConfigPath})`,
    ok: configExists,
    fix: "设置 CLOUDFLARED_TUNNEL_ID/CLOUDFLARED_TUNNEL_HOSTNAME 后重试 setup:macos 自动生成。",
  });

  if (configExists) {
    const summary = await loadCloudflaredConfigSummary(args.tunnelConfigPath);
    const credentialPath = summary.credentialsFile;
    checks.push({
      id: "tunnel_hostname",
      title: "cloudflared config 含固定 hostname",
      ok: Boolean(summary.hostname),
      fix: "请在 cloudflared config ingress 中配置 hostname（例如 callback.xxx.com）。",
      detail: summary.hostname,
    });
    checks.push({
      id: "tunnel_service",
      title: "cloudflared config 已转发到本地 callback 服务",
      ok: summary.service === `http://${args.callbackHost}:${args.callbackPort}`,
      fix: `请将 ingress service 改为 http://${args.callbackHost}:${args.callbackPort}`,
      detail: summary.service,
    });
    checks.push({
      id: "tunnel_credential",
      title: "cloudflared credentials 文件存在",
      ok: Boolean(credentialPath && (await fileExists(credentialPath))),
      fix: "请执行 cloudflared tunnel create/login 或修正 credentials-file 路径。",
      detail: credentialPath,
    });
  }

  checks.push({
    id: "single_active_host",
    title: "单机活跃约束提示",
    ok: true,
    detail: "当前版本不支持多机并发 active daemon，避免重复调度与重复通知。",
  });

  return checks;
}

async function ensureLaunchdEnvFile(args: CliArgs): Promise<string> {
  const targetPath = args.launchdEnvFilePath;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const sourcePath = await resolveEffectiveEnvSourcePath(args);
  if (sourcePath !== args.envFilePath) {
    // 当用户误把 AI_WEEKLY_ENV_FILE 指到 launchd 文件时，自动回退到项目 .env.local，
    // 防止“自复制”导致关键参数（例如 LLM 配置）被长期丢失。
    console.log(`[services-warn] 检测到 env 源/目标冲突，已自动改用 ${sourcePath} 作为同步源。`);
  }

  const sourceExists = await fileExists(sourcePath);
  if (sourceExists) {
    const sourceContent = await fs.readFile(sourcePath, "utf-8");
    // launchd 进程读取受保护目录（如 Documents）常会被 TCC 拦截，统一同步到 ~/.config 降低权限风险。
    await fs.writeFile(targetPath, sourceContent, "utf-8");
  } else if (!(await fileExists(targetPath))) {
    await fs.writeFile(targetPath, "# generated by service-ops\n", "utf-8");
  }

  await fs.chmod(targetPath, 0o600);
  return targetPath;
}

async function ensureTunnelConfig(args: CliArgs, envOverride?: Record<string, string>) {
  const sourcePath = await resolveEffectiveEnvSourcePath(args);
  const env = envOverride ?? (await loadEnvFromFile(sourcePath));
  if (await fileExists(args.tunnelConfigPath)) {
    return;
  }

  const tunnelId = args.tunnelId ?? env.CLOUDFLARED_TUNNEL_ID;
  const tunnelHostname = args.tunnelHostname ?? env.CLOUDFLARED_TUNNEL_HOSTNAME;
  // setup 阶段允许“条件不足时跳过生成”，避免在未配置 id/hostname 时强行失败。
  // 失败会在后续检查项中以可读提示暴露，而不是直接中断。
  if (!tunnelId || !tunnelHostname) {
    return;
  }

  const credentialsFile =
    args.tunnelCredentialsFile ?? env.CLOUDFLARED_CREDENTIALS_FILE ?? path.join(os.homedir(), ".cloudflared", `${tunnelId}.json`);
  const rendered = renderCloudflaredConfig({
    tunnelName: args.tunnelName,
    tunnelId,
    credentialsFile,
    hostname: tunnelHostname,
    callbackHost: args.callbackHost,
    callbackPort: args.callbackPort,
  });
  await fs.mkdir(path.dirname(args.tunnelConfigPath), { recursive: true });
  await fs.writeFile(args.tunnelConfigPath, rendered, "utf-8");
}

function parseArgs(argv: string[], projectRoot: string, env: NodeJS.ProcessEnv): CliArgs {
  const command = (argv[0] ?? "").trim() as ServiceCommand;
  if (!["setup-macos", "up", "down", "restart", "status", "logs"].includes(command)) {
    throw new Error("未知子命令。可选：setup-macos | up | down | restart | status | logs");
  }
  const envFilePath = env.AI_WEEKLY_ENV_FILE ?? path.join(projectRoot, ".env.local");
  return {
    command,
    projectRoot,
    envFilePath,
    tunnelName: env.CLOUDFLARED_TUNNEL_NAME ?? "ai-weekly-callback",
    tunnelConfigPath: env.CLOUDFLARED_CONFIG_PATH ?? path.join(os.homedir(), ".cloudflared", "config.yml"),
    tunnelHostname: env.CLOUDFLARED_TUNNEL_HOSTNAME,
    tunnelId: env.CLOUDFLARED_TUNNEL_ID,
    tunnelCredentialsFile: env.CLOUDFLARED_CREDENTIALS_FILE,
    callbackHost: env.FEISHU_CALLBACK_HOST ?? "127.0.0.1",
    callbackPort: parsePositiveInt(env.FEISHU_CALLBACK_PORT, 8787),
    logsTail: parsePositiveInt(env.SERVICE_LOGS_TAIL, 80),
    launchdEnvFilePath: env.AI_WEEKLY_LAUNCHD_ENV_FILE ?? DEFAULT_LAUNCHD_ENV_FILE,
  };
}

async function resolveEffectiveEnvSourcePath(args: Pick<CliArgs, "projectRoot" | "envFilePath" | "launchdEnvFilePath">): Promise<string> {
  if (!isEnvSourceSameAsLaunchdTarget(args.envFilePath, args.launchdEnvFilePath)) {
    return args.envFilePath;
  }

  const projectEnvPath = path.join(args.projectRoot, ".env.local");
  const projectEnvResolved = path.resolve(projectEnvPath);
  const launchdEnvResolved = path.resolve(args.launchdEnvFilePath);
  if (projectEnvResolved !== launchdEnvResolved && (await fileExists(projectEnvPath))) {
    return projectEnvPath;
  }
  return args.envFilePath;
}

function isEnvSourceSameAsLaunchdTarget(envFilePath: string, launchdEnvFilePath: string): boolean {
  return path.resolve(envFilePath) === path.resolve(launchdEnvFilePath);
}

async function loadEnvFromFile(filePath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseEnvFile(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function commandExists(binary: string, runner: CommandRunner) {
  const result = await runner({
    command: "which",
    args: [binary],
  });
  return result.exitCode === 0;
}

async function probeTunnelExists(tunnelName: string, runner: CommandRunner): Promise<{ ok: boolean; detail?: string }> {
  const result = await runner({
    command: "cloudflared",
    args: ["tunnel", "info", tunnelName],
  });
  if (result.exitCode === 0) {
    return { ok: true };
  }
  const detail = [result.stderr, result.stdout]
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 180);
  return {
    ok: false,
    detail: detail || "not_found_or_not_logged_in",
  };
}

function renderCloudflaredConfig(input: {
  tunnelName: string;
  tunnelId: string;
  credentialsFile: string;
  hostname: string;
  callbackHost: string;
  callbackPort: number;
}) {
  // 统一从模板渲染运行配置，避免多机手工编辑造成格式漂移或 ingress 缺失。
  return [
    `tunnel: ${input.tunnelName}`,
    `credentials-file: ${input.credentialsFile}`,
    "",
    "ingress:",
    `  - hostname: ${input.hostname}`,
    `    service: http://${input.callbackHost}:${input.callbackPort}`,
    "  - service: http_status:404",
    "",
    "# metadata",
    `# tunnel-id: ${input.tunnelId}`,
  ].join("\n");
}

async function loadCloudflaredConfigSummary(configPath: string): Promise<CloudflaredConfigSummary> {
  const content = await fs.readFile(configPath, "utf-8");
  return parseCloudflaredConfigSummary(content);
}

function parseCloudflaredConfigSummary(content: string): CloudflaredConfigSummary {
  const parsed = YAML.parse(content) as
    | {
        tunnel?: string;
        ["credentials-file"]?: string;
        ingress?: Array<{ hostname?: string; service?: string }>;
      }
    | undefined;

  const ingress = parsed?.ingress ?? [];
  const primary = ingress.find((item) => item.hostname);
  return {
    tunnel: parsed?.tunnel,
    credentialsFile: parsed?.["credentials-file"],
    hostname: primary?.hostname,
    service: primary?.service,
  };
}

function renderLaunchAgentPlist(input: {
  label: string;
  command: string;
  projectRoot: string;
  stdoutPath: string;
  stderrPath: string;
}) {
  // launchd 通过 shell 启动命令，必须做 XML 转义；否则路径中的特殊字符会导致 plist 解析失败。
  const escapedCommand = escapeXml(input.command);
  const escapedProjectRoot = escapeXml(input.projectRoot);
  const escapedStdout = escapeXml(input.stdoutPath);
  const escapedStderr = escapeXml(input.stderrPath);
  const pathValue = escapeXml(`${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${input.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${escapedCommand}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapedProjectRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapedStdout}</string>
  <key>StandardErrorPath</key>
  <string>${escapedStderr}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathValue}</string>
  </dict>
</dict>
</plist>`;
}

function buildDaemonCommand(args: CliArgs, launchdEnvFilePath: string) {
  const root = shellSingleQuote(args.projectRoot);
  const envFile = shellSingleQuote(launchdEnvFilePath);
  // 统一先 source .env.local，再执行 daemon，确保重启后运行参数一致。
  return `cd ${root} && if [ -f ${envFile} ]; then set -a; source ${envFile}; set +a; fi && exec pnpm run run:daemon`;
}

function buildTunnelCommand(args: CliArgs, launchdEnvFilePath: string) {
  const root = shellSingleQuote(args.projectRoot);
  const envFile = shellSingleQuote(launchdEnvFilePath);
  const configPath = shellSingleQuote(args.tunnelConfigPath);
  const tunnelName = shellSingleQuote(args.tunnelName);
  return `cd ${root} && if [ -f ${envFile} ]; then set -a; source ${envFile}; set +a; fi && exec cloudflared tunnel --config ${configPath} run ${tunnelName}`;
}

async function bootstrapAgent(plistPath: string, runner: CommandRunner) {
  const domain = launchctlDomain();
  let lastError = "";
  for (let attempt = 1; attempt <= SAME_LABEL_BOOTSTRAP_RETRY; attempt += 1) {
    const result = await runner({
      command: "launchctl",
      args: ["bootstrap", domain, plistPath],
    });
    if (result.exitCode === 0) {
      return;
    }
    const output = `${result.stderr}\n${result.stdout}`.trim();
    lastError = output;
    if (shouldRetryBootstrap(output) && attempt < SAME_LABEL_BOOTSTRAP_RETRY) {
      await sleep(BOOTSTRAP_RETRY_DELAY_MS * attempt);
      continue;
    }
    break;
  }
  throw new Error(`launchctl_bootstrap_failed:${lastError || "unknown_error"}`);
}

async function kickstartAgent(label: string, runner: CommandRunner) {
  const domain = launchctlDomain();
  const result = await runner({
    command: "launchctl",
    args: ["kickstart", "-k", `${domain}/${label}`],
  });
  if (result.exitCode !== 0) {
    throw new Error(`launchctl_kickstart_failed:${result.stderr || result.stdout}`);
  }
}

async function bootoutIfExists(label: string, runner: CommandRunner) {
  const domain = launchctlDomain();
  const result = await runner({
    command: "launchctl",
    args: ["bootout", `${domain}/${label}`],
  });
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    // bootout 在服务尚未加载时会返回错误，这里按幂等语义忽略。
    // 这样 restart/down 可以“无脑重试”，不用先判断服务是否存在。
    if (output.includes("could not find service") || output.includes("no such process")) {
      return;
    }
    if (output.includes("in progress") || output.includes("operation now in progress")) {
      return;
    }
  }
}

async function waitForServiceStopped(label: string, runner: CommandRunner): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await queryLaunchAgent(label, runner);
    if (state.state === "stopped") {
      return;
    }
    await sleep(150);
  }
}

async function waitForStartupHealth(args: CliArgs): Promise<void> {
  const localUrl = `http://${args.callbackHost}:${args.callbackPort}/health`;
  const hostname = args.tunnelHostname ?? (await detectTunnelHostname(args.tunnelConfigPath));
  const hasPublicTarget = Boolean(hostname);
  for (let attempt = 1; attempt <= STARTUP_HEALTH_MAX_ATTEMPTS; attempt += 1) {
    const local = await checkHttpHealth(localUrl);
    const publicHealth = hasPublicTarget
      ? await checkHttpHealth(`https://${hostname}/health`)
      : ({ ok: false, detail: "missing_hostname" } as HealthCheckResult);
    if (isStartupWarmupComplete({ local, publicHealth, hasPublicTarget })) {
      return;
    }
    if (attempt < STARTUP_HEALTH_MAX_ATTEMPTS) {
      console.log(
        `[services-wait] startup warm-up ${attempt}/${STARTUP_HEALTH_MAX_ATTEMPTS}: local=${local.ok ? "ok" : "fail"}${
          hasPublicTarget ? `, public=${publicHealth.ok ? "ok" : "fail"}` : ""
        }`,
      );
      await sleep(STARTUP_HEALTH_RETRY_DELAY_MS);
    }
  }
}

async function queryLaunchAgent(label: string, runner: CommandRunner): Promise<{ state: "running" | "stopped" | "unknown"; pid?: string }> {
  const domain = launchctlDomain();
  const result = await runner({
    command: "launchctl",
    args: ["print", `${domain}/${label}`],
  });
  if (result.exitCode !== 0) {
    return { state: "stopped" };
  }
  return parseLaunchctlPrint(result.stdout);
}

function parseLaunchctlPrint(content: string): { state: "running" | "stopped" | "unknown"; pid?: string } {
  // launchctl 输出并非稳定 JSON，这里用宽松 regex 兼容系统版本差异。
  const stateMatch = content.match(/state = ([a-z_]+)/i)?.[1]?.toLowerCase();
  const pidMatch = content.match(/\bpid = (\d+)/i)?.[1];
  if (stateMatch === "running") {
    return {
      state: "running",
      pid: pidMatch,
    };
  }
  if (stateMatch === "exited" || stateMatch === "stopped") {
    return {
      state: "stopped",
      pid: pidMatch,
    };
  }
  return {
    state: "unknown",
    pid: pidMatch,
  };
}

async function detectTunnelHostname(configPath: string): Promise<string | undefined> {
  try {
    const summary = await loadCloudflaredConfigSummary(configPath);
    return summary.hostname;
  } catch {
    return undefined;
  }
}

async function checkHttpHealth(url: string): Promise<{ ok: boolean; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, detail: `http_${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function isStartupWarmupComplete(input: {
  local: HealthCheckResult;
  publicHealth: HealthCheckResult;
  hasPublicTarget: boolean;
}): boolean {
  if (!input.local.ok) {
    return false;
  }
  if (!input.hasPublicTarget) {
    return true;
  }
  return input.publicHealth.ok;
}

async function readTail(filePath: string, lineCount: number): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    return lines.slice(Math.max(0, lines.length - Math.max(1, lineCount))).join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function shouldRetryBootstrap(output: string): boolean {
  const text = output.toLowerCase();
  return text.includes("input/output error") || text.includes("in progress") || text.includes("operation now in progress");
}

function isLikelyTccProtectedPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return ["/documents/", "/desktop/", "/icloud drive/", "/library/mobile documents/"].some((segment) => normalized.includes(segment));
}

function launchctlDomain() {
  // getuid 在 Node 类型定义中可能是可选属性；这里显式兜底避免编译报错。
  if (typeof process.getuid !== "function") {
    throw new Error("当前 Node 运行时不支持 process.getuid，无法推导 launchctl domain。");
  }
  return `gui/${process.getuid()}`;
}

function assertMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("仅支持 macOS（launchd 模式）。");
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shellSingleQuote(input: string): string {
  return `'${input.replaceAll("'", "'\"'\"'")}'`;
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function defaultCommandRunner(input: ExecInput): Promise<CommandResult> {
  // 统一子进程采集器：保证每个系统命令都返回 exitCode/stdout/stderr，
  // 上层可以按同一错误模型做提示与恢复。
  return await new Promise((resolve) => {
    const child = spawn(input.command, input.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[service-ops-error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export const __test__ = {
  parseArgs,
  parseEnvFile,
  isEnvSourceSameAsLaunchdTarget,
  renderCloudflaredConfig,
  parseCloudflaredConfigSummary,
  renderLaunchAgentPlist,
  buildDaemonCommand,
  buildTunnelCommand,
  parseLaunchctlPrint,
  isLikelyTccProtectedPath,
  shouldRetryBootstrap,
  isStartupWarmupComplete,
};
