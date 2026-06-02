import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tempDirs: string[] = [];
let savedArgv1: string | undefined;

function createPackagedOpenClaw(chunkSource: string): {
  root: string;
  launcherPath: string;
  chunkPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otel-diagnostics-test-"));
  tempDirs.push(root);
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  const launcherPath = path.join(root, "openclaw.mjs");
  fs.writeFileSync(launcherPath, "export {};\n");
  const chunkPath = path.join(dist, "diagnostic-events-test.js");
  fs.writeFileSync(chunkPath, chunkSource);
  return { root, launcherPath, chunkPath };
}

function writeDiagnosticChunk(root: string, name: string, chunkSource: string): string {
  const chunkPath = path.join(root, "dist", name);
  fs.writeFileSync(chunkPath, chunkSource);
  return chunkPath;
}

function fakeTelemetry() {
  return {
    counters: {},
    histograms: {},
    meter: {},
  };
}

describe("internal diagnostics loader", () => {
  afterEach(() => {
    if (savedArgv1 === undefined) {
      process.argv.splice(1, 1);
    } else {
      process.argv[1] = savedArgv1;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("loads diagnostic-events chunks from packaged launcher sibling dist", async () => {
    savedArgv1 = process.argv[1];
    const { launcherPath, chunkPath } = createPackagedOpenClaw(`
      export const state = { listener: null, unsubscribed: false };
      export function onInternalDiagnosticEvent(listener) {
        state.listener = listener;
        return () => { state.unsubscribed = true; };
      }
    `);
    process.argv[1] = launcherPath;

    const diagnostics = await import("../src/diagnostics.js");
    const unsubscribe = await diagnostics.registerDiagnosticsListener(
      fakeTelemetry() as any,
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    );
    const fixture = await import(pathToFileURL(chunkPath).href);

    expect(diagnostics.hasDiagnosticsSupport()).toBe(true);
    expect(typeof fixture.state.listener).toBe("function");
    unsubscribe();
    expect(fixture.state.unsubscribed).toBe(true);
  });

  it("supports the minified internal listener export fallback", async () => {
    savedArgv1 = process.argv[1];
    const { launcherPath, chunkPath } = createPackagedOpenClaw(`
      export const state = { listener: null };
      export function d(listener) {
        state.listener = listener;
        return () => {};
      }
    `);
    process.argv[1] = launcherPath;

    const diagnostics = await import("../src/diagnostics.js");
    await diagnostics.registerDiagnosticsListener(
      fakeTelemetry() as any,
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    );
    const fixture = await import(pathToFileURL(chunkPath).href);

    expect(diagnostics.hasDiagnosticsSupport()).toBe(true);
    expect(typeof fixture.state.listener).toBe("function");
  });

  it("does not accept unrelated minified emitter exports as listener support", async () => {
    savedArgv1 = process.argv[1];
    const { launcherPath } = createPackagedOpenClaw(`
      export function o() {
        return undefined;
      }
    `);
    process.argv[1] = launcherPath;

    const diagnostics = await import("../src/diagnostics.js");
    await diagnostics.registerDiagnosticsListener(
      fakeTelemetry() as any,
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    );

    expect(diagnostics.hasDiagnosticsSupport()).toBe(false);
  });

  it("tries later diagnostic-events chunks when the first one lacks a listener", async () => {
    savedArgv1 = process.argv[1];
    const { root, launcherPath, chunkPath } = createPackagedOpenClaw(`
      export function unrelated() {
        return undefined;
      }
    `);
    const secondChunkPath = writeDiagnosticChunk(root, "diagnostic-events-z-listener.js", `
      export const state = { listener: null };
      export function d(listener) {
        state.listener = listener;
        return () => {};
      }
    `);
    process.argv[1] = launcherPath;

    const diagnostics = await import("../src/diagnostics.js");
    await diagnostics.registerDiagnosticsListener(
      fakeTelemetry() as any,
      { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    );
    const firstFixture = await import(pathToFileURL(chunkPath).href);
    const secondFixture = await import(pathToFileURL(secondChunkPath).href);

    expect(firstFixture.unrelated()).toBeUndefined();
    expect(diagnostics.hasDiagnosticsSupport()).toBe(true);
    expect(typeof secondFixture.state.listener).toBe("function");
  });
});
