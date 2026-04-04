import { motion } from 'motion/react';
import { ExternalLink, Calendar } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';

import type { PublicHomeForm } from '../types';
import { isFormCurrentlyOpen } from '../types';

export default function FormCard({ form }: { form: PublicHomeForm }) {
  const isOpen = isFormCurrentlyOpen(form);
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all group"
    >
      <div className="flex justify-between items-start mb-4 gap-3">
        <h3 className="text-xl font-bold text-slate-800 group-hover:text-indigo-600 transition-colors">
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
        <a
          href={form.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all shadow-indigo-100 shadow-lg group-hover:-translate-y-0.5"
        >
          Acceder al Formulario
          <ExternalLink className="w-4 h-4" />
        </a>
      )}
      {!isOpen && (
        <div className="text-sm text-slate-500 font-medium">
          Disponible próximamente
        </div>
      )}
    </motion.div>
  );
}