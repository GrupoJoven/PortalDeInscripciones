import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { CalendarCheck, ChevronDown, CirclePlay, Receipt, Tent } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { TUTORIAL_CATEGORIES } from '../lib/tutorials';
import type { TutorialCategoryId } from '../lib/tutorials';

const CATEGORY_ICONS: Record<TutorialCategoryId, LucideIcon> = {
  'inicio-curso': CalendarCheck,
  acampadas: Tent,
  pagos: Receipt,
};

/**
 * Vídeos tutoriales para rellenar los formularios. Primero se elige una
 * sección (?seccion=<id>) y dentro se despliega un vídeo (?video=<id>). El
 * asistente enlaza directamente al vídeo: se abre su sección con él
 * desplegado.
 */
export default function TutorialsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const requestedVideo = searchParams.get('video');
  const videoCategory = TUTORIAL_CATEGORIES.find((category) =>
    category.tutorials.some((tutorial) => tutorial.id === requestedVideo),
  );
  const selectedCategory =
    videoCategory ?? TUTORIAL_CATEGORIES.find((category) => category.id === searchParams.get('seccion'));
  const openVideoId = videoCategory ? requestedVideo : null;

  const listRef = useRef<HTMLDivElement>(null);
  const openVideoRef = useRef<HTMLElement>(null);

  // Al desplegar un vídeo (o llegar desde el asistente) se baja hasta él; al
  // elegir sección sin vídeo, hasta su lista.
  useEffect(() => {
    if (openVideoId) openVideoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [openVideoId]);

  useEffect(() => {
    if (selectedCategory && !openVideoId) {
      listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedCategory?.id]);

  const selectCategory = (id: TutorialCategoryId) => setSearchParams({ seccion: id });

  const toggleVideo = (categoryId: TutorialCategoryId, videoId: string) =>
    setSearchParams(videoId === openVideoId ? { seccion: categoryId } : { video: videoId }, {
      replace: true,
    });

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
          Vídeos que te enseñan, paso a paso, cómo entrar en los formularios y rellenarlos. Elige qué
          formulario quieres hacer.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {TUTORIAL_CATEGORIES.map((category) => {
          const Icon = CATEGORY_ICONS[category.id];
          const isSelected = category.id === selectedCategory?.id;
          const count = category.tutorials.length;

          return (
            <button
              key={category.id}
              type="button"
              onClick={() => selectCategory(category.id)}
              aria-pressed={isSelected}
              className={`flex sm:flex-col items-center sm:items-start gap-4 sm:gap-3 text-left p-4 sm:p-5 rounded-3xl border transition-colors ${
                isSelected
                  ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-200'
                  : 'bg-white border-slate-200 text-slate-900 hover:border-indigo-300 hover:bg-indigo-50'
              }`}
            >
              <span
                className={`w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 ${
                  isSelected ? 'bg-white/20 text-white' : 'bg-indigo-100 text-indigo-700'
                }`}
              >
                <Icon className="w-6 h-6" />
              </span>
              <span className="min-w-0">
                <span className="block font-bold leading-tight">{category.title}</span>
                <span className={`block text-sm mt-1 ${isSelected ? 'text-indigo-100' : 'text-slate-500'}`}>
                  {category.description}
                </span>
                <span className={`block text-xs font-semibold mt-2 ${isSelected ? 'text-indigo-100' : 'text-indigo-600'}`}>
                  {count === 1 ? '1 vídeo' : `${count} vídeos`}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {selectedCategory ? (
        <div ref={listRef} className="scroll-mt-28 mt-10">
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight mb-4">{selectedCategory.title}</h2>

          <div className="space-y-3">
            {selectedCategory.tutorials.map((tutorial) => {
              const isOpen = tutorial.id === openVideoId;

              return (
                <section
                  key={tutorial.id}
                  id={tutorial.id}
                  ref={isOpen ? openVideoRef : undefined}
                  className={`scroll-mt-28 bg-white rounded-3xl border ${
                    isOpen ? 'border-indigo-400 ring-4 ring-indigo-100' : 'border-slate-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleVideo(selectedCategory.id, tutorial.id)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center gap-4 p-4 sm:p-5 text-left"
                  >
                    <CirclePlay className="w-8 h-8 text-indigo-600 flex-shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-lg font-bold text-slate-900 leading-tight">{tutorial.title}</span>
                      <span className="block text-slate-600 mt-1">{tutorial.description}</span>
                    </span>
                    <ChevronDown
                      className={`w-5 h-5 text-slate-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {isOpen && (
                    <div className="px-4 pb-4 sm:px-5 sm:pb-5">
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
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-8 text-center text-slate-500">Elige una sección para ver sus vídeos.</p>
      )}
    </div>
  );
}
