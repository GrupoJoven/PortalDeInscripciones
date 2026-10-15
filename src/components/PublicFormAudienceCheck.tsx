import { useState } from 'react';
import { motion } from 'motion/react';
import { X, Users, UserRound } from 'lucide-react';

import type { PublicHomeForm } from '../types';

type PublicFormAudienceCheckProps = {
  form: PublicHomeForm;
  onCancel: () => void;
  // Es un alumno nuevo: sigue al acceso normal del formulario público.
  onContinue: (form: PublicHomeForm) => void;
  // Ya está en un grupo: tiene que entrar con su código.
  onEnterCode: () => void;
  onForgotCode: () => void;
};

/**
 * Pregunta previa a los formularios públicos de inscripción: las familias con
 * hijos en Preconfirmación o Confirmación tienen su propio formulario en
 * "Tus formularios" y no deben usar el público. (Los de pago no pasan por
 * aquí: un mismo pago público puede incluir participantes de ambos tipos.)
 */
export default function PublicFormAudienceCheck({
  form,
  onCancel,
  onContinue,
  onEnterCode,
  onForgotCode,
}: PublicFormAudienceCheckProps) {
  const [isMember, setIsMember] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-200 p-6 relative"
      >
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
          aria-label="Cerrar"
        >
          <X className="w-5 h-5" />
        </button>

        {!isMember ? (
          <>
            <div className="mb-6 pr-8">
              <div className="w-11 h-11 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4">
                <Users className="w-5 h-5" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Antes de empezar</h2>
              <p className="text-sm font-semibold text-slate-800 mb-3">{form.title}</p>
              <p className="text-slate-700">
                ¿Tu hijo/a ya está en un grupo de Preconfirmación o Confirmación del Grupo Joven
                este curso?
              </p>
            </div>

            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setIsMember(true)}
                className="w-full bg-slate-100 text-slate-800 px-4 py-3 rounded-xl font-bold hover:bg-slate-200 transition-colors"
              >
                Sí, ya está en un grupo de Preconfirmación o Confirmación del Grupo Joven.
              </button>
              <button
                type="button"
                onClick={() => onContinue(form)}
                className="w-full bg-indigo-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors"
              >
                No, es nuevo/a o pertenece a comunión/postcomunión.
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-6 pr-8">
              <div className="w-11 h-11 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4">
                <UserRound className="w-5 h-5" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Este no es tu formulario</h2>
              <p className="text-slate-700">
                Los formularios de tu hijo/a están en <strong>«Tus formularios»</strong>. Para
                verlos, escribe su código (empieza por <strong>SANP-</strong>) en el recuadro de la
                portada. Se abrirán con sus datos ya rellenados.
              </p>
            </div>

            <div className="space-y-3">
              <button
                type="button"
                onClick={onEnterCode}
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors"
              >
                Escribir su código
              </button>
              <button
                type="button"
                onClick={onForgotCode}
                className="w-full bg-slate-100 text-slate-800 py-3 rounded-xl font-bold hover:bg-slate-200 transition-colors"
              >
                No sé su código
              </button>
              <button
                type="button"
                onClick={() => setIsMember(false)}
                className="w-full text-sm text-slate-500 hover:text-slate-700 py-1"
              >
                Volver
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
