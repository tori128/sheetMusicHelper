// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => "D:\\EarCopyAssist\\EarCopyAssist.exe"),
  },
  spawn: vi.fn(),
}));

vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

import { ServiceManager } from "../electron/service-manager";

interface FakeService {
  process: ChildProcessWithoutNullStreams;
  resume: ReturnType<typeof vi.spyOn>;
  stdout: PassThrough;
  stderr: PassThrough;
}

function createFakeService(processId: number): FakeService {
  const service = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const resume = vi.spyOn(stdout, "resume");
  Object.assign(service, {
    pid: processId,
    exitCode: null,
    killed: false,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  return { process: service, resume, stdout, stderr };
}

describe("ServiceManager", () => {
  let services: FakeService[];

  beforeEach(() => {
    delete process.env.EARCOPY_LAUNCHER_ROOT;
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "D:\\EarCopyAssist\\resources",
    });
    services = [];
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation((command: string) => {
      if (command === "taskkill.exe") {
        return createFakeService(20_000).process;
      }
      const service = createFakeService(10_000 + services.length);
      services.push(service);
      return service.process;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true }),
    );
  });

  it("shares one startup between concurrent callers and drains stdout", async () => {
    const manager = new ServiceManager();

    const [first, second] = await Promise.all([
      manager.start(),
      manager.start(),
    ]);

    expect(first).toEqual(second);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(services[0].resume).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith(
      "D:\\EarCopyAssist\\resources\\backend\\earcopy_service.exe",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          EARCOPY_USER_DATA: "D:\\EarCopyAssist\\UserData",
          EARCOPY_MODELS_DIRS:
            "D:\\EarCopyAssist\\resources\\models\\muscriptor",
          EARCOPY_STEM_MODEL_DIR:
            "D:\\EarCopyAssist\\models",
        }),
      }),
    );
    manager.stop();
  });

  it("uses the launcher root for data and source-separation models", async () => {
    process.env.EARCOPY_LAUNCHER_ROOT = "D:\\Portable\\EarCopyAssist";
    const manager = new ServiceManager();

    await manager.start();

    expect(mocks.spawn).toHaveBeenCalledWith(
      "D:\\EarCopyAssist\\resources\\backend\\earcopy_service.exe",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          EARCOPY_USER_DATA: "D:\\Portable\\EarCopyAssist\\UserData",
          EARCOPY_MODELS_DIRS:
            "D:\\EarCopyAssist\\resources\\models\\muscriptor",
          EARCOPY_STEM_MODEL_DIR:
            "D:\\Portable\\EarCopyAssist\\models",
        }),
      }),
    );
    manager.stop();
  });

  it("discards a dead connection and starts a replacement service", async () => {
    const manager = new ServiceManager();
    const first = await manager.start();
    Object.defineProperty(services[0].process, "exitCode", {
      configurable: true,
      value: 1,
    });
    services[0].process.emit("exit", 1, null);

    const second = await manager.start();

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(second.token).not.toBe(first.token);
    manager.stop();
  });

  it("handles a process error after startup and permits restart", async () => {
    const manager = new ServiceManager();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await manager.start();
    services[0].process.emit("error", new Error("service pipe failed"));

    await manager.start();

    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    expect(consoleError).toHaveBeenCalledWith(
      "[service] service pipe failed",
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/pid", "10000", "/T", "/F"],
      { detached: true, windowsHide: true, stdio: "ignore" },
    );
    const termination = vi.mocked(mocks.spawn).mock.results[1]?.value;
    expect(termination.unref).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("records service output and lifecycle events", async () => {
    const logger = { log: vi.fn() };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const manager = new ServiceManager(logger);

    await manager.start();
    services[0].stdout.write("backend ready\n");
    services[0].stderr.write("backend warning\n");
    Object.defineProperty(services[0].process, "exitCode", {
      configurable: true,
      value: 0,
    });
    services[0].process.emit("exit", 0, null);

    expect(logger.log).toHaveBeenCalledWith(
      "INFO",
      "service-manager",
      expect.stringContaining("起動します"),
    );
    expect(logger.log).toHaveBeenCalledWith(
      "INFO",
      "service:stdout",
      "backend ready",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "INFO",
      "service:stderr",
      "backend warning",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "INFO",
      "service-manager",
      expect.stringContaining("code=0"),
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[service] backend warning",
    );
  });

  it("reports an unexpected service exit after startup", async () => {
    const onUnexpectedFailure = vi.fn();
    const manager = new ServiceManager(null, onUnexpectedFailure);

    await manager.start();
    Object.defineProperty(services[0].process, "exitCode", {
      configurable: true,
      value: 3221225477,
    });
    services[0].process.emit("exit", 3221225477, null);

    expect(onUnexpectedFailure).toHaveBeenCalledWith({
      kind: "exit",
      code: 3221225477,
      signal: null,
      message: "code=3221225477, signal=null",
    });
  });

  it("does not report the service exit requested by application shutdown", async () => {
    const onUnexpectedFailure = vi.fn();
    const manager = new ServiceManager(null, onUnexpectedFailure);

    await manager.start();
    manager.stop();
    services[0].process.emit("exit", 1, null);

    expect(onUnexpectedFailure).not.toHaveBeenCalled();
  });

  it("cancels startup when the application stops during health check", async () => {
    const manager = new ServiceManager();
    let resolveHealth!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHealth = resolve;
        }),
    );

    const startup = manager.start();
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    manager.stop();
    resolveHealth(new Response(null, { status: 200 }));

    await expect(startup).rejects.toThrow(
      "ローカルサービスの起動が中断されました",
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/pid", "10000", "/T", "/F"],
      { detached: true, windowsHide: true, stdio: "ignore" },
    );
  });

  it("fails immediately when the service process cannot spawn", async () => {
    const manager = new ServiceManager();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValue(new TypeError("not ready"));
    mocks.spawn.mockImplementationOnce(() => {
      const service = createFakeService(20_000);
      services.push(service);
      queueMicrotask(() => {
        service.process.emit("error", new Error("spawn failed"));
      });
      return service.process;
    });

    await expect(manager.start()).rejects.toThrow("spawn failed");
  });
});
