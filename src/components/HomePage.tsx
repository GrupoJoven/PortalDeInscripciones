import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { X, Mail, Lock, AlertCircle } from 'lucide-react';

import { supabase } from '../lib/supabaseClient';
import { isFormCurrentlyOpen } from '../types';
import FormCard from './FormCard';

import type { PublicHomeForm, PublicFormsResponse, StartPublicFormEmailAccessResponse } from '../types';

export default function HomePage() {
  const [publicId, setPublicId] = useState('');
  const [publicForms, setPublicForms] = useState<PublicHomeForm[]>([]);
  const [restrictedForms, setRestrictedForms] = useState<PublicHomeForm[]>([]);
  const [loadingPublic, setLoadingPublic] = useState(true);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [searchParams] = useSearchParams();
  const [selectedPublicForm, setSelectedPublicForm] = useState<PublicHomeForm | null>(null);
  const [publicFormEmail, setPublicFormEmail] = useState('');
  const [publicFormEmailError, setPublicFormEmailError] = useState('');
  const [publicFormEmailInfo, setPublicFormEmailInfo] = useState('');
  const [submittingPublicFormEmail, setSubmittingPublicFormEmail] = useState(false);

  const openPublicFormAccessModal = (form: PublicHomeForm) => {
    setSelectedPublicForm(form);
    setPublicFormEmail('');
    setPublicFormEmailError('');
    setPublicFormEmailInfo('');
  };

  const closePublicFormAccessModal = () => {
    setSelectedPublicForm(null);
    setPublicFormEmail('');
    setPublicFormEmailError('');
    setPublicFormEmailInfo('');
    setSubmittingPublicFormEmail(false);
  };

  const handleSubmitPublicFormEmail = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedPublicForm) return;

    const cleanEmail = publicFormEmail.trim().toLowerCase();

    if (!cleanEmail) {
      setPublicFormEmailError('Debes introducir un correo electrónico.');
      setPublicFormEmailInfo('');
      return;
    }

    setSubmittingPublicFormEmail(true);
    setPublicFormEmailError('');
    setPublicFormEmailInfo('');

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/start-public-form-email-access`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            form_id: selectedPublicForm.id,
            email: cleanEmail,
          }),
        }
      );

      const result: StartPublicFormEmailAccessResponse = await response.json();

      if (!response.ok || !result.ok) {
        setPublicFormEmailError(
          result.message ?? 'No se pudo procesar el acceso al formulario.'
        );
        setSubmittingPublicFormEmail(false);
        return;
      }

      if (result.status === 'verified' && result.access_url) {
        window.location.href = result.access_url;
        return;
      }

      if (result.status === 'verification_required') {
        setPublicFormEmailInfo(
          result.message ??
            'Te hemos enviado un correo de verificación. Revisa tu bandeja de entrada.'
        );
        setSubmittingPublicFormEmail(false);
        return;
      }

      setPublicFormEmailError('No se pudo procesar el acceso al formulario.');
      setSubmittingPublicFormEmail(false);
    } catch (error) {
      console.error(error);
      setPublicFormEmailError('Ha ocurrido un error al procesar el acceso.');
      setSubmittingPublicFormEmail(false);
    }
  };

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
      .select('id, title, description, url, circular_url, authorization_url, active, open_date, close_date, access_type')
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
        circular_url: form.circular_url,
        authorization_url: form.authorization_url,
        open_date: form.open_date,
        close_date: form.close_date,
        access_type: form.access_type,
      }));

    setPublicForms(normalized);
    setLoadingPublic(false);
  };

  useEffect(() => {
    loadPublicForms();
  }, []);

  useEffect(() => {
    const paramPublicId = (searchParams.get('public_id') ?? '').trim().toUpperCase();
    const autoCheck = searchParams.get('auto_check') === '1';

    if (!paramPublicId) return;

    setPublicId(paramPublicId);

    if (autoCheck) {
      checkAccessByPublicId(paramPublicId);
    }
  }, [searchParams]);

  const checkAccessByPublicId = async (rawPublicId: string) => {
    const cleanPublicId = rawPublicId.trim().toUpperCase();

    if (!cleanPublicId) {
      setRestrictedForms([]);
      setError('');
      setInfoMessage('');
      return;
    }

    setCheckingAccess(true);
    setError('');
    setInfoMessage('');

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

      if (result.status === 'verification_required') {
        setRestrictedForms([]);
        setInfoMessage(
          result.message ??
            'Te hemos enviado un correo de verificación. Revisa tu bandeja de entrada.'
        );
        setCheckingAccess(false);
        return;
      }

      if (result.status === 'not_found') {
        setRestrictedForms([]);
        setError('No se ha encontrado ningún acceso asociado a ese identificador.');
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

  const handleCheckAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    await checkAccessByPublicId(publicId);
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
            placeholder="SANP-XXXX-XXX"
            className="block w-full pl-12 pr-28 py-4 bg-white border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all text-lg shadow-sm"
          />

          <button
            type="submit"
            disabled={checkingAccess}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold text-sm hover:bg-indigo-700 transition-colors disabled:opacity-50"
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

        {infoMessage && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 text-blue-700 bg-blue-50 p-3 rounded-xl border border-blue-100"
          >
            <span className="text-sm font-medium">{infoMessage}</span>
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
                <FormCard
                    key={form.id}
                    form={form}
                    onAccessClick={form.access_type === 'public' ? openPublicFormAccessModal : undefined}
                  />
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
                  <FormCard
                    key={form.id}
                    form={form}
                    onAccessClick={form.access_type === 'public' ? openPublicFormAccessModal : undefined}
                  />
                ))}
              </motion.div>
            </div>
          )}
        </>
      )}
      {selectedPublicForm && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 p-6 relative"
          >
            <button
              type="button"
              onClick={closePublicFormAccessModal}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="mb-6 pr-8">
              <h2 className="text-2xl font-bold text-slate-900 mb-2">
                Verificación de acceso
              </h2>
              <p className="text-slate-600 text-sm">
                Introduce tu correo electrónico de contacto para acceder al formulario:
              </p>
              <p className="text-sm font-semibold text-slate-800 mt-2">
                {selectedPublicForm.title}
              </p>
            </div>

            <form onSubmit={handleSubmitPublicFormEmail} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Correo electrónico
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="email"
                    value={publicFormEmail}
                    onChange={(e) => setPublicFormEmail(e.target.value)}
                    placeholder="correo@ejemplo.com"
                    className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    autoFocus
                  />
                </div>
              </div>

              {publicFormEmailError && (
                <div className="flex items-start gap-2 text-red-600 bg-red-50 p-3 rounded-xl border border-red-100">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span className="text-sm font-medium">{publicFormEmailError}</span>
                </div>
              )}

              {publicFormEmailInfo && (
                <div className="text-blue-700 bg-blue-50 p-3 rounded-xl border border-blue-100">
                  <span className="text-sm font-medium">{publicFormEmailInfo}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submittingPublicFormEmail}
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submittingPublicFormEmail ? 'Comprobando...' : 'Continuar'}
              </button>
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
}