import { NextResponse } from "next/server";

import { listShowcaseCandidates } from "@/infrastructure/showcase/repository";
import {
  requireShowcaseAdmin,
  showcaseApiError,
} from "@/infrastructure/showcase/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireShowcaseAdmin(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const cases = await listShowcaseCandidates();
    return NextResponse.json({ cases });
  } catch (error) {
    return showcaseApiError(error);
  }
}
