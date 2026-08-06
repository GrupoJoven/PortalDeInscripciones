import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "dni_uploads";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 20;

// El servicio de OCR puede tardar bastante si está en un plan que duerme el
// contenedor: hay que sumar el arranque en frío a la lectura en sí.
const OCR_TIMEOUT_MS = 110_000;

/** Validez de los enlaces firmados que se pasan al servicio de OCR. */
const SIGNED_URL_TTL_SECONDS = 180;

type SessionRow = {
  id: string;
  status: string;
  minor_without_dni: boolean;
  front_path: string | null;
  back_path: string | null;
  expires_at: string;
  attempts: number;
};

/**
 * Campos que hay que haber leído para dar la verificación por válida.
 *
 * Si el menor no tiene DNI y se verifica el de un progenitor, el nombre leído
 * es el del adulto y no se usa, así que no se exige. El número y el domicilio
 * sí: el domicilio es justamente lo que permite comprobar la zona pastoral.
 */
function camposObligatorios(minorWithoutDni: boolean) {
  return minorWithoutDni
    ? (["numero", "domicilio_texto"] as const)
    : (["numero", "nombre", "domicilio_texto"] as const);
}

const ETIQUETAS_CAMPOS: Record<string, string> = {
  numero: "el número de DNI",
  nombre: "el nombre",
  domicilio_texto: "el domicilio",
};

function camposQueFaltan(
  extracted: Record<string, unknown>,
  minorWithoutDni: boolean,
): string[] {
  return camposObligatorios(minorWithoutDni).filter((campo) => {
    const valor = extracted[campo];
    return typeof valor !== "string" || valor.trim() === "";
  });
}

/**
 * Recibe una cara del documento desde el móvil, la guarda en el bucket
 * privado y, cuando ya están las dos, llama al servicio de OCR.
 *
 * Admite dos operaciones:
 *   { side, image_b64 }  -> sube una cara (y extrae si ya están las dos)
 *   { retry: true }      -> vuelve a intentar la lectura con las fotos ya
 *                           subidas, sin obligar a repetirlas
 *
 * Las imágenes se conservan hasta que el usuario confirma los datos, así que
 * puede repetir una sola cara sin rehacer las dos fotos.
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
    const ocrUrl = Deno.env.get("DNI_OCR_SERVICE_URL");
    const ocrSecret = Deno.env.get("DNI_OCR_SERVICE_SECRET");

    if (!supabaseUrl || !serviceRoleKey || !ocrUrl || !ocrSecret) {
      console.error(
        "Faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DNI_OCR_SERVICE_URL o DNI_OCR_SERVICE_SECRET",
      );
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => null);
    const mobileToken = typeof body?.mobile_token === "string" ? body.mobile_token.trim() : "";
    const esReintento = body?.retry === true;
    const side = body?.side === "front" || body?.side === "back" ? body.side : null;
    const imageB64 = typeof body?.image_b64 === "string" ? body.image_b64 : "";

    if (!mobileToken || (!esReintento && (!side || !imageB64))) {
      return jsonResponse({ ok: false, error: "missing_fields" }, 400);
    }

    const { data: session, error: sessionError } = await supabase
      .from("dni_verification_sessions")
      .select("id, status, minor_without_dni, front_path, back_path, expires_at, attempts")
      .eq("mobile_token_hash", await sha256(mobileToken))
      .maybeSingle<SessionRow>();

    if (sessionError) {
      console.error("Error cargando sesión:", sessionError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!session) {
      return jsonResponse({ ok: false, error: "invalid_session" }, 404);
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      return jsonResponse(
        {
          ok: false,
          error: "session_expired",
          message: "El código QR ha caducado. Vuelve a empezar desde el ordenador.",
        },
        410,
      );
    }

    if (session.status === "confirmed") {
      return jsonResponse(
        { ok: false, error: "already_confirmed", message: "Esta verificación ya está confirmada." },
        409,
      );
    }

    // --- Reintentar la lectura con las fotos ya subidas -------------------
    if (esReintento) {
      if (!session.front_path || !session.back_path) {
        return jsonResponse(
          {
            ok: false,
            error: "missing_images",
            message: "Faltan fotos por hacer.",
          },
          409,
        );
      }

      return await extraerYGuardar({
        supabase,
        sessionId: session.id,
        ocrUrl,
        ocrSecret,
        frontPath: session.front_path,
        backPath: session.back_path,
        minorWithoutDni: session.minor_without_dni,
      });
    }

    // --- Subida de una cara ----------------------------------------------
    if (session.attempts >= MAX_ATTEMPTS) {
      return jsonResponse(
        {
          ok: false,
          error: "too_many_attempts",
          message: "Se han hecho demasiados intentos. Vuelve a empezar desde el ordenador.",
        },
        429,
      );
    }

    let bytes: Uint8Array;

    try {
      bytes = decodeBase64Image(imageB64);
    } catch {
      return jsonResponse({ ok: false, error: "invalid_image" }, 400);
    }

    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return jsonResponse({ ok: false, error: "image_too_large" }, 413);
    }

    if (!looksLikeJpeg(bytes)) {
      return jsonResponse({ ok: false, error: "unsupported_image_format" }, 400);
    }

    const path = `${session.id}/${side}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: "image/jpeg", upsert: true });

    if (uploadError) {
      console.error("Error subiendo imagen:", uploadError);
      return jsonResponse({ ok: false, error: "upload_failed" }, 500);
    }

    const frontPath = side === "front" ? path : session.front_path;
    const backPath = side === "back" ? path : session.back_path;

    const bothPresent = Boolean(frontPath) && Boolean(backPath);

    const { error: updateError } = await supabase
      .from("dni_verification_sessions")
      .update({
        front_path: frontPath,
        back_path: backPath,
        status: bothPresent ? "processing" : "front_uploaded",
        attempts: session.attempts + 1,
        // Repetir una foto invalida la extracción anterior.
        extracted: null,
        extraction_error: null,
      })
      .eq("id", session.id);

    if (updateError) {
      console.error("Error actualizando sesión:", updateError);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    if (!bothPresent) {
      return jsonResponse({ ok: true, status: "front_uploaded" });
    }

    return await extraerYGuardar({
      supabase,
      sessionId: session.id,
      ocrUrl,
      ocrSecret,
      frontPath: frontPath!,
      backPath: backPath!,
      minorWithoutDni: session.minor_without_dni,
    });
  } catch (error) {
    console.error("Error no controlado en dni-verification-upload:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

/**
 * Llama al servicio de OCR y guarda el resultado.
 *
 * Distingue dos tipos de fallo, porque llevan a acciones muy distintas:
 *
 *   - `ocr_unavailable`: el servicio no responde, tarda demasiado o devuelve
 *     un error. Las fotos pueden estar perfectas: repetirlas no arregla nada,
 *     lo que procede es reintentar la lectura.
 *   - `unreadable`: el servicio ha respondido pero no ha reconocido ningún
 *     dato. Ahí sí hay que repetir las fotos.
 *
 * Confundir ambos casos dejaba al usuario repitiendo la foto del reverso en
 * bucle mientras el problema estaba en el servidor.
 */
