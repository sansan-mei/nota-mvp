import { existsSync, readFileSync } from 'node:fs';

/** 读取 .env（不覆盖已存在的环境变量），避免引入 dotenv 依赖。 */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export type Config = {
  port: number;
  dbPath: string;
  freeDailyLimit: number;
  staleProcessingMs: number;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    mock: boolean;
    mockDelayMs: number;
    timeoutMs: number;
  };
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? 'data/nota.db',
    freeDailyLimit: Number(env.FREE_DAILY_LIMIT ?? 10),
    staleProcessingMs: Number(env.STALE_PROCESSING_MS ?? 5 * 60 * 1000),
    llm: {
      baseUrl: (env.LLM_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
      apiKey: env.LLM_API_KEY ?? '',
      model: env.LLM_MODEL ?? 'qwen3.6-flash',
      mock: env.LLM_MOCK === '1',
      mockDelayMs: Number(env.LLM_MOCK_DELAY_MS ?? 50),
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 45000),
    },
  };
}
