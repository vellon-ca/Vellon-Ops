import { OnboardingClient } from "@/components/onboarding/OnboardingClient";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <OnboardingClient slug={slug} />;
}
