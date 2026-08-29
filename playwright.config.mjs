export default {
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
    timeout: 30000,
  },
};
