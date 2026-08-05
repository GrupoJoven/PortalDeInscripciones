import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Presupuesto de tiempo por invocación. Si se agota, se devuelve next_offset
// para que el cliente continúe con el siguiente lote de destinatarios.
const MAX_RUN_MS = 50_000;
// Gmail permite ~2,5 envíos por segundo y usuario: 2 envíos en paralelo cada 800 ms.
const SEND_CONCURRENCY = 2;
const MIN_BATCH_MS = 800;
const DB_PAGE_SIZE = 1000;

type StudentRow = {
  id: string;
  name: string;
  parent_email: string | null;
  group_id: string | null;
};

type Recipient = {
  email: string;
  children: { name: string; public_id: string; group_name: string }[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const startedAt = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const internalEmailSecret = Deno.env.get("INTERNAL_EMAIL_FUNCTION_SECRET");

    if (!supabaseUrl || !serviceRoleKey || !internalEmailSecret) {
      console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or INTERNAL_EMAIL_FUNCTION_SECRET");
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1) Solo coordinadores autenticados pueden lanzar el envío masivo.
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
    const rawOffset = Number(body?.offset ?? 0);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    // 2) Construir la lista de destinatarios (un correo por parent_email).
    const students = await fetchAllRows<StudentRow>(
      supabase,
      "students",
      "id, name, parent_email, group_id",
      "id"
    );
    const accessRows = await fetchAllRows<{ student_id: string; public_id: string }>(
      supabase,
      "student_public_access",
      "student_id, public_id",
      "student_id"
    );
    const groupRows = await fetchAllRows<{ id: string; name: string }>(
      supabase,
      "groups",
      "id, name",
      "id"
    );

    const publicIdByStudentId = new Map(accessRows.map((row) => [row.student_id, row.public_id]));
    const groupNameById = new Map(groupRows.map((row) => [row.id, row.name]));

    const recipientsByEmail = new Map<string, Recipient>();
    let skippedNoPublicId = 0;
    let skippedInvalidEmail = 0;

    for (const student of students) {
      const publicId = publicIdByStudentId.get(student.id);

      if (!publicId) {
        skippedNoPublicId++;
        continue;
      }

      const email = (student.parent_email ?? "").trim();
      const normalizedEmail = email.toLowerCase();

      if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
        skippedInvalidEmail++;
        continue;
      }

      const child = {
        name: student.name,
        public_id: publicId,
        group_name: (student.group_id && groupNameById.get(student.group_id)) || "Sin grupo",
      };

      const existing = recipientsByEmail.get(normalizedEmail);

      if (existing) {
        existing.children.push(child);
      } else {
        recipientsByEmail.set(normalizedEmail, { email, children: [child] });
      }
    }

    // Orden estable para que el paginado por offset entre invocaciones sea coherente.
    const recipients = [...recipientsByEmail.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, recipient]) => ({
        ...recipient,
        children: [...recipient.children].sort((a, b) => a.name.localeCompare(b.name, "es")),
      }));

    const appBaseUrl = Deno.env.get("APP_BASE_URL") ?? "";

    // 3) Enviar por lotes hasta agotar el presupuesto de tiempo.
    let processed = 0;
    let sent = 0;
    let failed = 0;
    let nextOffset: number | null = null;
    let cursor = offset;

    while (cursor < recipients.length) {
      if (Date.now() - startedAt > MAX_RUN_MS) {
        nextOffset = cursor;
        break;
      }

      const batch = recipients.slice(cursor, cursor + SEND_CONCURRENCY);
      const batchStartedAt = Date.now();

      const results = await Promise.all(
        batch.map((recipient) =>
          sendReminderEmail({
            supabaseUrl,
            serviceRoleKey,
            internalEmailSecret,
            appBaseUrl,
            recipient,
          })
        )
      );

      for (const ok of results) {
        processed++;
        if (ok) sent++;
        else failed++;
      }

      cursor += batch.length;

      const elapsed = Date.now() - batchStartedAt;
      if (cursor < recipients.length && elapsed < MIN_BATCH_MS) {
        await sleep(MIN_BATCH_MS - elapsed);
      }
    }

    return jsonResponse({
      ok: true,
      total_recipients: recipients.length,
      processed,
      sent,
      failed,
      skipped_no_public_id: skippedNoPublicId,
      skipped_invalid_email: skippedInvalidEmail,
      next_offset: nextOffset,
    });
  } catch (error) {
    console.error("Unhandled error in send-public-id-reminders:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

async function fetchAllRows<T>(
  supabase: ReturnType<typeof createClient>,
  table: string,
  columns: string,
  orderColumn: string
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;

  while (true) {
    // El orden explícito es necesario para que el paginado con range() sea estable.
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, from + DB_PAGE_SIZE - 1);

    if (error) {
      console.error(`Error fetching ${table}:`, error);
      throw error;
    }

    const page = (data ?? []) as T[];
    rows.push(...page);

    if (page.length < DB_PAGE_SIZE) break;
    from += DB_PAGE_SIZE;
  }

  return rows;
}

async function sendReminderEmail({
  supabaseUrl,
  serviceRoleKey,
  internalEmailSecret,
  appBaseUrl,
  recipient,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  internalEmailSecret: string;
  appBaseUrl: string;
  recipient: Recipient;
}): Promise<boolean> {
  const subject =
    recipient.children.length === 1
      ? "Identificador de acceso al portal de inscripciones"
      : "Identificadores de acceso al portal de inscripciones";

  const payload = JSON.stringify({
    to: recipient.email,
    subject,
    html: buildReminderHtml(recipient, appBaseUrl),
  });

  // Un reintento: un fallo puntual dejaría a esa familia sin sus identificadores.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1000);

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/send-form-policy-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "x-internal-function-secret": internalEmailSecret,
        },
        body: payload,
      });

      const result = await response.json().catch(() => null);

      if (response.ok && result?.ok) return true;

      console.error(`Error sending reminder email to ${recipient.email}:`, result);
    } catch (error) {
      console.error(`Error sending reminder email to ${recipient.email}:`, error);
    }
  }

  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReminderHtml(recipient: Recipient, appBaseUrl: string) {
  const isSingle = recipient.children.length === 1;

  const rows = recipient.children
    .map(
      (child) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;">${escapeHtml(child.name)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;">${escapeHtml(child.group_name)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-weight:bold;color:#4338ca;">${escapeHtml(
            child.public_id
          )}</td>
        </tr>`
    )
    .join("");

  const portalUrl = appBaseUrl ? appBaseUrl.replace(/\/$/, "") : "";

  const portalBlock = portalUrl
    ? `
        <p>
          <a href="${portalUrl}" style="display:inline-block;padding:12px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">
            Ir al portal de inscripciones
          </a>
        </p>
        <p>Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
        <p>${portalUrl}</p>`
    : "";

  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
      <h2>${isSingle ? "Identificador de acceso" : "Identificadores de acceso"}</h2>
      <p>Hola,</p>
      <p>
        Te recordamos ${isSingle ? "el identificador" : "los identificadores"} de acceso al portal de
        inscripciones ${isSingle ? "de tu hijo/a" : "de tus hijos/as"}:
      </p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr>
            <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #cbd5e1;">Nombre</th>
            <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #cbd5e1;">Grupo</th>
            <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #cbd5e1;">Identificador</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
      <p>
        Introduce ${isSingle ? "este identificador" : "el identificador correspondiente"} en el portal
        para ver los formularios disponibles.
      </p>
      ${portalBlock}
      <p style="margin-top:24px;color:#6b7280;font-size:13px;">
        NOTA: no respondas a este correo electrónico, ha sido enviado de manera automática.
      </p>
    </div>
  `;
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
