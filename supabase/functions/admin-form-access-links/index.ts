import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendGmailEmail } from "../_shared/gmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DB_PAGE_SIZE = 1000;

type FormRow = {
  id: string;
  title: string;
  url: string;
  active: boolean;
  access_type: string;
  form_type: string | null;
  open_date: string | null;
  close_date: string | null;
  dni_verification_enabled: boolean | null;
  prefill_public_id_entry: string | null;
  prefill_name_entry: string | null;
  prefill_dni_entry: string | null;
  prefill_gender_entry: string | null;
  prefill_parent_email_entry: string | null;
  prefill_school_entry: string | null;
  prefill_birth_date_entry: string | null;
  prefill_group_entry: string | null;
};

type StudentRow = {
  id: string;
  name: string;
  dni: string;
  gender: string;
  parent_email: string | null;
  school: string;
  birth_date: string | null;
  group_id: string | null;
};

type LinkFailure = { ok: false; error: string; message?: string };

type LinkSuccess = {
  ok: true;
  url: string;
  form_title: string;
  /** Correo al que se enviaría el enlace; null si no hay uno válido. */
  recipient: string | null;
  student?: { name: string; group_name: string };
  email?: string;
  warnings: string[];
};

type LinkResult = LinkFailure | LinkSuccess;

