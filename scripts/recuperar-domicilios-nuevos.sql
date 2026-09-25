-- Recuperación del domicilio y el código postal de las inscripciones del
-- formulario "NUEVOS: PRE/CONFIRMACIÓN".
--
-- Qué pasó: el portal prerrellenaba DOMICILIO y CÓDIGO POSTAL en una sección
-- del Google Form por la que nunca se pasaba (de la 6 se saltaba a la 8).
-- Google Forms descarta las respuestas de las secciones no visitadas, así que
-- esos dos campos llegaron vacíos en todas las inscripciones.
--
-- Por qué se puede recuperar: los datos leídos del DNI siguen guardados en
-- dni_verification_sessions.extracted. En teoría esas filas se borran 24 h
-- después de confirmar, pero la limpieza programada ('limpiar-fotos-dni')
-- lleva fallando con 401 (el secreto del cron no coincide con
-- DNI_CLEANUP_SECRET), así que no se ha borrado ninguna.
--
-- IMPORTANTE: no arregles la limpieza hasta haber exportado esto. En cuanto
-- funcione, borrará todas estas filas.
--
-- Ejecutar cada bloque por separado (seleccionarlo y Run) en:
--   https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/sql
-- y descargar el resultado con "Export > Download CSV".

-- ---------------------------------------------------------------------------
-- 1) Un domicilio por DNI, para cruzarlo con la hoja de respuestas.
-- ---------------------------------------------------------------------------
--
-- El DNI que llegó al formulario es exactamente el que se leyó aquí (se
-- prerrellenaba), así que basta con buscarlo en la hoja. Si una persona
-- verificó el DNI varias veces, se queda la última verificación confirmada.
--
-- En la hoja de respuestas: importa el CSV en una pestaña nueva
-- ("Domicilios") y en la columna de domicilio pon, por ejemplo:
--   =BUSCARX(<celda del DNI>; Domicilios!A:A; Domicilios!B:B; "NO ENCONTRADO")
-- y lo mismo con la columna C para el código postal.
--
-- Si menor_sin_dni = true, el DNI y el nombre son los del progenitor que hizo
-- la verificación (el domicilio es el de su documento).

with sesiones as (
  select distinct on (upper(trim(s.extracted->>'numero')))
    upper(trim(s.extracted->>'numero'))                   as dni,
    s.extracted->>'domicilio_texto'                       as domicilio,
    s.extracted->>'codigo_postal'                         as codigo_postal,
    (s.extracted->>'en_zona_parroquial')::boolean         as en_zona_parroquial,
    s.minor_without_dni                                   as menor_sin_dni,
    s.extracted->>'nombre'                                as nombre_leido_del_dni,
    s.confirmed_at
  from dni_verification_sessions s
  join registration_forms f on f.id = s.registration_form_id
  where f.title = 'NUEVOS: PRE/CONFIRMACIÓN'
    and s.status = 'confirmed'
    and coalesce(trim(s.extracted->>'numero'), '') <> ''
  order by upper(trim(s.extracted->>'numero')), s.confirmed_at desc
)
select
  dni,
  domicilio,
  codigo_postal,
  en_zona_parroquial,
  menor_sin_dni,
  nombre_leido_del_dni,
  to_char(confirmed_at at time zone 'Europe/Madrid', 'DD/MM/YYYY HH24:MI') as verificado_el
from sesiones
order by dni;

-- ---------------------------------------------------------------------------
-- 2) Inscripciones válidas cuyo DNI no aparece en ninguna verificación.
-- ---------------------------------------------------------------------------
--
-- Son las que saldrán como "NO ENCONTRADO" en la hoja (normalmente porque se
-- modificó el DNI a mano en el formulario). Hay que revisarlas una a una o
-- pedir el domicilio a la familia. marca_temporal coincide con la columna
-- "Marca temporal" de la hoja de respuestas.

with f as (
  select id, response_parent_email_question_id
  from registration_forms
  where title = 'NUEVOS: PRE/CONFIRMACIÓN'
),
dnis as (
  select distinct upper(regexp_replace(s.extracted->>'numero', '[^A-Za-z0-9]', '', 'g')) as dni
  from dni_verification_sessions s
  join f on f.id = s.registration_form_id
  where s.status = 'confirmed'
    and coalesce(s.extracted->>'numero', '') <> ''
)
select
  to_char(r.submitted_at at time zone 'Europe/Madrid', 'DD/MM/YYYY HH24:MI:SS') as marca_temporal,
  r.raw_response->'answers'->(f.response_parent_email_question_id)
    ->'textAnswers'->'answers'->0->>'value'                                   as email_contacto,
  r.response_id
from google_form_processed_responses r
join f on f.id = r.registration_form_id
where r.processing_status = 'validated_ok'
  and not exists (
    select 1
    from dnis d
    where length(d.dni) >= 8
      and position(d.dni in upper(regexp_replace(r.raw_response->>'answers', '[^A-Za-z0-9]', '', 'g'))) > 0
  )
order by r.submitted_at;
