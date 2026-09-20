-- Renovación automática de los watches de Google Forms.
--
-- Los watches (avisos de Google por Pub/Sub cuando llega una respuesta)
-- caducan a los 7 días. Hasta ahora solo se renovaban al guardar el
-- formulario desde el panel de administración, así que en cuanto pasaban
-- 7 días sin tocarlo, dejaban de llegar respuestas al seguimiento automático
-- (ni validación, ni emails de incidencia, ni borrado).
--
-- Este cron llama a google-forms-watch-sync cada 6 horas. La función, solo
-- para formularios activos con seguimiento:
--   - no hace nada si al watch le queda más de 24 h;
--   - lo renueva (watches/{id}:renew) si le queda menos de 24 h;
--   - crea uno nuevo si ya ha caducado y, en ese caso, como ha habido un hueco
--     sin avisos, descarga y procesa las respuestas que se enviaron mientras
--     tanto (sync_responses_on_create).
--
-- Antes de ejecutar esto:
--
--   1) Desplegar la versión de la función que sabe renovar:
--
--        supabase functions deploy google-forms-watch-sync --project-ref pqycvrpdyebshkfaxzmi
--
--   2) Tener pg_cron y pg_net habilitados (ya lo están: los usan los crons
--      limpiar-fotos-dni y cleanup-expired-parent-email-verification-tokens).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Por si se vuelve a ejecutar el script: quita la versión anterior del cron.
select cron.unschedule('renovar-watches-google-forms')
where exists (select 1 from cron.job where jobname = 'renovar-watches-google-forms');

select cron.schedule(
  'renovar-watches-google-forms',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://pqycvrpdyebshkfaxzmi.supabase.co/functions/v1/google-forms-watch-sync',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{"sync_responses_on_create": true}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- Primera ejecución manual (para no esperar hasta 6 h): recrea los watches
-- caducados y recupera las respuestas perdidas.
-- ---------------------------------------------------------------------------

-- timeout_milliseconds: pg_net corta a los 5 s por defecto y la recuperación
-- (crear watches + descargar y procesar respuestas) puede tardar bastante más.
-- La función termina igualmente en el servidor, pero sin este margen el
-- resultado no queda registrado en net._http_response.

select net.http_post(
  url := 'https://pqycvrpdyebshkfaxzmi.supabase.co/functions/v1/google-forms-watch-sync',
  headers := jsonb_build_object('Content-Type', 'application/json'),
  body := '{"sync_responses_on_create": true}'::jsonb,
  timeout_milliseconds := 300000
) as request_id;

-- El resultado de esa llamada (created, renewed, synced, process_result,
-- errors) se puede ver con la consulta de abajo, usando el request_id que
-- devuelve el select anterior. Ojo: `order by id desc limit 1` puede enseñar
-- otra petición (el cron cada 6 h, o el de fotos DNI cada 15 min).
--
--   select id, created, status_code, timed_out, error_msg, content::jsonb
--   from net._http_response
--   where id = <request_id>;

-- ---------------------------------------------------------------------------
-- Comprobaciones
-- ---------------------------------------------------------------------------

-- Estado del watch de cada formulario activo con seguimiento: todos deberían
-- tener status = 'active' y expires_at en el futuro. (Los inactivos ya no se
-- renuevan; su watch caduca solo y es lo esperado.)
--
--   select f.title, f.active, w.status, w.expires_at, w.updated_at
--   from registration_forms f
--   left join lateral (
--     select status, expires_at, updated_at
--     from google_form_watches
--     where registration_form_id = f.id
--     order by created_at desc
--     limit 1
--   ) w on true
--   where f.google_form_watch_enabled and f.active
--   order by w.expires_at;

-- Últimas ejecuciones del cron (status = 'succeeded' solo indica que se lanzó
-- la petición HTTP; el resultado real está en net._http_response o en los
-- logs de la función en el dashboard de Supabase).
--
--   select start_time, status, return_message
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'renovar-watches-google-forms')
--   order by start_time desc
--   limit 10;
