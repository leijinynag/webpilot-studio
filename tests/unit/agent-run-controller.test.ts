// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  abortAgentRun,
  withAgentRunController,
} from "@/infrastructure/agent/run-controller";

describe("Agent Run controller", () => {
  it("does not abort a healthy stream when recovery schedules the same Run", async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstSignal: AbortSignal | undefined;

    const first = withAgentRunController("run-recovery", async (signal) => {
      firstSignal = signal;
      await firstMayFinish;
      return "first";
    });

    const duplicate = await withAgentRunController(
      "run-recovery",
      async (signal) => {
        expect(signal).toBe(firstSignal);
        expect(signal.aborted).toBe(false);
        return "duplicate";
      },
    );

    expect(duplicate).toBe("duplicate");
    expect(firstSignal?.aborted).toBe(false);
    releaseFirst();
    await expect(first).resolves.toBe("first");
  });

  it("aborts the current in-instance stream on an explicit cancel", async () => {
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observedAbort = false;

    const execution = withAgentRunController("run-cancel", async (signal) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        release();
      });
      await mayFinish;
    });

    expect(abortAgentRun("run-cancel")).toBe(true);
    await execution;
    expect(observedAbort).toBe(true);
  });
});
