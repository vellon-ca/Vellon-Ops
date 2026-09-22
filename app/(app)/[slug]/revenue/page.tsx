import { RevenueDashboard } from "@/components/revenue/RevenueDashboard";

export default async function RevenuePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <RevenueDashboard slug={slug} />;
}
