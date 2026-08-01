import { describe, expect, it } from "vitest";

import {
  computeChangeSet,
  computeRestorePlan,
  summarizeChangeSet,
} from "@/domains/project/change-set";

describe("project change set", () => {
  it("computes create, update, delete and deterministic rename operations", () => {
    const changes = computeChangeSet(
      [
        { path: "src/delete.ts", hash: "delete-hash" },
        { path: "src/old-a.ts", hash: "same-hash" },
        { path: "src/old-b.ts", hash: "same-hash" },
        { path: "src/update.ts", hash: "before-hash" },
      ],
      [
        { path: "src/create.ts", hash: "create-hash" },
        { path: "src/new-a.ts", hash: "same-hash" },
        { path: "src/new-b.ts", hash: "same-hash" },
        { path: "src/update.ts", hash: "after-hash" },
      ],
    );

    expect(changes).toEqual([
      {
        operation: "create",
        pathBefore: null,
        pathAfter: "src/create.ts",
        beforeHash: null,
        afterHash: "create-hash",
      },
      {
        operation: "delete",
        pathBefore: "src/delete.ts",
        pathAfter: null,
        beforeHash: "delete-hash",
        afterHash: null,
      },
      {
        operation: "rename",
        pathBefore: "src/old-a.ts",
        pathAfter: "src/new-a.ts",
        beforeHash: "same-hash",
        afterHash: "same-hash",
      },
      {
        operation: "rename",
        pathBefore: "src/old-b.ts",
        pathAfter: "src/new-b.ts",
        beforeHash: "same-hash",
        afterHash: "same-hash",
      },
      {
        operation: "update",
        pathBefore: "src/update.ts",
        pathAfter: "src/update.ts",
        beforeHash: "before-hash",
        afterHash: "after-hash",
      },
    ]);
    expect(summarizeChangeSet(changes)).toBe(
      "新增 1 个，修改 1 个，删除 1 个，重命名 2 个",
    );
  });

  it("marks later user mutations as conflicts without planning partial writes", () => {
    const changes = computeChangeSet(
      [
        { path: "src/deleted.ts", hash: "base-delete" },
        { path: "src/old.ts", hash: "rename-hash" },
        { path: "src/update.ts", hash: "base-update" },
      ],
      [
        { path: "src/created.ts", hash: "agent-create" },
        { path: "src/new.ts", hash: "rename-hash" },
        { path: "src/update.ts", hash: "agent-update" },
      ],
    );
    const plan = computeRestorePlan(changes, [
      { path: "src/created.ts", hash: "user-edited-create" },
      { path: "src/new.ts", hash: "rename-hash" },
      { path: "src/update.ts", hash: "agent-update" },
    ]);

    expect(plan.conflicts).toEqual([
      {
        path: "src/created.ts",
        currentHash: "user-edited-create",
        resultHash: "agent-create",
        restoreHash: null,
        reason: "modified",
      },
    ]);
    expect(plan.impacts).toEqual([
      {
        path: "src/created.ts",
        currentHash: "user-edited-create",
        resultHash: "agent-create",
        restoreHash: null,
        action: "delete",
      },
      {
        path: "src/deleted.ts",
        currentHash: null,
        resultHash: null,
        restoreHash: "base-delete",
        action: "write",
      },
      {
        path: "src/new.ts",
        currentHash: "rename-hash",
        resultHash: "rename-hash",
        restoreHash: null,
        action: "delete",
      },
      {
        path: "src/old.ts",
        currentHash: null,
        resultHash: null,
        restoreHash: "rename-hash",
        action: "write",
      },
      {
        path: "src/update.ts",
        currentHash: "agent-update",
        resultHash: "agent-update",
        restoreHash: "base-update",
        action: "write",
      },
    ]);
  });

  it("treats paths already restored to the base manifest as no-op", () => {
    const changes = computeChangeSet(
      [{ path: "src/value.ts", hash: "base" }],
      [{ path: "src/value.ts", hash: "result" }],
    );
    const plan = computeRestorePlan(changes, [
      { path: "src/value.ts", hash: "base" },
    ]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.impacts[0]?.action).toBe("none");
  });
});
