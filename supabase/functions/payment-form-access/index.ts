import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  MAX_PARTICIPANTS_PER_ACTIVITY,
  PAYMENT_ACTIVITIES,
  gridColumnForCount,
  isPaymentActivityKey,
  joinParticipantNames,
  stageFromGroupName,
} from "../_shared/paymentActivities.ts";
import type {
  CatechesisStage,
  PaymentActivity,
  PaymentActivityKey,
} from "../_shared/paymentActivities.ts";

// Acceso a los formularios de pago. Dos acciones:
//
//   - validate_ids: transforma identificadores personales en el nombre del
//     alumno asociado (el botón "Validar identificadores" del portal).
//     Solo se aceptan alumnos de un grupo de la etapa de la actividad
//     (preconfirmación o confirmación, según el nombre del grupo).
//   - build_url: recibe los participantes de cada actividad, vuelve a
//     validar los identificadores y devuelve el enlace prerrellenado al
//     formulario de Google (nombres en un único párrafo por actividad y la
//     cuadrícula con el número de participantes, 0 en el resto).
//
// En los formularios de acceso limitado, ambas acciones exigen el
// identificador con el que la familia ha entrado en el portal, y se
// comprueba igual que en get-registration-forms-by-public-id: que exista,
// que su grupo tenga asignado el formulario y que el email esté verificado.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_NAME_LENGTH = 120;
const MAX_PUBLIC_ID_LENGTH = 40;

type ResolvedStudent = {
  name: string;
  stage: CatechesisStage | null;
};

