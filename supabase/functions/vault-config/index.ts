import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import { verifyCaller } from "../_shared/auth.ts";
import { roleCanSetPin } from "../_shared/vaultGate.ts";
import {
  generateSaltB64,
  hashPin,
  PIN_ITERATIONS,
  validateNewPin,
  verifyPin,
} from "../_shared/pin.ts";

type ServiceClient = ReturnType<typeof createClient>;

/** Caller's role from the profiles table (source of truth for role gating). */
async function profileRole(
  supabase: ServiceClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) return null;
  return (data?.role as string | undefined) ?? null;
}

async function loadPinRow(supabase: ServiceClient) {
  const { data } = await supabase
    .from("vault_config")
    .select("pin_hash, pin_salt, pin_iterations")
    .eq("id", 1)
    .maybeSingle();
  return data as
    | { pin_hash: string | null; pin_salt: string | null; pin_iterations: number | null }
    | null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "status");

    const row = await loadPinRow(supabase);
    const pinSet = Boolean(row?.pin_hash && row.pin_salt && row.pin_iterations);

    if (action === "status") {
      return jsonResponse({ pinSet }, 200, cors);
    }

    if (action === "set") {
      const userId = auth.status === "ok" ? auth.user.id : null;
      const role = userId ? await profileRole(supabase, userId) : null;
      if (!roleCanSetPin(role)) {
        return jsonResponse(
          { error: "Only an owner can set or change the vault PIN." },
          403,
          cors,
        );
      }

      const newPin = String(body?.newPin ?? "");
      const check = validateNewPin(newPin);
      if (!check.ok) {
        return jsonResponse({ error: check.error }, 400, cors);
      }

      // Changing an existing PIN requires the current one.
      if (pinSet) {
        const currentPin = String(body?.currentPin ?? "");
        const ok = await verifyPin(
          currentPin,
          row!.pin_salt!,
          row!.pin_iterations!,
          row!.pin_hash!,
        );
        if (!ok) {
          return jsonResponse({ error: "Current PIN is incorrect." }, 403, cors);
        }
      }

      const salt = generateSaltB64();
      const hash = await hashPin(newPin, salt, PIN_ITERATIONS);
      const { error: upErr } = await supabase.from("vault_config").upsert({
        id: 1,
        pin_hash: hash,
        pin_salt: salt,
        pin_iterations: PIN_ITERATIONS,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      });
      if (upErr) throw upErr;

      return jsonResponse({ ok: true, pinSet: true }, 200, cors);
    }

    return jsonResponse({ error: `unknown action: ${action}` }, 400, cors);
  } catch (e) {
    console.error("vault-config error", e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
