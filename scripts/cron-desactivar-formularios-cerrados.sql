-- Desactivación automática de formularios cuya fecha de cierre ya ha pasado.
--
-- Hasta ahora `active` era un interruptor puramente manual: un formulario con
-- close_date pasada dejaba de verse en el portal, pero seguía marcado como
-- activo y, en consecuencia, seguía con seguimiento automático (renovación
-- del watch, recuperación de respuestas atrasadas, correos de incidencia,
-- borrados). Este cron pone active = false en cuanto se alcanza close_date.
--
-- Efectos de active = false (además de no verse en el portal):
--   - google-forms-watch-sync ignora el formulario (no renueva ni recrea su
--     watch, ni recupera respuestas atrasadas);
--   - google-forms-sync-responses no descarga sus respuestas, así que no se
--     validan, no se envían correos y no se borran. Se quedan tal cual en
--     Google Forms. Si se reactiva el formulario, la siguiente sincronización
--     las recoge.
--
-- Antes de ejecutar esto, desplegar las funciones que respetan `active`:
--
--   supabase functions deploy google-forms-watch-sync --project-ref pqycvrpdyebshkfaxzmi
--   supabase functions deploy google-forms-sync-responses --project-ref pqycvrpdyebshkfaxzmi

create extension if not exists pg_cron;

-- Devuelve cuántos formularios ha desactivado.
create or replace function public.deactivate_closed_registration_forms()
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update public.registration_forms
    set active = false
    where active = true
      and close_date is not null
      and close_date <= now()
    returning id
  )
  select count(*)::integer from updated;
$$;

revoke all on function public.deactivate_closed_registration_forms() from public, anon, authenticated;

-- Por si se vuelve a ejecutar el script: quita la versión anterior del cron.
select cron.unschedule('desactivar-formularios-cerrados')
where exists (select 1 from cron.job where jobname = 'desactivar-formularios-cerrados');

select cron.schedule(
  'desactivar-formularios-cerrados',
  '*/15 * * * *',
  'select public.deactivate_closed_registration_forms();'
);

-- ---------------------------------------------------------------------------
-- Primera pasada manual: desactiva ahora mismo los que ya están cerrados.
-- Antes de ejecutarla, conviene ver cuáles son:
--
--   select title, close_date
--   from registration_forms
--   where active and close_date is not null and close_date <= now()
--   order by close_date;
-- ---------------------------------------------------------------------------

select public.deactivate_closed_registration_forms() as formularios_desactivados;

-- ---------------------------------------------------------------------------
-- Comprobación de que el cron va corriendo
-- ---------------------------------------------------------------------------
--
--   select start_time, status, return_message
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'desactivar-formularios-cerrados')
--   order by start_time desc
--   limit 10;
