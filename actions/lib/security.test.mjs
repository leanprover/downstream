import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const compiled = mkdtempSync(path.join(tmpdir(), "downstream-security-test-"));
const compiledSecurity = path.join(compiled, "security.cjs");
await build({
  entryPoints: [fileURLToPath(new URL("./security.ts", import.meta.url))],
  bundle: true,
  outfile: compiledSecurity,
  platform: "node",
  target: "node20",
  format: "cjs",
});
process.once("exit", () => rmSync(compiled, { recursive: true, force: true }));
const {
  gitPushEnvironment,
  pushBranch,
  repositoryUrl,
  runUpdater,
  trustedUpdaterPath,
  updaterEnvironment,
  writeToolchainOverride,
} = createRequire(import.meta.url)(compiledSecurity);

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function commitFixture(clone, message) {
  execFileSync("git", ["init", "-b", "master"], { cwd: clone });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: clone });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: clone,
  });
  execFileSync("git", ["add", "."], { cwd: clone });
  execFileSync("git", ["commit", "-m", message], { cwd: clone });
}

function runPinnedUpdater(clone) {
  return spawnSync(
    "uv",
    ["run", "python", path.join(root, "update.py"), clone, "--fixup-all"],
    {
      cwd: root,
      encoding: "utf8",
      env: updaterEnvironment(process.env),
    },
  );
}

