import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { createSignedAssetUrl } from "@/domains/image/asset-url";
import { listOwnedAssetRows, toAssetToolView } from "@/domains/image/service";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import { imageApiErrorResponse } from "@/infrastructure/http/image-api";
import { imageExtensionForMime } from "@/domains/image/validation";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const rows = await listOwnedAssetRows({ ownerId, projectId });
    const assets = rows.map((asset) => ({
      ...toAssetToolView(asset),
      // assetPath 是项目代码稳定使用的公开路径，downloadUrl 只用于本次
      // 浏览器同步，永远不写入 Repository 或 Agent 生成的文件。
      assetPath: `/__webpilot/assets/${asset.id}.${imageExtensionForMime(asset.mimeType)}`,
      downloadUrl: createSignedAssetUrl({ asset }),
    }));
    return NextResponse.json(
      { assets },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}
