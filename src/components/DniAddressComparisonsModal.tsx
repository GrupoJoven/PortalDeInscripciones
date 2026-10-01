import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { XCircle, CheckCircle2, RefreshCcw } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';

import { supabase } from '../lib/supabaseClient';
import type { DniAddressComparison, RegistrationForm } from '../types';

type Filter = 'pending' | 'mismatch' | 'all';

const STATUS_LABELS: Record<DniAddressComparison['status'], { label: string; className: string }> = {
  match: { label: 'Coincide', className: 'bg-green-100 text-green-700' },
  mismatch: { label: 'No coincide', className: 'bg-red-100 text-red-700' },
  not_compared: { label: 'Sin datos que comparar', className: 'bg-slate-100 text-slate-600' },
  no_snapshot: { label: 'Prerrelleno no encontrado', className: 'bg-slate-100 text-slate-600' },
};

const formatDate = (iso: string | null) =>
  iso ? format(parseISO(iso), "d MMM yyyy, HH:mm", { locale: es }) : '—';

function ComparedValue({
  label,
  expected,
  received,
  matches,
}: {
  label: string;
  expected: string | null;
  received: string | null;
  matches: boolean | null;
}) {
  return (
    <div>
      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
          <p className="text-[11px] font-semibold text-slate-400">Leído del DNI</p>
          <p className="text-slate-700 break-words">{expected || '—'}</p>
        </div>
        <div
          className={`rounded-xl px-3 py-2 border ${matches === false
            ? 'bg-red-50 border-red-200'
            : 'bg-slate-50 border-slate-200'
            }`}
        >
          <p className="text-[11px] font-semibold text-slate-400">Enviado en el formulario</p>
          <p className={`break-words ${matches === false ? 'text-red-700 font-semibold' : 'text-slate-700'}`}>
            {received || '(en blanco)'}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function DniAddressComparisonsModal({
  form,
  userId,
  onClose,
}: {
  form: RegistrationForm;
  userId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DniAddressComparison[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('pending');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadRows = async () => {
    setLoading(true);
    setError('');

    const { data, error: loadError } = await supabase
      .from('dni_address_comparisons')
      .select('*')
      .eq('registration_form_id', form.id)
      .order('submitted_at', { ascending: false, nullsFirst: false });

    if (loadError) {
      console.error(loadError);
      setError('No se han podido cargar las comparaciones.');
    } else {
      setRows((data ?? []) as DniAddressComparison[]);
    }

    setLoading(false);
  };

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.id]);

  const counts = useMemo(() => {
    const mismatches = rows.filter((row) => row.status === 'mismatch');
    return {
      all: rows.length,
      mismatch: mismatches.length,
      pending: mismatches.filter((row) => !row.reviewed_at).length,
    };
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'mismatch') return rows.filter((row) => row.status === 'mismatch');
    return rows.filter((row) => row.status === 'mismatch' && !row.reviewed_at);
  }, [rows, filter]);

  const toggleReviewed = async (row: DniAddressComparison) => {
    setUpdatingId(row.id);
    setError('');

    const reviewed = !row.reviewed_at;
    const patch = {
      reviewed_at: reviewed ? new Date().toISOString() : null,
      reviewed_by: reviewed ? userId : null,
    };

    const { error: updateError } = await supabase
      .from('dni_address_comparisons')
      .update(patch)
      .eq('id', row.id);

    if (updateError) {
      console.error(updateError);
      setError('No se ha podido actualizar la comparación.');
    } else {
      setRows((current) =>
        current.map((r) => (r.id === row.id ? { ...r, reviewed_at: patch.reviewed_at } : r))
      );
    }

    setUpdatingId(null);
  };

  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'pending', label: 'Pendientes de revisar', count: counts.pending },
    { key: 'mismatch', label: 'Todas las discrepancias', count: counts.mismatch },
    { key: 'all', label: 'Todas las respuestas', count: counts.all },
  ];

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl overflow-hidden"
      >
        <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-start gap-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-800">Domicilio: DNI vs. respuesta</h3>
            <p className="text-sm text-slate-500 mt-1">{form.title}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadRows}
              disabled={loading}
              className="p-2 text-slate-400 hover:text-slate-600 disabled:opacity-50 transition-colors"
              title="Recargar"
            >
              <RefreshCcw className={`w-6 h-6 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
              <XCircle className="w-8 h-8" />
            </button>
          </div>
        </div>

        <div className="p-8 space-y-4 max-h-[75vh] overflow-y-auto">
          {!form.response_address_question_id && !form.response_postal_code_question_id && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-2xl p-4">
              Este formulario no tiene configurados los QUESTION ID de la dirección ni del código
              postal (Editar → campos de seguimiento), así que sus respuestas no se están comparando.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${filter === f.key
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
              >
                {f.label} ({f.count})
              </button>
            ))}
          </div>

          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {loading ? (
            <div className="py-10 text-center">
              <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-slate-500">Cargando...</p>
            </div>
          ) : visibleRows.length === 0 ? (
            <p className="py-10 text-center text-slate-500">
              {filter === 'pending' ? 'No hay discrepancias pendientes de revisar.' : 'No hay respuestas que mostrar.'}
            </p>
          ) : (
            <ul className="space-y-4">
              {visibleRows.map((row) => {
                const status = STATUS_LABELS[row.status];
                return (
                  <li key={row.id} className="border border-slate-200 rounded-2xl p-5 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${status.className}`}
                          >
                            {status.label}
                          </span>
                          {row.reviewed_at && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider bg-green-100 text-green-700">
                              Revisada
                            </span>
                          )}
                          {row.minor_without_dni && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider bg-amber-100 text-amber-800">
                              DNI de un progenitor
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-700">
                          <span className="font-semibold">{row.contact_email || '—'}</span>
                          {row.dni && <span className="text-slate-500"> · DNI {row.dni}</span>}
                        </p>
                        <p className="text-xs text-slate-500">Enviada: {formatDate(row.submitted_at)}</p>
                      </div>

                      {row.status === 'mismatch' && (
                        <button
                          onClick={() => toggleReviewed(row)}
                          disabled={updatingId === row.id}
                          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2 disabled:opacity-60 ${row.reviewed_at
                            ? 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                            : 'bg-green-600 text-white hover:bg-green-700'
                            }`}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          {row.reviewed_at ? 'Marcar como pendiente' : 'Marcar como revisada'}
                        </button>
                      )}
                    </div>

                    {(row.address_expected || row.address_received) && (
                      <ComparedValue
                        label="Dirección de la residencia habitual"
                        expected={row.address_expected}
                        received={row.address_received}
                        matches={row.address_matches}
                      />
                    )}

                    {(row.postal_code_expected || row.postal_code_received) && (
                      <ComparedValue
                        label="Código postal"
                        expected={row.postal_code_expected}
                        received={row.postal_code_received}
                        matches={row.postal_code_matches}
                      />
                    )}

                    {row.status === 'mismatch' && (
                      <div className="text-xs text-slate-500 space-y-0.5">
                        <p>
                          Aviso a administración:{' '}
                          {row.admin_notified_at ? formatDate(row.admin_notified_at) : 'no enviado'}
                          {' · '}
                          Aviso al email de contacto:{' '}
                          {row.contact_notified_at ? formatDate(row.contact_notified_at) : 'no enviado'}
                        </p>
                        {row.notification_error && (
                          <p className="text-red-600">Error al avisar: {row.notification_error}</p>
                        )}
                        {row.reviewed_at && <p>Revisada: {formatDate(row.reviewed_at)}</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </motion.div>
    </div>
  );
}
