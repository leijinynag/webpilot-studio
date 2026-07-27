import { describe, expect, it } from "vitest";

import {
  buildProjectTemplate,
  flattenProjectTemplate,
} from "@/domains/project/template";

describe("project template conversion", () => {
  it("round-trips repository file snapshots through a WebContainer tree", () => {
    const files = [
      { path: "package.json", content: '{"scripts":{}}' },
      { path: "src/App.tsx", content: "export function App() {}" },
      { path: "src/styles/app.css", content: "body {}" },
    ];

    expect(flattenProjectTemplate(buildProjectTemplate(files))).toEqual(files);
  });

  it("rejects file and directory collisions", () => {
    expect(() =>
      buildProjectTemplate([
        { path: "src", content: "file" },
        { path: "src/App.tsx", content: "nested" },
      ]),
    ).toThrow("目录冲突");
  });
});
