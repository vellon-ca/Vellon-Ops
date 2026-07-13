import { requirePlatformOwner } from "@/lib/auth/guard";
import { Sidebar } from "@/components/Sidebar";

// Every route under this group is gated: the guard redirects to /login unless
// the caller is an allowlisted platform owner.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePlatformOwner();

  return (
    <div className="flex min-h-screen">
      <Sidebar email={user.email ?? null} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
