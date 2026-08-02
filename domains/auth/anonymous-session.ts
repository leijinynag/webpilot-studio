import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_VERSION = 1;
const OWNER_ID_BYTES = 32;
const MINIMUM_SECRET_LENGTH = 32;
const DEVELOPMENT_SECRET = "webpilot-studio-local-anonymous-session-secret-v1";

export const ANONYMOUS_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

type AnonymousSessionPayload = {
  version: typeof SESSION_VERSION;
  ownerId: string;
  issuedAt: number;
};

export type AnonymousSession = Readonly<AnonymousSessionPayload>;

export function getAnonymousSessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Host-webpilot-anonymous"
    : "webpilot-anonymous";
}

export function getAnonymousSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: ANONYMOUS_SESSION_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

function getSessionSecret(explicitSecret?: string): string {
  const secret =
    explicitSecret?.trim() || process.env.ANON_SESSION_SECRET?.trim();

  if (secret && secret.length >= MINIMUM_SECRET_LENGTH) {
    return secret;
  }

  // 本地与测试允许固定开发密钥，避免初次 clone 必须先配置 Secret；
  // 生产环境必须 fail closed，不能静默使用仓库内已知值。
  if (process.env.NODE_ENV !== "production") {
    return DEVELOPMENT_SECRET;
  }

  throw new Error(
    `生产环境必须配置至少 ${MINIMUM_SECRET_LENGTH} 个字符的 ANON_SESSION_SECRET。`,
  );
}

/**
 * 资产临时 URL 与匿名会话使用同一份服务端签名密钥。
 *
 * 这里复用会话密钥可以避免为匿名工作区再维护一份容易错配的 Secret；
 * 生产环境仍然遵循同一条 fail-closed 规则，不允许回退到开发固定值。
 */
export function getAnonymousSessionSigningSecret(): string {
  return getSessionSecret();
}

function signPayload(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

export function createAnonymousSession(
  now = Date.now(),
  explicitSecret?: string,
): { session: AnonymousSession; cookieValue: string } {
  const session: AnonymousSession = {
    version: SESSION_VERSION,
    ownerId: randomBytes(OWNER_ID_BYTES).toString("base64url"),
    issuedAt: now,
  };
  const encodedPayload = Buffer.from(JSON.stringify(session)).toString(
    "base64url",
  );
  const signature = signPayload(
    encodedPayload,
    getSessionSecret(explicitSecret),
  );

  return {
    session,
    cookieValue: `${encodedPayload}.${signature.toString("base64url")}`,
  };
}

export function verifyAnonymousSession(
  cookieValue: string | null | undefined,
  explicitSecret?: string,
): AnonymousSession | null {
  if (!cookieValue) {
    return null;
  }

  const [encodedPayload, encodedSignature, ...remainder] =
    cookieValue.split(".");

  if (!encodedPayload || !encodedSignature || remainder.length > 0) {
    return null;
  }

  try {
    const expected = signPayload(
      encodedPayload,
      getSessionSecret(explicitSecret),
    );
    const received = Buffer.from(encodedSignature, "base64url");

    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<AnonymousSessionPayload>;

    if (
      payload.version !== SESSION_VERSION ||
      typeof payload.ownerId !== "string" ||
      payload.ownerId.length < 40 ||
      !Number.isSafeInteger(payload.issuedAt) ||
      payload.issuedAt! <= 0
    ) {
      return null;
    }

    return payload as AnonymousSession;
  } catch {
    return null;
  }
}
