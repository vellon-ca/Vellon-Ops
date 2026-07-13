export default function OverviewPage() {
  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-100">Overview</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Portfolio at a glance. Today: M&amp;G C&amp;J (mgcj).
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: "Companies", hint: "onboarded" },
          { label: "Revenue (MTD)", hint: "snapshot" },
          { label: "Ops health", hint: "live" },
        ].map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5"
          >
            <p className="text-sm text-zinc-400">{c.label}</p>
            <p className="mt-2 text-2xl font-semibold text-zinc-600">—</p>
            <p className="mt-1 text-xs text-zinc-600">{c.hint}</p>
          </div>
        ))}
      </div>

      <p className="mt-8 text-xs text-zinc-600">
        Shell scaffolded — modules wired next.
      </p>
    </div>
  );
}
