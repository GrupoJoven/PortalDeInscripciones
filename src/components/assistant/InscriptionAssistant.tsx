import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, BookOpen, MessageCircleQuestion, RotateCcw, X } from 'lucide-react';

import { ASSISTANT_TREE } from './assistantTree';
import type { AssistantAction, AssistantNodeId } from './assistantTree';

type InscriptionAssistantProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: AssistantAction) => void;
};

// Cada paso de la conversación: el nodo y, salvo en el primero, la opción
// que eligió la familia para llegar a él.
type ConversationEntry = { nodeId: AssistantNodeId; choice?: string };

const INITIAL_CONVERSATION: ConversationEntry[] = [{ nodeId: 'start' }];

/**
 * Asistente de la portada: una conversación guiada con botones (no texto
 * libre) que lleva a la familia al sitio exacto del portal. La conversación
 * se conserva al cerrar el panel, para poder volver a ella tras una acción.
 */
export default function InscriptionAssistant({
  open,
  onOpenChange,
  onAction,
}: InscriptionAssistantProps) {
  const [conversation, setConversation] = useState<ConversationEntry[]>(INITIAL_CONVERSATION);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEntryRef = useRef<HTMLDivElement>(null);

  // Se coloca al principio del último intercambio (no al final): las
  // respuestas con pasos son largas y hay que leerlas desde arriba.
  useEffect(() => {
    if (!open || !scrollRef.current || !lastEntryRef.current) return;
    scrollRef.current.scrollTo({ top: lastEntryRef.current.offsetTop - 16, behavior: 'smooth' });
  }, [conversation, open]);

  const choose = (label: string, next: AssistantNodeId) => {
    setConversation((current) => [...current, { nodeId: next, choice: label }]);
  };

  const goBack = () => {
    setConversation((current) => (current.length > 1 ? current.slice(0, -1) : current));
  };

  const restart = () => setConversation(INITIAL_CONVERSATION);

  const runAction = (action: AssistantAction) => {
    onAction(action);
    // La guía se abre en otra pestaña: el panel puede quedarse abierto.
    if (action !== 'guide') onOpenChange(false);
  };

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            type="button"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            onClick={() => onOpenChange(true)}
            className="fixed bottom-4 right-4 z-40 flex items-center gap-2 bg-indigo-600 text-white pl-4 pr-5 py-3 rounded-full font-bold shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-colors"
          >
            <MessageCircleQuestion className="w-5 h-5" />
            ¿Te ayudo?
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            role="dialog"
            aria-label="Asistente de inscripción"
            className="fixed bottom-4 right-4 z-40 w-[min(26rem,calc(100vw-2rem))] h-[min(40rem,calc(100dvh-6rem))] bg-white rounded-3xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 px-5 py-4 bg-indigo-600 text-white">
              <MessageCircleQuestion className="w-6 h-6 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-bold leading-tight">Asistente de inscripción</p>
                <p className="text-xs text-indigo-100">Te guío paso a paso</p>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="text-indigo-100 hover:text-white"
                aria-label="Cerrar el asistente"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-4 py-5 space-y-4 bg-slate-50">
              {conversation.map((entry, index) => {
                const node = ASSISTANT_TREE[entry.nodeId];
                const isCurrent = index === conversation.length - 1;

                return (
                  <div
                    key={`${entry.nodeId}-${index}`}
                    ref={isCurrent ? lastEntryRef : undefined}
                    className="space-y-4"
                  >
                    {entry.choice && (
                      <div className="flex justify-end">
                        <p className="max-w-[85%] bg-indigo-600 text-white text-sm font-medium px-4 py-2.5 rounded-2xl rounded-br-md">
                          {entry.choice}
                        </p>
                      </div>
                    )}

                    <div className="max-w-[92%] bg-white border border-slate-200 text-slate-700 text-sm px-4 py-3 rounded-2xl rounded-bl-md space-y-2">
                      {node.message.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                      ))}

                      {node.steps && (
                        <ol className="space-y-2 pt-1">
                          {node.steps.map((step, stepIndex) => (
                            <li key={step} className="flex gap-2.5">
                              <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                                {stepIndex + 1}
                              </span>
                              <span>{step}</span>
                            </li>
                          ))}
                        </ol>
                      )}

                      {node.note && (
                        <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                          {node.note}
                        </p>
                      )}
                    </div>

                    {isCurrent && (node.actions || node.options) && (
                      <div className="space-y-2">
                        {node.actions?.map((action) => (
                          <button
                            key={action.label}
                            type="button"
                            onClick={() => runAction(action.action)}
                            className="w-full bg-indigo-600 text-white text-sm font-bold px-4 py-2.5 rounded-xl hover:bg-indigo-700 transition-colors"
                          >
                            {action.label}
                          </button>
                        ))}

                        {node.options?.map((option) => (
                          <button
                            key={option.label}
                            type="button"
                            onClick={() => choose(option.label, option.next)}
                            className="w-full text-left bg-white text-indigo-700 text-sm font-semibold px-4 py-2.5 rounded-xl border border-indigo-200 hover:bg-indigo-50 transition-colors"
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-1 px-3 py-2 border-t border-slate-200 bg-white text-sm">
              <button
                type="button"
                onClick={goBack}
                disabled={conversation.length === 1}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ArrowLeft className="w-4 h-4" />
                Atrás
              </button>
              <button
                type="button"
                onClick={restart}
                disabled={conversation.length === 1}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <RotateCcw className="w-4 h-4" />
                Inicio
              </button>
              <button
                type="button"
                onClick={() => runAction('guide')}
                className="ml-auto flex items-center gap-1.5 px-3 py-2 rounded-lg font-semibold text-indigo-600 hover:bg-indigo-50"
              >
                <BookOpen className="w-4 h-4" />
                Guía
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
