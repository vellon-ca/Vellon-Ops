import { requirePlatformOwner } from "@/lib/auth/guard";
import { listProjects } from "./actions";
import { ProjectCard } from "@/components/projects/ProjectCard";

// Landing screen after login. Reads the real `projects` spoke registry
// (seeded with mgcj today) rather than a hardcoded card, so a second
// project — or an edited name/color/icon — shows up here automatically.
export default async function ProjectsPage() {
  const user = await requirePlatformOwner();
  const result = await listProjects();
  const projects = result.ok ? result.data : [];

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-10 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
              Vellon Ops
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Signed in as {user.email}
            </p>
          </div>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-md px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
            >
              Sign out
            </button>
          </form>
        </div>

        <p className="mb-4 text-sm text-zinc-500">Select a project</p>

        {!result.ok && (
          <p className="mb-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {result.error}
          </p>
        )}

        {result.ok && projects.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-800 px-5 py-8 text-center text-sm text-zinc-500">
            No projects registered yet.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </div>
    </main>
  );
}