async function extraerYGuardar({
  supabase,
  sessionId,
  ocrUrl,
  ocrSecret,
  frontPath,
  backPath,
  minorWithoutDni,
}: {
  supabase: ReturnType<typeof createClient>;
  sessionId: string;
  ocrUrl: string;
  ocrSecret: string;
  frontPath: string;
  backPath: string;
  minorWithoutDni: boolean;
}) {
  const frontUrl = await crearEnlaceFirmado(supabase, frontPath);
  const backUrl = await crearEnlaceFirmado(supabase, backPath);

  if (!frontUrl || !backUrl) {
    await marcarFallo(supabase, sessionId, "No se han podido preparar las fotos.");

    return jsonResponse(
      {
        ok: false,
        error: "images_unavailable",
        message: "No se han podido recuperar las fotos. Vuelve a hacerlas.",
      },
      500,
    );
  }

  let extracted: Record<string, unknown>;

  try {
    extracted = await callOcrService({ ocrUrl, ocrSecret, frontUrl, backUrl });
  } catch (error) {
    const esTimeout = error instanceof DOMException && error.name === "AbortError";

    console.error(
      esTimeout
        ? "El servicio de OCR ha agotado el tiempo de espera"
        : "Error llamando al servicio de OCR:",
      error,
    );

    // Deja constancia en los logs de si el servicio responde siquiera.
    console.error(`Diagnóstico: ${await diagnosticarServicio(ocrUrl)}`);

    // No se marca como 'failed': las fotos siguen guardadas y sirven.
    await supabase
      .from("dni_verification_sessions")
      .update({
        status: "processing",
        extraction_error: esTimeout ? "timeout" : "servicio_no_disponible",
      })
      .eq("id", sessionId);

    return jsonResponse(
      {
        ok: false,
        error: "ocr_unavailable",
        can_retry: true,
        message: esTimeout
          ? "El servicio de lectura ha tardado demasiado. Las fotos están guardadas: puedes reintentar la lectura sin repetirlas."
          : "El servicio de lectura no está disponible ahora mismo. Las fotos están guardadas: puedes reintentar la lectura sin repetirlas.",
      },
      503,
    );
  }

  // Antes bastaba con leer un campo cualquiera para dar la lectura por buena,
  // así que con solo el número se podía continuar y la verificación quedaba
  // en nada. Ahora tienen que estar todos los que la validación exige.
  const faltan = camposQueFaltan(extracted, minorWithoutDni);

  if (faltan.length > 0) {
    const listado = faltan.map((campo) => ETIQUETAS_CAMPOS[campo] ?? campo).join(" y ");

    await marcarFallo(supabase, sessionId, `No se ha podido leer ${listado}.`);

    return jsonResponse({
      ok: true,
      status: "failed",
      missing_fields: faltan,
      message:
        `No hemos podido leer ${listado} del documento. ` +
        "Repite las fotos con mejor luz, sin reflejos y con el documento bien encajado en el marco.",
    });
  }

  const { error: saveError } = await supabase
    .from("dni_verification_sessions")
    .update({ status: "extracted", extracted, extraction_error: null })
    .eq("id", sessionId);

  if (saveError) {
    console.error("Error guardando datos extraídos:", saveError);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }

  return jsonResponse({
    ok: true,
    status: "extracted",
    extracted: {
      nombre: extracted.nombre ?? null,
      numero: extracted.numero ?? null,
      domicilio_texto: extracted.domicilio_texto ?? null,
      numero_valido: extracted.numero_valido === true,
      avisos: Array.isArray(extracted.avisos) ? extracted.avisos : [],
    },
  });
}

