-- =====================================================================
-- Prerrelleno de "¿Es menor de edad?" a partir de la fecha de nacimiento
-- =====================================================================
-- Pregunta de opción única (respuestas literales "Sí"/"No") que indica si
-- la persona es menor de edad en el primer día del evento (normalmente un
-- fin de semana), para que los monitores lo sepan sin calcularlo a mano.
--
-- Se calcula en tiempo de prerrelleno comparando la fecha de nacimiento
-- leída del DNI del menor con `prefill_underage_reference_date` (fecha
-- fija que fija la persona administradora al configurar el formulario, no
-- una pregunta del formulario). Por eso, igual que "curso al que entra",
-- solo tiene sentido cuando la verificación de DNI está activada.
--
-- `prefill_underage` ya se había creado a mano en producción; se deja aquí
-- documentada (con `if not exists`, así que no falla si ya existe) para
-- que quede reflejada en el historial de migraciones y en otros entornos.
-- =====================================================================

alter table public.registration_forms
  add column if not exists prefill_underage text,
  add column if not exists prefill_underage_enabled boolean not null default false,
  add column if not exists prefill_underage_reference_date date;

comment on column public.registration_forms.prefill_underage is
  'Identificador entry.XXXXXXXXX de Google Forms para la pregunta "¿Es menor de edad?" (opción única, respuestas literales "Sí"/"No").';

comment on column public.registration_forms.prefill_underage_enabled is
  'Casilla "Monitores menores". Si es true, se prerrellena prefill_underage comparando la fecha de nacimiento leída del DNI con prefill_underage_reference_date.';

comment on column public.registration_forms.prefill_underage_reference_date is
  'Fecha fija (normalmente el primer día del fin de semana del evento) contra la que se calcula si la persona es menor de edad. La fija la persona administradora; no viene del formulario.';

-- Solo tiene sentido si hay fecha de nacimiento fiable, y esa solo viene de
-- la verificación de DNI (que, a su vez, ya está restringida a acceso libre).
alter table public.registration_forms
  drop constraint if exists registration_forms_underage_requires_dni_verification;

alter table public.registration_forms
  add constraint registration_forms_underage_requires_dni_verification
  check (prefill_underage_enabled = false or dni_verification_enabled = true);
