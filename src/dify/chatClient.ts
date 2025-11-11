import config from '../config';

export type DifyResponseMode = 'blocking' | 'streaming';

export interface DifyChatMessagePayload {
  inputs?: Record<string, unknown> | undefined;
  query: string;
  response_mode?: DifyResponseMode | undefined;
  conversation_id?: string | undefined;
  user?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface DifyConfig {
  baseUrl: string;
  apiKeyEnv: string;
  defaultResponseMode?: DifyResponseMode;
}

export interface DifyChatMessageResult {
  response: Response;
  mode: DifyResponseMode;
}

function assertFetch(): typeof fetch {
  if (typeof fetch !== 'function') {
    throw new Error('Fetch API is not available in the current runtime.');
  }
  return fetch;
}

function assertDifyConfig(): DifyConfig {
  if (!config.dify) {
    throw new Error('Missing Dify configuration. Please set config.dify in service.config.json.');
  }
  return config.dify;
}

function resolveApiKey(difyConfig: DifyConfig): string {
  const key = "app-7vLembh6u1b45EOnt80rSurQ";
  if (!key) {
    throw new Error(`Missing Dify API key. Please set ${difyConfig.apiKeyEnv} in your environment.`);
  }
  return key;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

export async function sendDifyChatMessage(payload: DifyChatMessagePayload): Promise<DifyChatMessageResult> {
  const difyConfig = assertDifyConfig();
  const apiKey = resolveApiKey(difyConfig);
  const fetchFn = assertFetch();

  const mode: DifyResponseMode = payload.response_mode ?? difyConfig.defaultResponseMode ?? 'blocking';
  const body: Record<string, unknown> = {
    inputs: payload.inputs ?? {},
    query: payload.query,
    response_mode: mode,
  };

  if (payload.conversation_id !== undefined) {
    body.conversation_id = payload.conversation_id;
  }
  if (payload.user !== undefined) {
    body.user = payload.user;
  }
  if (payload.metadata !== undefined) {
    body.metadata = payload.metadata;
  }

  const endpoint = `${normalizeBaseUrl(difyConfig.baseUrl)}/chat-messages`;
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return { response, mode };
}

