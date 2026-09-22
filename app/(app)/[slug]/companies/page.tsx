import { CompaniesDashboard } from "@/components/companies/CompaniesDashboard";

export default async function CompaniesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <CompaniesDashboard slug={slug} />;
}
