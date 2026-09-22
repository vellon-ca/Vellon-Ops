import { OverviewDashboard } from "@/components/overview/OverviewDashboard";

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <OverviewDashboard slug={slug} />;
}
