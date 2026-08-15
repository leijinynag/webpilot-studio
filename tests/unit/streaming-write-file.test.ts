import { describe, expect, it } from "vitest";

import {
  completeStreamingWriteFileProjection,
  createStreamingWriteFileProjection,
  discardStreamingWriteFileProjection,
  updateStreamingWriteFileProjection,
} from "@/domains/agent/streaming-write-file";

describe("streaming write_file projection", () => {
  it("跨 chunk 解码转义内容并只发送新增文本", () => {
    const projection = createStreamingWriteFileProjection();
    const first = updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-1",
      toolName: "write_file",
      argumentsText:
        '{"path":"src/App.tsx","content":"line 1\\nconst title = \\"Web',
    });
    const second = updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-1",
      toolName: "write_file",
      argumentsText:
        '{"path":"src/App.tsx","content":"line 1\\nconst title = \\"WebPilot\\";\\n","expectedRevision":2}',
    });
    const completed = completeStreamingWriteFileProjection({
      projection,
      toolCallId: "call-1",
      toolName: "write_file",
      argumentsText:
        '{"path":"src/App.tsx","content":"line 1\\nconst title = \\"WebPilot\\";\\n","expectedRevision":2}',
    });

    expect(first).toEqual([
      {
        type: "file.stream_started",
        payload: { toolCallId: "call-1", path: "src/App.tsx" },
      },
      {
        type: "file.stream_delta",
        payload: {
          toolCallId: "call-1",
          path: "src/App.tsx",
          text: 'line 1\nconst title = "Web',
        },
      },
    ]);
    expect(second).toEqual([
      {
        type: "file.stream_delta",
        payload: {
          toolCallId: "call-1",
          path: "src/App.tsx",
          text: 'Pilot";\n',
        },
      },
    ]);
    expect(completed).toEqual([
      {
        type: "file.stream_completed",
        payload: {
          toolCallId: "call-1",
          path: "src/App.tsx",
          characterCount: 33,
        },
      },
    ]);
  });

  it("累计参数改写已展示前缀时丢弃临时文件", () => {
    const projection = createStreamingWriteFileProjection();
    updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-prefix",
      toolName: "write_file",
      argumentsText: '{"path":"src/a.ts","content":"const value = 1;',
    });

    const events = updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-prefix",
      toolName: "write_file",
      argumentsText: '{"path":"src/a.ts","content":"const value = 2;\\n"}',
    });

    expect(events).toEqual([
      {
        type: "file.stream_discarded",
        payload: {
          toolCallId: "call-prefix",
          path: "src/a.ts",
          reason: "content_prefix_changed",
        },
      },
    ]);
  });

  it("content 先于 path 时先缓冲，拿到安全路径后一次投影", () => {
    const projection = createStreamingWriteFileProjection();
    expect(
      updateStreamingWriteFileProjection({
        projection,
        toolCallId: "call-2",
        toolName: "write_file",
        argumentsText: '{"content":"export const value = 1;","path":"src/',
      }),
    ).toEqual([]);

    expect(
      updateStreamingWriteFileProjection({
        projection,
        toolCallId: "call-2",
        toolName: "write_file",
        argumentsText:
          '{"content":"export const value = 1;","path":"src/value.ts","expectedRevision":0}',
      }),
    ).toEqual([
      {
        type: "file.stream_started",
        payload: { toolCallId: "call-2", path: "src/value.ts" },
      },
      {
        type: "file.stream_delta",
        payload: {
          toolCallId: "call-2",
          path: "src/value.ts",
          text: "export const value = 1;",
        },
      },
    ]);
  });

  it("半个 unicode 转义不会提前泄漏，完整后再发送", () => {
    const projection = createStreamingWriteFileProjection();
    const first = updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-3",
      toolName: "write_file",
      argumentsText: '{"path":"README.md","content":"hello \\u4f',
    });
    const second = updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-3",
      toolName: "write_file",
      argumentsText: '{"path":"README.md","content":"hello \\u4f60',
    });

    expect(first.at(-1)).toEqual({
      type: "file.stream_delta",
      payload: { toolCallId: "call-3", path: "README.md", text: "hello " },
    });
    expect(second).toEqual([
      {
        type: "file.stream_delta",
        payload: { toolCallId: "call-3", path: "README.md", text: "你" },
      },
    ]);
  });

  it("危险路径在 started 前被拒绝", () => {
    const projection = createStreamingWriteFileProjection();
    const events = updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-4",
      toolName: "write_file",
      argumentsText: '{"path":"../secret.txt","content":"nope',
    });

    expect(events).toEqual([]);
    expect(projection.status).toBe("discarded");
  });

  it("投影开始后出现重复 content 字段会回收临时文件", () => {
    const projection = createStreamingWriteFileProjection();
    updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-5",
      toolName: "write_file",
      argumentsText: '{"path":"src/a.ts","content":"first"}',
    });

    const events = updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-5",
      toolName: "write_file",
      argumentsText: '{"path":"src/a.ts","content":"first","content":"second"}',
    });

    expect(events).toEqual([
      {
        type: "file.stream_discarded",
        payload: {
          toolCallId: "call-5",
          path: "src/a.ts",
          reason: "duplicate_content",
        },
      },
    ]);
  });

  it("完整参数未通过正式 Schema 时不发送 completed", () => {
    const projection = createStreamingWriteFileProjection();
    updateStreamingWriteFileProjection({
      projection,
      toolCallId: "call-6",
      toolName: "write_file",
      argumentsText: '{"path":"src/a.ts","content":"ok"',
    });

    const events = completeStreamingWriteFileProjection({
      projection,
      toolCallId: "call-6",
      toolName: "write_file",
      argumentsText: '{"path":"src/a.ts","content":"ok"}',
    });

    expect(events).toEqual([
      {
        type: "file.stream_discarded",
        payload: {
          toolCallId: "call-6",
          path: "src/a.ts",
          reason: "invalid_arguments",
        },
      },
    ]);
  });

  it("参数已完成但正式工具失败时仍可回收临时文件", () => {
    const projection = createStreamingWriteFileProjection();
    completeStreamingWriteFileProjection({
      projection,
      toolCallId: "call-completed-failure",
      toolName: "write_file",
      argumentsText:
        '{"path":"src/a.ts","content":"export const value = 1;","expectedRevision":1}',
    });

    expect(
      discardStreamingWriteFileProjection({
        projection,
        toolCallId: "call-completed-failure",
        reason: "repository_write_failed",
      }),
    ).toEqual([
      {
        type: "file.stream_discarded",
        payload: {
          toolCallId: "call-completed-failure",
          path: "src/a.ts",
          reason: "repository_write_failed",
        },
      },
    ]);
  });
});
