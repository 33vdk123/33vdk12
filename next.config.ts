import type { NextConfig } from "next";

// @libsql/client يحمل وحدة native — يجب إبقاؤه خارج حزمة التجميع حتى يعمل على Vercel
const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["@libsql/client"],
};

export default nextConfig;
