import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getPublishedShowcaseCase,
} from "@/infrastructure/showcase/repository";
import { showcaseApiError } from "@/infrastructure/showcase/api";

const paramsSchema = z.object({ slug: z.string().min(1).max(160) }).strict();

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const item = await getPublishedShowcaseCase(slug);

    if (!item) {
      return NextResponse.json(
        {
          error: {
            code: "SHOWCASE_NOT_FOUND",
            message: "Showcase 案例不存在或已经撤销。",
          },
        },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { case: item },
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
