import { describe, expect, it } from "vitest";

import { __test__ } from "../src/tools/service-ops.js";

describe("service-ops parseArgs", () => {
  it("应解析 setup-macos 子命令与默认值", () => {
    const args = __test__.parseArgs(["setup-macos"], "/repo", {});
    expect(args.command).toBe("setup-macos");
    expect(args.tunnelName).toBe("ai-weekly-callback");
    expect(args.callbackHost).toBe("127.0.0.1");
    expect(args.callbackPort).toBe(8787);
  });

  it("应从环境变量覆盖关键参数", () => {
    const args = __test__.parseArgs(["status"], "/repo", {
      FEISHU_CALLBACK_HOST: "0.0.0.0",
      FEISHU_CALLBACK_PORT: "9876",
      CLOUDFLARED_TUNNEL_NAME: "my-tunnel",
      AI_WEEKLY_LAUNCHD_ENV_FILE: "/tmp/.env.launchd",
      AI_WEEKLY_RUNTIME_ROOT: "/tmp/ai-weekly-runtime",
    });
    expect(args.command).toBe("status");
    expect(args.callbackHost).toBe("0.0.0.0");
    expect(args.callbackPort).toBe(9876);
    expect(args.tunnelName).toBe("my-tunnel");
    expect(args.launchdEnvFilePath).toBe("/tmp/.env.launchd");
    expect(args.runtimeRoot).toBe("/tmp/ai-weekly-runtime");
  });

  it("端口与日志行数非法时应回退默认值", () => {
    const args = __test__.parseArgs(["status"], "/repo", {
      FEISHU_CALLBACK_PORT: "not-a-number",
      SERVICE_LOGS_TAIL: "-20",
    });
    expect(args.callbackPort).toBe(8787);
    expect(args.logsTail).toBe(80);
  });

  it("未知子命令应抛错", () => {
    expect(() => __test__.parseArgs(["oops"], "/repo", {})).toThrow("未知子命令");
  });
});

describe("service-ops env parser", () => {
  it("应正确解析注释、引号与空行", () => {
    const parsed = __test__.parseEnvFile(`
# comment
FEISHU_APP_ID="cli_xxx"
FEISHU_APP_SECRET='sec_yyy'
REVIEW_CHAT_ID=oc_zzz

INVALID_LINE
`);
    expect(parsed.FEISHU_APP_ID).toBe("cli_xxx");
    expect(parsed.FEISHU_APP_SECRET).toBe("sec_yyy");
    expect(parsed.REVIEW_CHAT_ID).toBe("oc_zzz");
    expect(parsed.INVALID_LINE).toBeUndefined();
  });
});

describe("service-ops cloudflared config", () => {
  it("应渲染固定域名配置", () => {
    const rendered = __test__.renderCloudflaredConfig({
      tunnelName: "ai-weekly-callback",
      tunnelId: "abc-123",
      credentialsFile: "/Users/hetao/.cloudflared/abc-123.json",
      hostname: "callback.tianai.dev",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
    });
    expect(rendered).toContain("tunnel: ai-weekly-callback");
    expect(rendered).toContain("hostname: callback.tianai.dev");
    expect(rendered).toContain("service: http://127.0.0.1:8787");
  });

  it("应能解析 cloudflared 配置摘要", () => {
    const summary = __test__.parseCloudflaredConfigSummary(`
tunnel: ai-weekly-callback
credentials-file: /Users/hetao/.cloudflared/id.json
ingress:
  - hostname: callback.tianai.dev
    service: http://127.0.0.1:8787
  - service: http_status:404
`);
    expect(summary.tunnel).toBe("ai-weekly-callback");
    expect(summary.credentialsFile).toBe("/Users/hetao/.cloudflared/id.json");
    expect(summary.hostname).toBe("callback.tianai.dev");
    expect(summary.service).toBe("http://127.0.0.1:8787");
  });
});

describe("service-ops launchd helpers", () => {
  it("应渲染 launch agent plist 并进行 XML 转义", () => {
    const plist = __test__.renderLaunchAgentPlist({
      label: "com.ai-weekly.daemon",
      command: `echo "a&b"`,
      projectRoot: "/Users/hetao/Documents/ai-weekly",
      stdoutPath: "/tmp/a.out",
      stderrPath: "/tmp/a.err",
    });
    expect(plist).toContain("<string>com.ai-weekly.daemon</string>");
    expect(plist).toContain("a&amp;b");
  });

  it("应解析 launchctl print 输出状态", () => {
    const running = __test__.parseLaunchctlPrint(`
service = com.ai-weekly.daemon
state = running
pid = 12345
`);
    expect(running.state).toBe("running");
    expect(running.pid).toBe("12345");

    const stopped = __test__.parseLaunchctlPrint(`
service = com.ai-weekly.daemon
state = exited
`);
    expect(stopped.state).toBe("stopped");
  });

  it("daemon 启动命令应直接运行 dist 产物", () => {
    const command = __test__.buildDaemonCommand(
      {
        projectRoot: "/repo",
      } as any,
      "/tmp/.env.launchd",
    );
    expect(command).toContain("dist/cli.js run --daemon");
    expect(command).not.toContain("pnpm run run:daemon");
  });
});

