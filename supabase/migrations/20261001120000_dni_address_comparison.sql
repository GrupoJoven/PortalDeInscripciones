-- =====================================================================
-- Comparación del domicilio prerrellenado con el que se envía
-- =====================================================================
-- En los formularios con verificación de DNI, la DIRECCIÓN DE LA
-- RESIDENCIA HABITUAL y el CÓDIGO POSTAL se prerrellenan con lo leído del
-- DNI, pero la familia puede cambiarlos antes de enviar. Esta migración
-- permite detectar esos cambios:
--
--   1. Dos identificadores de respuesta nuevos por formulario (el
--      "question ID" de Google Forms, p.ej. 29bd3893), igual que
--      response_parent_email_question_id.
--   2. dni_prefill_snapshots: lo que se prerrellenó en cada enlace de
--      acceso. Hace falta guardarlo aparte porque la sesión de verificación
--      (con los datos del DNI) se borra a las 24 h de confirmarla, y la
--      respuesta puede procesarse después.
--   3. dni_address_comparisons: el resultado de comparar cada respuesta con
--      su prerrelleno, que se consulta desde el panel de administración.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Identificadores de respuesta
-- ---------------------------------------------------------------------

alter table public.registration_forms
  add column if not exists response_address_question_id text,
  add column if not exists response_postal_code_question_id text;

comment on column public.registration_forms.response_address_question_id is
  'Question ID de Google Forms (p.ej. 29bd3893) de DIRECCIÓN DE LA RESIDENCIA HABITUAL. Opcional: si está, se compara la respuesta con el domicilio prerrellenado desde el DNI.';

comment on column public.registration_forms.response_postal_code_question_id is
  'Question ID de Google Forms (p.ej. 5affe64e) de CÓDIGO POSTAL. Opcional: si está, se compara la respuesta con el código postal prerrellenado.';


-- ---------------------------------------------------------------------
-- 2. Lo que se prerrellenó en cada enlace de acceso
-- ---------------------------------------------------------------------
-- Se guarda al construir el enlace del formulario de Google (una fila por
-- sesión de DNI y email). Solo los datos necesarios para comparar y para
-- encontrar la fila desde la respuesta: nada de nombre ni fotos.
-- Se borran a los 7 días (ver cleanup_dni_verification_sessions).

create table if not exists public.dni_prefill_snapshots (
  id uuid primary key default gen_random_uuid(),
  registration_form_id uuid not null
    references public.registration_forms(id) on delete cascade,
  dni_verification_session_id uuid
    references public.dni_verification_sessions(id) on delete set null,
  normalized_email text not null,
  dni text,
  -- null = no se prerrellenó (el formulario no tiene esa pregunta
  -- configurada, o no había dato que poner).
  address text,
  postal_code text,
  minor_without_dni boolean not null default false,
  created_at timestamp with time zone not null default now(),

  constraint dni_prefill_snapshots_session_email_key
    unique (dni_verification_session_id, normalized_email)
);

comment on table public.dni_prefill_snapshots is
  'Domicilio y código postal prerrellenados desde el DNI en cada enlace de acceso, para compararlos con la respuesta enviada. Se borran a los 7 días.';

create index if not exists dni_prefill_snapshots_lookup_idx
  on public.dni_prefill_snapshots (registration_form_id, normalized_email, created_at desc);

create index if not exists dni_prefill_snapshots_created_idx
  on public.dni_prefill_snapshots (created_at);

alter table public.dni_prefill_snapshots enable row level security;

revoke all on public.dni_prefill_snapshots from anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. Resultado de la comparación
-- ---------------------------------------------------------------------

create table if not exists public.dni_address_comparisons (
  id uuid primary key default gen_random_uuid(),
  registration_form_id uuid not null
    references public.registration_forms(id) on delete cascade,

  -- Identifican la respuesta igual que en google_form_processed_responses.
  google_form_id text not null,
  response_id text not null,
  submitted_at timestamp with time zone,

  contact_email text,
  dni text,
  minor_without_dni boolean,

  status text not null,

  address_expected text,
  address_received text,
  address_matches boolean,
  postal_code_expected text,
  postal_code_received text,
  postal_code_matches boolean,

  admin_notified_at timestamp with time zone,
  contact_notified_at timestamp with time zone,
  notification_error text,

  reviewed_at timestamp with time zone,
  reviewed_by uuid references auth.users(id) on delete set null,

  created_at timestamp with time zone not null default now(),

  constraint dni_address_comparisons_response_key
    unique (google_form_id, response_id),

  constraint dni_address_comparisons_status_check check (
    status = any (array[
      'match',        -- todo lo comparado coincide
      'mismatch',     -- la dirección o el código postal no coinciden
      'not_compared', -- no se prerrellenó nada comparable
      'no_snapshot'   -- no se ha encontrado el prerrelleno de esta respuesta
    ])
  )
);

comment on table public.dni_address_comparisons is
  'Comparación entre el domicilio/código postal prerrellenados desde el DNI y los enviados en la respuesta de Google Forms. La rellena google-forms-process-responses.';

create index if not exists dni_address_comparisons_form_idx
  on public.dni_address_comparisons (registration_form_id, submitted_at desc);

alter table public.dni_address_comparisons enable row level security;

revoke all on public.dni_address_comparisons from anon, authenticated;

-- Los coordinadores las consultan desde el panel y solo pueden marcarlas
-- como revisadas.
grant select on public.dni_address_comparisons to authenticated;
grant update (reviewed_at, reviewed_by) on public.dni_address_comparisons to authenticated;

drop policy if exists dni_address_comparisons_coordinator_select on public.dni_address_comparisons;

create policy dni_address_comparisons_coordinator_select
  on public.dni_address_comparisons
  for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'coordinator'
    )
  );

drop policy if exists dni_address_comparisons_coordinator_update on public.dni_address_comparisons;

create policy dni_address_comparisons_coordinator_update
  on public.dni_address_comparisons
  for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'coordinator'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'coordinator'
    )
  );


-- ---------------------------------------------------------------------
-- 4. Limpieza: los prerrellenos se borran a los 7 días
-- ---------------------------------------------------------------------
-- Se aprovecha la limpieza periódica que ya existe (cron
-- 'limpiar-fotos-dni' -> dni-verification-cleanup). Misma firma que antes,
-- así que la Edge Function no cambia.

create or replace function public.cleanup_dni_verification_sessions()
returns table (orphan_path text)
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.dni_prefill_snapshots
  where created_at < now() - interval '7 days';

  return query
  with borradas as (
    delete from public.dni_verification_sessions
    where expires_at < now()
    returning front_path, back_path
  )
  select p.path
  from borradas b
  cross join lateral (values (b.front_path), (b.back_path)) as p(path)
  where p.path is not null;
end;
$$;

revoke all on function public.cleanup_dni_verification_sessions() from public, anon, authenticated;
