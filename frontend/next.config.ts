import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pre-render every page at build time → produces ./out/ as a tree
  // of HTML, JS, and CSS that nginx serves verbatim. No Node runtime,
  // no headers() at request time, no middleware. All identity + data
  // fetching happens client-side.
  output: "export",
  // SPA-style routing fallback inside `out/` is handled by the nginx
  // config (try_files … /index.html).
  trailingSlash: false,
};

if (process.env.NODE_ENV === "development") {
  // Dev-only: `next dev` proxies REST /api/* to the backend so
  // /api/me and /api/leaderboard work at localhost:3000. Guarded
  // because rewrites aren't allowed together with `output: "export"`
  // at build time. Note `next dev` can NOT proxy the WebSocket — the
  // game socket connects straight to the backend port in dev instead
  // (lib/ws.ts).
  nextConfig.rewrites = async () => [
    {
      source: "/api/:path*",
      destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/api/:path*`,
    },
  ];
}

export default nextConfig;
