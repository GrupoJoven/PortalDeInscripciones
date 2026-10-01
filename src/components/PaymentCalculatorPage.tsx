import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Calculator, Minus, Plus, Receipt } from 'lucide-react';

import { supabase } from '../lib/supabaseClient';
import { isFormCurrentlyOpen } from '../types';
import {
  MAX_PARTICIPANTS_PER_ACTIVITY,
  PAYMENT_ACTIVITIES,
  calculatePaymentAmount,
  isPaymentActivityKey,
} from '../../supabase/functions/_shared/paymentActivities';
import type {
  PaymentActivity,
  PaymentActivityKey,
  SiblingDiscounts,
} from '../../supabase/functions/_shared/paymentActivities';

type CalculatorActivity = PaymentActivity & { price: number };

type CalculatorForm = {
  id: string;
  title: string;
  discounts: SiblingDiscounts;
  activities: CalculatorActivity[];
};

const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

const toNumberOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * Formularios de pago públicos abiertos ahora mismo, del más reciente al más
 * antiguo, solo con las actividades que tienen precio. Si una actividad está
 * en varios formularios abiertos, se queda en el más reciente.
 */
const buildCalculatorForms = (rows: any[]): CalculatorForm[] => {
  const usedKeys = new Set<PaymentActivityKey>();
  const forms: CalculatorForm[] = [];

  for (const row of rows) {
    if (!isFormCurrentlyOpen(row)) continue;

    const enabledKeys: PaymentActivityKey[] = (row.payment_activities ?? []).filter(
      isPaymentActivityKey,
    );
    const prices: Record<string, unknown> = row.payment_activity_prices ?? {};

    const activities = PAYMENT_ACTIVITIES.flatMap((activity) => {
      const price = toNumberOrNull(prices[activity.key]);

      if (!enabledKeys.includes(activity.key) || price === null || usedKeys.has(activity.key)) {
        return [];
      }

      usedKeys.add(activity.key);
      return [{ ...activity, price }];
    });

    if (activities.length === 0) continue;

    forms.push({
      id: row.id,
      title: row.title,
      discounts: {
        pair: toNumberOrNull(row.payment_sibling_discount_pair),
        trio: toNumberOrNull(row.payment_sibling_discount_trio),
        fourPlus: toNumberOrNull(row.payment_sibling_discount_four_plus),
      },
      activities,
    });
  }

  return forms;
};

const discountSummary = (discounts: SiblingDiscounts) => {
  const tiers = [
    { label: '2 hermanos', value: discounts.pair },
    { label: '3 hermanos', value: discounts.trio },
    { label: '4 o más', value: discounts.fourPlus },
  ].filter((tier) => tier.value);

  return tiers.length > 0
    ? tiers.map((tier) => `${tier.label}: ${tier.value} %`).join(' · ')
    : null;
};

