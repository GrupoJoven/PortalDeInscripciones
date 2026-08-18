import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SessionRow = {
  id: string;
  status: string;
  minor_without_dni: boolean;
  extracted: Record<string, unknown> | null;
  expires_at: string;
  confirmed_at: string | null;
};

/**
 * Sondeo desde el navegador de escritorio, que se identifica con el token que
 * recibió al generar el QR.
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
    const desktopToken = typeof body?.desktop_token === "string" ? body.desktop_token.trim() : "";

    if (!desktopToken) {
      return jsonResponse({ ok: false, error: "missing_token" }, 400);
    }

    const { data: session, error: sessionError } = await supabase
      .from("dni_verification_sessions")
      .select("id, status, minor_without_dni, extracted, expires_at, confirmed_at")
      .eq("desktop_token_hash", await sha256(desktopToken))
      .maybeSingle<SessionRow>();

    if (sessionError) {
      console.error("Error cargando sesión:", sessionError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!session) {
      return jsonResponse({ ok: false, error: "invalid_session" }, 404);
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      return jsonResponse({ ok: true, status: "expired" });
    }

    // Los datos solo se devuelven al escritorio una vez confirmados en el móvil.
    const confirmed = session.status === "confirmed";

    return jsonResponse({
      ok: true,
      status: session.status,
      minor_without_dni: session.minor_without_dni,
      confirmed_at: session.confirmed_at,
      expires_at: session.expires_at,
      extracted: confirmed ? sanitizeExtracted(session.extracted, session.minor_without_dni) : null,
    });
  } catch (error) {
    console.error("Error no controlado en dni-verification-status:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

function sanitizeExtracted(
  extracted: Record<string, unknown> | null,
  minorWithoutDni: boolean,
) {
  if (!extracted) return null;

  return {
    // Si el DNI verificado es el de un progenitor, el nombre, el sexo y la
    // fecha de nacimiento leídos son los del adulto, no los del menor: no
    // deben mostrarse ni prerrellenarse.
    nombre: minorWithoutDni ? null : ((extracted.nombre as string | null) ?? null),
    sexo: minorWithoutDni ? null : ((extracted.sexo as string | null) ?? null),
    fecha_nacimiento: minorWithoutDni ? null : ((extracted.fecha_nacimiento as string | null) ?? null),
    numero: (extracted.numero as string | null) ?? null,
    domicilio_texto: (extracted.domicilio_texto as string | null) ?? null,
    codigo_postal: (extracted.codigo_postal as string | null) ?? null,
    en_zona_parroquial: (extracted.en_zona_parroquial as boolean | null) ?? null,
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
