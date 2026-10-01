-- =====================================================================
-- Identificadores de las preguntas de los formularios de pago
-- =====================================================================
-- Hasta ahora los `entry.XXXXXXXXX` de las preguntas del formulario de pago
-- estaban fijos en el código. Pasan a guardarse en cada formulario, igual
-- que los de inscripción, para poder usar formularios de Google distintos y
-- copiarlos desde una plantilla en el panel.
--
-- payment_prefill_entries es un objeto con una entrada por actividad:
--   {
--     "campamento_verano": {
--       "names": "entry.1482861068",  -- pregunta de párrafo con los nombres
--       "grid":  "entry.1895229552"   -- fila de "INDIQUE LAS ACTIVIDADES PAGADAS"
--     },
--     ...
--   }
-- =====================================================================

alter table public.registration_forms
  add column if not exists payment_prefill_entries jsonb not null default '{}'::jsonb;

comment on column public.registration_forms.payment_prefill_entries is
  'Solo formularios de pago: identificadores entry.XXXXXXXXX de cada actividad, como {"clave": {"names": "entry.X", "grid": "entry.Y"}}. "names" es la pregunta de párrafo con los nombres y "grid" la fila de la cuadrícula de actividades pagadas.';


-- Los formularios de pago que ya existían usan el formulario de Google cuyos
-- identificadores estaban en el código: se copian tal cual.
update public.registration_forms
set payment_prefill_entries = '{
  "acampada_postcomunion":    {"names": "entry.794595863",  "grid": "entry.666452913"},
  "acampada_preconfirmacion": {"names": "entry.546902884",  "grid": "entry.2125776880"},
  "acampada_confirmacion":    {"names": "entry.1625976138", "grid": "entry.719210589"},
  "retiro_confirmacion":      {"names": "entry.1441405370", "grid": "entry.827903391"},
  "campamento_verano":        {"names": "entry.1482861068", "grid": "entry.1895229552"},
  "camino_preconfirmacion":   {"names": "entry.31537136",   "grid": "entry.472469403"},
  "camino_confirmacion":      {"names": "entry.374068113",  "grid": "entry.222505288"}
}'::jsonb
where form_type = 'payment'
  and payment_prefill_entries = '{}'::jsonb;


-- El formulario de pago de prueba se queda como plantilla (bloqueada en el
-- panel, igual que las demás plantillas) para copiar desde él los
-- identificadores a los formularios de pago nuevos.
update public.registration_forms
set title = 'PLANTILLA PAGO',
    active = false
where id = '66d61b52-87f9-45a5-9ad8-478ebb660d6c';
