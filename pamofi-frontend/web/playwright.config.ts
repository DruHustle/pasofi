import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'./tests', timeout:30_000, workers:1, reporter:'list', use:{ baseURL:process.env.PAMOFI_BASE_URL || 'http://localhost:5173', browserName:'chromium', launchOptions:{ executablePath:process.env.PAMOFI_CHROME_PATH } } });
