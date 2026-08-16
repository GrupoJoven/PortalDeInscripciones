-- =====================================================================
-- Código postal inferido y comprobación de zona parroquial
-- =====================================================================
-- El DNI no incluye el código postal. `dni-verification-upload` lo infiere
-- llamando a la API de Geocodificación de Google Maps a partir del
-- domicilio leído, y lo guarda en `dni_verification_sessions.extracted`
-- (jsonb, sin necesidad de migración) junto con si está o no en la zona
-- parroquial (CP 46010).
--
-- Esta migración solo añade el identificador de Google Forms para poder
-- prerrellenar la pregunta "Código Postal", igual que ya existe
-- `prefill_address_entry` para el domicilio.
-- =====================================================================

alter table public.registration_forms
  add column if not exists prefill_postal_code_entry text;

comment on column public.registration_forms.prefill_postal_code_entry is
  'Identificador entry.XXXXXXXXX de Google Forms para CÓDIGO POSTAL. Opcional: es una inferencia (no viene en el DNI) y puede faltar si la API de geocodificación no encuentra la dirección.';
