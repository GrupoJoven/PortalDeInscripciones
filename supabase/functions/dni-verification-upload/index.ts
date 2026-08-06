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

type SessionRow = {
  id: string;
  status: string;
  front_path: string | null;
  back_path: string | null;
  expires_at: string;
  attempts: number;
};

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
      .select("id, status, front_path, back_path, expires_at, attempts")
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

      const frontBytes = await downloadImage(supabase, session.front_path);
      const backBytes = await downloadImage(supabase, session.back_path);

      if (!frontBytes || !backBytes) {
        return jsonResponse(
          {
            ok: false,
            error: "images_unavailable",
            message: "No se han podido recuperar las fotos. Vuelve a hacerlas.",
          },
          410,
        );
      }

      return await extraerYGuardar({
        supabase,
        sessionId: session.id,
        ocrUrl,
        ocrSecret,
        frontBytes,
        backBytes,
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

    const frontBytes = side === "front" ? bytes : await downloadImage(supabase, frontPath!);
    const backBytes = side === "back" ? bytes : await downloadImage(supabase, backPath!);

    if (!frontBytes || !backBytes) {
      await marcarFallo(supabase, session.id, "No se han podido recuperar las dos fotos.");
      return jsonResponse(
        {
          ok: false,
          error: "images_unavailable",
          message: "No se han podido recuperar las dos fotos. Vuelve a hacerlas.",
        },
        500,
      );
    }

    return await extraerYGuardar({
      supabase,
      sessionId: session.id,
      ocrUrl,
      ocrSecret,
      frontBytes,
      backBytes,
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
  frontBytes,
  backBytes,
}: {
  supabase: ReturnType<typeof createClient>;
  sessionId: string;
  ocrUrl: string;
  ocrSecret: string;
  frontBytes: Uint8Array;
  backBytes: Uint8Array;
}) {
  let extracted: Record<string, unknown>;

  try {
    extracted = await callOcrService({
      ocrUrl,
      ocrSecret,
      frontB64: encodeBase64(frontBytes),
      backB64: encodeBase64(backBytes),
    });
  } catch (error) {
    const esTimeout = error instanceof DOMException && error.name === "AbortError";

    console.error(
      esTimeout
        ? "El servicio de OCR ha agotado el tiempo de espera"
        : "Error llamando al servicio de OCR:",
      error,
    );

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

  const hasAnyField = Boolean(extracted.numero || extracted.nombre || extracted.domicilio_texto);

  if (!hasAnyField) {
    await marcarFallo(supabase, sessionId, "No se ha reconocido ningún dato en las fotos.");

    return jsonResponse({
      ok: true,
      status: "failed",
      message:
        "No hemos podido leer los datos del documento. Repite las fotos con mejor luz y sin reflejos.",
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

async function callOcrService({
  ocrUrl,
  ocrSecret,
  frontB64,
  backB64,
}: {
  ocrUrl: string;
  ocrSecret: string;
  frontB64: string;
  backB64: string;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

  const inicio = Date.now();

  try {
    const response = await fetch(`${ocrUrl.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Secret": ocrSecret,
      },
      body: JSON.stringify({ front_b64: frontB64, back_b64: backB64 }),
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

async function downloadImage(
  supabase: ReturnType<typeof createClient>,
  path: string,
): Promise<Uint8Array | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);

  if (error || !data) {
    console.error("Error descargando imagen:", error);
    return null;
  }

  return new Uint8Array(await data.arrayBuffer());
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

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
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
