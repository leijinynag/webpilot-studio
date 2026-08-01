import { notFound } from "next/navigation";

import { ShowcaseDetailPage } from "@/components/showcase/showcase-detail-page";
import { serverEnv } from "@/infrastructure/env/server";
import { getPublishedShowcaseCase } from "@/infrastructure/showcase/repository";

export const dynamic = "force-dynamic";

export default async function ShowcaseDetailRoute({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const item = await getPublishedShowcaseCase(slug);

  if (!item) {
    notFound();
  }

  return (
    <ShowcaseDetailPage
      item={item}
      runtimeOrigin={serverEnv.SHOWCASE_ORIGIN?.replace(/\/$/, "")}
    />
  );
}
