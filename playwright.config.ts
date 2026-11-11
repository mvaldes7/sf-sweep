import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', geolocation: { longitude: -122.4425, latitude: 37.7599 }, permissions: ['geolocation'] },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'iphone-width', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'pnpm dev --host 127.0.0.1 --port 4173', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
});
