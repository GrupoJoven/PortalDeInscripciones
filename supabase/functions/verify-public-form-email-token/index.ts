import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type PublicFormRow = {
  id: string;
  title: string;
  url: string;
  active: boolean;
  access_type: string;
  open_date: string | null;
  close_date: string | null;
  prefill_parent_email_entry: string | null;
  prefill_name_entry: string | null;
  prefill_dni_entry: string | null;
  prefill_address_entry: string | null;
  prefill_postal_code_entry: string | null;
};

type DniSession = {
  id: string;
  registration_form_id: string;
  status: string;
  minor_without_dni: boolean;
  extracted: Record<string, unknown> | null;
  expires_at: string;
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

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => null);
    const rawToken = typeof body?.token === "string" ? body.token.trim() : "";

    if (!rawToken) {
      return jsonResponse({ ok: false, error: "invalid_token" }, 400);
    }

    const tokenHash = await sha256(rawToken);

    const { data: tokenRow, error: tokenError } = await supabase
      .from("public_form_email_verification_tokens")
      .select(`
        id,
        registration_form_id,
        email,
        normalized_email,
        expires_at,
        consumed_at,
        dni_verification_session_id
      `)
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (tokenError) {
      console.error("Error buscando token público:", tokenError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!tokenRow) {
      return jsonResponse({ ok: false, error: "invalid_or_expired_token" }, 400);
    }

    const nowIso = new Date().toISOString();

    if (tokenRow.consumed_at) {
      const accessUrl = await getPublicFormAccessUrl(
        supabase,
        tokenRow.registration_form_id,
        tokenRow.normalized_email,
        tokenRow.dni_verification_session_id
      );

      if (!accessUrl) {
        return jsonResponse(
          { ok: false, error: "form_not_available" },
          404
        );
      }

      return jsonResponse({
        ok: true,
        status: "already_verified",
        access_url: accessUrl,
      });
    }

    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return jsonResponse({ ok: false, error: "invalid_or_expired_token" }, 400);
    }

    const { error: upsertError } = await supabase
      .from("parent_email_verifications")
      .upsert(
        {
          email: tokenRow.email,
          normalized_email: tokenRow.normalized_email,
          verified_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "normalized_email" }
      );

    if (upsertError) {
      console.error("Error guardando verificación pública:", upsertError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const { error: consumeError } = await supabase
      .from("public_form_email_verification_tokens")
      .update({ consumed_at: nowIso })
      .eq("id", tokenRow.id);

    if (consumeError) {
      console.error("Error consumiendo token público:", consumeError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const accessUrl = await getPublicFormAccessUrl(
      supabase,
      tokenRow.registration_form_id,
      tokenRow.normalized_email,
      tokenRow.dni_verification_session_id
    );

    if (!accessUrl) {
      return jsonResponse(
        { ok: false, error: "form_not_available" },
        404
      );
    }

    return jsonResponse({
      ok: true,
      status: "verified",
      access_url: accessUrl,
    });
  } catch (error) {
    console.error("Error no controlado:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

async function getPublicFormAccessUrl(
  supabase: ReturnType<typeof createClient>,
  formId: string,
  email: string,
  dniSessionId: string | null = null
) {
  const { data: formRow, error: formError } = await supabase
    .from("registration_forms")
    .select(`
      id,
      title,
      url,
      active,
      access_type,
      open_date,
      close_date,
      prefill_parent_email_entry,
      prefill_name_entry,
      prefill_dni_entry,
      prefill_address_entry,
      prefill_postal_code_entry
    `)
    .eq("id", formId)
    .maybeSingle<PublicFormRow>();

  if (formError) {
    console.error("Error cargando formulario público:", formError);
    throw formError;
  }

  if (!formRow || !isAccessiblePublicForm(formRow)) {
    return null;
  }

  const dniSession = await loadConfirmedDniSession(supabase, dniSessionId, formId);

  return buildPublicFormAccessUrl(formRow, email, dniSession);
}

/**
 * Recupera la sesión de verificación de DNI enlazada al token del email.
 * Solo se aceptan sesiones confirmadas, vigentes y del mismo formulario.
 */
async function loadConfirmedDniSession(
  supabase: ReturnType<typeof createClient>,
  sessionId: string | null,
  formId: string
): Promise<DniSession | null> {
  if (!sessionId) return null;

  const { data: session, error } = await supabase
    .from("dni_verification_sessions")
    .select("id, registration_form_id, status, minor_without_dni, extracted, expires_at")
    .eq("id", sessionId)
    .maybeSingle<DniSession>();

  if (error) {
    console.error("Error cargando sesión de DNI:", error);
    return null;
  }

  if (!session) return null;
  if (session.registration_form_id !== formId) return null;
  if (session.status !== "confirmed") return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;

  return session;
}

function isAccessiblePublicForm(form: PublicFormRow) {
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

function buildPublicFormAccessUrl(
  form: PublicFormRow,
  email: string,
  dniSession: DniSession | null = null
) {
  try {
    const url = new URL(form.url);

    if (form.prefill_parent_email_entry) {
      url.searchParams.set(form.prefill_parent_email_entry, email);
    }

    const extracted = dniSession?.extracted ?? null;

    if (extracted) {
      const numero = typeof extracted.numero === "string" ? extracted.numero.trim() : "";
      const nombre = typeof extracted.nombre === "string" ? extracted.nombre.trim() : "";
      const domicilio = typeof extracted.domicilio_texto === "string"
        ? extracted.domicilio_texto.trim()
        : "";
      const codigoPostal = typeof extracted.codigo_postal === "string"
        ? extracted.codigo_postal.trim()
        : "";

      if (form.prefill_dni_entry && numero) {
        url.searchParams.set(form.prefill_dni_entry, numero);
      }

      if (form.prefill_address_entry && domicilio) {
        url.searchParams.set(form.prefill_address_entry, domicilio);
      }

      if (form.prefill_postal_code_entry && codigoPostal) {
        url.searchParams.set(form.prefill_postal_code_entry, codigoPostal);
      }

      // Si el DNI verificado es el de un progenitor, el nombre no es el del
      // menor y no debe prerrellenarse.
      if (form.prefill_name_entry && nombre && !dniSession?.minor_without_dni) {
        url.searchParams.set(form.prefill_name_entry, nombre);
      }
    }

    return url.toString();
  } catch {
    return form.url;
  }
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