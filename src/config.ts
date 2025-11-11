import 'dotenv/config';
import type { Policy } from './types';

export interface ServiceConfig {
  server: {
    host: string;
    port: number;
  };
  policy: {
    default: Policy;
  };
  interpreter: {
    confidenceThreshold: number;
    model: string;
  };
  openai: {
    apiKeyEnv: string;
  };
  baseline: {
    allowMissing: boolean;
  };
  dify?: {
    baseUrl: string;
    apiKeyEnv: string;
    defaultResponseMode?: 'streaming' | 'blocking';
  };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config: ServiceConfig = require('../config/service.config.json');

export default config;
