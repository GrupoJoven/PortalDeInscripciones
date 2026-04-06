import { useEffect, useState } from 'react';
import { motion } from 'motion/react';

import type { VerifyPublicFormEmailResponse } from '../types';

export default function VerifyPublicFormEmailPage() {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Verificando tu correo...');

  useEffect(() => {
    const run = async () => {
      const searchParams = new URLSearchParams(window.location.search);
      const token = searchParams.get('token');

      if (!token) {
        setStatus('error');
        setMessage('El enlace de verificación no es válido.');
        return;
      }

      try {
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-public-form-email-token`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ token }),
          }
        );

        const result: VerifyPublicFormEmailResponse = await response.json();

        if (!response.ok || !result.ok || !result.access_url) {
          setStatus('error');
          setMessage('El enlace no es válido, ha caducado o el formulario ya no está disponible.');
          return;
        }

        setStatus('success');
        setMessage('Correo verificado correctamente. Redirigiendo al formulario...');

        window.location.href = result.access_url;
      } catch (error) {
        console.error(error);
        setStatus('error');
        setMessage('No se pudo completar la verificación del correo.');
      }
    };

    run();
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white rounded-3xl shadow-sm border border-slate-200 p-8 text-center"
      >
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Verificación de correo
        </h1>

        <p
          className={
            status === 'error'
              ? 'text-red-600'
              : status === 'success'
                ? 'text-green-700'
                : 'text-slate-600'
          }
        >
          {message}
        </p>

        {status === 'loading' && (
          <div className="mt-8 w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
        )}
      </motion.div>
    </div>
  );
}