
import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true, // Disable Next.js image optimization
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos', // Example, keep if used
      },
      {
        protocol: 'https',
        hostname: 'placehold.co', // For placeholder images
      },
      {
        protocol: 'https',
        hostname: 'firebasestorage.googleapis.com', // For Firebase Storage images
      },
    ],
  },
  // Ensure 'output: "export"' is NOT present for server-side deployments (Firebase App Hosting).

  webpack: (config, { isServer, buildId }) => {
    console.log(`[Next.js Webpack Config] Running for buildId: ${buildId}, isServer: ${isServer}`);
    if (!isServer) {
      // Don't resolve 'async_hooks' on the client.
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        async_hooks: false,
      };
      console.log('[Next.js Webpack Config] Applied async_hooks:false fallback for client bundle.');
    }
    return config;
  },
};

export default nextConfig;
