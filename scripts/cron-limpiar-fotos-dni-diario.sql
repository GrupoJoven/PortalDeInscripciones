-- Pasa el cron 'limpiar-fotos-dni' de cada 15 minutos a una vez al día
-- (03:00 UTC, las 4 o las 5 de la madrugada en Madrid según el horario).
--
-- Solo cambia la frecuencia: el comando (y el secreto leído de Vault) se
-- quedan como están. Ver scripts/cron-limpiar-fotos-dni.sql para el resto.

select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'limpiar-fotos-dni'),
  schedule := '0 3 * * *'
);

-- Comprobación: debe salir schedule = '0 3 * * *'.
--
--   select jobname, schedule, active
--   from cron.job
--   where jobname = 'limpiar-fotos-dni';
