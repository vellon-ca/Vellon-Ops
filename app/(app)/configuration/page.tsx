import { ConfigurationForm } from "@/components/configuration/ConfigurationForm";
import { PayoutTimingForm } from "@/components/configuration/PayoutTimingForm";

export default function ConfigurationPage() {
  return (
    <div>
      <ConfigurationForm />
      <PayoutTimingForm />
    </div>
  );
}
