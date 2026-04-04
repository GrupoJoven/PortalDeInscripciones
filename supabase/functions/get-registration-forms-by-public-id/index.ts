import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RestrictedForm = {
  id: string;
  title: string;
  description: string | null;
  url: string;
  open_date: string | null;
  close_date: string | null;
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
    const rawPublicId = body?.public_id;

    if (typeof rawPublicId !== "string") {
      return jsonResponse({ ok: true, forms: [] }, 200);
    }

    const publicId = rawPublicId.trim().toUpperCase();

    if (!publicId) {
      return jsonResponse({ ok: true, forms: [] }, 200);
    }

    const { data: accessRow, error: accessError } = await supabase
      .from("student_public_access")
      .select("student_id")
      .eq("public_id", publicId)
      .maybeSingle();

    if (accessError) {
      console.error("Error fetching student_public_access:", accessError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!accessRow?.student_id) {
      return jsonResponse({ ok: true, forms: [] }, 200);
    }

    const { data: studentRow, error: studentError } = await supabase
      .from("students")
      .select("id, name, dni, gender, parent_email, school, birth_date, group_id")
      .eq("id", accessRow.student_id)
      .maybeSingle();

    if (studentError) {
      console.error("Error fetching student:", studentError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!studentRow?.group_id) {
      return jsonResponse({ ok: true, forms: [] }, 200);
    }

    const { data: groupRow, error: groupError } = await supabase
      .from("groups")
      .select("name")
      .eq("id", studentRow.group_id)
      .maybeSingle();

    if (groupError) {
      console.error("Error fetching group:", groupError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const groupName = groupRow?.name ?? "";

    const { data: relationRows, error: relationError } = await supabase
      .from("registration_form_groups")
      .select("form_id")
      .eq("group_id", studentRow.group_id);

    if (relationError) {
      console.error("Error fetching registration_form_groups:", relationError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const formIds = [...new Set((relationRows ?? []).map((row) => row.form_id).filter(Boolean))];

    if (formIds.length === 0) {
      return jsonResponse({ ok: true, forms: [] }, 200);
    }

    const { data: formsData, error: formsError } = await supabase
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
        prefill_name_entry,
        prefill_dni_entry,
        prefill_gender_entry,
        prefill_parent_email_entry,
        prefill_school_entry,
        prefill_birth_date_entry,
        prefill_group_entry
      `)
      .in("id", formIds)
      .eq("active", true)
      .eq("access_type", "restricted");

    if (formsError) {
      console.error("Error fetching registration_forms:", formsError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const now = Date.now();

    const forms: RestrictedForm[] = (formsData ?? [])
      .filter((form) => {
        if (!form) return false;
        if (form.active !== true) return false;
        if (form.access_type !== "restricted") return false;

        if (form.open_date) {
          const openTime = new Date(form.open_date).getTime();
          if (Number.isNaN(openTime)) return false;
        }

        if (form.close_date) {
          const closeTime = new Date(form.close_date).getTime();
          if (Number.isNaN(closeTime) || now > closeTime) return false;
        }

        return true;
      })
      .map((form) => ({
        id: form.id,
        title: form.title,
        description: form.description,
        url: buildPrefilledUrl(form.url, {
          [form.prefill_name_entry]: studentRow.name,
          [form.prefill_dni_entry]: studentRow.dni,
          [form.prefill_gender_entry]: studentRow.gender,
          [form.prefill_parent_email_entry]: studentRow.parent_email,
          [form.prefill_school_entry]: studentRow.school,
          [form.prefill_birth_date_entry]: formatBirthDate(studentRow.birth_date),
          [form.prefill_group_entry]: groupName,
        }),
        open_date: form.open_date,
        close_date: form.close_date,
      }))
      .sort((a, b) => {
        const aTime = a.open_date ? new Date(a.open_date).getTime() : 0;
        const bTime = b.open_date ? new Date(b.open_date).getTime() : 0;
        return bTime - aTime;
      });

    return jsonResponse({ ok: true, forms }, 200);
  } catch (error) {
    console.error("Unhandled error in get-registration-forms-by-public-id:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

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

function formatBirthDate(value: string | null) {
  if (!value) return "";
  return value;
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