export default function PaymentCalculatorPage() {
  const [forms, setForms] = useState<CalculatorForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Participantes por formulario y actividad: counts[formId][activityKey]
  const [counts, setCounts] = useState<Record<string, Partial<Record<PaymentActivityKey, number>>>>(
    {},
  );

  useEffect(() => {
    const load = async () => {
      const { data, error: loadError } = await supabase
        .from('registration_forms')
        .select(
          'id, title, active, open_date, close_date, created_at, payment_activities, payment_activity_prices, payment_sibling_discount_pair, payment_sibling_discount_trio, payment_sibling_discount_four_plus',
        )
        .eq('form_type', 'payment')
        .eq('access_type', 'public')
        .eq('active', true)
        .order('created_at', { ascending: false });

      if (loadError) {
        console.error(loadError);
        setError('No se han podido cargar los precios. Inténtalo de nuevo más tarde.');
      } else {
        setForms(buildCalculatorForms(data ?? []));
      }

      setLoading(false);
    };

    load();
  }, []);

  const setCount = (formId: string, key: PaymentActivityKey, count: number) => {
    const clamped = Math.max(0, Math.min(MAX_PARTICIPANTS_PER_ACTIVITY, count));
    setCounts((current) => ({ ...current, [formId]: { ...current[formId], [key]: clamped } }));
  };

  // Importe de cada formulario: el descuento se calcula con los participantes
  // de todas sus actividades juntas.
  const amounts = useMemo(
    () =>
      forms.map((form) =>
        calculatePaymentAmount(
          form.activities.map((activity) => ({
            price: activity.price,
            count: counts[form.id]?.[activity.key] ?? 0,
          })),
          form.discounts,
        ),
      ),
    [forms, counts],
  );

  const grandTotal = amounts.reduce((sum, amount) => sum + amount.total, 0);
  const formsWithAmount = amounts.filter((amount) => amount.total > 0).length;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
      <div className="text-center mb-10">
        <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-5">
          <Calculator className="w-7 h-7" />
        </div>
        <motion.h1
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-4xl font-extrabold text-slate-900 tracking-tight mb-4"
        >
          Calculadora de pagos
        </motion.h1>
        <p className="text-slate-600 max-w-xl mx-auto">
          Indica cuántos de tus hijos participan en cada actividad que requiera un pago (acampadas, campamento, camino, etc.) y te diremos cuánto tienes que
          pagar, con los descuentos por hermanos ya aplicados.
        </p>
        <p className="text-slate-600 max-w-xl mx-auto">
          Participar en las catequesis durante el año no tiene coste alguno, pero las otras actividades al requerir la contratación de autobuses, comida, alojamiento,
          etc. Tienen un coste de participación asociado.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-16 bg-white rounded-3xl border border-slate-200">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-500 font-medium">Cargando precios...</p>
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 p-4 rounded-2xl">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="font-medium">{error}</span>
        </div>
      ) : forms.length === 0 ? (
        <div className="text-center py-16 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
          <AlertCircle className="w-8 h-8 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">
            Ahora mismo no hay ningún pago abierto con precios publicados.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {forms.map((form, formIndex) => {
            const summary = discountSummary(form.discounts);
            const amount = amounts[formIndex];

            return (
              <motion.section
                key={form.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden"
              >
                <div className="px-5 sm:px-6 pt-5 sm:pt-6 pb-4 border-b border-slate-100">
                  <div className="flex items-start gap-3">
                    <Receipt className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-1" />
                    <div className="min-w-0">
                      <h2 className="text-xl font-bold text-slate-900 break-words">{form.title}</h2>
                      {summary && (
                        <p className="text-sm text-slate-500 mt-1">
                          Descuento por hermanos en este pago: {summary}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <ul className="divide-y divide-slate-100">
                  {form.activities.map((activity, activityIndex) => {
                    const count = counts[form.id]?.[activity.key] ?? 0;
                    const activityAmount = amount.activities[activityIndex];
                    const discounted = count > 0 && activityAmount.discount > 0;

                    return (
                      <li
                        key={activity.key}
                        className="px-5 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-800 break-words">{activity.label}</p>
                          <p className="text-sm text-slate-500">
                            {euros.format(activity.price)} por participante
                          </p>
                          {discounted && (
                            <p className="text-sm font-semibold text-emerald-700">
                              Con descuento ({amount.discountPercent} %):{' '}
                              <span className="line-through font-normal text-slate-400">
                                {euros.format(activity.price)}
                              </span>{' '}
                              → {euros.format(activityAmount.discountedPrice)} por participante
                            </p>
                          )}
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-4">
                          <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
                            <button
                              type="button"
                              onClick={() => setCount(form.id, activity.key, count - 1)}
                              disabled={count === 0}
                              className="w-9 h-9 rounded-lg bg-white text-slate-700 shadow-sm flex items-center justify-center hover:bg-slate-50 disabled:opacity-40 disabled:shadow-none"
                              aria-label={`Quitar un participante de ${activity.label}`}
                            >
                              <Minus className="w-4 h-4" />
                            </button>
                            <span
                              className="w-10 text-center text-lg font-bold text-slate-900 tabular-nums"
                              aria-live="polite"
                              aria-label={`Participantes en ${activity.label}`}
                            >
                              {count}
                            </span>
                            <button
                              type="button"
                              onClick={() => setCount(form.id, activity.key, count + 1)}
                              disabled={count >= MAX_PARTICIPANTS_PER_ACTIVITY}
                              className="w-9 h-9 rounded-lg bg-white text-slate-700 shadow-sm flex items-center justify-center hover:bg-slate-50 disabled:opacity-40 disabled:shadow-none"
                              aria-label={`Añadir un participante a ${activity.label}`}
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>

                          <div className="w-28 text-right">
                            {discounted && (
                              <p className="text-xs text-slate-400 line-through tabular-nums">
                                {euros.format(activityAmount.gross)}
                              </p>
                            )}
                            <p
                              className={`font-bold tabular-nums ${count > 0 ? 'text-slate-900' : 'text-slate-300'}`}
                            >
                              {euros.format(activityAmount.total)}
                            </p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                <div className="px-5 sm:px-6 py-4 bg-emerald-50 border-t border-emerald-100">
                  {amount.discount > 0 && (
                    <div className="space-y-1 mb-3 pb-3 border-b border-emerald-100 text-sm">
                      <div className="flex items-center justify-between gap-4 text-slate-600">
                        <span>Subtotal</span>
                        <span className="tabular-nums">{euros.format(amount.gross)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4 font-semibold text-emerald-700">
                        <span>
                          Descuento {amount.participants >= 4 ? '4 o más' : amount.participants}{' '}
                          hermanos ({amount.discountPercent} %)
                        </span>
                        <span className="tabular-nums">−{euros.format(amount.discount)}</span>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-4">
                    <span className="font-bold text-emerald-900">Total de este pago</span>
                    <span className="text-2xl font-extrabold text-emerald-800 tabular-nums">
                      {euros.format(amount.total)}
                    </span>
                  </div>
                </div>
              </motion.section>
            );
          })}

          {formsWithAmount > 1 && (
            <div className="bg-slate-900 text-white rounded-3xl px-5 sm:px-6 py-5">
              <div className="flex items-center justify-between gap-4">
                <span className="font-bold">Total entre todos los pagos</span>
                <span className="text-2xl font-extrabold tabular-nums">
                  {euros.format(grandTotal)}
                </span>
              </div>
              <p className="text-sm text-slate-300 mt-2">
                Son pagos distintos: cada uno se justifica en su propio formulario de pago.
              </p>
            </div>
          )}

          <p className="text-sm text-slate-500 text-center">
            El descuento por hermanos se calcula con todos tus hijos que participan en las
            actividades de un mismo pago, aunque sean actividades distintas. Los hermanos en
            actividades de pagos distintos no se suman.
          </p>
        </div>
      )}
    </div>
  );
}
