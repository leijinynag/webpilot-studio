import { NextResponse } from "next/server";

import { listPublishedShowcaseCases } from "@/infrastructure/showcase/repository";
import { showcaseApiError } from "@/infrastructure/showcase/api";

export const dynamic = "force-dynamic";

/**
 * 公开列表只暴露 published case 和 active artifact。
 * 草稿、已撤销案例以及旧 artifact 都由 Repository 在数据库查询层过滤。
 */
export async function GET() {
  try {
    const cases = await listPublishedShowcaseCases();
    return NextResponse.json(
      { cases },
      {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    return showcaseApiError(error);
  }
}
