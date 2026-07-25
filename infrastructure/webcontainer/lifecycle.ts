// 生命周期顺序同时服务于 UI 文案、诊断归类和自动化测试。
// 新增阶段时应同步检查 Manager 的推进路径与 WEB_CONTAINER_PHASE_LABELS。
export const WEB_CONTAINER_PHASES = [
  "idle",
  "booting",
  "mounting",
  "installing",
  "starting",
  "ready",
  "failed",
] as const;

export type WebContainerPhase = (typeof WEB_CONTAINER_PHASES)[number];

// 错误码是面向程序的稳定契约；用户可见文案可以国际化或调整，不应被业务逻辑解析。
export type WebContainerErrorCode =
  | "cross_origin_isolation_required"
  | "boot_failed"
  | "mount_failed"
  | "install_failed"
  | "dev_server_failed";

export type WebContainerDiagnostic = {
  code: WebContainerErrorCode;
  message: string;
  detail?: string;
};

/**
 * Manager 对 UI 暴露的不可变快照。
 *
 * 组件只订阅这一份状态，不直接读取 WebContainer SDK 实例或进程对象，从而把
 * 浏览器运行时细节限制在 infrastructure 层，也为后续持久化和遥测保留清晰边界。
 */
export type WebContainerRuntimeSnapshot = {
  phase: WebContainerPhase;
  previewUrl: string | null;
  port: number | null;
  logs: string[];
  diagnostic: WebContainerDiagnostic | null;
  // null 表示浏览器能力尚未检查，区别于已检查且明确不满足隔离要求的 false。
  crossOriginIsolated: boolean | null;
};

// 每次启动或 teardown 都从全新对象开始，避免复用数组或诊断对象造成隐式状态泄漏。
export function createInitialRuntimeSnapshot(): WebContainerRuntimeSnapshot {
  return {
    phase: "idle",
    previewUrl: null,
    port: null,
    logs: [],
    diagnostic: null,
    crossOriginIsolated: null,
  };
}

// 展示文案集中维护，避免各组件分别解释同一个底层阶段。
export const WEB_CONTAINER_PHASE_LABELS: Record<WebContainerPhase, string> = {
  idle: "等待启动",
  booting: "启动运行时",
  mounting: "挂载项目",
  installing: "安装依赖",
  starting: "启动服务",
  ready: "预览就绪",
  failed: "启动失败",
};
