module.exports = {
  apps: [{
    name: "project-manager",
    cwd: "./apps/server",
    script: "dist/index.js",
    // `pnpm start`/`pnpm dev` both load `.env` via this same Node flag (see their package.json
    // scripts) -- pm2 runs the script directly, bypassing pnpm entirely, so it needs the same
    // flag itself or PM_AUTH_TOKEN (and everything else) never gets set. Without it the app
    // fails safe (index.ts refuses to start with the default token under NODE_ENV=production)
    // rather than running insecurely, but it still wouldn't start at all.
    node_args: ["--env-file-if-exists=../../.env"],
    env: { NODE_ENV: "production" },
    autorestart: true,
    max_restarts: 10,
  }],
};
