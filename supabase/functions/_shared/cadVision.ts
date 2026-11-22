import { requireOpenAI, type OpenAiUsage } from "./openai.ts";

import { CAD_VISION_MODEL } from "./cadReviewPrompt.mts";
export { CAD_VISION_MODEL };

// On its first day on production (2026-11-22) every drawing came back as a 502
// and nothing said why. This model reasons before it answers, and that
// reasoning is paid for out of max_output_tokens: at 1024 with no effort set,
// it could spend the whole allowance thinking and return no answer at all, or
// still be thinking when a 30 second limit cut it off. So the effort is set
// low (reading labelled dimensions off one drawing is not a hard problem),
// the allowance and the wait are both raised, and a reply with no answer says
// what the provider reported instead of only that it failed.
export async function requestCadVision(instructions: string, context: unknown, images: readonly string[]) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireOpenAI()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: CAD_VISION_MODEL,
      store: false,
      instructions,
      reasoning: { effort: "low" },
      text: { format: { type: "json_object" } },
      max_output_tokens: 4096,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: JSON.stringify(context) },
          ...images.map(image_url => ({ type: "input_image", image_url, detail: "high" })),
        ],
      }],
    }),
  });
  if (!response.ok) return { status: response.status, text: null, usage: null, failure: `provider ${response.status}` };
  const result = await response.json();
  const usage: OpenAiUsage | null = result.usage ? {
    inputTokens: result.usage.input_tokens ?? null,
    outputTokens: result.usage.output_tokens ?? null,
  } : null;
  const text = result.output?.flatMap((item: { content?: { type: string; text?: string }[] }) => item.content ?? [])
    .find((part: { type: string }) => part.type === "output_text")?.text;
  const answered = typeof text === "string";
  // A 200 with no answer: `incomplete_details.reason` is the provider's own
  // word for why (max_output_tokens, content_filter).
  const failure = answered ? null : `no answer, ${result.incomplete_details?.reason ?? result.status ?? "unknown"}`;
  return { status: response.status, text: answered ? text as string : null, usage, failure };
}
