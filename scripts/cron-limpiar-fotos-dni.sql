-- Limpieza periódica de las sesiones de verificación de DNI y de sus fotos.
--
-- El cron 'limpiar-fotos-dni' llama cada 15 minutos a dni-verification-cleanup,
-- que borra las sesiones caducadas y sus fotos del bucket dni_uploads. La
-- función solo actúa si recibe la cabecera x-cleanup-secret con el mismo
-- valor que el secreto DNI_CLEANUP_SECRET de las Edge Functions.
--
-- Qué pasó: el secreto escrito a mano dentro del cron dejó de coincidir con
-- DNI_CLEANUP_SECRET. La función respondía 401 en cada pasada y no se borraba
-- nada: ni sesiones (con nombre, DNI y domicilio) ni fotos del documento.
-- Como el valor de un secreto de Edge Functions no se puede volver a leer,
-- ahora se guarda también en Supabase Vault y el cron lo lee de ahí. Así el
-- cron ya no lleva el secreto en claro y, si hace falta, se puede consultar
-- (ver "Comprobaciones" al final).
--
-- Pasos:
--   1) Generar un secreto nuevo (Git Bash):  openssl rand -hex 32
--   2) Ponerlo como valor de DNI_CLEANUP_SECRET en
--      https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/functions/secrets
--   3) Cambiar PEGA_AQUI_EL_SECRETO (bloque 1) por ese MISMO valor y ejecutar
--      los bloques 1 y 2 en
--      https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/sql
--   4) Ejecutar el bloque 3 para lanzar la primera limpieza sin esperar.
--
-- OJO: la primera pasada que funcione borra TODAS las sesiones caducadas que
-- se han ido acumulando (incluidos los domicilios leídos del DNI) y sus
-- fotos. No se puede deshacer.

-- ---------------------------------------------------------------------------
-- 1) Guardar el secreto en Vault (lo crea, o lo actualiza si ya existe).
-- ---------------------------------------------------------------------------

do $$
declare
  v_secreto constant text := 'PEGA_AQUI_EL_SECRETO';
  v_id uuid;
begin
  if v_secreto = 'PEGA_AQUI_EL_SECRETO' or length(v_secreto) < 32 then
    raise exception 'Cambia PEGA_AQUI_EL_SECRETO por el valor que has puesto en DNI_CLEANUP_SECRET.';
  end if;

  select id into v_id from vault.secrets where name = 'dni_cleanup_secret';

  if v_id is null then
    perform vault.create_secret(
      v_secreto,
      'dni_cleanup_secret',
      'Mismo valor que DNI_CLEANUP_SECRET (Edge Functions). Lo usa el cron limpiar-fotos-dni.'
    );
  else
    perform vault.update_secret(v_id, v_secreto);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Reprogramar el cron para que lea el secreto de Vault.
-- ---------------------------------------------------------------------------

-- Por si se vuelve a ejecutar el script: quita la versión anterior del cron.
select cron.unschedule('limpiar-fotos-dni')
where exists (select 1 from cron.job where jobname = 'limpiar-fotos-dni');

-- timeout_milliseconds: pg_net corta a los 5 s por defecto. La función acaba
-- igual en el servidor, pero sin este margen su respuesta no queda registrada
-- en net._http_response y no se puede comprobar si ha ido bien.
select cron.schedule(
  'limpiar-fotos-dni',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://pqycvrpdyebshkfaxzmi.supabase.co/functions/v1/dni-verification-cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cleanup-secret', (
        select decrypted_secret from vault.decrypted_secrets where name = 'dni_cleanup_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- 3) Primera limpieza manual (para no esperar al siguiente cuarto de hora).
-- ---------------------------------------------------------------------------

select net.http_post(
  url := 'https://pqycvrpdyebshkfaxzmi.supabase.co/functions/v1/dni-verification-cleanup',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cleanup-secret', (
      select decrypted_secret from vault.decrypted_secrets where name = 'dni_cleanup_secret'
    )
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 60000
) as request_id;

-- La petición es asíncrona: espera unos segundos y mira la respuesta con el
-- request_id que devuelve el select anterior. Debe ser status_code 200 y
-- {"ok":true,"fotos_encontradas":N,"fotos_borradas":N}. Si sale 401, el
-- valor de Vault y el de DNI_CLEANUP_SECRET no son iguales.
--
--   select id, created, status_code, timed_out, error_msg, content
--   from net._http_response
--   where id = <request_id>;

-- ---------------------------------------------------------------------------
-- Comprobaciones
-- ---------------------------------------------------------------------------

-- Sesiones que quedan: "caducadas" debe ser 0 (o casi: las que hayan caducado
-- desde la última pasada, que se borrarán en la siguiente).
--
--   select count(*) as total,
--          count(*) filter (where expires_at < now()) as caducadas
--   from dni_verification_sessions;

-- Fotos que quedan en el bucket: solo las de verificaciones en curso.
--
--   select count(*) from storage.objects where bucket_id = 'dni_uploads';

-- Respuestas de las últimas pasadas del cron: ya no debe salir ningún 401.
--
--   select created, status_code, content
--   from net._http_response
--   where content like '%fotos_%' or content like '%unauthorized%'
--   order by created desc
--   limit 10;

-- Si algún día necesitas el valor del secreto (p. ej. para probar la función
-- a mano):
--
--   select decrypted_secret from vault.decrypted_secrets where name = 'dni_cleanup_secret';
