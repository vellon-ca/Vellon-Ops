"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  getReports,
  resolveReport,
  type DispatchReport,
  type Reports,
  type TechnicalReport,
} from "@/app/(app)/[slug]/reports/actions";

type Tab = "dispatch" | "technical";
type Selected =
  | { source: "dispatch"; report: DispatchReport }
  | { source: "technical"; report: TechnicalReport };

function fullTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function relTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
      {category.replace("_", " ")}
    </span>
  );
}

function StatusBadge({ status }: { status: "open" | "resolved" }) {
  return status === "open" ? (
    <span className="rounded-full bg-amber-950/40 px-2 py-0.5 text-xs text-amber-300">
      open
    </span>
  ) : (
    <span className="rounded-full bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-300">
      resolved
    </span>
  );
}

export function ReportsDashboard({ slug }: { slug: string }) {
  const [reports, setReports] = useState<Reports | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("dispatch");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const res = await getReports(slug);
      if (res.ok) {
        setReports(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const resolve = (source: Tab, id: string) => {
    setResolvingId(id);
    startTransition(async () => {
      const res = await resolveReport(slug, { source, id });
      if (res.ok) {
        load();
        setSelected(null);
      } else {
        setError(res.error);
      }
      setResolvingId(null);
    });
  };

  const dispatchOpen = reports?.dispatch.filter((r) => r.status === "open").length ?? 0;
  const technicalOpen = reports?.technical.filter((r) => r.status === "open").length ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Reports</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Technical reports filed by dispatchers (mgcj-dashboard Support tab)
            and by passengers/drivers (mobile app).
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {!reports && !error && (
        <p className="mt-6 text-sm text-zinc-500">Loading…</p>
      )}

      {reports && (
        <div className="mt-6">
          <div className="flex gap-1 border-b border-zinc-800">
            <button
              onClick={() => setTab("dispatch")}
              className={
                "px-4 py-2 text-sm " +
                (tab === "dispatch"
                  ? "border-b-2 border-accent text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300")
              }
            >
              Dispatch{" "}
              {dispatchOpen > 0 && (
                <span className="ml-1 text-xs text-amber-400">({dispatchOpen})</span>
              )}
            </button>
            <button
              onClick={() => setTab("technical")}
              className={
                "px-4 py-2 text-sm " +
                (tab === "technical"
                  ? "border-b-2 border-accent text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300")
              }
            >
              Passenger / Driver{" "}
              {technicalOpen > 0 && (
                <span className="ml-1 text-xs text-amber-400">({technicalOpen})</span>
              )}
            </button>
          </div>

          {tab === "dispatch" ? (
            <>
              <ReportSection title="Open">
                <DispatchTable
                  rows={reports.dispatch.filter((r) => r.status === "open")}
                  onSelect={(report) => setSelected({ source: "dispatch", report })}
                />
              </ReportSection>
              <ReportSection title="Resolved" muted>
                <DispatchTable
                  rows={reports.dispatch.filter((r) => r.status === "resolved")}
                  onSelect={(report) => setSelected({ source: "dispatch", report })}
                />
              </ReportSection>
            </>
          ) : (
            <>
              <ReportSection title="Open">
                <TechnicalTable
                  rows={reports.technical.filter((r) => r.status === "open")}
                  onSelect={(report) => setSelected({ source: "technical", report })}
                />
              </ReportSection>
              <ReportSection title="Resolved" muted>
                <TechnicalTable
                  rows={reports.technical.filter((r) => r.status === "resolved")}
                  onSelect={(report) => setSelected({ source: "technical", report })}
                />
              </ReportSection>
            </>
          )}
        </div>
      )}

      {selected && (
        <ReportDetailModal
          selected={selected}
          resolving={resolvingId === selected.report.id}
          onResolve={() => resolve(selected.source, selected.report.id)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function ReportSection({
  title,
  muted,
  children,
}: {
  title: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-4">
      <h2
        className={
          "text-sm font-semibold " + (muted ? "text-zinc-500" : "text-zinc-300")
        }
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function DispatchTable({
  rows,
  onSelect,
}: {
  rows: DispatchReport[];
  onSelect: (report: DispatchReport) => void;
}) {
  if (rows.length === 0)
    return <p className="mt-3 text-sm text-zinc-600">None.</p>;

  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
            <th className="px-4 py-2.5 font-medium">Company</th>
            <th className="px-4 py-2.5 font-medium">Admin</th>
            <th className="px-4 py-2.5 font-medium">Category</th>
            <th className="px-4 py-2.5 font-medium">Message</th>
            <th className="px-4 py-2.5 font-medium">Filed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onSelect(r)}
              className="cursor-pointer border-b border-zinc-900 last:border-0 hover:bg-zinc-800/40"
            >
              <td className="px-4 py-3 text-zinc-200">{r.companyName}</td>
              <td className="px-4 py-3 text-zinc-400">{r.adminName ?? "—"}</td>
              <td className="px-4 py-3">
                <CategoryBadge category={r.category} />
              </td>
              <td className="px-4 py-3 max-w-md truncate text-zinc-300">
                {r.message}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-zinc-500">
                {relTime(r.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TechnicalTable({
  rows,
  onSelect,
}: {
  rows: TechnicalReport[];
  onSelect: (report: TechnicalReport) => void;
}) {
  if (rows.length === 0)
    return <p className="mt-3 text-sm text-zinc-600">None.</p>;

  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
            <th className="px-4 py-2.5 font-medium">Reporter</th>
            <th className="px-4 py-2.5 font-medium">Role</th>
            <th className="px-4 py-2.5 font-medium">Company</th>
            <th className="px-4 py-2.5 font-medium">Category</th>
            <th className="px-4 py-2.5 font-medium">Message</th>
            <th className="px-4 py-2.5 font-medium">Filed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => onSelect(r)}
              className="cursor-pointer border-b border-zinc-900 last:border-0 hover:bg-zinc-800/40"
            >
              <td className="px-4 py-3 text-zinc-200">{r.reporterName ?? "—"}</td>
              <td className="px-4 py-3 text-zinc-400 capitalize">{r.reporterRole}</td>
              <td className="px-4 py-3 text-zinc-400">{r.companyName ?? "—"}</td>
              <td className="px-4 py-3">
                <CategoryBadge category={r.category} />
              </td>
              <td className="px-4 py-3 max-w-md truncate text-zinc-300">
                {r.message}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-zinc-500">
                {relTime(r.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-200">{value}</span>
    </div>
  );
}

function ReportDetailModal({
  selected,
  resolving,
  onResolve,
  onClose,
}: {
  selected: Selected;
  resolving: boolean;
  onResolve: () => void;
  onClose: () => void;
}) {
  const { source, report } = selected;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <CategoryBadge category={report.category} />
            <StatusBadge status={report.status} />
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 divide-y divide-zinc-800">
          {/* The reference the reporter also has — it is in the subject line of
              the email that brought this in, so a reply thread and this row can
              be matched up. Same value on both report kinds. */}
          <DetailRow label="Reference" value={report.reportRef} />
          {source === "dispatch" ? (
            <>
              <DetailRow label="Company" value={report.companyName} />
              <DetailRow label="Filed by" value={report.adminName ?? "—"} />
            </>
          ) : (
            <>
              <DetailRow label="Reporter" value={report.reporterName ?? "—"} />
              <DetailRow
                label="Role"
                value={<span className="capitalize">{report.reporterRole}</span>}
              />
              <DetailRow label="Company" value={report.companyName ?? "—"} />
              {report.rideId && (
                <DetailRow
                  label="Ride"
                  value={
                    <span className="font-mono text-xs">{report.rideId}</span>
                  }
                />
              )}
            </>
          )}
          <DetailRow label="Filed" value={fullTime(report.createdAt)} />
        </div>

        <div className="mt-4">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Message</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-200">
            {report.message}
          </p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {report.status === "open" && (
            <button
              onClick={onResolve}
              disabled={resolving}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 disabled:opacity-50"
            >
              {resolving ? "Resolving…" : "Mark resolved"}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
