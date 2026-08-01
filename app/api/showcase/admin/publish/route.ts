import { NextResponse } from "next/server";

import {
  requireShowcaseAdmin,
  showcaseApiError,
  showcasePublishRequestSchema,
} from "@/infrastructure/showcase/api";
import { publishShowcaseArtifact } from "@/infrastructure/showcase/repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const unauthorized = requireShowcaseAdmin(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const body = showcasePublishRequestSchema.parse(await request.json());
    const item = await publishShowcaseArtifact({
      ...body,
      files: body.files.map((file) => ({
        path: file.path,
        hash: file.hash,
        content: Buffer.from(file.contentBase64, "base64"),
      })),
    });

    return NextResponse.json({ case: item }, { status: 201 });
  } catch (error) {
    return showcaseApiError(error);
  }
}
