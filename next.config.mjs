import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the tracing root to this project — a stray lockfile in the home dir
  // otherwise makes Next infer the wrong workspace root.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
