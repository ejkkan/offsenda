/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@batchsender/db"],
  output: "standalone", // Required for Docker builds
};

module.exports = nextConfig;
