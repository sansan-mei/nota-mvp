import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv, readConfig } from './config.ts';
import { openDb } from './db.ts';
import { createLLM } from './llm.ts';
import { createRateLimiter, createTranscriber } from './asr.ts';
import { createHandler } from './app.ts';
import { sweepStale } from './quota.ts';

loadDotEnv();
const config = readConfig();
const db = openDb(config.dbPath);
const swept = sweepStale(db, new Date(), config.staleProcessingMs);
if (swept) console.log(`[nota] 清理了 ${swept} 条超时未完成的请求并返还额度`);

const llm = createLLM(config.llm);
const transcribe = createTranscriber(config.llm, config.asr);
const asrLimit = createRateLimiter(config.asr.perMinute);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
if (!existsSync(join(publicDir, 'index.html'))) {
  console.warn('[nota] 未找到 web/dist，请先运行 npm run build（只有接口可用）');
}
const server = createServer(createHandler({ db, llm, config, publicDir, transcribe, asrLimit }));

server.listen(config.port, () => {
  console.log(`[nota] pid=${process.pid} http://localhost:${config.port}  model=${config.llm.mock ? 'mock' : config.llm.model}  db=${config.dbPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
