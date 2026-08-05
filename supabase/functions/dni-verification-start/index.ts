import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SESSION_TTL_MINUTES = 30;

type FormRow = {
  id: string;
  title: string;
  active: boolean;
  access_type: string;
  open_date: string | null;
  close_date: string | null;
  dni_verification_enabled: boolean;
};

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
    const appBaseUrl = Deno.env.get("APP_BASE_URL");

    if (!supabaseUrl || !serviceRoleKey || !appBaseUrl) {
      console.error("Faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o APP_BASE_URL");
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => null);
    const formId = typeof body?.form_id === "string" ? body.form_id.trim() : "";
    const minorWithoutDni = body?.minor_without_dni === true;

    if (!formId) {
      return jsonResponse({ ok: false, error: "missing_fields" }, 400);
    }

    const { data: formRow, error: formError } = await supabase
      .from("registration_forms")
      .select("id, title, active, access_type, open_date, close_date, dni_verification_enabled")
      .eq("id", formId)
      .maybeSingle<FormRow>();

    if (formError) {
      console.error("Error cargando formulario:", formError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!formRow || !isAccessiblePublicForm(formRow)) {
      return jsonResponse(
        {
          ok: false,
          error: "form_not_available",
          message: "El formulario no está disponible.",
        },
        404,
      );
    }

    if (!formRow.dni_verification_enabled) {
      return jsonResponse(
        {
          ok: false,
          error: "dni_verification_disabled",
          message: "Este formulario no requiere verificación de DNI.",
        },
        400,
      );
    }

    const mobileToken = generateToken();
    const desktopToken = generateToken();

    const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString();

    const { data: inserted, error: insertError } = await supabase
      .from("dni_verification_sessions")
      .insert({
        registration_form_id: formRow.id,
        mobile_token_hash: await sha256(mobileToken),
        desktop_token_hash: await sha256(desktopToken),
        minor_without_dni: minorWithoutDni,
        status: "pending",
        expires_at: expiresAt,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      console.error("Error creando sesión de verificación:", insertError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    // El token viaja en el fragmento de la URL: así nunca llega al servidor
    // ni queda en los logs de acceso ni en la cabecera Referer.
    const mobileUrl =
      `${appBaseUrl.replace(/\/$/, "")}/verificacion-dni#t=${mobileToken}`;

    return jsonResponse({
      ok: true,
      session_id: inserted.id,
      desktop_token: desktopToken,
      mobile_url: mobileUrl,
      expires_at: expiresAt,
      minor_without_dni: minorWithoutDni,
    });
  } catch (error) {
    console.error("Error no controlado en dni-verification-start:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

function isAccessiblePublicForm(form: FormRow) {
  if (!form.active) return false;
  if (form.access_type !== "public") return false;

  const now = Date.now();

  if (form.open_date) {
    const openTime = new Date(form.open_date).getTime();
    if (Number.isNaN(openTime) || now < openTime) return false;
  }

  if (form.close_date) {
    const closeTime = new Date(form.close_date).getTime();
    if (Number.isNaN(closeTime) || now > closeTime) return false;
  }

  return true;
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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
