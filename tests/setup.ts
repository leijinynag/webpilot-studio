import "@testing-library/jest-dom/vitest";

/**
 * JSDOM 不实现 ResizeObserver，但 Radix 的 Tooltip、Popper 等组件会在布局阶段
 * 按需创建观察器。统一提供无副作用桩，避免测试是否触发 hover/portal 导致偶发失败；
 * 需要验证尺寸回调的测试仍可在各自文件中覆盖这个默认实现。
 */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserverMock {
    disconnect() {}

    observe() {}

    unobserve() {}
  };
}