/**
 * Herramientas del panel de administración para generar a mano los mismos
 * enlaces prerrellenados que reciben las familias desde la portada:
 *
 * - list_verified_emails: correos de parent_email_verifications, para el
 *   buscador de los formularios públicos.
 * - verify_email_manually: añade un correo a parent_email_verifications sin
 *   pasar por el email de verificación (lo decide el coordinador).
 * - build_restricted_link: enlace de un formulario privado a partir del
 *   identificador público del catecúmeno.
 * - build_public_link: enlace de un formulario público con el EMAIL DE
 *   CONTACTO prerrellenado (debe estar verificado).
 * - send_link: genera de nuevo uno de los dos enlaces anteriores y lo envía
 *   por correo al email de contacto. El enlace y el destinatario se calculan
 *   aquí, nunca se aceptan del cliente.
 *
 * Solo para coordinadores autenticados.
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
      console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization") ?? "";
    const accessToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

    if (!accessToken) {
      return jsonResponse({ ok: false, error: "missing_jwt" }, 401);
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);

    if (userError || !userData?.user) {
      return jsonResponse({ ok: false, error: "invalid_jwt" }, 401);
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Error fetching profile:", profileError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (profile?.role !== "coordinator") {
      return jsonResponse({ ok: false, error: "forbidden" }, 403);
    }

    const body = await req.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action : "";

    switch (action) {
      case "list_verified_emails":
        return await listVerifiedEmails(supabase);
      case "verify_email_manually":
        return await verifyEmailManually(supabase, body?.email);
      case "build_restricted_link":
        return jsonResponse(await buildRestrictedLink(supabase, body?.form_id, body?.public_id), 200);
      case "build_public_link":
        return jsonResponse(await buildPublicLink(supabase, body?.form_id, body?.email), 200);
      case "send_link":
        return await sendLink(supabase, body);
      default:
        return jsonResponse({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (error) {
    console.error("Unhandled error in admin-form-access-links:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

async function listVerifiedEmails(supabase: ReturnType<typeof createClient>) {
  const emails: { email: string; normalized_email: string; verified_at: string | null }[] = [];
  let from = 0;

  while (true) {
    // El orden explícito es necesario para que el paginado con range() sea estable.
    const { data, error } = await supabase
      .from("parent_email_verifications")
      .select("email, normalized_email, verified_at")
      .order("normalized_email", { ascending: true })
      .range(from, from + DB_PAGE_SIZE - 1);

    if (error) {
      console.error("Error fetching parent_email_verifications:", error);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const page = data ?? [];
    emails.push(...page);

    if (page.length < DB_PAGE_SIZE) break;
    from += DB_PAGE_SIZE;
  }

  return jsonResponse({ ok: true, emails }, 200);
}

async function verifyEmailManually(supabase: ReturnType<typeof createClient>, rawEmail: unknown) {
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const normalizedEmail = normalizeEmail(email);

  if (!isValidEmail(normalizedEmail)) {
    return jsonResponse(
      { ok: false, error: "invalid_email", message: "El correo electrónico no es válido." },
      200
    );
  }

  const { data: existing, error: existingError } = await supabase
    .from("parent_email_verifications")
    .select("email, normalized_email, verified_at")
    .eq("normalized_email", normalizedEmail)
    .maybeSingle();

  if (existingError) {
    console.error("Error fetching parent_email_verifications:", existingError);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }

  if (existing) {
    return jsonResponse({ ok: true, status: "already_verified", email: existing }, 200);
  }

  const nowIso = new Date().toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from("parent_email_verifications")
    .insert({
      email,
      normalized_email: normalizedEmail,
      verified_at: nowIso,
      updated_at: nowIso,
    })
    .select("email, normalized_email, verified_at")
    .single();

  if (insertError) {
    console.error("Error inserting parent_email_verifications:", insertError);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }

  return jsonResponse({ ok: true, status: "verified", email: inserted }, 200);
}

async function sendLink(supabase: ReturnType<typeof createClient>, body: any) {
  const link: LinkResult =
    body?.mode === "restricted"
      ? await buildRestrictedLink(supabase, body?.form_id, body?.public_id)
      : body?.mode === "public"
        ? await buildPublicLink(supabase, body?.form_id, body?.email)
        : { ok: false, error: "missing_fields" };

  if (!link.ok) {
    return jsonResponse(link, 200);
  }

  if (!link.recipient) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_recipient",
        message: "No hay un correo de contacto válido al que enviar el enlace.",
      },
      200
    );
  }

  const { subject, html } = buildLinkEmail(link);

  try {
    await sendGmailEmail({ to: link.recipient, subject, html });
  } catch (error) {
    console.error("Error sending access link email:", error);
    return jsonResponse(
      { ok: false, error: "email_send_failed", message: "No se pudo enviar el correo. Inténtalo de nuevo." },
      200
    );
  }

  return jsonResponse({ ok: true, sent_to: link.recipient }, 200);
}

async function buildRestrictedLink(
  supabase: ReturnType<typeof createClient>,
  rawFormId: unknown,
  rawPublicId: unknown
): Promise<LinkResult> {
  const formId = typeof rawFormId === "string" ? rawFormId.trim() : "";
  const publicId = typeof rawPublicId === "string" ? rawPublicId.trim().toUpperCase() : "";

  if (!formId || !publicId) {
    return { ok: false, error: "missing_fields" };
  }

  const form = await loadForm(supabase, formId);

  if (!form || form.access_type !== "restricted" || form.form_type === "payment") {
    return {
      ok: false,
      error: "form_not_found",
      message: "El formulario no existe o no es un formulario privado de inscripción.",
    };
  }

  const { data: accessRow, error: accessError } = await supabase
    .from("student_public_access")
    .select("student_id")
    .eq("public_id", publicId)
    .maybeSingle();

  if (accessError) {
    console.error("Error fetching student_public_access:", accessError);
    throw accessError;
  }

  const { data: student, error: studentError } = accessRow?.student_id
    ? await supabase
        .from("students")
        .select("id, name, dni, gender, parent_email, school, birth_date, group_id")
        .eq("id", accessRow.student_id)
        .maybeSingle<StudentRow>()
    : { data: null, error: null };

  if (studentError) {
    console.error("Error fetching student:", studentError);
    throw studentError;
  }

  if (!student) {
    return {
      ok: false,
      error: "student_not_found",
      message: `No hay ningún catecúmeno con el identificador ${publicId}.`,
    };
  }

  let groupName = "";

  if (student.group_id) {
    const { data: groupRow, error: groupError } = await supabase
      .from("groups")
      .select("name")
      .eq("id", student.group_id)
      .maybeSingle();

    if (groupError) {
      console.error("Error fetching group:", groupError);
      throw groupError;
    }

    groupName = groupRow?.name ?? "";
  }

  const warnings = getFormStatusWarnings(form);

  const { data: relationRow, error: relationError } = student.group_id
    ? await supabase
        .from("registration_form_groups")
        .select("form_id")
        .eq("form_id", form.id)
        .eq("group_id", student.group_id)
        .limit(1)
        .maybeSingle()
    : { data: null, error: null };

  if (relationError) {
    console.error("Error fetching registration_form_groups:", relationError);
    throw relationError;
  }

  if (!relationRow) {
    warnings.push(
      `El grupo del catecúmeno (${groupName || "sin grupo"}) no tiene asignado este formulario: desde la portada no le aparecería.`
    );
  }

  const parentEmail = normalizeEmail(student.parent_email);
  const recipient = isValidEmail(parentEmail) ? parentEmail : null;

  if (!recipient) {
    warnings.push("El catecúmeno no tiene un correo de contacto válido: el enlace no se puede enviar por correo.");
  }

  // Mismo prerrelleno que get-registration-forms-by-public-id.
  const url = buildPrefilledUrl(form.url, {
    [form.prefill_public_id_entry ?? ""]: publicId,
    [form.prefill_name_entry ?? ""]: student.name,
    [form.prefill_dni_entry ?? ""]: student.dni,
    [form.prefill_gender_entry ?? ""]: mapDatabaseGenderToGoogleForm(student.gender),
    [form.prefill_parent_email_entry ?? ""]: student.parent_email,
    [form.prefill_school_entry ?? ""]: student.school,
    [form.prefill_birth_date_entry ?? ""]: student.birth_date ?? "",
    [form.prefill_group_entry ?? ""]: groupName,
  });

  return {
    ok: true,
    url,
    form_title: form.title,
    recipient,
    student: { name: student.name, group_name: groupName },
    warnings,
  };
}

async function buildPublicLink(
  supabase: ReturnType<typeof createClient>,
  rawFormId: unknown,
  rawEmail: unknown
): Promise<LinkResult> {
  const formId = typeof rawFormId === "string" ? rawFormId.trim() : "";
  const normalizedEmail = normalizeEmail(typeof rawEmail === "string" ? rawEmail : "");

  if (!formId || !normalizedEmail) {
    return { ok: false, error: "missing_fields" };
  }

  const form = await loadForm(supabase, formId);

  if (!form || form.access_type !== "public" || form.form_type === "payment") {
    return {
      ok: false,
      error: "form_not_found",
      message: "El formulario no existe o no es un formulario público de inscripción.",
    };
  }

  // Las respuestas de formularios públicos con un email no verificado se
  // rechazan al procesarlas, así que no tiene sentido generar el enlace.
  const { data: verifiedRow, error: verifiedError } = await supabase
    .from("parent_email_verifications")
    .select("normalized_email")
    .eq("normalized_email", normalizedEmail)
    .maybeSingle();

  if (verifiedError) {
    console.error("Error fetching parent_email_verifications:", verifiedError);
    throw verifiedError;
  }

  if (!verifiedRow) {
    return {
      ok: false,
      error: "email_not_verified",
      message: "Ese correo no está verificado. Verifícalo antes de generar el enlace.",
    };
  }

  const warnings = getFormStatusWarnings(form);

  if (!form.prefill_parent_email_entry) {
    warnings.push("Este formulario no tiene configurado el campo de EMAIL DE CONTACTO: el enlace no lleva nada prerrellenado.");
  }

  if (form.dni_verification_enabled) {
    warnings.push(
      "Este formulario pide verificar el DNI: con este enlace se salta esa verificación y no se prerrellenan los datos del DNI."
    );
  }

  const url = buildPrefilledUrl(form.url, {
    [form.prefill_parent_email_entry ?? ""]: normalizedEmail,
  });

  return {
    ok: true,
    url,
    form_title: form.title,
    recipient: normalizedEmail,
    email: normalizedEmail,
    warnings,
  };
}

function buildLinkEmail(link: LinkSuccess) {
  const subject = `Enlace de acceso al formulario: ${link.form_title}`;

  const forWhom = link.student
    ? ` para <strong>${escapeHtml(link.student.name)}</strong>`
    : "";

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
      <h2>Enlace de acceso al formulario</h2>
      <p>Hola,</p>
      <p>
        Te enviamos el enlace para rellenar el formulario
        <strong>${escapeHtml(link.form_title)}</strong>${forWhom}.
      </p>
      <p>
        El formulario ya tiene rellenados algunos datos. <strong>No los modifiques</strong>:
        si no coinciden con los que tenemos registrados, la inscripción no será válida.
      </p>
      <p>
        <a href="${escapeHtml(link.url)}" style="display:inline-block;padding:12px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">
          Abrir formulario
        </a>
      </p>
      <p>Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
      <p style="word-break:break-all;">${escapeHtml(link.url)}</p>
      <p style="margin-top:24px;color:#6b7280;font-size:13px;">
        NOTA: no respondas a este correo electrónico, ha sido enviado de manera automática.
      </p>
    </div>
  `;

  return { subject, html };
}

async function loadForm(supabase: ReturnType<typeof createClient>, formId: string) {
  const { data, error } = await supabase
    .from("registration_forms")
    .select(`
      id,
      title,
      url,
      active,
      access_type,
      form_type,
      open_date,
      close_date,
      dni_verification_enabled,
      prefill_public_id_entry,
      prefill_name_entry,
      prefill_dni_entry,
      prefill_gender_entry,
      prefill_parent_email_entry,
      prefill_school_entry,
      prefill_birth_date_entry,
      prefill_group_entry
    `)
    .eq("id", formId)
    .maybeSingle<FormRow>();

  if (error) {
    console.error("Error fetching registration_forms:", error);
    throw error;
  }

  return data;
}

function getFormStatusWarnings(form: FormRow) {
  const warnings: string[] = [];
  const now = Date.now();

  if (!form.active) {
    warnings.push("El formulario está desactivado en el portal.");
  }

  if (form.open_date && new Date(form.open_date).getTime() > now) {
    warnings.push("El formulario todavía no ha abierto.");
  }

  if (form.close_date && new Date(form.close_date).getTime() < now) {
    warnings.push("La fecha de cierre del formulario ya ha pasado.");
  }

  return warnings;
}

function mapDatabaseGenderToGoogleForm(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();

  if (normalized === "male") return "MASCULINO";
  if (normalized === "female") return "FEMENINO";

  return value ?? "";
}

function buildPrefilledUrl(
  baseUrl: string,
  entries: Record<string, string | null | undefined>
) {
  try {
    const url = new URL(baseUrl);

    for (const [entryKey, value] of Object.entries(entries)) {
      if (!entryKey || !value) continue;
      url.searchParams.set(entryKey, value);
    }

    return url.toString();
  } catch {
    return baseUrl;
  }
}

function normalizeEmail(email: string | null | undefined) {
  return (email ?? "").trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
