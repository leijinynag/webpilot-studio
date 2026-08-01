import { ProjectWorkspace } from "@/components/workbench/project-workspace";
import type {
  ProjectDescription,
  ProjectFileSnapshot,
} from "@/domains/project/types";

/**
 * 路由页面继续保持 Server Component。Browser Git 项目的源码不会从服务端
 * 序列化，而是由客户端工作区在挂载后从专用 Worker 恢复。
 */
export function WorkbenchPage({
  files,
  project,
}: {
  files: readonly ProjectFileSnapshot[];
  project: ProjectDescription;
}) {
  return <ProjectWorkspace initialFiles={files} project={project} />;
}
