import {defineConfig} from '@playwright/test';
import base from './playwright.config';
export default defineConfig(base,{testMatch:'**/agent-payments.integration.ts',outputDir:'test-results/payment-service'});
