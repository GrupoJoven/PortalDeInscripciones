import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { X, Mail, AlertCircle, KeyRound } from 'lucide-react';

type PublicIdRecoveryModalProps = {
  onClose: () => void;
};

/**
 * "No sé mi código": pide el email de contacto y, si es el de algún alumno,
 * le llegan por correo los identificadores de todos sus hijos. La respuesta
 * es siempre la misma, para no revelar qué correos están registrados.
 */
export default function PublicIdRecoveryModal({ onClose }: PublicIdRecoveryModalProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    const cleanEmail = email.trim().toLowerCase();

    if (!cleanEmail) {
      setError('Debes introducir un correo electrónico.');
      setInfo('');
      return;
    }

    setSubmitting(true);
    setError('');
    setInfo('');

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/recover-public-ids`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ email: cleanEmail }),
        }
      );

      const result: { ok: boolean; message?: string } = await response.json();

      if (!response.ok || !result.ok) {
        setError(result.message ?? 'No se ha podido procesar la petición. Inténtalo más tarde.');
        return;
      }

      setInfo(result.message ?? 'Revisa tu bandeja de entrada.');
    } catch (err) {
      console.error(err);
      setError('No se ha podido procesar la petición. Inténtalo más tarde.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 p-6 relative"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
          aria-label="Cerrar"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="mb-6 pr-8">
          <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4">
            <KeyRound className="w-5 h-5" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">¿No sabes tu código?</h2>
          <p className="text-slate-600 text-sm">
            Escribe el correo electrónico de contacto que nos diste al apuntar a tu hijo/a. Te
            enviaremos a ese correo los códigos de todos tus hijos.
          </p>
        </div>

        {info ? (
          <div className="space-y-4">
            <div className="text-blue-700 bg-blue-50 p-3 rounded-xl border border-blue-100">
              <span className="text-sm font-medium">{info}</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors"
            >
              Entendido
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Correo electrónico de contacto
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="correo@ejemplo.com"
                  className="w-full pl-10 pr-4 py-3 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  autoFocus
                />
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-red-600 bg-red-50 p-3 rounded-xl border border-red-100">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span className="text-sm font-medium">{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? 'Enviando...' : 'Enviarme mis códigos'}
            </button>
          </form>
        )}
      </motion.div>
    </div>
  );
}
