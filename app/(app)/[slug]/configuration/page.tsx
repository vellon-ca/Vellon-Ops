import { ConfigurationForm } from "@/components/configuration/ConfigurationForm";
import { PayoutTimingForm } from "@/components/configuration/PayoutTimingForm";

export default async function ConfigurationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div>
      <ConfigurationForm slug={slug} />
      <PayoutTimingForm slug={slug} />
    </div>
  );
}
