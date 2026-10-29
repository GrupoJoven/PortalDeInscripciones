import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { CirclePlay } from 'lucide-react';

import { TUTORIAL_CATEGORIES } from '../lib/tutorials';

/**
 * Vídeos tutoriales para rellenar los formularios. Con ?video=<id> se baja
 * hasta ese vídeo y se resalta (así llega el asistente).
 */
export default function TutorialsPage() {
  const [searchParams] = useSearchParams();
  const selectedId = searchParams.get('video');
  const selectedRef = useRef<HTMLElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
      <div className="text-center mb-10">
        <div className="w-14 h-14 rounded-2xl bg-indigo-100 text-indigo-700 flex items-center justify-center mx-auto mb-5">
          <CirclePlay className="w-7 h-7" />
        </div>
        <motion.h1
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-4xl font-extrabold text-slate-900 tracking-tight mb-4"
        >
          Tutoriales
        </motion.h1>
        <p className="text-slate-600 max-w-xl mx-auto">
          Vídeos que te enseñan, paso a paso, cómo entrar en los formularios y rellenarlos.
        </p>
      </div>

      <div className="space-y-12">
        {TUTORIAL_CATEGORIES.map((category) => (
          <div key={category.title}>
            <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight mb-4">{category.title}</h2>

            <div className="space-y-8">
              {category.tutorials.map((tutorial) => {
                const isSelected = tutorial.id === selectedId;

                return (
                  <section
                    key={tutorial.id}
                    id={tutorial.id}
                    ref={isSelected ? selectedRef : undefined}
                    className={`scroll-mt-28 bg-white rounded-3xl border p-5 sm:p-6 ${
                      isSelected ? 'border-indigo-400 ring-4 ring-indigo-100' : 'border-slate-200'
                    }`}
                  >
                    <h3 className="text-xl font-bold text-slate-900 mb-1">{tutorial.title}</h3>
                    <p className="text-slate-600 mb-4">{tutorial.description}</p>
                    <video
                      src={tutorial.videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      className="w-full aspect-video rounded-2xl bg-slate-900"
                    >
                      Tu navegador no puede reproducir este vídeo.{' '}
                      <a href={tutorial.videoUrl} target="_blank" rel="noopener noreferrer" className="underline">
                        Ábrelo aquí
                      </a>
                      .
                    </video>
                  </section>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
