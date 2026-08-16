import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type PublicFormRow = {
  id: string;
  title: string;
  description: string | null;
  url: string;
  active: boolean;
  access_type: string;
  open_date: string | null;
  close_date: string | null;
  prefill_parent_email_entry: string | null;
  dni_verification_enabled: boolean;
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
    const internalEmailSecret = Deno.env.get("INTERNAL_EMAIL_FUNCTION_SECRET");

    if (!supabaseUrl || !serviceRoleKey || !internalEmailSecret) {
      console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or INTERNAL_EMAIL_FUNCTION_SECRET");
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => null);
    const formId = typeof body?.form_id === "string" ? body.form_id.trim() : "";
    const rawEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const dniSessionToken = typeof body?.dni_session_token === "string"
      ? body.dni_session_token.trim()
      : "";

    if (!formId || !rawEmail) {
      return jsonResponse({ ok: false, error: "missing_fields" }, 400);
    }

    const normalizedEmail = normalizeEmail(rawEmail);

    if (!isValidEmail(normalizedEmail)) {
      return jsonResponse(
        {
          ok: false,
          error: "invalid_email",
          message: "Debes introducir un correo electrónico válido.",
        },
        400
      );
    }

    const { data: formRow, error: formError } = await supabase
      .from("registration_forms")
      .select(`
        id,
        title,
        description,
        url,
        active,
        access_type,
        open_date,
        close_date,
        prefill_parent_email_entry,
        dni_verification_enabled,
        prefill_name_entry,
        prefill_dni_entry,
        prefill_address_entry,
        prefill_postal_code_entry
      `)
      .eq("id", formId)
      .maybeSingle<PublicFormRow>();

    if (formError) {
      console.error("Error fetching registration_forms:", formError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!formRow || !isAccessiblePublicForm(formRow)) {
      return jsonResponse(
        {
          ok: false,
          error: "form_not_available",
          message: "El formulario no está disponible.",
        },
        404
      );
    }

    // Si el formulario exige verificación de DNI, no se puede llegar al
    // formulario sin una sesión confirmada para ese mismo formulario.
    let dniSession: DniSession | null = null;

    if (formRow.dni_verification_enabled) {
      dniSession = await loadConfirmedDniSession(supabase, dniSessionToken, formRow.id);

      if (!dniSession) {
        return jsonResponse(
          {
            ok: false,
            error: "dni_verification_required",
            message:
              "Este formulario requiere verificar el DNI antes de continuar. Vuelve a empezar el proceso.",
          },
          403
        );
      }
    }

    const { data: verifiedRow, error: verifiedError } = await supabase
      .from("parent_email_verifications")
      .select("id, verified_at")
      .eq("normalized_email", normalizedEmail)
      .maybeSingle();

    if (verifiedError) {
      console.error("Error fetching parent_email_verifications:", verifiedError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (verifiedRow) {
      return jsonResponse(
        {
          ok: true,
          status: "verified",
          access_url: buildPublicFormAccessUrl(formRow, normalizedEmail, dniSession),
        },
        200
      );
    }

    const sendOutcome = await ensurePublicVerificationEmailSent({
      supabase,
      supabaseUrl,
      serviceRoleKey,
      internalEmailSecret,
      formId: formRow.id,
      formTitle: formRow.title,
      email: rawEmail,
      normalizedEmail,
      dniSessionId: dniSession?.id ?? null,
    });

    return jsonResponse(
      {
        ok: true,
        status: "verification_required",
        message:
          sendOutcome === "sent"
            ? "Te hemos enviado un correo de verificación. Revisa tu bandeja de entrada."
            : "Ya te habíamos enviado un correo de verificación hace unos minutos. Revisa tu bandeja de entrada.",
      },
      200
    );
  } catch (error) {
    console.error("Unhandled error in start-public-form-email-access:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

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

async function ensurePublicVerificationEmailSent({
  supabase,
  supabaseUrl,
  serviceRoleKey,
  internalEmailSecret,
  formId,
  formTitle,
  email,
  normalizedEmail,
  dniSessionId,
}: {
  supabase: ReturnType<typeof createClient>;
  supabaseUrl: string;
  serviceRoleKey: string;
  internalEmailSecret: string;
  formId: string;
  formTitle: string;
  email: string;
  normalizedEmail: string;
  dniSessionId: string | null;
}): Promise<"sent" | "already_sent_recently"> {
  const now = Date.now();
  const tenMinutesAgoIso = new Date(now - 10 * 60 * 1000).toISOString();

  const { data: recentToken, error: recentTokenError } = await supabase
    .from("public_form_email_verification_tokens")
    .select("id, created_at, dni_verification_session_id")
    .eq("registration_form_id", formId)
    .eq("normalized_email", normalizedEmail)
    .is("consumed_at", null)
    .gt("created_at", tenMinutesAgoIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentTokenError) {
    console.error("Error checking recent public token:", recentTokenError);
    throw recentTokenError;
  }

  if (recentToken) {
    // El enlace que ya está en su bandeja debe apuntar a la verificación de
    // DNI más reciente, no a la de un intento anterior.
    if (recentToken.dni_verification_session_id !== dniSessionId) {
      const { error: relinkError } = await supabase
        .from("public_form_email_verification_tokens")
        .update({ dni_verification_session_id: dniSessionId })
        .eq("id", recentToken.id);

      if (relinkError) {
        console.error("Error relinking DNI session to pending token:", relinkError);
      }
    }

    return "already_sent_recently";
  }

  const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const tokenHash = await sha256(rawToken);
  const expiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();

  const { error: insertError } = await supabase
    .from("public_form_email_verification_tokens")
    .insert({
      registration_form_id: formId,
      email,
      normalized_email: normalizedEmail,
      token_hash: tokenHash,
      expires_at: expiresAt,
      dni_verification_session_id: dniSessionId,
    });

  if (insertError) {
    console.error("Error inserting public verification token:", insertError);
    throw insertError;
  }

  const sendResponse = await fetch(
    `${supabaseUrl}/functions/v1/send-public-form-verification-email`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "x-internal-function-secret": internalEmailSecret,
      },
      body: JSON.stringify({
        to: email,
        form_title: formTitle,
        form_id: formId,
        token: rawToken,
      }),
    }
  );

  const sendResult = await sendResponse.json().catch(() => null);

  if (!sendResponse.ok || !sendResult?.ok) {
    console.error("Error sending public verification email:", sendResult);
    throw new Error("email_send_failed");
  }

  return "sent";
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

      // Si se verificó el DNI de un progenitor porque el menor no tiene, el
      // nombre leído es el del adulto: no debe prerrellenar el del menor.
      if (form.prefill_name_entry && nombre && !dniSession?.minor_without_dni) {
        url.searchParams.set(form.prefill_name_entry, nombre);
      }
    }

    return url.toString();
  } catch {
    return form.url;
  }
}

/**
 * Recupera una sesión de verificación de DNI confirmada, vigente y asociada a
 * este mismo formulario. Devuelve null si no cumple todo.
 */
async function loadConfirmedDniSession(
  supabase: ReturnType<typeof createClient>,
  desktopToken: string,
  formId: string
): Promise<DniSession | null> {
  if (!desktopToken) return null;

  const { data: session, error } = await supabase
    .from("dni_verification_sessions")
    .select("id, registration_form_id, status, minor_without_dni, extracted, expires_at")
    .eq("desktop_token_hash", await sha256(desktopToken))
    .maybeSingle<DniSession>();

  if (error) {
    console.error("Error loading DNI session:", error);
    return null;
  }

  if (!session) return null;
  if (session.registration_form_id !== formId) return null;
  if (session.status !== "confirmed") return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;

  return session;
}

function normalizeEmail(email: string | null | undefined) {
  return (email ?? "").trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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