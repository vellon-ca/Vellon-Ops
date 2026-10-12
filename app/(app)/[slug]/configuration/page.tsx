import { ConfigurationForm } from "@/components/configuration/ConfigurationForm";
import { FeeTaxForm } from "@/components/configuration/FeeTaxForm";

export default async function ConfigurationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div>
      <ConfigurationForm slug={slug} />
      <FeeTaxForm slug={slug} />
    </div>
  );
}
