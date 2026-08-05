-- =====================================================================
-- Verificación de DNI para formularios de acceso libre
-- =====================================================================
-- Añade:
--   1. Configuración por formulario (casilla + entry de domicilio).
--   2. Tabla de sesiones de verificación (escritorio <-> móvil vía QR).
--   3. Bucket privado temporal para las fotos del documento.
--   4. Enlace de la sesión con el token de verificación por email.
--   5. Función de limpieza de sesiones caducadas.
--
-- Política de datos: las imágenes se borran en cuanto se extraen los
-- datos. Solo se conservan nombre, número de DNI y domicilio, y
-- únicamente hasta que la sesión caduca.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Configuración por formulario
-- ---------------------------------------------------------------------

alter table public.registration_forms
  add column if not exists dni_verification_enabled boolean not null default false;

alter table public.registration_forms
  add column if not exists prefill_address_entry text;

comment on column public.registration_forms.dni_verification_enabled is
  'Si es true, antes de abrir el formulario se exige verificar el DNI del menor (o de un progenitor si el menor tiene menos de 14 años y no dispone de DNI).';

comment on column public.registration_forms.prefill_address_entry is
  'Identificador entry.XXXXXXXXX de Google Forms para DIRECCIÓN DE LA RESIDENCIA HABITUAL.';

-- La verificación de DNI solo tiene sentido en formularios de acceso libre:
-- en los restringidos el nombre y el DNI ya se prerrellenan desde students.
alter table public.registration_forms
  drop constraint if exists registration_forms_dni_verification_public_only;

alter table public.registration_forms
  add constraint registration_forms_dni_verification_public_only
  check (dni_verification_enabled = false or access_type = 'public');


-- ---------------------------------------------------------------------
-- 2. Sesiones de verificación
-- ---------------------------------------------------------------------

create table if not exists public.dni_verification_sessions (
  id uuid primary key default gen_random_uuid(),
  registration_form_id uuid not null
    references public.registration_forms(id) on delete cascade,

  -- El QR lleva el token en claro; en la base solo guardamos el hash.
  mobile_token_hash text not null unique,
  desktop_token_hash text not null unique,

  -- Marcado por el usuario en el aviso previo.
  minor_without_dni boolean not null default false,

  status text not null default 'pending',

  front_path text,
  back_path text,
  images_deleted_at timestamp with time zone,

  extracted jsonb,
  extraction_error text,

  attempts integer not null default 0,

  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null default (now() + interval '30 minutes'),
  confirmed_at timestamp with time zone,
  consumed_at timestamp with time zone,

  constraint dni_verification_sessions_status_check check (
    status = any (array[
      'pending',        -- sesión creada, esperando al móvil
      'capturing',      -- el móvil ha abierto la página
      'front_uploaded', -- anverso subido
      'processing',     -- ambas caras subidas, extrayendo datos
      'extracted',      -- datos listos para revisar en el móvil
      'confirmed',      -- el usuario ha aceptado los datos
      'failed'          -- la extracción ha fallado
    ])
  )
);

comment on table public.dni_verification_sessions is
  'Sesión efímera que conecta el navegador de escritorio (QR) con el móvil que hace las fotos del documento. Las imágenes se borran tras extraer los datos.';

create index if not exists dni_verification_sessions_form_idx
  on public.dni_verification_sessions (registration_form_id);

create index if not exists dni_verification_sessions_expires_idx
  on public.dni_verification_sessions (expires_at);

create index if not exists dni_verification_sessions_status_idx
  on public.dni_verification_sessions (status);

-- updated_at automático
create or replace function public.touch_dni_verification_session()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists dni_verification_sessions_touch on public.dni_verification_sessions;

create trigger dni_verification_sessions_touch
  before update on public.dni_verification_sessions
  for each row
  execute function public.touch_dni_verification_session();


-- ---------------------------------------------------------------------
-- 3. RLS: acceso exclusivamente a través de Edge Functions
-- ---------------------------------------------------------------------
-- No se crea ninguna policy a propósito: con RLS activado y sin policies,
-- anon y authenticated no pueden leer ni escribir nada. El service_role
-- que usan las Edge Functions salta RLS.

alter table public.dni_verification_sessions enable row level security;

revoke all on public.dni_verification_sessions from anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. Bucket privado para las fotos
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dni_uploads',
  'dni_uploads',
  false,
  8 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Sin policies de storage para anon/authenticated: las subidas y borrados
-- los hace la Edge Function con service_role.


-- ---------------------------------------------------------------------
-- 5. Enlace con el flujo de verificación por email
-- ---------------------------------------------------------------------
-- Cuando el usuario tiene que verificar su email, el enlace que recibe por
-- correo debe seguir arrastrando los datos del DNI ya verificado.

alter table public.public_form_email_verification_tokens
  add column if not exists dni_verification_session_id uuid
    references public.dni_verification_sessions(id) on delete set null;

create index if not exists public_form_email_tokens_dni_session_idx
  on public.public_form_email_verification_tokens (dni_verification_session_id);


-- ---------------------------------------------------------------------
-- 6. Limpieza de sesiones caducadas
-- ---------------------------------------------------------------------
-- Borra las sesiones caducadas y devuelve las rutas de imagen que
-- quedaran huérfanas, para que la Edge Function las elimine del bucket.

create or replace function public.cleanup_dni_verification_sessions()
returns table (orphan_path text)
language plpgsql
security definer
set search_path = public
as $$
begin
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
