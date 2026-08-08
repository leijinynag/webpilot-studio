export const QUOTA_ERROR_CODES = {
  dailyQuotaExhausted: "DAILY_QUOTA_EXHAUSTED",
  globalBudgetExhausted: "GLOBAL_BUDGET_EXHAUSTED",
  globalBudgetPriceUnavailable: "GLOBAL_BUDGET_PRICE_UNAVAILABLE",
  tooManyConcurrentRuns: "TOO_MANY_CONCURRENT_RUNS",
  rateLimitStorageUnavailable: "RATE_LIMIT_STORAGE_UNAVAILABLE",
  storageUnavailable: "QUOTA_STORAGE_UNAVAILABLE",
} as const;

export type QuotaErrorCode =
  (typeof QUOTA_ERROR_CODES)[keyof typeof QUOTA_ERROR_CODES];

export class QuotaError extends Error {
  constructor(
    readonly code: QuotaErrorCode,
    message: string,
    readonly status = 429,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}

export function isQuotaError(error: unknown): error is QuotaError {
  return error instanceof QuotaError;
}
