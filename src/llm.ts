import type { Config } from './config.ts';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: object } };
export type AssistantMessage = { content: string | null; tool_calls?: ToolCall[] };

export type LLM = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<AssistantMessage>;

export class LLMError extends Error {}

/** OpenAI 兼容的 Chat Completions（默认指向通义千问 DashScope）。 */
export function createLLM(cfg: Config['llm']): LLM {
  if (cfg.mock) return createMockLLM(cfg.mockDelayMs);
  if (!cfg.apiKey) throw new Error('LLM_API_KEY 未配置（或设置 LLM_MOCK=1 使用离线假模型）');

  return async (messages, tools) => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
    };
    // Qwen3 系列默认可能开启思考，工具调用场景关掉以降低延迟
    if (cfg.baseUrl.includes('dashscope')) body.enable_thinking = false;

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new LLMError(`LLM HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new LLMError(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const json = (await res.json()) as { choices?: { message?: AssistantMessage }[] };
        const msg = json.choices?.[0]?.message;
        if (!msg) throw new LLMError('LLM 返回为空');
        return { content: msg.content ?? null, tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined };
      } catch (err) {
        if (err instanceof LLMError && !String(err.message).match(/HTTP (429|5\d\d)/)) throw err;
        lastErr = err;
      }
    }
    throw new LLMError(`LLM 调用失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  };
}

/**
 * 离线假模型：只用于自动化测试和没有 key 时体验界面。
 * 规则固定：问句 → search_history；否则 → save_summary + create_todo。
 * 输入包含 #fail 时模拟第三方故障。
 */
export function createMockLLM(delayMs = 50): LLM {
  let seq = 0;
  return async (messages) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const userText = (messages.find((m) => m.role === 'user') as { content: string }).content;
    if (userText.includes('#fail')) throw new LLMError('mock: upstream unavailable');
    const toolResults = messages.filter((m) => m.role === 'tool');
    const call = (name: string, args: object): ToolCall => ({
      id: `mock_${++seq}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    if (toolResults.length === 0) {
      if (/[?？]|多少|什么|吗/.test(userText)) {
        return { content: null, tool_calls: [call('search_history', { keywords: userText.replace(/[?？]/g, '').slice(0, 6).split(/\s+/) })] };
      }
      const title = userText.replace(/\s+/g, ' ').slice(0, 30);
      return {
        content: null,
        tool_calls: [call('save_summary', { summary: `记录：${title}` }), call('create_todo', { title })],
      };
    }
    return { content: '（离线假模型）已处理完成。', tool_calls: undefined };
  };
}
