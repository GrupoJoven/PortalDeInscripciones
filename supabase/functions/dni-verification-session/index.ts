import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SessionRow = {
  id: string;
  registration_form_id: string;
  minor_without_dni: boolean;
  status: string;
  front_path: string | null;
  back_path: string | null;
  extracted: Record<string, unknown> | null;
  extraction_error: string | null;
  expires_at: string;
  attempts: number;
};

/**
 * Estado de la sesión para la página móvil. El móvil se identifica con el
 * token que venía en el QR.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => null);
    const mobileToken = typeof body?.mobile_token === "string" ? body.mobile_token.trim() : "";

    if (!mobileToken) {
      return jsonResponse({ ok: false, error: "missing_token" }, 400);
    }

    const { data: session, error: sessionError } = await supabase
      .from("dni_verification_sessions")
      .select(
        "id, registration_form_id, minor_without_dni, status, front_path, back_path, extracted, extraction_error, expires_at, attempts",
      )
      .eq("mobile_token_hash", await sha256(mobileToken))
      .maybeSingle<SessionRow>();

    if (sessionError) {
      console.error("Error cargando sesión:", sessionError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!session) {
      return jsonResponse({ ok: false, error: "invalid_session" }, 404);
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      return jsonResponse(
        {
          ok: false,
          error: "session_expired",
          message: "El código QR ha caducado. Vuelve a empezar desde el ordenador.",
        },
        410,
      );
    }

    const { data: formRow } = await supabase
      .from("registration_forms")
      .select("title")
      .eq("id", session.registration_form_id)
      .maybeSingle<{ title: string }>();

    // Al abrir la página desde el móvil pasamos de 'pending' a 'capturing'
    // para que el escritorio pueda avisar de que ya han escaneado el QR.
    if (session.status === "pending") {
      await supabase
        .from("dni_verification_sessions")
        .update({ status: "capturing" })
        .eq("id", session.id);

      session.status = "capturing";
    }

    return jsonResponse({
      ok: true,
      status: session.status,
      form_title: formRow?.title ?? "",
      minor_without_dni: session.minor_without_dni,
      front_uploaded: Boolean(session.front_path),
      back_uploaded: Boolean(session.back_path),
      extracted: sanitizeExtracted(session.extracted),
      extraction_error: session.extraction_error,
      attempts: session.attempts,
      expires_at: session.expires_at,
    });
  } catch (error) {
    console.error("Error no controlado en dni-verification-session:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

/** Solo devolvemos los campos que interesan al formulario. */
function sanitizeExtracted(extracted: Record<string, unknown> | null) {
  if (!extracted) return null;

  return {
    nombre: (extracted.nombre as string | null) ?? null,
    numero: (extracted.numero as string | null) ?? null,
    domicilio_texto: (extracted.domicilio_texto as string | null) ?? null,
    codigo_postal: (extracted.codigo_postal as string | null) ?? null,
    en_zona_parroquial: (extracted.en_zona_parroquial as boolean | null) ?? null,
    numero_valido: extracted.numero_valido === true,
    avisos: Array.isArray(extracted.avisos) ? extracted.avisos : [],
  };
}

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
