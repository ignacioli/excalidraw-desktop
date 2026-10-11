import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import { readSystemLanguages } from "./systemLanguages";

function invokerReturning(response: unknown): CommandInvoker {
  return { invoke: vi.fn(async () => response) } as unknown as CommandInvoker;
}

describe("readSystemLanguages", () => {
  it("returns the handshake language list", async () => {
    await expect(
      readSystemLanguages(
        invokerReturning({ preferredLanguages: ["zh-Hans-CN", "en-US"] }),
      ),
    ).resolves.toEqual(["zh-Hans-CN", "en-US"]);
  });

  it("returns an empty list outside the desktop shell", async () => {
    await expect(readSystemLanguages()).resolves.toEqual([]);
  });

  it("returns an empty list when the handshake fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invoker = {
      invoke: vi.fn(async () => {
        throw new Error("not ready");
      }),
    } as unknown as CommandInvoker;
    await expect(readSystemLanguages(invoker)).resolves.toEqual([]);
  });

  it("drops malformed entries and caps the list", async () => {
    const tags = Array.from({ length: 20 }, (_, index) => `en-${index}`);
    await expect(
      readSystemLanguages(
        invokerReturning({ preferredLanguages: [1, ...tags] }),
      ),
    ).resolves.toEqual(tags.slice(0, 16));
    await expect(
      readSystemLanguages(invokerReturning({ preferredLanguages: "en" })),
    ).resolves.toEqual([]);
  });
});
