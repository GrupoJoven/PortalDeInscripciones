// Guarda lo que se prerrellena del DNI (domicilio y código postal) en el
// enlace al formulario de Google, para que google-forms-process-responses
// pueda compararlo después con lo que la familia envía de verdad.
//
// Lo usan las dos funciones que construyen ese enlace:
// start-public-form-email-access y verify-public-form-email-token.

type SnapshotForm = {
  id: string;
  prefill_address_entry: string | null;
  prefill_postal_code_entry: string | null;
};

type SnapshotSession = {
  id: string;
  minor_without_dni: boolean;
  extracted: Record<string, unknown> | null;
};

// Basta con lo que usan las dos funciones de su cliente de Supabase.
type SupabaseLike = {
  from: (table: string) => any;
};

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * Nunca lanza: un fallo aquí no debe impedir que la familia llegue al
 * formulario. Lo peor que pasa es que esa respuesta quede como "no_snapshot".
 */
export async function guardarPrefillDni(
  supabase: SupabaseLike,
  form: SnapshotForm,
  session: SnapshotSession | null,
  normalizedEmail: string,
): Promise<void> {
  const extracted = session?.extracted;
  if (!session || !extracted) return;

  // Los mismos valores, con las mismas condiciones, que buildPublicFormAccessUrl.
  const domicilio = texto(extracted.domicilio_texto);
  const codigoPostal = texto(extracted.codigo_postal);
  const address = form.prefill_address_entry && domicilio ? domicilio : null;
  const postalCode = form.prefill_postal_code_entry && codigoPostal ? codigoPostal : null;

  // Si no se prerrellena ninguno de los dos, no hay nada que comparar.
  if (!address && !postalCode) return;

  try {
    const { error } = await supabase
      .from("dni_prefill_snapshots")
      .upsert(
        {
          registration_form_id: form.id,
          dni_verification_session_id: session.id,
          normalized_email: normalizedEmail,
          dni: texto(extracted.numero) || null,
          address,
          postal_code: postalCode,
          minor_without_dni: session.minor_without_dni,
        },
        {
          // Volver a abrir el mismo enlace no crea filas nuevas.
          onConflict: "dni_verification_session_id,normalized_email",
          ignoreDuplicates: true,
        },
      );

    if (error) {
      console.error("Error guardando el prerrelleno del DNI:", error);
    }
  } catch (error) {
    console.error("Error guardando el prerrelleno del DNI:", error);
  }
}
