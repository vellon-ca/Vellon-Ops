"use client";

import { useState } from "react";
import { OnboardingWizard } from "./OnboardingWizard";
import { CompaniesTable } from "./CompaniesTable";
import type { CompanyRow } from "@/app/(app)/onboarding/actions";

export function OnboardingClient() {
  // Bumping this refetches the companies table (after any wizard mutation).
  const [reloadNonce, setReloadNonce] = useState(0);
  const [resume, setResume] = useState<CompanyRow | null>(null);

  return (
    <div>
      <OnboardingWizard
        resume={resume}
        onChanged={() => setReloadNonce((n) => n + 1)}
      />
      <CompaniesTable
        reloadNonce={reloadNonce}
        onResume={(r) => {
          setResume(r);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
    </div>
  );
}
