import { ReportsDashboard } from "@/components/reports/ReportsDashboard";

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <ReportsDashboard slug={slug} />;
}
