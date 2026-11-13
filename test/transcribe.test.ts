import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { createMockLLM } from '../src/llm.ts';
import { createHandler } from '../src/app.ts';
import { createRateLimiter } from '../src/asr.ts';

async function withServer(fn: (url: string, calls: { mime: string; bytes: number }[]) => Promise<void>) {
  const calls: { mime: string; bytes: number }[] = [];
  const config = readConfig({ ASR_MAX_BYTES: '20000', ASR_PER_MINUTE: '3' });
  const server = createServer(
    createHandler({
      db: openDb(':memory:'),
      llm: createMockLLM(1),
      config,
      publicDir: '/nonexistent',
      transcribe: async (audio, mime) => {
        calls.push({ mime, bytes: audio.length });
        return '明天早上九点提醒我交周报';
      },
      asrLimit: createRateLimiter(config.asr.perMinute),
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls);
  } finally {
    server.close();
  }
}

const post = (url: string, body: Uint8Array<ArrayBuffer>, type: string, user = 'u_free_1') =>
  fetch(`${url}/api/transcribe`, { method: 'POST', headers: { 'content-type': type, 'x-user-id': user }, body });

test('语音转写：格式、大小、限流，且不占 AI 处理额度', async () => {
  await withServer(async (url, calls) => {
    const audio = new Uint8Array(5000);

    const ok = await post(url, audio, 'audio/webm;codecs=opus');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).text, '明天早上九点提醒我交周报');
    assert.deepEqual(calls[0], { mime: 'audio/webm', bytes: 5000 }, 'codecs 参数被去掉，按基础 MIME 转发');

    assert.equal((await post(url, audio, 'text/plain')).status, 415);
    assert.equal((await post(url, new Uint8Array(10), 'audio/mp4')).status, 400, '太短');
    assert.equal((await post(url, new Uint8Array(30000), 'audio/mp4')).status, 413, '超过大小上限');

    // 上限 3 次/分钟：前面 ok + too-short + too-large 已计 3 次（415 在限流前拒绝）
    assert.equal((await post(url, audio, 'audio/mp4')).status, 429);
    assert.equal((await post(url, audio, 'audio/mp4', 'u_free_2')).status, 200, '限流按用户隔离');

    const me = await (await fetch(`${url}/api/me`, { headers: { 'x-user-id': 'u_free_1' } })).json();
    assert.equal(me.quota.used, 0, '转写不扣 AI 处理额度');
  });
});

test('未登录不能转写', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(5000) });
    assert.equal(r.status, 401);
  });
});