test("wires both adaptation actions through the secure execution boundary", () => {
  for (const action of ["adaptation-pr-create", "adaptation-pr-merge"]) {
    const source = readFileSync(
      path.join(root, "actions", action, "main.ts"),
      "utf8",
    );
    const bundle = readFileSync(
      path.join(root, "actions", action, "dist/index.js"),
      "utf8",
    );

    assert.match(source, /await runUpdater\(downstreamClone\)/);
    assert.match(source, /await pushBranch\(/);
    assert.match(source, /delete process\.env\["INPUT_APP-TOKEN"\]/);
    assert.match(source, /delete process\.env\["INPUT_UPSTREAM-TOKEN"\]/);
    assert.match(source, /delete process\.env\["INPUT_DOWNSTREAM-TOKEN"\]/);
    assert.match(source, /github\.getOctokit\(upstreamToken\)/);
    assert.match(source, /github\.getOctokit\(downstreamToken\)/);
    assert.doesNotMatch(source, /["']\.downstream\/update\.py["']/);
    assert.doesNotMatch(source, /\["push", "-u", "origin"/);
    if (action === "adaptation-pr-create") {
      assert.match(source, /await writeToolchainOverride\(/);
      assert.doesNotMatch(source, /fs\.writeFile/);
    }

    assert.match(bundle, /function trustedUpdaterPath/);
    assert.match(bundle, /HEAD:refs\/heads/);
    assert.match(bundle, /delete process\.env\["INPUT_UPSTREAM-TOKEN"\]/);
    assert.match(bundle, /delete process\.env\["INPUT_DOWNSTREAM-TOKEN"\]/);
    assert.doesNotMatch(bundle, /\.downstream\/update\.py/);
    if (action === "adaptation-pr-create") {
      assert.match(bundle, /function writeToolchainOverride/);
    }
  }
});

test("declares separate upstream and downstream token inputs", () => {
  for (const action of ["adaptation-pr-create", "adaptation-pr-merge"]) {
    const metadata = readFileSync(
      path.join(root, "actions", action, "action.yml"),
      "utf8",
    );
    assert.match(metadata, /^  upstream-token:/m);
    assert.match(metadata, /^  downstream-token:/m);
  }
});

test("treats updater repository URLs as HTTPS-only data", () => {
  const updater = readFileSync(
    path.join(root, "downstream/updater.py"),
    "utf8",
  );
  assert.match(updater, /run\("git", "fetch", "--depth=1", "--", url, rev\)/);
});

test("resolves the updater from the pinned action checkout", () => {
  const bundleDir = path.join(
    "/runner/_work/_actions/leanprover/downstream/0123456789abcdef",
    "actions/adaptation-pr-create/dist",
  );

  assert.equal(
    trustedUpdaterPath(bundleDir),
    path.join(
      "/runner/_work/_actions/leanprover/downstream/0123456789abcdef",
      "update.py",
    ),
  );
});

test("writes toolchain overrides only through a regular checkout file", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "downstream-toolchain-test-"));
  const clone = path.join(temp, "clone");
  const toolchain = path.join(clone, "lean-toolchain");
  const outside = path.join(temp, "outside");

  try {
    mkdirSync(clone);
    writeFileSync(outside, "unchanged\n");
    symlinkSync(outside, toolchain);

    await assert.rejects(
      writeToolchainOverride(clone, "override"),
      /regular file/,
    );
    assert.equal(readFileSync(outside, "utf8"), "unchanged\n");

    rmSync(toolchain);
    writeFileSync(toolchain, "original\n");
    await writeToolchainOverride(clone, "override");
    assert.equal(readFileSync(toolchain, "utf8"), "override\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("rejects git fetch option injection from repos.toml", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "downstream-fetch-test-"));
  const clone = path.join(temp, "clone");
  const sentinel = path.join(temp, "fetch-payload-ran");

  try {
    mkdirSync(path.join(clone, "target"), { recursive: true });
    writeFileSync(path.join(clone, "lean-toolchain"), "x\n");
    writeFileSync(path.join(clone, "target/lean-toolchain"), "x\n");
    writeFileSync(
      path.join(clone, "target/lake-manifest.json"),
      JSON.stringify({
        version: "1.1.0",
        packages: [
          {
            type: "git",
            url: "https://example.invalid/override",
            rev: "deadbeef",
            inputRev: "deadbeef",
          },
        ],
      }),
    );
    const fetchUrl = `--upload-pack=sh -c 'touch ${sentinel}'; git-upload-pack`;
    writeFileSync(
      path.join(clone, "repos.toml"),
      `[target]
url = "https://example.invalid/target"
rev = "HEAD"

[override]
url = "https://example.invalid/override"
fetch_url = ${JSON.stringify(fetchUrl)}
rev = "."
override_only = true
`,
    );
    commitFixture(
      clone,
      "initial\n\ndownstream-repo: target\ndownstream-sha: HEAD",
    );

    const result = runPinnedUpdater(clone);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("rejects updater output symlinks that escape the checkout", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "downstream-symlink-test-"));
  const clone = path.join(temp, "clone");
  const outside = path.join(temp, "outside");

  try {
    mkdirSync(path.join(clone, "target/.lake"), { recursive: true });
    writeFileSync(outside, "unchanged\n");
    writeFileSync(path.join(clone, "lean-toolchain"), "x\n");
    writeFileSync(path.join(clone, "target/lean-toolchain"), "x\n");
    writeFileSync(
      path.join(clone, "target/lake-manifest.json"),
      JSON.stringify({ version: "1.1.0", packages: [] }),
    );
    writeFileSync(
      path.join(clone, "repos.toml"),
      `[target]
url = "https://example.invalid/target"
rev = "HEAD"
`,
    );
    symlinkSync(
      outside,
      path.join(clone, "target/.lake/package-overrides.json"),
    );
    commitFixture(
      clone,
      "initial\n\ndownstream-repo: target\ndownstream-sha: HEAD",
    );

    const result = runPinnedUpdater(clone);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(outside, "utf8"), "unchanged\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("rejects subrepo names that escape the checkout", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "downstream-name-test-"));
  const clone = path.join(temp, "clone");
  const outside = path.join(temp, "outside");

  try {
    mkdirSync(clone);
    mkdirSync(outside);
    writeFileSync(path.join(clone, "lean-toolchain"), "x\n");
    writeFileSync(path.join(outside, "lean-toolchain"), "outside\n");
    writeFileSync(
      path.join(outside, "lake-manifest.json"),
      JSON.stringify({ version: "1.1.0", packages: [] }),
    );
    writeFileSync(
      path.join(clone, "repos.toml"),
      `["../outside"]
url = "https://example.invalid/outside"
rev = "HEAD"
`,
    );
    commitFixture(
      clone,
      "initial\n\ndownstream-repo: ../outside\ndownstream-sha: HEAD",
    );

    const result = runPinnedUpdater(clone);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /invalid subrepo name/);
    assert.equal(
      readFileSync(path.join(outside, "lean-toolchain"), "utf8"),
      "outside\n",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("removes credentials and code-loading variables from updater environment", () => {
  const env = updaterEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    HTTPS_PROXY: "http://proxy.example",
    "INPUT_APP-TOKEN": "app-token",
    ACTIONS_RUNTIME_TOKEN: "runtime-token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
    GITHUB_TOKEN: "github-token",
    GH_TOKEN: "gh-token",
    GIT_ASKPASS: "/checkout/askpass",
    GIT_ALLOW_PROTOCOL: "ext:file:https",
    PYTHONPATH: "/checkout",
    UNRELATED_SECRET: "unknown-secret",
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    HTTPS_PROXY: "http://proxy.example",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_TERMINAL_PROMPT: "0",
  });
});

test("scopes the app token to a hook-free push to the downstream repository", () => {
  const repo = { owner: "leanprover", repo: "downstream-lean4" };
  const url = repositoryUrl(repo);
  const env = gitPushEnvironment("app-token", repo, {
    PATH: "/usr/bin",
    "INPUT_APP-TOKEN": "app-token",
  });

  assert.equal(url, "https://github.com/leanprover/downstream-lean4.git");
  assert.equal(env["INPUT_APP-TOKEN"], undefined);
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_ALLOW_PROTOCOL, "https");
  assert.equal(env.GIT_CONFIG_KEY_0, `http.${url}.extraheader`);
  assert.equal(
    env.GIT_CONFIG_VALUE_0,
    "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46YXBwLXRva2Vu",
  );
  assert.equal(env.GIT_CONFIG_KEY_1, "core.hooksPath");
  assert.equal(env.GIT_CONFIG_VALUE_1, "/dev/null");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("pushes directly without exposing the app token to hooks or remotes", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "downstream-push-test-"));
  const bin = path.join(temp, "bin");
  const capture = path.join(temp, "capture.json");
  const originalPath = process.env.PATH;
  const originalInput = process.env["INPUT_APP-TOKEN"];

  try {
    mkdirSync(bin);
    const wrapper = path.join(bin, "git");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args: process.argv.slice(2),
  tokens: {
    legacy: process.env["INPUT_APP-TOKEN"] ?? null,
    upstream: process.env["INPUT_UPSTREAM-TOKEN"] ?? null,
    downstream: process.env["INPUT_DOWNSTREAM-TOKEN"] ?? null,
  },
  config: {
    count: process.env.GIT_CONFIG_COUNT,
    key0: process.env.GIT_CONFIG_KEY_0,
    value0: process.env.GIT_CONFIG_VALUE_0,
    key1: process.env.GIT_CONFIG_KEY_1,
    value1: process.env.GIT_CONFIG_VALUE_1,
  },
}));
`,
    );
    chmodSync(wrapper, 0o755);

    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.env["INPUT_APP-TOKEN"] = "sentinel-app-token";
    process.env["INPUT_UPSTREAM-TOKEN"] = "sentinel-upstream-token";
    process.env["INPUT_DOWNSTREAM-TOKEN"] = "sentinel-downstream-token";
    await pushBranch(
      temp,
      { owner: "leanprover", repo: "downstream-lean4" },
      "adaptation-123",
      "app-token",
    );

    const url = "https://github.com/leanprover/downstream-lean4.git";
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), {
      args: ["push", "--no-verify", url, "HEAD:refs/heads/adaptation-123"],
      tokens: { legacy: null, upstream: null, downstream: null },
      config: {
        count: "2",
        key0: `http.${url}.extraheader`,
        value0: "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46YXBwLXRva2Vu",
        key1: "core.hooksPath",
        value1: "/dev/null",
      },
    });
  } finally {
    process.env.PATH = originalPath;
    if (originalInput === undefined) delete process.env["INPUT_APP-TOKEN"];
    else process.env["INPUT_APP-TOKEN"] = originalInput;
    delete process.env["INPUT_UPSTREAM-TOKEN"];
    delete process.env["INPUT_DOWNSTREAM-TOKEN"];
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runs the pinned updater without exposing the app token", async () => {
  const temp = mkdtempSync(path.join(tmpdir(), "downstream-action-test-"));
  const clone = path.join(temp, "clone");
  const bin = path.join(temp, "bin");
  const capture = path.join(temp, "capture.json");
  const sentinel = path.join(clone, "checkout-updater-ran");

  try {
    mkdirSync(path.join(clone, ".downstream"), { recursive: true });
    mkdirSync(path.join(clone, "downstream"));
    mkdirSync(bin);
    writeFileSync(path.join(clone, "lean-toolchain"), "original\n");
    writeFileSync(path.join(clone, "repos.toml"), "");
    writeFileSync(
      path.join(clone, ".downstream/update.py"),
      `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("ran")\n`,
    );
    writeFileSync(path.join(clone, "downstream/__init__.py"), "");
    writeFileSync(
      path.join(clone, "downstream/updater.py"),
      `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text("imported")\nraise RuntimeError("checkout module imported")\n`,
    );

    execFileSync("git", ["init", "-b", "master"], { cwd: clone });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: clone,
    });
    execFileSync("git", ["add", "."], { cwd: clone });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: clone });
    writeFileSync(path.join(clone, "lean-toolchain"), "tampered\n");

    const python = execFileSync(
      "uv",
      ["run", "python", "-c", "import sys; print(sys.executable)"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    const wrapper = path.join(bin, "python");
    writeFileSync(
      wrapper,
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args,
  tokens: {
    legacy: process.env["INPUT_APP-TOKEN"] ?? null,
    upstream: process.env["INPUT_UPSTREAM-TOKEN"] ?? null,
    downstream: process.env["INPUT_DOWNSTREAM-TOKEN"] ?? null,
  },
}));
const result = spawnSync(${JSON.stringify(python)}, args, {
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
    );
    chmodSync(wrapper, 0o755);

    const sourceEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      "INPUT_APP-TOKEN": "sentinel-app-token",
      "INPUT_UPSTREAM-TOKEN": "sentinel-upstream-token",
      "INPUT_DOWNSTREAM-TOKEN": "sentinel-downstream-token",
    };
    const bundleDir = path.join(root, "actions/adaptation-pr-create/dist");
    const originalPath = process.env.PATH;
    process.env.PATH = sourceEnv.PATH;
    try {
      await runUpdater(clone, bundleDir, sourceEnv);
    } finally {
      process.env.PATH = originalPath;
    }

    const recorded = JSON.parse(readFileSync(capture, "utf8"));
    assert.deepEqual(recorded, {
      args: [trustedUpdaterPath(bundleDir), ".", "--fixup-all"],
      tokens: { legacy: null, upstream: null, downstream: null },
    });
    assert.equal(existsSync(sentinel), false);
    assert.equal(
      readFileSync(path.join(clone, "lean-toolchain"), "utf8"),
      "original\n",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
