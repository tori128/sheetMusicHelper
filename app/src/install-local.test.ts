// @vitest-environment node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe.runIf(process.platform === "win32")("local Windows installation", () => {
  let root: string;
  let packagedRoot: string;
  let script: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "earcopy-local-install-"));
    packagedRoot = join(root, "app", "release", "win-unpacked");
    const packagingRoot = join(root, "app", "packaging");
    mkdirSync(packagingRoot, { recursive: true });
    script = join(packagingRoot, "install-local.ps1");
    cpSync(resolve("packaging/install-local.ps1"), script);
    writeFileSync(join(packagingRoot, "assert-app-not-running.ps1"), "return\n");
    mkdirSync(join(packagedRoot, "resources"), { recursive: true });
    mkdirSync(join(packagedRoot, "locales"));
    writeFileSync(join(packagedRoot, "EarCopyAssist.exe"), "new executable");
    writeFileSync(join(packagedRoot, "resources", "app.asar"), "new application");
    mkdirSync(join(root, "UserData"));
    mkdirSync(join(root, "models"));
    writeFileSync(join(root, "UserData", "presets.json"), "existing presets");
    writeFileSync(join(root, "UserData", "model-profiles.json"), "existing profiles");
    writeFileSync(join(root, "models", "model.safetensors"), "existing model");
    writeFileSync(join(root, "README.md"), "source documentation");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function install() {
    return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
  }

  it("updates runtime files, preserves user files, and removes the consumed build", () => {
    writeFileSync(join(root, "EarCopyAssist.exe"), "old executable");
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "resources", "old.txt"), "old application");
    writeFileSync(join(root, "dxil.dll"), "obsolete runtime file");

    const result = install();

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, "EarCopyAssist.exe"), "utf8")).toBe("new executable");
    expect(readFileSync(join(root, "resources", "app.asar"), "utf8")).toBe("new application");
    expect(existsSync(join(root, "resources", "old.txt"))).toBe(false);
    expect(existsSync(join(root, "dxil.dll"))).toBe(false);
    expect(readFileSync(join(root, "UserData", "presets.json"), "utf8")).toBe("existing presets");
    expect(readFileSync(join(root, "UserData", "model-profiles.json"), "utf8")).toBe("existing profiles");
    expect(readFileSync(join(root, "models", "model.safetensors"), "utf8")).toBe("existing model");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("source documentation");
    expect(existsSync(packagedRoot)).toBe(false);
    expect(existsSync(join(root, "app", "release", ".local-install-backup"))).toBe(false);
  });

  it("rejects user data in the build before changing the installation", () => {
    mkdirSync(join(packagedRoot, "UserData"));
    writeFileSync(join(root, "EarCopyAssist.exe"), "old executable");

    const result = install();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unexpected packaged application entry: UserData");
    expect(readFileSync(join(root, "EarCopyAssist.exe"), "utf8")).toBe("old executable");
    expect(existsSync(join(packagedRoot, "EarCopyAssist.exe"))).toBe(true);
  });

  it("rejects a linked destination directory before replacing files", () => {
    const linkedResources = join(root, "other-resources");
    mkdirSync(linkedResources);
    writeFileSync(join(linkedResources, "keep.txt"), "keep");
    symlinkSync(linkedResources, join(root, "resources"), "junction");
    writeFileSync(join(root, "EarCopyAssist.exe"), "old executable");

    const result = install();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("The installation destination contains a directory link:");
    expect(readFileSync(join(root, "EarCopyAssist.exe"), "utf8")).toBe("old executable");
    expect(readFileSync(join(linkedResources, "keep.txt"), "utf8")).toBe("keep");
  });
});
