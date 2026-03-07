import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use webpack instead of turbopack for @coral-xyz/anchor Node.js polyfills
  turbopack: {
    // Resolve aliases for browser polyfills under Turbopack
    resolveAlias: {
      fs: { browser: "./lib/empty-module.ts" },
      os: { browser: "./lib/empty-module.ts" },
      path: { browser: "./lib/empty-module.ts" },
      crypto: { browser: "./lib/empty-module.ts" },
      stream: { browser: "./lib/empty-module.ts" },
      http: { browser: "./lib/empty-module.ts" },
      https: { browser: "./lib/empty-module.ts" },
      zlib: { browser: "./lib/empty-module.ts" },
      url: { browser: "./lib/empty-module.ts" },
      assert: { browser: "./lib/empty-module.ts" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        fs: false,
        os: false,
        path: false,
        crypto: false,
        stream: false,
        http: false,
        https: false,
        zlib: false,
        url: false,
        assert: false,
        buffer: require.resolve("buffer/"),
      };

      const webpack = require("webpack");
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
        })
      );
    }
    return config;
  },
};

export default nextConfig;
