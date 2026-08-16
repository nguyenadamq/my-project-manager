module.exports = {
  apps: [{
    name: "project-manager",
    cwd: "./apps/server",
    script: "dist/index.js",
    env: { NODE_ENV: "production" },
    autorestart: true,
    max_restarts: 10,
  }],
};
