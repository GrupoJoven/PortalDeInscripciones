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
        prefill_parent_email_entry
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
          access_url: buildPublicFormAccessUrl(formRow, normalizedEmail),
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
}: {
  supabase: ReturnType<typeof createClient>;
  supabaseUrl: string;
  serviceRoleKey: string;
  internalEmailSecret: string;
  formId: string;
  formTitle: string;
  email: string;
  normalizedEmail: string;
}): Promise<"sent" | "already_sent_recently"> {
  const now = Date.now();
  const tenMinutesAgoIso = new Date(now - 10 * 60 * 1000).toISOString();

  const { data: recentToken, error: recentTokenError } = await supabase
    .from("public_form_email_verification_tokens")
    .select("id, created_at")
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
  email: string
) {
  try {
    const url = new URL(form.url);

    if (form.prefill_parent_email_entry) {
      url.searchParams.set(form.prefill_parent_email_entry, email);
    }

    return url.toString();
  } catch {
    return form.url;
  }
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