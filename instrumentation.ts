export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await Promise.all([
      import("@/infrastructure/env/server"),
      import("@/infrastructure/env/public"),
    ]);
  }
}
