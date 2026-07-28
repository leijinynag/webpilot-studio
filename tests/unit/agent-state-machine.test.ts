import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import {
  isTerminalAgentRunStatus,
  reduceAgentRunStatus,
} from "@/domains/agent/state-machine";

describe("Agent Run state machine", () => {
  it("accepts the normal queued -> running -> succeeded path", () => {
    expect(reduceAgentRunStatus("queued", "running")).toBe("running");
    expect(reduceAgentRunStatus("running", "succeeded")).toBe("succeeded");
    expect(isTerminalAgentRunStatus("succeeded")).toBe(true);
  });

  it("rejects transitions out of a terminal state", () => {
    expect(() => reduceAgentRunStatus("cancelled", "running")).toThrowError(
      expect.objectContaining<Partial<AgentError>>({
        code: AGENT_ERROR_CODES.invalidTransition,
      }),
    );
  });
});
