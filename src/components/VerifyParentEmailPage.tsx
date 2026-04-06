import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';

import type { VerifyParentEmailResponse } from '../types';

export default function VerifyParentEmailPage() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Verificando tu correo...');
  const [publicId, setPublicId] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    const publicIdParam = searchParams.get('public_id') ?? '';

    setPublicId(publicIdParam);

    if (!token) {
      setStatus('error');
      setMessage('El enlace de verificación no es válido.');
      return;
    }

    const verify = async () => {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-parent-email-token`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ token }),
          }
        );

        const result: VerifyParentEmailResponse = await response.json();

        if (!response.ok || !result.ok) {
          setStatus('error');
          setMessage('El enlace no es válido o ha caducado.');
          return;
        }

        if (result.status === 'already_verified') {
          setStatus('success');
          setMessage('Este correo ya estaba verificado.');
          setPublicId(result.public_id ?? publicIdParam);
          return;
        }

        setStatus('success');
        setMessage('Correo verificado correctamente. Ya puedes continuar.');
        setPublicId(result.public_id ?? publicIdParam);
      } catch (error) {
        console.error(error);
        setStatus('error');
        setMessage('No se pudo completar la verificación del correo.');
      }
    };

    verify();
  }, [searchParams]);

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

        <div className="mt-8">
          {status === 'success' ? (
            <Link
              to={`/?public_id=${encodeURIComponent(publicId)}&auto_check=1`}
              className="inline-flex items-center justify-center px-6 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors"
            >
              Continuar
            </Link>
          ) : status === 'error' ? (
            <Link
              to="/"
              className="inline-flex items-center justify-center px-6 py-3 bg-slate-800 text-white rounded-xl font-bold hover:bg-slate-900 transition-colors"
            >
              Volver al inicio
            </Link>
          ) : (
            <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
          )}
        </div>
      </motion.div>
    </div>
  );
}