describe("service-ops protection helpers", () => {
  it("应识别可能受 TCC 保护的路径", () => {
    expect(__test__.isLikelyTccProtectedPath("/Users/hetao/Documents/github/ai-weekly/.env.local")).toBe(true);
    expect(__test__.isLikelyTccProtectedPath("/Users/hetao/Desktop/.env.local")).toBe(true);
    expect(__test__.isLikelyTccProtectedPath("/Users/hetao/.config/ai-weekly/.env.launchd")).toBe(false);
  });

  it("应识别 bootstrap 可重试错误", () => {
    expect(__test__.shouldRetryBootstrap("Bootstrap failed: 5: Input/output error")).toBe(true);
    expect(__test__.shouldRetryBootstrap("operation now in progress")).toBe(true);
    expect(__test__.shouldRetryBootstrap("permission denied")).toBe(false);
  });

  it("应判断启动 warm-up 是否完成", () => {
    expect(
      __test__.isStartupWarmupComplete({
        local: { ok: true },
        publicHealth: { ok: true },
        hasPublicTarget: true,
      }),
    ).toBe(true);
    expect(
      __test__.isStartupWarmupComplete({
        local: { ok: true },
        publicHealth: { ok: false, detail: "http_530" },
        hasPublicTarget: true,
      }),
    ).toBe(false);
    expect(
      __test__.isStartupWarmupComplete({
        local: { ok: true },
        publicHealth: { ok: false, detail: "missing_hostname" },
        hasPublicTarget: false,
      }),
    ).toBe(true);
  });

  it("应识别 env 源文件与 launchd 目标文件冲突", () => {
    expect(__test__.isEnvSourceSameAsLaunchdTarget("/tmp/.env.launchd", "/tmp/.env.launchd")).toBe(true);
    expect(__test__.isEnvSourceSameAsLaunchdTarget("/repo/.env.local", "/tmp/.env.launchd")).toBe(false);
  });

  it("应为 launchd 生成低风险 runtime 路径覆盖", () => {
    const managed = __test__.buildManagedLaunchdEnv(
      {
        STORAGE_DB_PATH: "outputs/db/app.sqlite",
        DAEMON_MARKER_ROOT: "outputs/daemon/schedule-markers",
        FEISHU_NOTIFICATION_ROOT: "/tmp/custom-feishu",
      },
      {
        runtimeRoot: "/Users/hetao/.local/state/ai-weekly/runtime",
        launchdEnvFilePath: "/Users/hetao/.config/ai-weekly/.env.launchd",
      },
    );
    expect(managed.AI_WEEKLY_ENV_FILE).toBe("/Users/hetao/.config/ai-weekly/.env.launchd");
    expect(managed.STORAGE_DB_PATH).toBe("/Users/hetao/.local/state/ai-weekly/runtime/db/app.sqlite");
    expect(managed.DAEMON_MARKER_ROOT).toBe("/Users/hetao/.local/state/ai-weekly/runtime/daemon/schedule-markers");
    expect(managed.FEISHU_NOTIFICATION_ROOT).toBe("/tmp/custom-feishu");
    expect(managed.GIT_SYNC_INCLUDE_PATHS).toBe("outputs/review,outputs/published");
  });

  it("应把受管 launchd 配置附加到 env 文件末尾", () => {
    const merged = __test__.mergeLaunchdEnvContent({
      sourceContent: 'AUTO_GIT_SYNC="true"\n',
      managedEnv: {
        STORAGE_DB_PATH: "/tmp/runtime/db/app.sqlite",
        DAEMON_MARKER_ROOT: "/tmp/runtime/daemon/schedule-markers",
      },
    });
    expect(merged).toContain('AUTO_GIT_SYNC="true"');
    expect(merged).toContain("# --- managed by service-ops: launchd runtime paths ---");
    expect(merged).toContain('STORAGE_DB_PATH="/tmp/runtime/db/app.sqlite"');
  });
});
