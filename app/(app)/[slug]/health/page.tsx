import { HealthDashboard } from "@/components/health/HealthDashboard";

export default async function HealthPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <HealthDashboard slug={slug} />;
}
