import type { Config } from './config.ts';

export type Transcriber = (audio: Buffer, mime: string) => Promise<string>;

export class ASRError extends Error {}

/** 千问语音识别（qwen3-asr-flash），OpenAI 兼容 chat/completions + input_audio。 */
export function createTranscriber(llm: Config['llm'], asr: Config['asr']): Transcriber {
  if (llm.mock) {
    return async () => {
      await new Promise((r) => setTimeout(r, llm.mockDelayMs));
      return '明天早上九点提醒我交周报';
    };
  }
  return async (audio, mime) => {
    const res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: asr.model,
        messages: [
          { role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${audio.toString('base64')}` } }] },
        ],
        stream: false,
        asr_options: { language: 'zh', enable_itn: true },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ASRError(`ASR HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (json.choices?.[0]?.message?.content ?? '').trim();
  };
}

/** 进程内的简单限流：每个用户每分钟最多 N 次转写（转写不占 AI 处理额度）。 */
export function createRateLimiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

export const AUDIO_MIME_RE = /^audio\/(webm|ogg|mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav|amr|flac)$/;
