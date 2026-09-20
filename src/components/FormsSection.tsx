import { motion } from 'motion/react';
import { AlertCircle, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import FormCard from './FormCard';
import type { PublicHomeForm } from '../types';

type FormsSectionProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  availableForms: PublicHomeForm[];
  upcomingForms: PublicHomeForm[];
  emptyMessage: string;
  loading?: boolean;
  onAccessClick?: (form: PublicHomeForm) => void;
};

/**
 * Bloque de la portada con un título, los formularios abiertos ahora y, si
 * los hay, los que abrirán próximamente.
 */
export default function FormsSection({
  title,
  description,
  icon: Icon,
  availableForms,
  upcomingForms,
  emptyMessage,
  loading = false,
  onAccessClick,
}: FormsSectionProps) {
  const isEmpty = availableForms.length === 0 && upcomingForms.length === 0;

  return (
    <section>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center flex-shrink-0">
            <Icon className="w-5 h-5" />
          </div>
          <h2 className="text-3xl font-bold text-slate-900 tracking-tight">{title}</h2>
        </div>
        <p className="mt-3 text-slate-600">{description}</p>
      </motion.div>

      {loading ? (
        <div className="text-center py-16 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-500 font-medium">Cargando formularios...</p>
        </div>
      ) : isEmpty ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-16 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200"
        >
          <div className="bg-white w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 shadow-sm">
            <AlertCircle className="w-8 h-8 text-slate-300" />
          </div>

          <p className="text-slate-500 font-medium">{emptyMessage}</p>
        </motion.div>
      ) : (
        <>
          {availableForms.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"
            >
              {availableForms.map((form) => (
                <FormCard key={form.id} form={form} onAccessClick={onAccessClick} />
              ))}
            </motion.div>
          )}

          {upcomingForms.length > 0 && (
            <div className={availableForms.length > 0 ? 'mt-10' : ''}>
              <h3 className="flex items-center gap-2 text-xl font-bold text-slate-700 mb-6">
                <Clock className="w-5 h-5 text-slate-400" />
                Próximamente...
              </h3>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"
              >
                {upcomingForms.map((form) => (
                  <FormCard key={form.id} form={form} onAccessClick={onAccessClick} />
                ))}
              </motion.div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
