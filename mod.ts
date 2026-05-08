// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.203.0/http/server.ts";

/**
 * Gemini rotating proxy
 * - Key rotation with cooldown on 401/403/429
 * - CORS + OPTIONS
 * - /health
 * - Rewrites :generateText -> :generateContent
 * - Scrubs thinkingConfig (camel and snake case)
 * - Buffers the body once to avoid BadResource and TDZ issues
 */

const KEY_ENV = Deno.env.get("API_KEYS") || "";
const API_KEYS: string[] = KEY_ENV.startsWith("[")
  ? JSON.parse(KEY_ENV)
  : KEY_ENV.split(",").map((k) => k.trim()).filter(Boolean);

const DEFAULT_BASE = "https://generativelanguage.googleapis.com";
const API_BASE = (Deno.env.get("GEMINI_API_BASE_URL") || DEFAULT_BASE).replace(/\/+$/, "");

// Optional access token (X-Access-Token)
const ACCESS_TOKEN = Deno.env.get("ACCESS_TOKEN") || null;

// Cooldown (ms) after 401/403/429
const COOLDOWN_MS = 60 * 60 * 1000;

// --- Rotation state ---
let rrIndex = 0;
interface KeyState { exhaustedUntil?: number }
const keyStates: KeyState[] = API_KEYS.map(() => ({}));

function pickKey(): { key: string; idx: number } | null {
  const now = Date.now();
  for (let i = 0; i < API_KEYS.length; i++) {
    const j = (rrIndex + i) % API_KEYS.length;
    if ((keyStates[j].exhaustedUntil ?? 0) <= now) {
      rrIndex = (j + 1) % API_KEYS.length;
      return { key: API_KEYS[j], idx: j };
    }
  }
  return null;
}
function backoff(idx: number) {
  keyStates[idx].exhaustedUntil = Date.now() + COOLDOWN_MS;
}
function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Access-Token",
  };
}

function rewritePath(pathname: string): string {
  // Do not rewrite /v1beta or /v1beta2; the client chooses the version.
  // Keep only this useful alias in case a client still calls :generateText.
  return pathname.replace(/:generateText\b/, ":generateContent");
}

// ---- util: JSON cleanup for unsupported fields ----
function scrubUnsupportedFields(obj: any): any {
  // Do not remove systemInstruction / system_instruction.
  // Only remove thinkingConfig and its snake_case variant.
  const DELETE_KEYS = new Set([
    "thinkingConfig", "thinking_config",
  ]);

  const walk = (val: any): any => {
    if (val && typeof val === "object") {
      if (Array.isArray(val)) return val.map(walk);
      for (const k of Object.keys(val)) {
        if (DELETE_KEYS.has(k)) {
          delete val[k];
          continue;
        }
        // Special case: generationConfig / generation_config
        if (k === "generationConfig" || k === "generation_config") {
          const gc = val[k];
          if (gc && typeof gc === "object") {
            delete gc["thinkingConfig"];
            delete gc["thinking_config"];
          }
        }
        val[k] = walk(val[k]);
      }
    }
    return val;
  };
  return walk(obj);
}

serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");
    const method = req.method.toUpperCase();
    const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS";

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { headers: cors(origin) });
    }

    // /health
    if (url.pathname === "/health") {
      const cooling = keyStates.map((s) => Math.max((s.exhaustedUntil ?? 0) - Date.now(), 0));
      return Response.json({ ok: true, keys: API_KEYS.length, coolingMs: cooling }, { headers: cors(origin) });
    }

    // Access token?
    if (ACCESS_TOKEN) {
      const tok = req.headers.get("X-Access-Token");
      if (tok !== ACCESS_TOKEN) {
        return new Response("Unauthorized", { status: 401, headers: cors(origin) });
      }
    }

    // Target URL with path rewriting
    const path = rewritePath(url.pathname);
    const targetBase = new URL(API_BASE + path);
    targetBase.search = url.search;

    // Headers to forward
    const fwd = new Headers();
    for (const [h, v] of req.headers.entries()) {
      const lower = h.toLowerCase();
      if (["host", "cookie", "authorization", "content-length"].includes(lower)) continue;
      fwd.set(h, v);
    }
    if (!fwd.has("content-type") && req.headers.has("content-type")) {
      fwd.set("content-type", req.headers.get("content-type")!);
    }

    // ---- body: declare before any use to avoid TDZ ----
    let rawBody: BodyInit | undefined = undefined;

    // Read and scrub the body once when needed
    if (!idempotent) {
      const ab = await req.arrayBuffer();
      rawBody = ab;

      // Try to parse and clean JSON.
      try {
        const text = new TextDecoder().decode(ab);
        const parsed = JSON.parse(text);
        const cleaned = scrubUnsupportedFields(parsed);
        const cleanedText = JSON.stringify(cleaned);
        if (cleanedText !== text) {
          rawBody = cleanedText;
          console.log("Payload cleaned: removed unsupported thinkingConfig fields");
        }
      } catch {
        // Not JSON: leave it untouched.
      }
    }

    // Retry loop with key rotation
    let attempt = 0;
    let lastRes: Response | null = null;

    while (attempt < Math.max(1, API_KEYS.length)) {
      const pick = pickKey();
      if (!pick) break;
      const { key, idx } = pick;

      const target = new URL(targetBase);
      target.searchParams.set("key", key);

      attempt++;
      console.log(new Date().toISOString(), `try#${attempt}`, method, url.pathname + url.search);

      const res = await fetch(target, {
        method,
        headers: fwd,
        body: idempotent ? undefined : rawBody,
      }).catch((e) => {
        console.warn("fetch error:", e?.message ?? e);
        return null;
      });

      if (!res) { lastRes = null; continue; }

      if ([401, 403, 429].includes(res.status)) {
        backoff(idx);
        lastRes = res;
        console.warn(`Key ${idx} returned ${res.status}, switching key...`);
        continue;
      }

      if (res.status === 503 && attempt < API_KEYS.length) {
        lastRes = res;
        console.warn("503 (model overloaded). Trying next key...");
        continue;
      }

      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors(origin))) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Global failure
    if (lastRes) {
      const txt = await lastRes.text();
      return new Response(txt, { status: lastRes.status, headers: cors(origin) });
    }
    return Response.json(
      { error: { code: 429, message: "All API keys exhausted or network error." } },
      { status: 429, headers: cors(origin) },
    );

  } catch (err: any) {
    console.error("Edge function error:", err);
    return new Response("Internal error in key rotator", {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
});
