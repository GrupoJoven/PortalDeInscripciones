-- Diagnóstico del borrado automático de respuestas de Google Forms.
--
-- Cómo funciona el borrado (para saber qué mirar):
--
--   1) google-forms-process-responses valida cada respuesta. Si no pasa la
--      validación, envía el correo de incidencia y marca la fila en
--      google_form_processed_responses con deletion_status = 'pending_delete'.
--      HASTA AQUÍ NO SE BORRA NADA: solo se apunta en una cola.
--
--   2) El borrado real lo hace un Apps Script de Google (fuera de este repo,
--      en script.google.com) que, con un activador por tiempo, llama a la
--      función google-forms-delete-queue:
--        - action = 'claim'  -> se lleva las filas en 'pending_delete';
--        - borra cada respuesta del formulario con FormApp (deleteResponse);
--        - action = 'report' -> marca la fila como 'deleted' o 'delete_error'.
--
--   Si el Apps Script no corre (activador borrado/caducado, autorización
--   revocada, secreto cambiado, etc.), los correos se envían igual pero las
--   respuestas se quedan en Google Forms. Estas consultas lo confirman.
--
-- Ejecutar en el SQL Editor del dashboard de Supabase:
--   https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/sql

-- ---------------------------------------------------------------------------
-- 1) Resumen: cuántas respuestas hay en cada combinación de estado.
-- ---------------------------------------------------------------------------
--
--   deletion_status = 'pending_delete' -> pedido pero nadie lo ha recogido.
--   deletion_status = 'delete_error'   -> el Apps Script lo intentó y falló.
--   deletion_status = 'deleted'        -> el Apps Script dice que lo borró.

select
  processing_status,
  deletion_status,
  count(*)                        as total,
  min(deletion_requested_at)      as primera_peticion,
  max(deletion_requested_at)      as ultima_peticion,
  max(deletion_attempted_at)      as ultimo_intento
from google_form_processed_responses
group by processing_status, deletion_status
order by processing_status, deletion_status;

-- ---------------------------------------------------------------------------
-- 2) Detalle de todas las respuestas para las que se pidió el borrado.
-- ---------------------------------------------------------------------------
--
-- Qué buscar:
--   - 'pending_delete' con deletion_attempted_at NULL y deletion_requested_at
--     de hace horas o días -> el Apps Script NO está llamando a la cola.
--   - 'delete_error' -> leer deletion_error (permisos sobre el formulario,
--     id de respuesta no válido, etc.).
--   - 'deleted' -> comprobar a mano en Google Forms (pestaña Respuestas) que
--     esa respuesta ya no aparece. Usa respondent_email y submitted_at para
--     localizarla. Si sigue ahí, el script informa de éxito sin borrar.

select
  f.title                                   as formulario,
  r.google_form_id,
  r.response_id,
  r.submitted_at,
  r.raw_response->>'respondentEmail'        as respondent_email,
  r.processing_status,
  r.deletion_status,
  r.deletion_requested_at,
  r.deletion_attempted_at,
  r.deleted_at,
  r.deletion_error,
  now() - r.deletion_requested_at           as tiempo_en_cola
from google_form_processed_responses r
left join registration_forms f on f.id = r.registration_form_id
where r.deletion_status is distinct from 'not_requested'
order by r.deletion_requested_at desc nulls last
limit 100;

-- ---------------------------------------------------------------------------
-- 3) Lo que devolvería ahora mismo el 'claim' del Apps Script.
-- ---------------------------------------------------------------------------
--
-- Es exactamente el filtro de google-forms-delete-queue (action = 'claim').
-- Si aquí salen filas antiguas, el script no las está recogiendo.

select
  r.id,
  r.google_form_id,
  r.response_id,
  r.deletion_requested_at,
  now() - r.deletion_requested_at as tiempo_en_cola
from google_form_processed_responses r
where r.processing_status in (
    'email_sent_public_unverified',
    'email_sent_restricted_unknown_id',
    'email_sent_restricted_data_mismatch'
  )
  and r.deletion_status = 'pending_delete'
order by r.deletion_requested_at asc;
