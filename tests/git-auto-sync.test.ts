import { describe, expect, it } from "vitest";

import { __test__, autoSyncToGit } from "../src/git/auto-sync.js";

describe("autoSyncToGit", () => {
  it("无变更时应跳过 commit/push", async () => {
    const calls: string[][] = [];
    const runner = async (input: { args: string[] }) => {
      calls.push(input.args);
      if (input.args[0] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await autoSyncToGit(
      {
        repoRoot: "/tmp/repo",
        includePaths: ["outputs/review", "outputs/published"],
        commitMessage: "auto",
        push: true,
      },
      runner as any,
    );

    expect(result.changed).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("status");
  });

  it("有变更时应执行 add/commit/rev-parse/push", async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (input: { args: string[]; env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: input.args, env: input.env });
      if (input.args[0] === "status") {
        return { exitCode: 0, stdout: " M outputs/review/weekly/2026-03-09.md\n", stderr: "" };
      }
      if (input.args[0] === "diff") {
        return { exitCode: 0, stdout: "outputs/review/weekly/2026-03-09.md\n", stderr: "" };
      }
      if (input.args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await autoSyncToGit(
      {
        repoRoot: "/tmp/repo",
        includePaths: ["outputs/review", "outputs/published"],
        commitMessage: "auto",
        push: true,
      },
      runner as any,
    );

    expect(result.changed).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.commitSha).toBe("abc123");
    expect(calls.map((item) => item.args[0])).toEqual(["status", "add", "diff", "commit", "rev-parse", "push"]);
    expect(calls[1].args).toEqual(["add", "--", "outputs/review/weekly/2026-03-09.md"]);
  });

  it("includePaths 含不存在目录时也应正常 add 实际变更文件", async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (input: { args: string[]; env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: input.args, env: input.env });
      if (input.args[0] === "status") {
        return { exitCode: 0, stdout: "?? outputs/review/weekly/2026-03-09.md\n", stderr: "" };
      }
      if (input.args[0] === "diff") {
        return { exitCode: 0, stdout: "outputs/review/weekly/2026-03-09.md\n", stderr: "" };
      }
      if (input.args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "def456\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await autoSyncToGit(
      {
        repoRoot: "/tmp/repo",
        includePaths: ["outputs/review", "outputs/runtime-config"],
        commitMessage: "auto",
        push: false,
      },
      runner as any,
    );

    expect(result.changed).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(calls.map((item) => item.args[0])).toEqual(["status", "add", "diff", "commit", "rev-parse"]);
    expect(calls[1].args).toEqual(["add", "--", "outputs/review/weekly/2026-03-09.md"]);
    expect(calls[1].args).not.toContain("outputs/runtime-config");
  });

  it("push 时应注入可选代理环境变量", async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (input: { args: string[]; env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: input.args, env: input.env });
      if (input.args[0] === "status") {
        return { exitCode: 0, stdout: " M outputs/review/weekly/2026-03-09.md\n", stderr: "" };
      }
      if (input.args[0] === "diff") {
        return { exitCode: 0, stdout: "outputs/review/weekly/2026-03-09.md\n", stderr: "" };
      }
      if (input.args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await autoSyncToGit(
      {
        repoRoot: "/tmp/repo",
        includePaths: ["outputs/review"],
        commitMessage: "auto",
        push: true,
        httpProxy: "http://127.0.0.1:8118",
        httpsProxy: "http://127.0.0.1:8118",
      },
      runner as any,
    );

    const pushCall = calls.find((item) => item.args[0] === "push");
    expect(pushCall?.env?.http_proxy).toBe("http://127.0.0.1:8118");
    expect(pushCall?.env?.https_proxy).toBe("http://127.0.0.1:8118");
  });
});

describe("auto-sync helpers", () => {
  it("应正确解析 porcelain 变更路径", () => {
    const files = __test__.parsePorcelainChangedFiles(" M outputs/review/a.md\n?? outputs/review/b.json\n");
    expect(files).toEqual(["outputs/review/a.md", "outputs/review/b.json"]);
  });
});
