import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cleanup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "dni_uploads";

/** El bucket admite borrar varias rutas de una sola llamada; se trocea por
 * si acumulase muchísimas rutas huérfanas desde la última pasada. */
const TAMANO_LOTE = 500;

type FilaHuerfana = { orphan_path: string | null };

/**
 * Borra las sesiones de verificación de DNI caducadas y, con ellas, las
 * fotos que hubieran quedado huérfanas en el bucket.
 *
 * `dni-verification-confirm` solo borra las fotos cuando el usuario confirma
 * los datos leídos. Una sesión que nunca llega a confirmarse -abandonada,
 * fallida, o simplemente una prueba- no tenía ningún otro sitio donde
 * borrarse: las fotos se quedaban en el bucket para siempre, pese al mensaje
 * de "las fotos se han borrado" que solo era cierto para el camino feliz.
 *
 * La función SQL `cleanup_dni_verification_sessions()` ya existe desde que
 * se creó la tabla de sesiones -estaba pensada exactamente para esto-, pero
 * nada la invocaba nunca. Esta función solo la llama y borra del bucket las
 * rutas que devuelve.
 *
 * Pensada para invocarse periódicamente (cron), no desde el navegador: ver
 * el README de este directorio para cómo se programa.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  // Solo se exige el secreto si está configurado, para no dejar el servicio
  // roto en despliegues donde todavía no se haya definido la variable.
  const secretoEsperado = Deno.env.get("DNI_CLEANUP_SECRET");
  const secretoRecibido = req.headers.get("x-cleanup-secret");

  if (secretoEsperado && secretoRecibido !== secretoEsperado) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse({ ok: false, error: "server_configuration_error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data, error } = await supabase.rpc("cleanup_dni_verification_sessions");

    if (error) {
      console.error("Error limpiando sesiones de DNI caducadas:", error);
      return jsonResponse({ ok: false, error: "internal_error" }, 500);
    }

    const rutas = ((data ?? []) as FilaHuerfana[])
      .map((fila) => fila.orphan_path)
      .filter((path): path is string => Boolean(path));

    if (rutas.length === 0) {
      console.log("Limpieza de DNI: ninguna foto huérfana pendiente de borrar.");
      return jsonResponse({ ok: true, fotos_encontradas: 0, fotos_borradas: 0 });
    }

    let borradas = 0;

    for (let inicio = 0; inicio < rutas.length; inicio += TAMANO_LOTE) {
      const lote = rutas.slice(inicio, inicio + TAMANO_LOTE);
      const { error: removeError } = await supabase.storage.from(BUCKET).remove(lote);

      if (removeError) {
        // No se aborta: el resto de lotes puede seguir borrándose, y lo que
        // quede pendiente se recogerá en la siguiente pasada (las filas ya
        // se han borrado de la base de datos, así que sus rutas no volverán
        // a aparecer aquí; quedarían huérfanas en el bucket hasta que se
        // detecten y limpien a mano).
        console.error(`Error borrando un lote de ${lote.length} fotos:`, removeError);
        continue;
      }

      borradas += lote.length;
    }

    console.log(
      `Limpieza de DNI: ${rutas.length} fotos huérfanas encontradas, ${borradas} borradas.`,
    );

    return jsonResponse({
      ok: true,
      fotos_encontradas: rutas.length,
      fotos_borradas: borradas,
    });
  } catch (error) {
    console.error("Error no controlado en dni-verification-cleanup:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
