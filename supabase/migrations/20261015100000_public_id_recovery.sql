-- =====================================================================
-- Recuperación del identificador ("No sé mi código")
-- =====================================================================
-- Las familias que no saben el identificador de sus hijos pueden pedir
-- desde la portada que se lo enviemos por correo. La función
-- recover-public-ids busca los alumnos cuyo EMAIL DE CONTACTO coincide con
-- el introducido y manda a ese correo los identificadores de todos ellos.
--
--   1. public_id_recovery_requests: una fila por petición, para no enviar
--      más de un correo cada pocos minutos al mismo email. Se guarda el
--      hash del email, no el email: cualquiera puede escribir un correo
--      que no tenga nada que ver con el grupo.
--   2. find_students_by_parent_email: alumnos (con su identificador y su
--      grupo) de un email de contacto, comparando sin mayúsculas ni
--      espacios. Solo la puede ejecutar la service role.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Peticiones de recuperación
-- ---------------------------------------------------------------------
-- La propia función borra las de más de un día en cada llamada.

create table if not exists public.public_id_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  -- sha256 en hexadecimal del email normalizado (trim + minúsculas)
  email_hash text not null,
  created_at timestamp with time zone not null default now()
);

create index if not exists public_id_recovery_requests_email_hash_created_at_idx
  on public.public_id_recovery_requests (email_hash, created_at desc);

-- Sin políticas: solo accede la service role desde la edge function.
alter table public.public_id_recovery_requests enable row level security;


-- ---------------------------------------------------------------------
-- 2. Alumnos de un email de contacto
-- ---------------------------------------------------------------------

create or replace function public.find_students_by_parent_email(p_email text)
returns table (
  student_name text,
  public_id text,
  group_name text
)
language sql
stable
set search_path = public
as $$
  select s.name, spa.public_id, g.name
  from public.students s
  join public.student_public_access spa on spa.student_id = s.id
  left join public.groups g on g.id = s.group_id
  where lower(trim(s.parent_email)) = lower(trim(p_email))
  order by s.name;
$$;

-- Las funciones de public se pueden llamar por RPC con la anon key si no se
-- revoca el permiso: con ella cualquiera podría sacar los identificadores
-- de un email sin tener acceso a su buzón.
revoke execute on function public.find_students_by_parent_email(text) from public, anon, authenticated;
grant execute on function public.find_students_by_parent_email(text) to service_role;
