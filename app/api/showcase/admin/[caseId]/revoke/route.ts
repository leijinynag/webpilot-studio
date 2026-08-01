import { NextResponse } from "next/server";
import { z } from "zod";

import {
  requireShowcaseAdmin,
  showcaseApiError,
} from "@/infrastructure/showcase/api";
import { revokeShowcaseCase } from "@/infrastructure/showcase/repository";

const paramsSchema = z.object({ caseId: z.uuid() }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  const unauthorized = requireShowcaseAdmin(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const { caseId } = paramsSchema.parse(await context.params);
    await revokeShowcaseCase(caseId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return showcaseApiError(error);
  }
}
