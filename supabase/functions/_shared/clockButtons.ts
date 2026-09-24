/**
 * One-tap clock buttons (crew redesign K2.4). The AI never changes a clock or
 * a break: when somebody says "going to lunch" or "clock me out", the model
 * calls `offer_clock_button`, which writes nothing and only records that a
 * button should appear under the reply. The person taps it, and the button
 * goes through the same job-clock path the clock sheet uses. Pure — no Deno,
 * no fetch — so the app's tests and the Ask function share one definition.
 */
import type { AnthropicToolDef } from "./anthropicTools.ts";

export const CLOCK_BUTTON_ACTIONS = ["start_break", "end_break", "clock_in", "clock_out"] as const;
export type ClockButtonAction = (typeof CLOCK_BUTTON_ACTIONS)[number];
export const BREAK_TYPES = ["lunch", "rest", "other"] as const;
export type ClockBreakType = (typeof BREAK_TYPES)[number];

/** One button under a reply. `break_type` only means something for start_break. */
export interface ClockButton {
  action: ClockButtonAction;
  break_type: ClockBreakType | null;
}

export const OFFER_CLOCK_BUTTON_TOOL_NAME = "offer_clock_button";

export const OFFER_CLOCK_BUTTON_TOOL: AnthropicToolDef = {
  name: OFFER_CLOCK_BUTTON_TOOL_NAME,
  strict: true,
  description:
    "Show a one-tap job-clock button under your reply (Start break, End break, Clock in, Clock out) when the person asks to change their own clock or break, " +
    "e.g. 'going to lunch', 'back from break', 'clock me out'. Changes NOTHING: only the person's tap does, through the job clock. " +
    "Never say the break or clock changed; tell them to tap the button. Never offer it for anyone else's clock.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...CLOCK_BUTTON_ACTIONS], description: "Which button." },
      break_type: { type: ["string", "null"], enum: [...BREAK_TYPES, null], description: "For start_break: lunch, rest or other. Null when not said (the button asks)." },
    },
    required: ["action", "break_type"],
    additionalProperties: false,
  },
};

/** The tool call's input, checked; null when it names no real button. */
export function clockButtonFromInput(input: unknown): ClockButton | null {
  const a = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (!CLOCK_BUTTON_ACTIONS.includes(a.action as ClockButtonAction)) return null;
  const breakType = a.action === "start_break" && BREAK_TYPES.includes(a.break_type as ClockBreakType) ? a.break_type as ClockBreakType : null;
  return { action: a.action as ClockButtonAction, break_type: breakType };
}

export interface ClockButtonState { buttons: ClockButton[] }
export const newClockButtonState = (): ClockButtonState => ({ buttons: [] });

const BUTTON_WORDS: Record<ClockButtonAction, string> = { start_break: "Start break", end_break: "End break", clock_in: "Clock in", clock_out: "Clock out" };

/** The executor for `offer_clock_button`. It never touches a clock. */
export function clockButtonExecutor(state: ClockButtonState) {
  return (name: string, input: unknown): { content: string; is_error?: boolean } => {
    if (name !== OFFER_CLOCK_BUTTON_TOOL_NAME) return { content: "Unknown clock button tool.", is_error: true };
    const button = clockButtonFromInput(input);
    if (!button) return { content: "Choose start_break, end_break, clock_in or clock_out.", is_error: true };
    if (!state.buttons.some((b) => b.action === button.action)) state.buttons.push(button);
    return {
      content: JSON.stringify({
        shown: BUTTON_WORDS[button.action],
        guidance: `Nothing changed. A "${BUTTON_WORDS[button.action]}" button is now under your reply; the person taps it and it uses their job clock. ` +
          "Tell them to tap it. Never say the break or clock already changed. If they are not clocked in, the button says so instead.",
      }),
    };
  };
}

/** The reply's `buttons`, read back on the phone: only real actions survive. */
export function readClockButtons(raw: unknown): ClockButton[] {
  if (!Array.isArray(raw)) return [];
  const out: ClockButton[] = [];
  for (const item of raw) {
    const b = clockButtonFromInput(item);
    if (b && !out.some((x) => x.action === b.action)) out.push(b);
  }
  return out;
}

export function clockButtonActivityLine(name: string): string | null {
  return name === OFFER_CLOCK_BUTTON_TOOL_NAME ? "Prepared a job-clock button (nothing changed)" : null;
}
