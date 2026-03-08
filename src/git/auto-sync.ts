import { spawn } from "node:child_process";

export interface GitSyncInput {
  repoRoot: string;
  includePaths: string[];
  commitMessage: string;
  push?: boolean;
  remote?: string;
  branch?: string;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export interface GitSyncResult {
  changed: boolean;
  committed: boolean;
  pushed: boolean;
  commitSha?: string;
  changedFiles: string[];
}

export interface GitCommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (input: {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}) => Promise<GitCommandOutput>;

export async function autoSyncToGit(input: GitSyncInput, runner: GitCommandRunner = defaultGitRunner): Promise<GitSyncResult> {
  const includePaths = normalizeIncludePaths(input.includePaths);
  if (includePaths.length === 0) {
    return {
      changed: false,
      committed: false,
      pushed: false,
      changedFiles: [],
    };
  }

  // 先只看受控目录的变更，避免误提交工作区其他临时改动。
  const status = await runner({
    cwd: input.repoRoot,
    args: ["status", "--porcelain", "--", ...includePaths],
  });
  if (status.exitCode !== 0) {
    throw new Error(`git_status_failed:${status.stderr || status.stdout}`);
  }

  const changedFiles = parsePorcelainChangedFiles(status.stdout);
  if (changedFiles.length === 0) {
    return {
      changed: false,
      committed: false,
      pushed: false,
      changedFiles: [],
    };
  }

  const add = await runner({
    cwd: input.repoRoot,
    // 只 add status 已确认存在的变更文件，避免 include path 中含“尚未创建目录”时 git pathspec 报错。
    args: ["add", "--", ...changedFiles],
  });
  if (add.exitCode !== 0) {
    throw new Error(`git_add_failed:${add.stderr || add.stdout}`);
  }

  // commit 前再确认 staged 列表，避免 add 之后仍无有效变更。
  const staged = await runner({
    cwd: input.repoRoot,
    args: ["diff", "--cached", "--name-only", "--", ...includePaths],
  });
  if (staged.exitCode !== 0) {
    throw new Error(`git_diff_cached_failed:${staged.stderr || staged.stdout}`);
  }
  const stagedFiles = staged.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (stagedFiles.length === 0) {
    return {
      changed: true,
      committed: false,
      pushed: false,
      changedFiles,
    };
  }

  const commit = await runner({
    cwd: input.repoRoot,
    args: ["commit", "-m", input.commitMessage],
  });
  if (commit.exitCode !== 0) {
    throw new Error(`git_commit_failed:${commit.stderr || commit.stdout}`);
  }

  const head = await runner({
    cwd: input.repoRoot,
    args: ["rev-parse", "HEAD"],
  });
  if (head.exitCode !== 0) {
    throw new Error(`git_rev_parse_failed:${head.stderr || head.stdout}`);
  }
  const commitSha = head.stdout.trim();

  if (!input.push) {
    return {
      changed: true,
      committed: true,
      pushed: false,
      commitSha,
      changedFiles,
    };
  }

  const pushEnv = buildPushEnv(input);
  const pushArgs = input.branch
    ? ["push", input.remote ?? "origin", `HEAD:${input.branch}`]
    : ["push", input.remote ?? "origin", "HEAD"];
  const push = await runner({
    cwd: input.repoRoot,
    args: pushArgs,
    env: pushEnv,
  });
  if (push.exitCode !== 0) {
    throw new Error(`git_push_failed:${push.stderr || push.stdout}`);
  }

  return {
    changed: true,
    committed: true,
    pushed: true,
    commitSha,
    changedFiles,
  };
}

function parsePorcelainChangedFiles(input: string): string[] {
  return input
    .split("\n")
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

function normalizeIncludePaths(paths: string[]): string[] {
  return Array.from(
    new Set(
      paths
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function buildPushEnv(input: Pick<GitSyncInput, "httpProxy" | "httpsProxy" | "noProxy">): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (input.httpProxy) {
    env.http_proxy = input.httpProxy;
    env.HTTP_PROXY = input.httpProxy;
  }
  if (input.httpsProxy) {
    env.https_proxy = input.httpsProxy;
    env.HTTPS_PROXY = input.httpsProxy;
  }
  if (input.noProxy) {
    env.no_proxy = input.noProxy;
    env.NO_PROXY = input.noProxy;
  }
  return env;
}

async function defaultGitRunner(input: {
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<GitCommandOutput> {
  return new Promise((resolve) => {
    const child = spawn("git", input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

export const __test__ = {
  parsePorcelainChangedFiles,
  buildPushEnv,
};
