import { ConfigurationForm } from "@/components/configuration/ConfigurationForm";

export default async function ConfigurationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div>
      <ConfigurationForm slug={slug} />
    </div>
  );
}
