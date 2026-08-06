import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "dni_uploads";

// Tras confirmar, la sesión debe seguir viva el tiempo suficiente para que el
// usuario complete la verificación por email (que puede llegar por correo).
const POST_CONFIRM_TTL_HOURS = 24;

type SessionRow = {
  id: string;
  status: string;
  minor_without_dni: boolean;
  front_path: string | null;
  back_path: string | null;
  expires_at: string;
  extracted: Record<string, unknown> | null;
};

/**
 * Última barrera: aunque la interfaz del móvil ya impide confirmar con datos
 * incompletos, aquí se vuelve a comprobar. Si no, bastaría con una petición
 * hecha a mano para dar por verificado un documento del que no se ha leído
 * nada, y la verificación no serviría de nada.
 */
const ETIQUETAS_CAMPOS: Record<string, string> = {
  numero: "el número de DNI",
  nombre: "el nombre",
  domicilio_texto: "el domicilio",
};

function camposQueFaltan(
  extracted: Record<string, unknown> | null,
  minorWithoutDni: boolean,
): string[] {
  if (!extracted) return Object.keys(ETIQUETAS_CAMPOS);

  const obligatorios = minorWithoutDni
    ? ["numero", "domicilio_texto"]
    : ["numero", "nombre", "domicilio_texto"];

  return obligatorios.filter((campo) => {
    const valor = extracted[campo];
    return typeof valor !== "string" || valor.trim() === "";
  });
}

/**
 * El usuario acepta los datos leídos. En ese momento se borran las fotos del
 * documento: a partir de aquí solo se conservan nombre, número y domicilio.
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
      .select("id, status, minor_without_dni, front_path, back_path, expires_at, extracted")
      .eq("mobile_token_hash", await sha256(mobileToken))
      .maybeSingle<SessionRow>();

    if (sessionError) {
      console.error("Error cargando sesión:", sessionError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!session) {
      return jsonResponse({ ok: false, error: "invalid_session" }, 404);
    }

    if (session.status === "confirmed") {
      return jsonResponse({ ok: true, status: "confirmed" });
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

    if (session.status !== "extracted" || !session.extracted) {
      return jsonResponse(
        {
          ok: false,
          error: "not_ready",
          message: "Todavía no hay datos verificados que confirmar.",
        },
        409,
      );
    }

    const faltan = camposQueFaltan(session.extracted, session.minor_without_dni);

    if (faltan.length > 0) {
      const listado = faltan.map((campo) => ETIQUETAS_CAMPOS[campo] ?? campo).join(" y ");

      console.warn(
        `Intento de confirmar la sesión ${session.id} sin ${listado}`,
      );

      return jsonResponse(
        {
          ok: false,
          error: "incomplete_data",
          missing_fields: faltan,
          message:
            `No se puede continuar sin ${listado}. ` +
            "Repite las fotos del documento.",
        },
        422,
      );
    }

    const paths = [session.front_path, session.back_path].filter(
      (path): path is string => Boolean(path),
    );

    if (paths.length > 0) {
      const { error: removeError } = await supabase.storage.from(BUCKET).remove(paths);

      if (removeError) {
        // No bloqueamos al usuario: la limpieza periódica volverá a intentarlo.
        console.error("Error borrando imágenes del documento:", removeError);
      }
    }

    const nowIso = new Date().toISOString();
    const newExpiry = new Date(Date.now() + POST_CONFIRM_TTL_HOURS * 60 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from("dni_verification_sessions")
      .update({
        status: "confirmed",
        confirmed_at: nowIso,
        front_path: null,
        back_path: null,
        images_deleted_at: nowIso,
        expires_at: newExpiry,
      })
      .eq("id", session.id);

    if (updateError) {
      console.error("Error confirmando sesión:", updateError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    return jsonResponse({ ok: true, status: "confirmed" });
  } catch (error) {
    console.error("Error no controlado en dni-verification-confirm:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

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
