import { motion } from 'motion/react';
import { ExternalLink, Calendar, FileText, ShieldCheck } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';

import type { PublicHomeForm } from '../types';
import { isFormCurrentlyOpen } from '../types';

type FormCardProps = {
  form: PublicHomeForm;
  onAccessClick?: (form: PublicHomeForm) => void;
};

export default function FormCard({ form, onAccessClick }: FormCardProps) {
  const isOpen = isFormCurrentlyOpen(form);

  const handleClick = () => {
    if (onAccessClick) {
      onAccessClick(form);
      return;
    }

    window.open(form.url, '_blank', 'noopener,noreferrer');
  };

  const handleCircularClick = () => {
    if (!form.circular_url) return;
    window.open(form.circular_url, '_blank', 'noopener,noreferrer');
  };

  const handleAuthorizationClick = () => {
    if (!form.authorization_url) return;
    window.open(form.authorization_url, '_blank', 'noopener,noreferrer');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all group"
    >
      <div className="flex justify-between items-start mb-4 gap-3">
        <h3 className="min-w-0 flex-1 break-words text-xl font-bold text-slate-800 group-hover:text-indigo-600 transition-colors">
          {form.title}
        </h3>

        <div className="bg-green-50 text-green-700 text-xs font-bold px-2.5 py-1 rounded-full uppercase tracking-wider whitespace-nowrap">
          Activo
        </div>
      </div>

      <p className="text-slate-600 mb-6 max-h-32 overflow-y-auto">
        {form.description || 'Sin descripción disponible.'}
      </p>

      <div className="space-y-3 mb-6">
        {form.open_date && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Calendar className="w-4 h-4" />
            <span>
              Abre: {format(parseISO(form.open_date), 'PPP p', { locale: es })}
            </span>
          </div>
        )}

        {form.close_date && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Calendar className="w-4 h-4" />
            <span>
              Cierra: {format(parseISO(form.close_date), 'PPP p', { locale: es })}
            </span>
          </div>
        )}
      </div>

      {isOpen && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={handleClick}
            className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all shadow-indigo-100 shadow-lg group-hover:-translate-y-0.5"
          >
            Acceder al Formulario
            <ExternalLink className="w-4 h-4" />
          </button>

          {(form.circular_url || form.authorization_url) && (
            <div className="grid grid-cols-1 gap-3">
              {form.circular_url && (
                <button
                  type="button"
                  onClick={handleCircularClick}
                  className="w-full bg-slate-100 text-slate-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-slate-200 transition-all"
                >
                  Acceder a circular
                  <FileText className="w-4 h-4" />
                </button>
              )}

              {form.authorization_url && (
                <button
                  type="button"
                  onClick={handleAuthorizationClick}
                  className="w-full bg-slate-100 text-slate-700 py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-slate-200 transition-all"
                >
                  Acceder a autorización
                  <ShieldCheck className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {!isOpen && (
        <div className="text-sm text-slate-500 font-medium">
          Disponible próximamente
        </div>
      )}
    </motion.div>
  );
}