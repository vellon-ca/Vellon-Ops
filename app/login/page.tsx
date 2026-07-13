import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; denied?: string }>;
}) {
  const params = await searchParams;

  const message = params.denied
    ? "That account isn't authorized for Vellon Ops."
    : params.error
      ? "Invalid email or password."
      : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            Vellon Ops
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Founder console</p>
        </div>

        <form
          action={login}
          className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6"
        >
          {message && (
            <p className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {message}
            </p>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="email"
              className="block text-sm font-medium text-zinc-400"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password"
              className="block text-sm font-medium text-zinc-400"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Sign in
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-zinc-600">
          Authorized personnel only.
        </p>
      </div>
    </main>
  );
}
