"use client";

import { Suspense } from "react";
import { OnboardingWizard } from "./OnboardingWizard";

export function OnboardingClient() {
  // OnboardingWizard reads the ?resume= search param, which requires a
  // Suspense boundary per Next's app-router rules for useSearchParams.
  return (
    <Suspense fallback={null}>
      <OnboardingWizard />
    </Suspense>
  );
}
