import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Lock, AlertCircle } from 'lucide-react';

import { supabase } from '../lib/supabaseClient';
import { isFormCurrentlyOpen } from '../types';
import FormCard from './FormCard';

import type { PublicHomeForm, PublicFormsResponse } from '../types';

export default function HomePage() {
  const [publicId, setPublicId] = useState('');
  const [publicForms, setPublicForms] = useState<PublicHomeForm[]>([]);
  const [restrictedForms, setRestrictedForms] = useState<PublicHomeForm[]>([]);
  const [loadingPublic, setLoadingPublic] = useState(true);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [error, setError] = useState('');

  const isFormClosed = (form: PublicHomeForm) => {
    if (!form.close_date) return false;
    return new Date(form.close_date).getTime() < Date.now();
  };

  const isFormUpcoming = (form: PublicHomeForm) => {
    if (!form.open_date) return false;
    return new Date(form.open_date).getTime() > Date.now();
  };

  const loadPublicForms = async () => {
    setLoadingPublic(true);

    const { data, error } = await supabase
      .from('registration_forms')
      .select('id, title, description, url, active, open_date, close_date, access_type')
      .eq('access_type', 'public')
      .eq('active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(error);
      setError('Error al cargar los formularios públicos.');
      setLoadingPublic(false);
      return;
    }

    const normalized = (data ?? [])
      .filter((form) => !isFormClosed(form))
      .map((form) => ({
        id: form.id,
        title: form.title,
        description: form.description,
        url: form.url,
        open_date: form.open_date,
        close_date: form.close_date,
      }));

    setPublicForms(normalized);
    setLoadingPublic(false);
  };

  useEffect(() => {
    loadPublicForms();
  }, []);

  const handleCheckAccess = async (e: React.FormEvent) => {
    e.preventDefault();

    const cleanPublicId = publicId.trim().toUpperCase();

    if (!cleanPublicId) {
      setRestrictedForms([]);
      setError('');
      return;
    }

    setCheckingAccess(true);
    setError('');

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-registration-forms-by-public-id`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ public_id: cleanPublicId }),
        }
      );

      const result: PublicFormsResponse = await response.json();

      if (!response.ok || !result.ok) {
        console.error(result);
        setError('No se pudo verificar el identificador en este momento.');
        setRestrictedForms([]);
        setCheckingAccess(false);
        return;
      }

      const normalizedRestricted = (result.forms ?? []).filter(
        (form) => !isFormClosed(form)
      );

      setRestrictedForms(normalizedRestricted);
      setCheckingAccess(false);
    } catch (err) {
      console.error(err);
      setError('Error al verificar el acceso.');
      setRestrictedForms([]);
      setCheckingAccess(false);
    }
  };

  const mergedForms = [...publicForms, ...restrictedForms].filter(
    (form, index, arr) => arr.findIndex((f) => f.id === form.id) === index
  );

  const availableNowForms = mergedForms.filter(
    (form) => !isFormUpcoming(form) && isFormCurrentlyOpen(form)
  );

  const upcomingForms = mergedForms.filter((form) => isFormUpcoming(form));

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="text-center mb-16">
        <motion.h1
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-5xl font-extrabold text-slate-900 mb-6 tracking-tight"
        >
          Portal de Inscripciones del Grupo Joven
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed"
        >
          Accede a los formularios públicos o introduce tu identificador para ver los formularios disponibles para ti.
        </motion.p>
      </div>

      <div className="max-w-md mx-auto mb-16">
        <div className="mb-8 flex items-center justify-center">
          <img
            src="https://pqycvrpdyebshkfaxzmi.supabase.co/storage/v1/object/public/public_media/logo-limpio-normal-1-removebg-preview.png"
            alt="Logo Grupo Joven"
            className="max-h-40 w-auto object-contain drop-shadow-sm"
          />
        </div>

        <form onSubmit={handleCheckAccess} className="relative group">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Lock className="h-5 w-5 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
          </div>

          <input
            type="text"
            value={publicId}
            onChange={(e) => setPublicId(e.target.value.toUpperCase())}
            placeholder="Introduce tu identificador..."
            className="block w-full pl-12 pr-4 py-4 bg-white border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all text-lg shadow-sm"
          />

          <button
            type="submit"
            disabled={checkingAccess}
            className="absolute right-2 top-2 bottom-2 px-6 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors disabled:opacity-50"
          >
            {checkingAccess ? 'Verificando...' : 'Verificar'}
          </button>
        </form>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-xl border border-red-100"
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="text-sm font-medium">{error}</span>
          </motion.div>
        )}
      </div>

      {loadingPublic ? (
        <div className="text-center py-20 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-500 font-medium">Cargando formularios...</p>
        </div>
      ) : (
        <>
          {availableNowForms.length > 0 ? (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"
            >
              {availableNowForms.map((form) => (
                <FormCard key={form.id} form={form} />
              ))}
            </motion.div>
          ) : upcomingForms.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center py-20 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200"
            >
              <div className="bg-white w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm">
                <AlertCircle className="w-8 h-8 text-slate-300" />
              </div>

              <p className="text-slate-500 font-medium">
                No hay formularios activos disponibles en este momento.
              </p>
            </motion.div>
          ) : null}

          {upcomingForms.length > 0 && (
            <div className="mt-16">
              <motion.h2
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-3xl font-bold text-slate-900 mb-8 tracking-tight"
              >
                Próximamente...
              </motion.h2>

              <motion.div
                key="upcoming-results"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"
              >
                {upcomingForms.map((form) => (
                  <FormCard key={form.id} form={form} />
                ))}
              </motion.div>
            </div>
          )}
        </>
      )}
    </div>
  );
}