import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendGmailEmail } from "../_shared/gmail.ts";
import { buildPublicIdEmail } from "../_shared/publicIdEmail.ts";

// "No sé mi código": envía al email de contacto introducido los
// identificadores de todos los alumnos que lo tienen como EMAIL DE CONTACTO.
//
// La respuesta es siempre la misma, haya alumnos con ese email o no, para que
// desde la portada no se pueda averiguar qué correos tienen hijos inscritos.
// Los identificadores solo viajan por correo, al buzón de ese email.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Como mucho un correo por email en este intervalo.
const RATE_LIMIT_MS = 10 * 60 * 1000;
// Las peticiones más antiguas que esto ya no sirven para el límite.
const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

const GENERIC_MESSAGE =
  "Si ese correo es el email de contacto de algún alumno, te acabamos de enviar sus identificadores. " +
  "Revisa tu bandeja de entrada y la carpeta de spam. Si en unos minutos no te ha llegado, " +
  "prueba con otro correo que nos hayas podido dar.";

type StudentByEmailRow = {
  student_name: string;
  public_id: string;
  group_name: string | null;
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
      console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => null);
    const rawEmail = typeof body?.email === "string" ? body.email.trim() : "";
    const normalizedEmail = rawEmail.toLowerCase();

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

    const emailHash = await sha256(normalizedEmail);
    const now = Date.now();

    const { error: cleanupError } = await supabase
      .from("public_id_recovery_requests")
      .delete()
      .lt("created_at", new Date(now - REQUEST_RETENTION_MS).toISOString());

    if (cleanupError) {
      console.error("Error cleaning up old recovery requests:", cleanupError);
    }

    const { data: recentRequest, error: recentRequestError } = await supabase
      .from("public_id_recovery_requests")
      .select("id")
      .eq("email_hash", emailHash)
      .gt("created_at", new Date(now - RATE_LIMIT_MS).toISOString())
      .limit(1)
      .maybeSingle();

    if (recentRequestError) {
      console.error("Error checking recent recovery requests:", recentRequestError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (recentRequest) {
      return jsonResponse({ ok: true, message: GENERIC_MESSAGE });
    }

    const { data: insertedRequest, error: insertError } = await supabase
      .from("public_id_recovery_requests")
      .insert({ email_hash: emailHash })
      .select("id")
      .single();

    if (insertError || !insertedRequest) {
      console.error("Error inserting recovery request:", insertError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const { data: students, error: studentsError } = await supabase.rpc(
      "find_students_by_parent_email",
      { p_email: normalizedEmail }
    );

    if (studentsError) {
      console.error("Error fetching students by parent email:", studentsError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const children = ((students ?? []) as StudentByEmailRow[]).map((student) => ({
      name: student.student_name,
      public_id: student.public_id,
      group_name: student.group_name || "Sin grupo",
    }));

    if (children.length === 0) {
      return jsonResponse({ ok: true, message: GENERIC_MESSAGE });
    }

    const { subject, html } = buildPublicIdEmail(children, Deno.env.get("APP_BASE_URL") ?? "");

    try {
      await sendGmailEmail({ to: rawEmail, subject, html });
    } catch (error) {
      console.error("Error sending recovery email:", error);

      // Sin correo enviado, la petición no debe bloquear un reintento.
      await supabase.from("public_id_recovery_requests").delete().eq("id", insertedRequest.id);
    }

    // Igual aunque falle el envío: un mensaje distinto delataría que el email
    // tiene alumnos asociados.
    return jsonResponse({ ok: true, message: GENERIC_MESSAGE });
  } catch (error) {
    console.error("Unhandled error in recover-public-ids:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

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
