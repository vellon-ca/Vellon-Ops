import { notFound } from "next/navigation";
import { requirePlatformOwner } from "@/lib/auth/guard";
import { loadSpoke, SpokeError } from "@/lib/connectors/spoke";
import { Sidebar } from "@/components/Sidebar";

// Every route under this group is gated twice: the guard redirects to /login
// unless the caller is an allowlisted platform owner, and the [slug] segment
// must name a real, active spoke in the hub's `projects` registry.
//
// The layout lives HERE rather than one level up so it can read params.slug —
// a layout above the dynamic segment never sees it. Resolving the spoke here
// means an unknown slug 404s once, at the boundary, instead of each module
// discovering it separately.
export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const user = await requirePlatformOwner();
  const { slug } = await params;

  // loadSpoke is request-cached, so the pages and server actions below resolve
  // the same row without re-querying the hub.
  let spoke;
  try {
    spoke = await loadSpoke(slug);
  } catch (e) {
    if (e instanceof SpokeError) notFound();
    throw e;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        email={user.email ?? null}
        slug={spoke.slug}
        projectName={spoke.name}
        environment={spoke.environment}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
