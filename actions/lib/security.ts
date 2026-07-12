import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";

import type { Repo } from "./util";

type Environment = Record<string, string>;

const updaterEnvironmentKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
] as const;

export function updaterEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  const env: Environment = {};
  for (const key of updaterEnvironmentKeys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_ALLOW_PROTOCOL = "https";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function trustedUpdaterPath(bundleDir: string = __dirname): string {
  return path.resolve(bundleDir, "..", "..", "..", "update.py");
}

export async function writeToolchainOverride(
  downstreamClone: string,
  override: string,
): Promise<void> {
  const root = await fs.realpath(downstreamClone);
  const toolchain = path.join(root, "lean-toolchain");
  const stat = await fs.lstat(toolchain);
  if (!stat.isFile() || (await fs.realpath(toolchain)) !== toolchain) {
    throw new Error("downstream lean-toolchain must be a regular file");
  }
  await fs.writeFile(toolchain, `${override}\n`);
}

export async function runUpdater(
  downstreamClone: string,
  bundleDir: string = __dirname,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return await exec.exec(
    "python",
    [trustedUpdaterPath(bundleDir), ".", "--fixup-all"],
    {
      cwd: downstreamClone,
      env: updaterEnvironment(sourceEnv),
    },
  );
}

export function repositoryUrl(
  repo: Repo,
  serverUrl: string = github.context.serverUrl,
): string {
  const server = serverUrl.replace(/\/+$/, "");
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  return `${server}/${owner}/${name}.git`;
}

export function gitPushEnvironment(
  appToken: string,
  repo: Repo,
  source: NodeJS.ProcessEnv = process.env,
  serverUrl: string = github.context.serverUrl,
): Environment {
  const url = repositoryUrl(repo, serverUrl);
  const credential = Buffer.from(`x-access-token:${appToken}`).toString(
    "base64",
  );
  core.setSecret(credential);
  return {
    ...updaterEnvironment(source),
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${url}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function pushBranch(
  downstreamClone: string,
  downstreamRepo: Repo,
  branch: string,
  appToken: string,
): Promise<number> {
  const url = repositoryUrl(downstreamRepo);
  return await exec.exec(
    "git",
    ["push", "--no-verify", url, `HEAD:refs/heads/${branch}`],
    {
      cwd: downstreamClone,
      env: gitPushEnvironment(appToken, downstreamRepo),
    },
  );
}
