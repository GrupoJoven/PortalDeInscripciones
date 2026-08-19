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
  prefill_gender_entry: string | null;
  prefill_birth_date_entry: string | null;
  prefill_course_entry: string | null;
  prefill_preconfirmation_first_course_option: string | null;
  prefill_preconfirmation_second_course_option: string | null;
  prefill_confirmation_first_course_option: string | null;
  prefill_confirmation_second_course_option: string | null;
  prefill_underage: string | null;
  prefill_underage_reference_date: string | null;
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
      prefill_postal_code_entry,
      prefill_gender_entry,
      prefill_birth_date_entry,
      prefill_course_entry,
      prefill_preconfirmation_first_course_option,
      prefill_preconfirmation_second_course_option,
      prefill_confirmation_first_course_option,
      prefill_confirmation_second_course_option,
      prefill_underage,
      prefill_underage_reference_date
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

      // Si el DNI verificado es el de un progenitor, el nombre, el sexo y la
      // fecha de nacimiento leídos son los del adulto, no los del menor: no
      // deben prerrellenarse (ni tampoco el curso, que se deriva de la
      // fecha de nacimiento).
      const esDniDelMenor = !dniSession?.minor_without_dni;

      if (form.prefill_name_entry && nombre && esDniDelMenor) {
        url.searchParams.set(form.prefill_name_entry, nombre);
      }

      if (esDniDelMenor) {
        const sexo = typeof extracted.sexo === "string" ? extracted.sexo.trim() : "";
        const fechaNacimiento = typeof extracted.fecha_nacimiento === "string"
          ? extracted.fecha_nacimiento.trim()
          : "";

        const sexoGoogleForm = mapearSexoAGoogleForm(sexo);
        if (form.prefill_gender_entry && sexoGoogleForm) {
          url.searchParams.set(form.prefill_gender_entry, sexoGoogleForm);
        }

        if (form.prefill_birth_date_entry && fechaNacimiento) {
          aplicarFechaNacimiento(url, form.prefill_birth_date_entry, fechaNacimiento);
        }

        if (form.prefill_course_entry && fechaNacimiento) {
          const curso = calcularCurso(fechaNacimiento, new Date());
          const plantilla = curso ? obtenerPlantillaDeCurso(form, curso) : null;

          if (plantilla) {
            // El año de nacimiento ya es, por construcción, el que
            // corresponde a este curso concreto (es justo lo que
            // `calcularCurso` acaba de comprobar), así que no hace falta
            // recalcularlo aparte: se toma directamente de la fecha leída.
            const anioNacimiento = fechaNacimiento.slice(0, 4);
            url.searchParams.set(
              form.prefill_course_entry,
              plantilla.replaceAll("{ANIO}", anioNacimiento),
            );
          }
        }

        if (form.prefill_underage && form.prefill_underage_reference_date && fechaNacimiento) {
          const esMenor = esMenorDeEdad(fechaNacimiento, form.prefill_underage_reference_date);
          if (esMenor !== null) {
            url.searchParams.set(form.prefill_underage, esMenor ? "Sí" : "No");
          }
        }
      }
    }

    return url.toString();
  } catch {
    return form.url;
  }
}

/** El DNI trae "M"/"F"/"X" (MRZ); el formulario solo tiene MASCULINO/FEMENINO. */
function mapearSexoAGoogleForm(sexo: string): string | null {
  if (sexo === "M") return "MASCULINO";
  if (sexo === "F") return "FEMENINO";
  return null;
}

/**
 * Las preguntas de tipo "Fecha" nativas de Google Forms no se prerrellenan
 * con un único `entry.N=YYYY-MM-DD`: usan tres parámetros con el mismo
 * identificador base y sufijos `_year`/`_month`/`_day`.
 */
function aplicarFechaNacimiento(url: URL, entryBase: string, fechaIso: string) {
  const partes = fechaIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!partes) return;

  const [, anio, mes, dia] = partes;
  url.searchParams.set(`${entryBase}_year`, String(Number(anio)));
  url.searchParams.set(`${entryBase}_month`, String(Number(mes)));
  url.searchParams.set(`${entryBase}_day`, String(Number(dia)));
}

type Curso =
  | "preconfirmacion_primero"
  | "preconfirmacion_segundo"
  | "confirmacion_primero"
  | "confirmacion_segundo";

function obtenerPlantillaDeCurso(form: PublicFormRow, curso: Curso): string | null {
  switch (curso) {
    case "preconfirmacion_primero":
      return form.prefill_preconfirmation_first_course_option;
    case "preconfirmacion_segundo":
      return form.prefill_preconfirmation_second_course_option;
    case "confirmacion_primero":
      return form.prefill_confirmation_first_course_option;
    case "confirmacion_segundo":
      return form.prefill_confirmation_second_course_option;
  }
}

/**
 * Curso al que entra, a partir de los años que cumple dentro de ESTE curso
 * escolar y de la fecha de nacimiento.
 *
 * El curso escolar empieza en septiembre: de julio a diciembre ya
 * pertenece al curso que arranca este mismo año natural; de enero a junio,
 * todavía pertenece al que arrancó el año natural anterior. Sin este
 * ajuste, un mismo alumno cambiaría de curso el 1 de enero a mitad de año
 * escolar en vez de en septiembre.
 *
 * Con eso, cada año de diferencia corresponde a un curso concreto y ya no
 * hace falta distinguir "primer semestre"/"segundo semestre" aparte: 13 años
 * -> preconfirmación 1º, 14 -> preconfirmación 2º, 15 -> confirmación 1º,
 * 16 -> confirmación 2º. Fuera de ese rango no se marca nada: mejor dejar
 * la pregunta sin responder que adivinar un curso que no corresponde a
 * nadie de esa edad.
 */
function calcularCurso(fechaNacimientoIso: string, ahora: Date): Curso | null {
  const partes = fechaNacimientoIso.match(/^(\d{4})-\d{2}-\d{2}$/);
  if (!partes) return null;

  const anioNacimiento = Number(partes[1]);
  const anioActual = ahora.getFullYear();
  const mesActual = ahora.getMonth() + 1; // 1-12
  const anioInicioCurso = mesActual >= 7 ? anioActual : anioActual - 1;
  const aniosSegunInicioCurso = anioInicioCurso - anioNacimiento;

  switch (aniosSegunInicioCurso) {
    case 13:
      return "preconfirmacion_primero";
    case 14:
      return "preconfirmacion_segundo";
    case 15:
      return "confirmacion_primero";
    case 16:
      return "confirmacion_segundo";
    default:
      return null;
  }
}

/**
 * Es menor de edad si, en la fecha de referencia (el primer día del fin de
 * semana del evento), todavía no ha cumplido 18 años.
 */
function esMenorDeEdad(fechaNacimientoIso: string, fechaReferenciaIso: string): boolean | null {
  const nacimiento = fechaNacimientoIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const referencia = fechaReferenciaIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!nacimiento || !referencia) return null;

  const [anioNac, mesNac, diaNac] = nacimiento.slice(1).map(Number);
  const [anioRef, mesRef, diaRef] = referencia.slice(1).map(Number);

  const yaCumplioDieciocho =
    anioRef - anioNac > 18 ||
    (anioRef - anioNac === 18 && (mesRef > mesNac || (mesRef === mesNac && diaRef >= diaNac)));

  return !yaCumplioDieciocho;
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