-- =====================================================================
-- Descuentos por hermanos por defecto en los formularios de pago
-- =====================================================================
-- Los formularios de pago nuevos ya se crean desde el panel con 5 %, 10 %
-- y 15 % (2, 3 y 4 o más hermanos en las actividades del formulario). Esto aplica los
-- mismos valores a los que ya existían sin descuentos configurados, para
-- que la calculadora de pagos los tenga en cuenta.
--
-- Solo se rellenan los descuentos vacíos: si alguien ya puso un valor
-- (incluido 0), se respeta.
-- =====================================================================

update public.registration_forms
set
  payment_sibling_discount_pair = coalesce(payment_sibling_discount_pair, 5),
  payment_sibling_discount_trio = coalesce(payment_sibling_discount_trio, 10),
  payment_sibling_discount_four_plus = coalesce(payment_sibling_discount_four_plus, 15)
where form_type = 'payment'
  and (
    payment_sibling_discount_pair is null
    or payment_sibling_discount_trio is null
    or payment_sibling_discount_four_plus is null
  );
