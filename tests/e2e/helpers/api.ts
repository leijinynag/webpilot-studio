import type { APIRequestContext, Page } from "@playwright/test";

type RequestOptions = NonNullable<Parameters<APIRequestContext["post"]>[1]>;

const CSRF_COOKIE_NAMES = ["__Host-webpilot-csrf", "webpilot-csrf"];

/**
 * 为 E2E 的主站写请求补齐和真实浏览器 fetch 一致的安全头。
 *
 * 生产 Proxy 使用 Origin + double-submit CSRF Token 保护 API mutation。
 * Playwright 的 APIRequestContext 不会自动执行页面里的 browserApiFetch，
 * 所以测试必须显式复制当前 context 的 Cookie，避免测试绕过真实安全边界。
 */
export async function postWithCsrf(
  page: Page,
  url: string,
  options: RequestOptions = {},
  request: APIRequestContext = page.request,
) {
  return request.post(url, {
    ...options,
    headers: await getMutationHeaders(page, options.headers),
  });
}

async function getMutationHeaders(
  page: Page,
  input: RequestOptions["headers"],
): Promise<Record<string, string>> {
  const headers = new Headers(input);
  const pageURL = page.url();

  if (pageURL) {
    headers.set("origin", new URL(pageURL).origin);
  }

  const cookies = await page.context().cookies();
  const csrfCookie = cookies.find((cookie) =>
    CSRF_COOKIE_NAMES.includes(cookie.name),
  );

  if (!csrfCookie) {
    throw new Error("E2E 请求缺少 CSRF Cookie，请先访问主站页面建立匿名会话。");
  }

  headers.set("x-webpilot-csrf", csrfCookie.value);
  return Object.fromEntries(headers.entries());
}
