import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  Loader2,
  Lock,
  Plus,
  Receipt,
  Trash2,
  X,
} from 'lucide-react';

import {
  MAX_PARTICIPANTS_PER_ACTIVITY,
  PAYMENT_ACTIVITIES,
} from '../../supabase/functions/_shared/paymentActivities';
import type {
  PaymentActivity,
  PaymentActivityKey,
} from '../../supabase/functions/_shared/paymentActivities';
import type {
  PaymentFormAccessResponse,
  PaymentValidateIdsResponse,
  PublicHomeForm,
} from '../types';

type PaymentFormGateProps = {
  form: PublicHomeForm;
  /** Identificador verificado en la portada; obligatorio en acceso limitado. */
  accessPublicId?: string;
  onCancel: () => void;
};

type ParticipantRow = {
  id: number;
  value: string;
  /** Solo actividades por identificador: nombre asociado, una vez validado. */
  name: string | null;
  error: string | null;
};

type RowsByActivity = Partial<Record<PaymentActivityKey, ParticipantRow[]>>;

const NOTICE_LOCK_SECONDS = 5;

const functionsUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const postPaymentFormAccess = async <T,>(body: unknown): Promise<T> => {
  const response = await fetch(`${functionsUrl}/payment-form-access`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  return (await response.json()) as T;
};

const normalizePublicId = (value: string) => value.trim().toUpperCase();

/** Permite partir "POSTCOMUNIÓN/COMUNIÓN" tras la barra en pantallas estrechas. */
const withSlashBreaks = (label: string) =>
  label.split('/').map((part, index) => (
    <Fragment key={index}>
      {index > 0 && (
        <>
          /<wbr />
        </>
      )}
      {part}
    </Fragment>
  ));

const isPendingValidation = (row: ParticipantRow) =>
  row.name === null && !row.error && !!row.value.trim();

/**
 * Paso previo a los formularios de pago: primero un aviso que no se puede
 * cerrar hasta pasados unos segundos y, después, los participantes de cada
 * actividad, con los que se prerrellena el formulario de Google.
 */
export default function PaymentFormGate({ form, accessPublicId, onCancel }: PaymentFormGateProps) {
  const [phase, setPhase] = useState<'notice' | 'participants'>('notice');
  const [secondsLeft, setSecondsLeft] = useState(NOTICE_LOCK_SECONDS);

  const [rowsByActivity, setRowsByActivity] = useState<RowsByActivity>({});
  const [activityErrors, setActivityErrors] = useState<Partial<Record<PaymentActivityKey, string>>>({});
  const [validatingKey, setValidatingKey] = useState<PaymentActivityKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const nextRowId = useRef(1);
  // Fila recién añadida, para ponerle el foco y poder escribir directamente.
  const [focusRowId, setFocusRowId] = useState<number | null>(null);

  const activities = useMemo(
    () => PAYMENT_ACTIVITIES.filter((activity) => form.payment_activities?.includes(activity.key)),
    [form.payment_activities],
  );

  // --- Aviso con cierre bloqueado ------------------------------------------
  useEffect(() => {
    if (phase !== 'notice' || secondsLeft <= 0) return;

    const timeout = window.setTimeout(() => setSecondsLeft((current) => current - 1), 1000);
    return () => window.clearTimeout(timeout);
  }, [phase, secondsLeft]);

  const noticeLocked = secondsLeft > 0;

  // --- Participantes ---------------------------------------------------------
  const updateRows = (
    key: PaymentActivityKey,
    update: (rows: ParticipantRow[]) => ParticipantRow[],
  ) => {
    setRowsByActivity((current) => ({ ...current, [key]: update(current[key] ?? []) }));
    setActivityErrors((current) => ({ ...current, [key]: undefined }));
    setSubmitError('');
  };

  const addRow = (key: PaymentActivityKey) => {
    const id = nextRowId.current++;
    updateRows(key, (rows) => [...rows, { id, value: '', name: null, error: null }]);
    setFocusRowId(id);
  };

  const removeRow = (key: PaymentActivityKey, rowId: number) => {
    updateRows(key, (rows) => rows.filter((row) => row.id !== rowId));
  };

  const changeRowValue = (key: PaymentActivityKey, rowId: number, value: string) => {
    updateRows(key, (rows) =>
      rows.map((row) => (row.id === rowId ? { ...row, value, name: null, error: null } : row)),
    );
  };

  const validateIds = async (activity: PaymentActivity) => {
    const rows = rowsByActivity[activity.key] ?? [];

    // Un mismo identificador dos veces en la misma actividad contaría dos
    // veces al mismo participante: se marca y no se envía.
    const seen = new Set(rows.filter((row) => row.name !== null).map((row) => row.value));
    const duplicateRowIds = new Set<number>();
    const idsToValidate: string[] = [];

    for (const row of rows) {
      if (row.name !== null) continue;

      const publicId = normalizePublicId(row.value);
      if (!publicId) continue;

      if (seen.has(publicId)) {
        duplicateRowIds.add(row.id);
        continue;
      }

      seen.add(publicId);
      idsToValidate.push(publicId);
    }

    const markDuplicates = (current: ParticipantRow[]) =>
      current.map((row) =>
        duplicateRowIds.has(row.id)
          ? { ...row, error: 'Este identificador ya está en esta actividad.' }
          : row,
      );

    if (idsToValidate.length === 0) {
      updateRows(activity.key, markDuplicates);
      return;
    }

    setValidatingKey(activity.key);

    try {
      const result = await postPaymentFormAccess<PaymentValidateIdsResponse>({
        action: 'validate_ids',
        form_id: form.id,
        access_public_id: accessPublicId,
        public_ids: idsToValidate,
      });

      if (!result.ok) {
        setActivityErrors((current) => ({
          ...current,
          [activity.key]: result.message ?? 'No se han podido validar los identificadores.',
        }));
        return;
      }

      const namesById = new Map((result.participants ?? []).map((p) => [p.public_id, p.name]));
      const notFound = new Set(result.not_found ?? []);

      // Se aplica sobre el estado actual: si mientras tanto se ha editado
      // alguna fila, esa se queda pendiente de validar.
      updateRows(activity.key, (current) =>
        markDuplicates(current).map((row) => {
          if (row.name !== null || row.error) return row;

          const publicId = normalizePublicId(row.value);
          const name = namesById.get(publicId);

          if (name) return { ...row, value: publicId, name, error: null };
          if (notFound.has(publicId)) {
            return { ...row, error: 'No se ha encontrado este identificador.' };
          }
          return row;
        }),
      );
    } catch (err) {
      console.error(err);
      setActivityErrors((current) => ({
        ...current,
        [activity.key]: 'No se han podido validar los identificadores.',
      }));
    } finally {
      setValidatingKey(null);
    }
  };

  const totalParticipants = activities.reduce(
    (total, activity) => total + (rowsByActivity[activity.key]?.length ?? 0),
    0,
  );

  // Todo lo que impide continuar, en el orden en que aparece en pantalla.
  const blockingIssues = useMemo(() => {
    const issues: string[] = [];

    for (const activity of activities) {
      const rows = rowsByActivity[activity.key] ?? [];
      const byId = activity.participantInput === 'public_id';

      if (rows.some((row) => !row.value.trim())) {
        issues.push(
          `${activity.label}: hay participantes sin ${byId ? 'identificador' : 'nombre'}. Rellénalos o elimínalos.`,
        );
      }

      if (!byId) continue;

      if (rows.some((row) => row.error)) {
        issues.push(
          `${activity.label}: hay identificadores que no son válidos. Corrígelos o elimínalos.`,
        );
      }

      if (rows.some(isPendingValidation)) {
        issues.push(`${activity.label}: pulsa "Validar identificadores" antes de continuar.`);
      }
    }

    if (totalParticipants === 0) {
      issues.push('Añade al menos un participante en alguna actividad.');
    }

    return issues;
  }, [activities, rowsByActivity, totalParticipants]);

  const goToForm = async () => {
    if (blockingIssues.length > 0) return;

    setSubmitting(true);
    setSubmitError('');

    const participants = Object.fromEntries(
      activities.map((activity) => [
        activity.key,
        (rowsByActivity[activity.key] ?? []).map((row) => row.value.trim()),
      ]),
    );

    try {
      const result = await postPaymentFormAccess<PaymentFormAccessResponse>({
        action: 'build_url',
        form_id: form.id,
        access_public_id: accessPublicId,
        participants,
      });

      if (result.ok && result.access_url) {
        window.location.href = result.access_url;
        return;
      }

      if (result.not_found?.length) {
        const notFound = new Set(result.not_found);

        setRowsByActivity((current) => {
          const next: RowsByActivity = { ...current };

          for (const activity of activities) {
            if (activity.participantInput !== 'public_id') continue;

            next[activity.key] = (current[activity.key] ?? []).map((row) =>
              notFound.has(normalizePublicId(row.value))
                ? { ...row, name: null, error: 'No se ha encontrado este identificador.' }
                : row,
            );
          }

          return next;
        });
      }

      setSubmitError(result.message ?? 'No se ha podido abrir el formulario de pago.');
    } catch (err) {
      console.error(err);
      setSubmitError('No se ha podido abrir el formulario de pago.');
    }

    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex p-4 overflow-y-auto">
      {phase === 'notice' ? (
        <motion.div
          key="notice"
          initial={{ opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="payment-notice-title"
          className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border-4 border-red-500 overflow-hidden relative m-auto"
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={noticeLocked}
            className="absolute top-4 right-4 text-white/80 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={noticeLocked ? `Podrás cerrar en ${secondsLeft} segundos` : 'Cerrar'}
          >
            {noticeLocked ? <Lock className="w-5 h-5" /> : <X className="w-5 h-5" />}
          </button>

          <div className="bg-red-600 text-white px-6 pt-6 pb-5">
            <div className="flex items-center gap-3 pr-8">
              <motion.div
                animate={{ scale: [1, 1.12, 1] }}
                transition={{ duration: 1.2, repeat: Infinity }}
                className="w-12 h-12 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0"
              >
                <AlertTriangle className="w-7 h-7" />
              </motion.div>
              <h2
                id="payment-notice-title"
                className="text-2xl font-extrabold uppercase tracking-tight leading-tight"
              >
                ¡Atención! Solo un justificante
              </h2>
            </div>
            <p className="text-sm font-semibold text-red-100 mt-3">{form.title}</p>
          </div>

          <div className="p-6 space-y-4 text-slate-700">
            <p className="text-lg font-bold text-slate-900">
              En este formulario solo se puede adjuntar <span className="text-red-600">UN ÚNICO</span>{' '}
              justificante de pago.
            </p>

            <p>
              Si has hecho <strong>más de un pago</strong> para las diferentes actividades (por
              ejemplo, un pago para una acampada y otro pago distinto para otra), tendrás que{' '}
              <strong>rellenar un formulario por cada actividad/pago</strong>.
            </p>

            <p className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-amber-900 text-sm font-medium">
              En la siguiente pantalla indica solo las actividades incluidas en el pago cuyo
              justificante vas a adjuntar. Pon varias actividades únicamente si las has pagado
              todas juntas en un único pago.
            </p>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setPhase('participants')}
                disabled={noticeLocked}
                className="relative w-full overflow-hidden bg-red-600 text-white py-3.5 rounded-xl font-bold hover:bg-red-700 transition-colors disabled:bg-slate-300 disabled:text-slate-600 disabled:cursor-not-allowed"
              >
                {noticeLocked && (
                  <motion.span
                    initial={{ width: '0%' }}
                    animate={{ width: '100%' }}
                    transition={{ duration: NOTICE_LOCK_SECONDS, ease: 'linear' }}
                    className="absolute inset-y-0 left-0 bg-slate-400/60"
                    aria-hidden="true"
                  />
                )}
                <span className="relative">
                  {noticeLocked
                    ? `Lee el aviso con atención (${secondsLeft} s)`
                    : 'Lo he entendido, continuar'}
                </span>
              </button>

              <button
                type="button"
                onClick={onCancel}
                disabled={noticeLocked}
                className="w-full mt-3 px-6 py-3 text-slate-600 font-bold hover:bg-slate-100 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancelar
              </button>
            </div>
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="participants"
          initial={{ opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-participants-title"
          className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-slate-200 p-5 sm:p-6 relative m-auto"
        >
          <button
            type="button"
            onClick={onCancel}
            className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-start gap-3 mb-5 pr-8">
            <div className="w-11 h-11 rounded-2xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
              <Receipt className="w-6 h-6 text-emerald-700" />
            </div>
            <div className="min-w-0">
              <h2
                id="payment-participants-title"
                className="text-2xl font-bold text-slate-900 leading-tight"
              >
                Participantes del pago
              </h2>
              <p className="text-sm font-semibold text-slate-500 mt-1 break-words">{form.title}</p>
            </div>
          </div>

          <p className="text-sm text-slate-600 mb-5">
            Añade a cada hijo en la actividad en la que participa. Si en alguna actividad no
            participa ninguno o no la incluyes en este pago, déjala vacía. Con estos datos se
            rellenarán los nombres y la tabla de actividades pagadas del formulario.
          </p>

          <div className="space-y-4">
            {activities.map((activity) => {
              const rows = rowsByActivity[activity.key] ?? [];
              const byId = activity.participantInput === 'public_id';
              const canAddMore = rows.length < MAX_PARTICIPANTS_PER_ACTIVITY;
              const validating = validatingKey === activity.key;
              const hasPending = rows.some(isPendingValidation);

              return (
                <section
                  key={activity.key}
                  className="border border-slate-200 rounded-2xl p-4 bg-slate-50/60"
                >
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <h3 className="font-bold text-slate-800 break-words min-w-0">
                      {withSlashBreaks(activity.label)}
                    </h3>
                    <span
                      className={`text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${
                        rows.length > 0
                          ? 'bg-indigo-100 text-indigo-700'
                          : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {rows.length} {rows.length === 1 ? 'participante' : 'participantes'}
                    </span>
                  </div>

                  <p className="text-xs text-slate-500 mb-3">
                    {byId
                      ? 'Escribe el identificador personal de cada participante (SANP-XXXX-XXX) y pulsa "Validar identificadores".'
                      : 'Escribe el nombre y apellidos de cada participante.'}
                  </p>

                  {rows.length === 0 && (
                    <p className="text-sm text-slate-400 italic mb-3">
                      Sin participantes en esta actividad.
                    </p>
                  )}

                  <ul className="space-y-2 mb-3">
                    {rows.map((row, index) => (
                      <li key={row.id}>
                        <div className="flex items-center gap-2">
                          {byId && row.name !== null ? (
                            <div
                              className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl"
                              title="El nombre viene del identificador y no se puede editar"
                            >
                              <BadgeCheck className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-slate-800 break-words">
                                  {row.name}
                                </p>
                                <p className="text-xs font-mono text-slate-500">{row.value}</p>
                              </div>
                              <Lock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 ml-auto" />
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={row.value}
                              onChange={(e) =>
                                changeRowValue(
                                  activity.key,
                                  row.id,
                                  byId ? e.target.value.toUpperCase() : e.target.value,
                                )
                              }
                              placeholder={byId ? 'SANP-XXXX-XXX' : 'Nombre y apellidos'}
                              maxLength={byId ? 40 : 120}
                              autoFocus={row.id === focusRowId}
                              aria-label={`${activity.label}: participante ${index + 1}`}
                              aria-invalid={!!row.error}
                              className={`flex-1 min-w-0 px-3 py-2.5 bg-white border rounded-xl outline-none transition-all focus:ring-4 ${
                                byId ? 'font-mono' : ''
                              } ${
                                row.error
                                  ? 'border-red-300 focus:ring-red-100 focus:border-red-500'
                                  : 'border-slate-200 focus:ring-indigo-100 focus:border-indigo-500'
                              }`}
                            />
                          )}

                          <button
                            type="button"
                            onClick={() => removeRow(activity.key, row.id)}
                            className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors flex-shrink-0"
                            aria-label={`Quitar participante ${index + 1} de ${activity.label}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        {row.error && (
                          <p className="mt-1 ml-1 text-xs font-semibold text-red-600">{row.error}</p>
                        )}
                      </li>
                    ))}
                  </ul>

                  {activityErrors[activity.key] && (
                    <div className="mb-3 flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 p-2.5 rounded-xl">
                      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span className="text-xs font-medium">{activityErrors[activity.key]}</span>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      type="button"
                      onClick={() => addRow(activity.key)}
                      disabled={!canAddMore}
                      className="flex-1 px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      Añadir nuevo participante
                    </button>

                    {byId && hasPending && (
                      <button
                        type="button"
                        onClick={() => validateIds(activity)}
                        disabled={validating}
                        className="flex-1 px-3 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
                      >
                        {validating ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <BadgeCheck className="w-4 h-4" />
                        )}
                        Validar identificadores
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>

          <p className="text-xs text-slate-500 mt-5">
            En el formulario solo te quedará indicar la cantidad total pagada y adjuntar el
            justificante.
          </p>

          {blockingIssues.length > 0 && (
            <ul className="mt-4 space-y-1.5 bg-amber-50 border border-amber-200 rounded-2xl p-4">
              {blockingIssues.map((issue) => (
                <li key={issue} className="flex items-start gap-2 text-sm text-amber-900">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{issue}</span>
                </li>
              ))}
            </ul>
          )}

          {submitError && (
            <div className="mt-4 flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 p-3 rounded-2xl">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="text-sm font-medium">{submitError}</span>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-3 mt-5">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 px-6 py-3 text-slate-600 font-bold hover:bg-slate-100 rounded-xl transition-all"
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={goToForm}
              disabled={submitting || validatingKey !== null || blockingIssues.length > 0}
              className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Continuar al formulario de pago
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
