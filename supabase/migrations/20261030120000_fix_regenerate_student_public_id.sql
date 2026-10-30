-- Corrige regenerate_student_public_id (botón "Regenerar" de Accesos).
--
-- Al devolver RETURNS TABLE(student_id, public_id), la función tiene variables
-- de salida con el mismo nombre que las columnas, y en
-- `on conflict (student_id)` PostgreSQL no sabe a cuál se refiere:
--   42702 column reference "student_id" is ambiguous
--
-- Se indica el conflicto por el nombre de la clave primaria, que no admite
-- esa ambigüedad. La firma y el resultado no cambian.

create or replace function public.regenerate_student_public_id(p_student_id uuid)
returns table(student_id uuid, public_id text)
language plpgsql
as $function$
declare
  new_public_id text;
begin
  new_public_id := public.generate_unique_student_public_id();

  insert into public.student_public_access (student_id, public_id)
  values (p_student_id, new_public_id)
  on conflict on constraint student_public_access_pkey
  do update set public_id = excluded.public_id;

  return query
  select spa.student_id, spa.public_id
  from public.student_public_access spa
  where spa.student_id = p_student_id;
end;
$function$;