/**
 * Llama al servicio de OCR pasándole enlaces firmados a las fotos.
 *
 * Antes se le mandaban las dos imágenes en base64 dentro del JSON: entre 2 y
 * 3 MB por petición que esta función tenía que decodificar, subir a Storage y
 * volver a codificar. Las Edge Functions tienen un límite de CPU muy ajustado
 * y eso bastaba para que la petición ni llegara a salir. Ahora solo viajan dos
 * URL cortas y es el servicio quien descarga las fotos.
 */
async function callOcrService({
  ocrUrl,
  ocrSecret,
  frontUrl,
  backUrl,
}: {
  ocrUrl: string;
  ocrSecret: string;
  frontUrl: string;
  backUrl: string;
}): Promise<Record<string, unknown>> {
  const endpoint = `${ocrUrl.replace(/\/$/, "")}/extract`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

  const inicio = Date.now();

  console.log(`Llamando al servicio de OCR: ${endpoint}`);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Secret": ocrSecret,
      },
      body: JSON.stringify({ front_url: frontUrl, back_url: backUrl }),
      signal: controller.signal,
    });

    console.log(`OCR respondió ${response.status} en ${Date.now() - inicio} ms`);

    if (!response.ok) {
      const detalle = await response.text().catch(() => "");
      throw new Error(`El servicio de OCR ha devuelto ${response.status}: ${detalle.slice(0, 200)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cuando la llamada al OCR falla, comprueba si el servicio responde siquiera.
 * Distingue "no llego al servicio" (URL mal, servicio caído) de "el servicio
 * está vivo pero se atasca procesando", que se arreglan de formas distintas.
 */
async function diagnosticarServicio(ocrUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${ocrUrl.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
    });

    const cuerpo = await response.text().catch(() => "");

    return `/health respondió ${response.status}: ${cuerpo.slice(0, 200)}`;
  } catch (error) {
    return `/health tampoco responde (${error instanceof Error ? error.message : error})`;
  } finally {
    clearTimeout(timeout);
  }
}

/** Enlace firmado y efímero para que el servicio de OCR descargue una foto. */
async function crearEnlaceFirmado(
  supabase: ReturnType<typeof createClient>,
  path: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("Error creando enlace firmado:", error);
    return null;
  }

  return data.signedUrl;
}

async function marcarFallo(
  supabase: ReturnType<typeof createClient>,
  sessionId: string,
  message: string,
) {
  await supabase
    .from("dni_verification_sessions")
    .update({ status: "failed", extraction_error: message })
    .eq("id", sessionId);
}

function decodeBase64Image(value: string): Uint8Array {
  const clean = value.includes(",") && value.trim().toLowerCase().startsWith("data:")
    ? value.slice(value.indexOf(",") + 1)
    : value;

  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/** Cabecera JFIF/EXIF: el móvil siempre envía JPEG. */
function looksLikeJpeg(bytes: Uint8Array) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
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
