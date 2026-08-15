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

/**
 * 使用当前浏览器匿名会话读取受 owner 保护的 API。
 *
 * 本地生产回归仍通过 HTTP 访问 127.0.0.1，而生产 Cookie 必须保持 Secure。
 * Playwright 的页面能够使用 localhost 安全上下文 Cookie，APIRequestContext
 * 却不会自动在 HTTP 请求中附带，因此读取请求也需要显式复制会话。
 */
export async function getWithBrowserSession(
  page: Page,
  url: string,
  options: Parameters<APIRequestContext["get"]>[1] = {},
  request: APIRequestContext = page.request,
) {
  const headers = new Headers(options?.headers);
  headers.set("cookie", await getBrowserCookieHeader(page));

  return request.get(url, {
    ...options,
    headers: Object.fromEntries(headers.entries()),
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

  // 生产构建会把匿名会话和 CSRF Cookie 标记为 Secure。Chromium 允许
  // localhost/127.0.0.1 页面使用这些 Cookie，但 Playwright 的
  // APIRequestContext 在纯 HTTP 测试地址下不会自动附带它们。
  // 这里显式复制同一浏览器上下文的 Cookie，保证 E2E 请求仍使用真实会话，
  // 而不是为了本地测试关闭生产 Cookie 或 CSRF 安全策略。
  headers.set("cookie", serializeCookies(cookies));
  headers.set("x-webpilot-csrf", csrfCookie.value);
  return Object.fromEntries(headers.entries());
}

async function getBrowserCookieHeader(page: Page): Promise<string> {
  return serializeCookies(await page.context().cookies());
}

function serializeCookies(
  cookies: Array<{ name: string; value: string }>,
): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
