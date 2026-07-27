import { ProjectWorkspace } from "@/components/workbench/project-workspace";
import type {
  ProjectDescription,
  ProjectFileSnapshot,
} from "@/domains/project/types";

/**
 * 路由页面继续保持 Server Component，只把首屏项目快照序列化给客户端工作区。
 * 后续编辑、保存和运行状态都留在 ProjectWorkspace，避免整个页面失去服务端数据边界。
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
