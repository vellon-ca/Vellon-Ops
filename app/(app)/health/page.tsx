export default function HealthPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-100">DB / Ops health</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Row counts, pg_cron last-run/success, Edge Function stats, and stuck-state
        detectors. Live, read-only.
      </p>
      <div className="mt-6 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-600">
        Module not built yet.
      </div>
    </div>
  );
}
