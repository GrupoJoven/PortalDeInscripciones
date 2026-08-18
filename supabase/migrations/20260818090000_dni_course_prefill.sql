-- =====================================================================
-- Prerrelleno de género, fecha de nacimiento y curso al que entra
-- =====================================================================
-- `prefill_gender_entry` y `prefill_birth_date_entry` ya existen (se usan
-- en el flujo de acceso restringido) y se reutilizan tal cual para el
-- flujo de verificación de DNI: no hacen falta columnas nuevas para ellos.
--
-- "Curso al que entra" sí es nuevo. Es una pregunta de opción única con
-- CUATRO opciones (PRECONFIRMACIÓN/CONFIRMACIÓN x PRIMER/SEGUNDO CURSO),
-- y el texto de cada opción incluye el año de nacimiento admitido (p.ej.
-- "PRECONFIRMACIÓN PRIMER CURSO (NACIDOS EN EL 2013)") — un año que
-- avanza automáticamente cada curso escolar, así que no puede guardarse
-- como texto fijo.
--
-- Por eso cada opción se guarda como PLANTILLA con el marcador `{ANIO}`
-- en el punto donde va el año (p.ej.
-- "PRECONFIRMACIÓN PRIMER CURSO (NACIDOS EN EL {ANIO})"): en tiempo de
-- prerrelleno se sustituye `{ANIO}` por el año de nacimiento leído del DNI
-- y se manda ese texto ya completo. Google Forms exige el texto EXACTO de
-- la opción para poder marcarla en un enlace prerrellenado, y este
-- proyecto no tiene acceso a la API de Google Forms para leer las
-- preguntas de un formulario de "acceso libre" (esa integración solo
-- existe para el flujo de respuestas sincronizadas de "acceso
-- restringido"). Por eso, igual que ya se hace con el resto de
-- `entry.XXXXXXXXX`, es la persona administradora quien copia el texto
-- de cada opción desde su Google Form.
-- =====================================================================

alter table public.registration_forms
  add column if not exists prefill_course_entry text,
  add column if not exists prefill_preconfirmation_first_course_option text,
  add column if not exists prefill_preconfirmation_second_course_option text,
  add column if not exists prefill_confirmation_first_course_option text,
  add column if not exists prefill_confirmation_second_course_option text;

comment on column public.registration_forms.prefill_course_entry is
  'Identificador entry.XXXXXXXXX de Google Forms para "CURSO AL QUE ENTRA". Opcional: se deriva de la fecha de nacimiento leída del DNI del menor.';

comment on column public.registration_forms.prefill_preconfirmation_first_course_option is
  'Plantilla del texto de la opción "Preconfirmación primer curso", con {ANIO} donde va el año de nacimiento (p.ej. "PRECONFIRMACIÓN PRIMER CURSO (NACIDOS EN EL {ANIO})"). Debe copiarse literal salvo el marcador: un texto parcial o distinto no selecciona nada.';

comment on column public.registration_forms.prefill_preconfirmation_second_course_option is
  'Plantilla del texto de la opción "Preconfirmación segundo curso", con {ANIO} donde va el año de nacimiento. Ver prefill_preconfirmation_first_course_option.';

comment on column public.registration_forms.prefill_confirmation_first_course_option is
  'Plantilla del texto de la opción "Confirmación primer curso", con {ANIO} donde va el año de nacimiento. Ver prefill_preconfirmation_first_course_option.';

comment on column public.registration_forms.prefill_confirmation_second_course_option is
  'Plantilla del texto de la opción "Confirmación segundo curso", con {ANIO} donde va el año de nacimiento. Ver prefill_preconfirmation_first_course_option.';
