import { describe, expect, it } from "vitest";

import {
  deriveRepositoryIntent,
  normalizeRepositoryIntent,
} from "@/domains/agent/repository-intent";

describe("Repository intent", () => {
  it("不会把普通业务提交动作误判为 Git commit 授权", () => {
    expect(deriveRepositoryIntent("请把表单提交按钮改成蓝色")).toEqual({
      allowStage: false,
      allowUnstage: false,
      allowCommit: false,
      commitAuthor: null,
    });
    expect(deriveRepositoryIntent("提交审核后显示成功提示")).toEqual({
      allowStage: false,
      allowUnstage: false,
      allowCommit: false,
      commitAuthor: null,
    });
  });

  it("只冻结原始消息中明确表达的 stage 和 unstage 权限", () => {
    expect(deriveRepositoryIntent("请 git add src/App.tsx")).toMatchObject({
      allowStage: true,
      allowUnstage: false,
      allowCommit: false,
    });
    expect(deriveRepositoryIntent("请取消暂存 src/App.tsx")).toMatchObject({
      allowStage: false,
      allowUnstage: true,
      allowCommit: false,
    });
  });

  it("commit 意图缺少完整作者信息时不自动生成身份", () => {
    expect(
      deriveRepositoryIntent("请提交代码，邮箱是 dev@example.com"),
    ).toEqual({
      allowStage: false,
      allowUnstage: false,
      allowCommit: true,
      commitAuthor: null,
    });
  });

  it("从明确 commit 指令中冻结姓名和邮箱", () => {
    expect(
      deriveRepositoryIntent(
        "请提交代码，作者姓名: WebPilot Developer，邮箱 dev@example.com",
      ),
    ).toEqual({
      allowStage: false,
      allowUnstage: false,
      allowCommit: true,
      commitAuthor: {
        name: "WebPilot Developer",
        email: "dev@example.com",
      },
    });
  });

  it("旧 Run 或非法身份一律归一化为最小权限", () => {
    expect(normalizeRepositoryIntent(undefined)).toEqual({
      allowStage: false,
      allowUnstage: false,
      allowCommit: false,
      commitAuthor: null,
    });
    expect(
      normalizeRepositoryIntent({
        allowStage: true,
        allowUnstage: false,
        allowCommit: true,
        commitAuthor: {
          name: "  ",
          email: "not-an-email",
        },
      }),
    ).toEqual({
      allowStage: true,
      allowUnstage: false,
      allowCommit: true,
      commitAuthor: null,
    });
  });
});
