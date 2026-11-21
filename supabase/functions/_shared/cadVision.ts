import { requireOpenAI, type OpenAiUsage } from "./openai.ts";

import { CAD_VISION_MODEL } from "./cadReviewPrompt.mts";
export { CAD_VISION_MODEL };

export async function requestCadVision(instructions: string, context: unknown, images: readonly string[]) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireOpenAI()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: CAD_VISION_MODEL,
      store: false,
      instructions,
      text: { format: { type: "json_object" } },
      max_output_tokens: 1024,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: JSON.stringify(context) },
          ...images.map(image_url => ({ type: "input_image", image_url, detail: "high" })),
        ],
      }],
    }),
  });
  if (!response.ok) return { status: response.status, text: null, usage: null };
  const result = await response.json();
  const usage: OpenAiUsage | null = result.usage ? {
    inputTokens: result.usage.input_tokens ?? null,
    outputTokens: result.usage.output_tokens ?? null,
  } : null;
  const text = result.output?.flatMap((item: { content?: { type: string; text?: string }[] }) => item.content ?? [])
    .find((part: { type: string }) => part.type === "output_text")?.text;
  return { status: response.status, text: typeof text === "string" ? text : null, usage };
}