type PaymentFormRow = {
  id: string;
  url: string;
  active: boolean;
  access_type: string;
  open_date: string | null;
  close_date: string | null;
  form_type: string;
  payment_activities: string[] | null;
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
    const action = body?.action;
    const formId = typeof body?.form_id === "string" ? body.form_id.trim() : "";
    const accessPublicId = normalizePublicId(body?.access_public_id);

    if (!formId || (action !== "validate_ids" && action !== "build_url")) {
      return jsonResponse({ ok: false, error: "missing_fields" }, 400);
    }

    const { data: formRow, error: formError } = await supabase
      .from("registration_forms")
      .select("id, url, active, access_type, open_date, close_date, form_type, payment_activities")
      .eq("id", formId)
      .maybeSingle<PaymentFormRow>();

    if (formError) {
      console.error("Error fetching registration_forms:", formError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!formRow || !isAccessiblePaymentForm(formRow)) {
      return jsonResponse(
        {
          ok: false,
          error: "form_not_available",
          message: "El formulario no está disponible.",
        },
        404
      );
    }

    if (formRow.access_type === "restricted") {
      const hasAccess = await hasRestrictedAccess(supabase, formRow.id, accessPublicId);

      if (!hasAccess) {
        return jsonResponse(
          {
            ok: false,
            error: "access_denied",
            message:
              "No tienes acceso a este formulario. Vuelve a introducir tu identificador en la portada.",
          },
          403
        );
      }
    }

    if (action === "validate_ids") {
      return await handleValidateIds(supabase, formRow, body?.activity, body?.public_ids);
    }

    return await handleBuildUrl(supabase, formRow, body?.participants);
  } catch (error) {
    console.error("Unhandled error in payment-form-access:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

async function handleValidateIds(
  supabase: SupabaseClient,
  form: PaymentFormRow,
  rawActivity: unknown,
  rawIds: unknown
) {
  if (!Array.isArray(rawIds) || !isPaymentActivityKey(rawActivity)) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const activity = PAYMENT_ACTIVITIES.find((item) => item.key === rawActivity)!;

  if (
    activity.participantInput !== "public_id" ||
    !(form.payment_activities ?? []).includes(activity.key)
  ) {
    return jsonResponse({ ok: false, error: "activity_not_enabled" }, 400);
  }

  const publicIds = [...new Set(rawIds.map(normalizePublicId).filter(Boolean))];

  if (publicIds.length === 0 || publicIds.length > MAX_PARTICIPANTS_PER_ACTIVITY) {
    return jsonResponse({ ok: false, error: "invalid_public_ids" }, 400);
  }

  const studentsById = await resolvePublicIds(supabase, publicIds);
  const found = publicIds.filter((publicId) => studentsById.has(publicId));

  return jsonResponse({
    ok: true,
    participants: found
      .filter((publicId) => belongsToActivityStage(activity, studentsById.get(publicId)!))
      .map((publicId) => ({ public_id: publicId, name: studentsById.get(publicId)!.name })),
    not_found: publicIds.filter((publicId) => !studentsById.has(publicId)),
    wrong_group: found.filter(
      (publicId) => !belongsToActivityStage(activity, studentsById.get(publicId)!)
    ),
  });
}

async function handleBuildUrl(
  supabase: SupabaseClient,
  form: PaymentFormRow,
  rawParticipants: unknown
) {
  if (!rawParticipants || typeof rawParticipants !== "object" || Array.isArray(rawParticipants)) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const enabledKeys = new Set((form.payment_activities ?? []).filter(isPaymentActivityKey));
  const valuesByActivity = new Map<PaymentActivityKey, string[]>();

  for (const [key, rawValues] of Object.entries(rawParticipants as Record<string, unknown>)) {
    if (!isPaymentActivityKey(key) || !Array.isArray(rawValues)) {
      return jsonResponse({ ok: false, error: "invalid_participants" }, 400);
    }

    if (rawValues.length === 0) continue;

    // Una actividad que no se paga con este formulario no puede traer
    // participantes: se marcaría en la cuadrícula algo que no se ofrece.
    if (!enabledKeys.has(key)) {
      return jsonResponse({ ok: false, error: "activity_not_enabled" }, 400);
    }

    const values = rawValues.map((value) => (typeof value === "string" ? value.trim() : ""));

    if (values.some((value) => !value) || values.length > MAX_PARTICIPANTS_PER_ACTIVITY) {
      return jsonResponse({ ok: false, error: "invalid_participants" }, 400);
    }

    valuesByActivity.set(key, values);
  }

  if (valuesByActivity.size === 0) {
    return jsonResponse(
      {
        ok: false,
        error: "no_participants",
        message: "Añade al menos un participante antes de continuar.",
      },
      400
    );
  }

  // Todos los identificadores de todas las actividades se resuelven de una
  // vez; si falta alguno, no se da acceso al formulario.
  const publicIdsToResolve = new Set<string>();

  for (const activity of PAYMENT_ACTIVITIES) {
    if (activity.participantInput !== "public_id") continue;

    const publicIds = (valuesByActivity.get(activity.key) ?? []).map(normalizePublicId);

    if (publicIds.some((publicId) => !publicId)) {
      return jsonResponse({ ok: false, error: "invalid_participants" }, 400);
    }

    if (new Set(publicIds).size !== publicIds.length) {
      return jsonResponse(
        {
          ok: false,
          error: "duplicate_public_ids",
          message: `Hay identificadores repetidos en ${activity.label}.`,
        },
        400
      );
    }

    valuesByActivity.set(activity.key, publicIds);
    publicIds.forEach((publicId) => publicIdsToResolve.add(publicId));
  }

  const studentsById = publicIdsToResolve.size > 0
    ? await resolvePublicIds(supabase, [...publicIdsToResolve])
    : new Map<string, ResolvedStudent>();

  const notFound = [...publicIdsToResolve].filter((publicId) => !studentsById.has(publicId));

  if (notFound.length > 0) {
    return jsonResponse(
      {
        ok: false,
        error: "public_ids_not_found",
        not_found: notFound,
        message: `No se han encontrado estos identificadores: ${notFound.join(", ")}.`,
      },
      400
    );
  }

  // Cada identificador tiene que ser de un grupo de la etapa de su actividad.
  const wrongGroup: { activity: PaymentActivityKey; public_id: string }[] = [];

  for (const activity of PAYMENT_ACTIVITIES) {
    if (activity.participantInput !== "public_id") continue;

    for (const publicId of valuesByActivity.get(activity.key) ?? []) {
      if (!belongsToActivityStage(activity, studentsById.get(publicId)!)) {
        wrongGroup.push({ activity: activity.key, public_id: publicId });
      }
    }
  }

  if (wrongGroup.length > 0) {
    return jsonResponse(
      {
        ok: false,
        error: "public_ids_wrong_group",
        wrong_group: wrongGroup,
        message: `Estos identificadores no pertenecen a un grupo de la actividad en la que se han puesto: ${
          wrongGroup.map((item) => item.public_id).join(", ")
        }.`,
      },
      400
    );
  }

  let url: URL;

  try {
    url = new URL(form.url);
  } catch {
    console.error("Invalid payment form url:", form.id);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }

  for (const activity of PAYMENT_ACTIVITIES) {
    const values = enabledKeys.has(activity.key) ? valuesByActivity.get(activity.key) ?? [] : [];

    const names = activity.participantInput === "public_id"
      ? values.map((publicId) => studentsById.get(publicId)!.name)
      : values.map((name) => name.slice(0, MAX_NAME_LENGTH));

    if (names.length > 0) {
      url.searchParams.set(activity.namesEntry, joinParticipantNames(names));
    }

    // La cuadrícula exige respuesta en todas las filas: las actividades que
    // no se pagan con este formulario, o sin participantes, van a 0.
    url.searchParams.set(activity.gridRowEntry, gridColumnForCount(names.length));
  }

  return jsonResponse({ ok: true, access_url: url.toString() });
}

/**
 * Devuelve, solo para los identificadores que existen, el nombre del alumno y
 * la etapa de su grupo (null si el grupo no es de preconfirmación ni de
 * confirmación, o si no tiene grupo).
 */
async function resolvePublicIds(supabase: SupabaseClient, publicIds: string[]) {
  const studentsById = new Map<string, ResolvedStudent>();

  const { data: accessRows, error: accessError } = await supabase
    .from("student_public_access")
    .select("public_id, student_id")
    .in("public_id", publicIds);

  if (accessError) {
    console.error("Error fetching student_public_access:", accessError);
    throw accessError;
  }

  const studentIds = [...new Set((accessRows ?? []).map((row) => row.student_id).filter(Boolean))];

  if (studentIds.length === 0) {
    return studentsById;
  }

  const { data: studentRows, error: studentsError } = await supabase
    .from("students")
    .select("id, name, group_id")
    .in("id", studentIds);

  if (studentsError) {
    console.error("Error fetching students:", studentsError);
    throw studentsError;
  }

  const groupIds = [...new Set((studentRows ?? []).map((row) => row.group_id).filter(Boolean))];
  const groupNamesById = new Map<string, string>();

  if (groupIds.length > 0) {
    const { data: groupRows, error: groupsError } = await supabase
      .from("groups")
      .select("id, name")
      .in("id", groupIds);

    if (groupsError) {
      console.error("Error fetching groups:", groupsError);
      throw groupsError;
    }

    for (const row of groupRows ?? []) {
      groupNamesById.set(String(row.id), String(row.name ?? ""));
    }
  }

  const studentsByStudentId = new Map<string, ResolvedStudent>();

  for (const row of studentRows ?? []) {
    const name = String(row.name ?? "").trim();
    if (!name) continue;

    studentsByStudentId.set(String(row.id), {
      name,
      stage: stageFromGroupName(row.group_id ? groupNamesById.get(String(row.group_id)) : null),
    });
  }

  for (const row of accessRows ?? []) {
    const student = studentsByStudentId.get(String(row.student_id));
    if (student) {
      studentsById.set(String(row.public_id).toUpperCase(), student);
    }
  }

  return studentsById;
}

function belongsToActivityStage(activity: PaymentActivity, student: ResolvedStudent) {
  return !activity.requiredStage || student.stage === activity.requiredStage;
}

/**
 * Mismo criterio que get-registration-forms-by-public-id: el identificador
 * existe, su grupo tiene asignado este formulario y el email de contacto
 * está verificado.
 */
async function hasRestrictedAccess(
  supabase: SupabaseClient,
  formId: string,
  publicId: string
) {
  if (!publicId) return false;

  const { data: accessRow, error: accessError } = await supabase
    .from("student_public_access")
    .select("student_id")
    .eq("public_id", publicId)
    .maybeSingle();

  if (accessError) {
    console.error("Error fetching student_public_access:", accessError);
    throw accessError;
  }

  if (!accessRow?.student_id) return false;

  const { data: studentRow, error: studentError } = await supabase
    .from("students")
    .select("group_id, parent_email")
    .eq("id", accessRow.student_id)
    .maybeSingle();

  if (studentError) {
    console.error("Error fetching student:", studentError);
    throw studentError;
  }

  if (!studentRow?.group_id) return false;

  const { data: relationRow, error: relationError } = await supabase
    .from("registration_form_groups")
    .select("form_id")
    .eq("form_id", formId)
    .eq("group_id", studentRow.group_id)
    .maybeSingle();

  if (relationError) {
    console.error("Error fetching registration_form_groups:", relationError);
    throw relationError;
  }

  if (!relationRow) return false;

  const normalizedEmail = String(studentRow.parent_email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return false;

  const { data: verifiedRow, error: verifiedError } = await supabase
    .from("parent_email_verifications")
    .select("id")
    .eq("normalized_email", normalizedEmail)
    .maybeSingle();

  if (verifiedError) {
    console.error("Error fetching parent_email_verifications:", verifiedError);
    throw verifiedError;
  }

  return !!verifiedRow;
}

function isAccessiblePaymentForm(form: PaymentFormRow) {
  if (!form.active) return false;
  if (form.form_type !== "payment") return false;
  if (form.access_type !== "public" && form.access_type !== "restricted") return false;

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

function normalizePublicId(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toUpperCase();
  return normalized.length <= MAX_PUBLIC_ID_LENGTH ? normalized : "";
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
