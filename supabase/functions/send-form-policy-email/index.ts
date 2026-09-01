import { sendGmailEmail } from "../_shared/gmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-function-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const internalSecret = Deno.env.get("INTERNAL_EMAIL_FUNCTION_SECRET");
    const providedSecret = req.headers.get("x-internal-function-secret");

    if (!internalSecret || providedSecret !== internalSecret) {
      return jsonResponse({ ok: false, error: "forbidden" }, 403);
    }

    const body = await req.json().catch(() => null);

    const to = typeof body?.to === "string" ? body.to.trim() : "";
    const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
    const html = typeof body?.html === "string" ? body.html.trim() : "";

    if (!to || !subject || !html) {
      return jsonResponse({ ok: false, error: "missing_fields" }, 400);
    }

    try {
      await sendGmailEmail({ to, subject, html });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message === "missing_env_vars") {
        console.error("Faltan variables de entorno");
        return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
      }

      console.error("Error Gmail API:", message);
      return jsonResponse({ ok: false, error: "gmail_send_failed", details: message }, 500);
    }

    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    console.error("Error no controlado:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}