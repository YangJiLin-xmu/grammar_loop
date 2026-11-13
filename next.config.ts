import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "pg-boss"],
  outputFileTracingIncludes: { "/api/**": ["./data/samples.json"] },
  outputFileTracingExcludes: { "/*": ["./.data/**/*", "./.env*", "./.tools/**/*", "./data/sources/**/*", "./docs/**/*", "./tests/**/*"] },
};
export default config;
