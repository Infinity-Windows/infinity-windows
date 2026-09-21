/** Responses adapter for Forge's existing caller-owned tool executor. */
import type { AnthropicToolDef, ToolLoopResult } from './anthropicTools.ts';
export interface OpenAIAskOptions {
  apiKey: string; model: string; system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: AnthropicToolDef[];
  executeTool: (name: string, input: unknown) => Promise<{ content: string; is_error?: boolean }>;
  fetcher?: typeof fetch; maxRounds?: number;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}
interface OutputItem {
  type: string; call_id?: string; name?: string; arguments?: string;
  content?: Array<{ type: string; text?: string }>;
}
export async function openaiAsk(opts: OpenAIAskOptions): Promise<ToolLoopResult> {
  if (!opts.apiKey || !opts.model) throw new Error('OpenAI Ask is not configured.');
  const input: unknown[] = [...opts.messages];
  const result: ToolLoopResult = { text: '', toolCalls: [], rounds: 0, truncated: false, usage: { inputTokens: 0, outputTokens: 0 } };
  const maxRounds = Math.min(6, Math.max(1, opts.maxRounds ?? 6));
  const signal = AbortSignal.timeout(90000);
  for (let round = 1; round <= maxRounds; round++) {
    const response = await (opts.fetcher ?? fetch)('https://api.openai.com/v1/responses', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, instructions: opts.system, input,
        store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 4096,
        parallel_tool_calls: false,
        tools: opts.tools.map(t => ({ type: 'function', name: t.name, description: t.description,
          parameters: t.input_schema, strict: false })),
      }),
    });
    // Do not log raw provider errors, prompts, headers or credentials.
    if (!response.ok) throw new Error(`OpenAI Ask request failed (${response.status}).`);
    const data = await response.json();
    result.usage.inputTokens += data.usage?.input_tokens ?? 0;
    result.usage.outputTokens += data.usage?.output_tokens ?? 0;
    opts.onUsage?.({ ...result.usage });
    result.rounds = round;
    if (data.status !== 'completed') throw new Error('OpenAI Ask did not complete its response.');
    const output: OutputItem[] = Array.isArray(data.output) ? data.output : [];
    const calls = output.filter(x => x.type === 'function_call');
    result.text = output.filter(x => x.type === 'message').flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text ?? '').join('\n').trim();
    if (!calls.length) return result;
    if (round === maxRounds || result.toolCalls.length + calls.length > 20) return { ...result, truncated: true };
    // Retain reasoning items as well as calls when using store:false.
    input.push(...output);
    for (const call of calls) {
      if (!call.call_id || !call.name) throw new Error('The model returned an invalid tool call.');
      let outcome: { content: string; is_error?: boolean };
      if (!opts.tools.some(t => t.name === call.name)) outcome = { content: 'This tool is not available.', is_error: true };
      else {
        let args: unknown;
        try { args = JSON.parse(call.arguments ?? '{}'); } catch { args = undefined; }
        if (args === undefined) outcome = { content: 'Tool arguments were invalid. Try again with valid JSON.', is_error: true };
        else {
          result.toolCalls.push({ name: call.name, input: args });
          outcome = await opts.executeTool(call.name, args);
        }
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output: outcome.content });
    }
  }
  return { ...result, truncated: true };
}
