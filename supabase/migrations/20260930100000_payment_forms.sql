-- =====================================================================
-- Formularios de pago
-- =====================================================================
-- Nuevo tipo de formulario, además de los de inscripción. En un formulario
-- de pago la familia indica, antes de abrir el Google Form, qué hijos
-- participan en cada actividad que está pagando; con eso se prerrellenan
-- las preguntas de nombres y la cuadrícula "INDIQUE LAS ACTIVIDADES
-- PAGADAS". El justificante se adjunta ya en Google Forms.
--
-- No llevan seguimiento de respuestas ni verificación de DNI, y los
-- identificadores `entry.XXXXXXXXX` de las preguntas son fijos (están en
-- supabase/functions/_shared/paymentActivities.ts), así que no se
-- configuran por formulario.
--
-- Por formulario se guarda:
--   - form_type: 'registration' (el de siempre) o 'payment'.
--   - payment_activities: claves de las actividades que se pagan con él.
--     Solo esas aparecen en la pantalla de participantes; el resto se
--     marca con 0 en la cuadrícula.
--   - payment_activity_prices: precio de cada actividad, {"clave": 120.5}.
--   - payment_sibling_discount_*: descuento en % por 2, 3 y 4 o más
--     hermanos. Es el mismo para todas las actividades del formulario.
--   Los precios y descuentos son opcionales y, de momento, solo se guardan.
-- =====================================================================

alter table public.registration_forms
  add column if not exists form_type text not null default 'registration',
  add column if not exists payment_activities text[] not null default '{}',
  add column if not exists payment_activity_prices jsonb not null default '{}'::jsonb,
  add column if not exists payment_sibling_discount_pair numeric(5, 2),
  add column if not exists payment_sibling_discount_trio numeric(5, 2),
  add column if not exists payment_sibling_discount_four_plus numeric(5, 2);

comment on column public.registration_forms.form_type is
  'Tipo de formulario: ''registration'' (inscripción) o ''payment'' (pago de actividades).';

comment on column public.registration_forms.payment_activities is
  'Solo formularios de pago: claves de las actividades que se pueden pagar con este formulario (ver _shared/paymentActivities.ts).';

comment on column public.registration_forms.payment_activity_prices is
  'Solo formularios de pago: precio de cada actividad marcada, como objeto {"clave": importe}. Opcional.';

comment on column public.registration_forms.payment_sibling_discount_pair is
  'Solo formularios de pago: % de descuento cuando participan 2 hermanos. Común a todas las actividades.';

comment on column public.registration_forms.payment_sibling_discount_trio is
  'Solo formularios de pago: % de descuento cuando participan 3 hermanos. Común a todas las actividades.';

comment on column public.registration_forms.payment_sibling_discount_four_plus is
  'Solo formularios de pago: % de descuento cuando participan 4 o más hermanos. Común a todas las actividades.';


alter table public.registration_forms
  drop constraint if exists registration_forms_form_type_check;

alter table public.registration_forms
  add constraint registration_forms_form_type_check
  check (form_type in ('registration', 'payment'));


alter table public.registration_forms
  drop constraint if exists registration_forms_payment_activities_check;

alter table public.registration_forms
  add constraint registration_forms_payment_activities_check
  check (
    payment_activities <@ array[
      'acampada_postcomunion',
      'acampada_preconfirmacion',
      'acampada_confirmacion',
      'retiro_confirmacion',
      'campamento_verano',
      'camino_preconfirmacion',
      'camino_confirmacion'
    ]::text[]
    and (
      case
        when form_type = 'payment' then cardinality(payment_activities) > 0
        else cardinality(payment_activities) = 0
      end
    )
  );


-- Los formularios de pago no tienen seguimiento de respuestas ni DNI.
alter table public.registration_forms
  drop constraint if exists registration_forms_payment_no_tracking;

alter table public.registration_forms
  add constraint registration_forms_payment_no_tracking
  check (
    form_type <> 'payment'
    or (dni_verification_enabled = false and google_form_watch_enabled = false)
  );


alter table public.registration_forms
  drop constraint if exists registration_forms_payment_discounts_range;

alter table public.registration_forms
  add constraint registration_forms_payment_discounts_range
  check (
    coalesce(payment_sibling_discount_pair, 0) between 0 and 100
    and coalesce(payment_sibling_discount_trio, 0) between 0 and 100
    and coalesce(payment_sibling_discount_four_plus, 0) between 0 and 100
  );
