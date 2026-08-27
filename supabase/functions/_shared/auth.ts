/**
 * Shared caller-authentication for Edge Functions (Deno runtime).
 *
 * Every function in this project is already configured with `verify_jwt = true`
 * in supabase/config.toml, so the Supabase gateway rejects unauthenticated
 * requests before the function runs. This helper adds an explicit, in-function
 * defense-in-depth check: it re-verifies the caller's JWT with getUser() so a
 * function that talks to OpenAI or writes the database on the service-role key
 * never acts for an unauthenticated caller, even if the platform gate is ever
 * misconfigured.
 *
 * It is intentionally non-breaking: if the Supabase URL / anon key are not
 * available in the environment (misconfiguration), it returns "unconfigured"
 * and the caller falls back to the platform `verify_jwt` gate rather than
 * hard-failing a legitimate request.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

export interface AuthedUser {
  id: string;
  email: string | null;
  role: string | null;
}

export type AuthResult =
  | { status: "ok"; user: AuthedUser }
  | { status: "unauthorized" }
  | { status: "unconfigured" };

/** Read the `role` claim from an already-gateway-verified JWT (no re-verify). */
function jwtRoleClaim(authHeader: string): string | null {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { role?: unknown };
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}

export async function verifyCaller(req: Request): Promise<AuthResult> {
  // Missing env => cannot verify locally; rely on platform verify_jwt.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { status: "unconfigured" };

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return { status: "unauthorized" };

  // Trusted server callers (service-role key, e.g. a DB/storage webhook) carry
  // a service_role JWT with no end-user; allow them without a getUser() lookup.
  // The gateway (verify_jwt = true) already validated the token's signature.
  if (jwtRoleClaim(authHeader) === "service_role") {
    return { status: "ok", user: { id: "service_role", email: null, role: "service_role" } };
  }

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return { status: "unauthorized" };

  const meta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
  return {
    status: "ok",
    user: {
      id: data.user.id,
      email: data.user.email ?? null,
      role: typeof meta.role === "string" ? meta.role : null,
    },
  };
}

/**
 * Convenience guard: returns a 401 Response when the caller is unauthenticated,
 * or null when the request may proceed ("ok" or "unconfigured"). Keeps the
 * existing client invoke contract intact for signed-in users.
 */
export async function requireCaller(
  req: Request,
  cors: HeadersInit,
): Promise<Response | null> {
  const result = await verifyCaller(req);
  if (result.status === "unauthorized") {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  return null;
}

/**
 * A Supabase client scoped to the CALLER's own JWT — never the service-role
 * key — built exactly the way `verifyCaller` above builds its own internal
 * client. `auth.uid()` inside any query/RPC made with this client resolves to
 * the real caller, so role-gated RPCs like `my_role_rank()` and RLS policies
 * apply natively instead of seeing nobody (which is what the service-role
 * client's `auth.uid()` would resolve to).
 *
 * Introduced for wave A's scheduling tools (ask/index.ts): PERMISSION MIRROR
 * means the AI must hold exactly the caller's own power, and the only way to
 * ask the database "does THIS caller outrank a foreman" is to query as them.
 *
 * Returns null when unconfigured or there is no Authorization header to scope
 * to — callers must treat null as "cannot act as this user", never fall back
 * to an elevated client.
 */
export function callerSupabaseClient(req: Request): ReturnType<typeof createClient> | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
