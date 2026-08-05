import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  CheckCircle2,
  IdCard,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';

import DocumentCamera from './dni/DocumentCamera';

import type {
  DniExtractedData,
  DniSessionResponse,
  DniUploadResponse,
} from '../types';

type Step =
  | 'loading'
  | 'intro'
  | 'front'
  | 'back'
  | 'processing'
  | 'review'
  | 'confirmed'
  | 'error';

const functionsUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const postFunction = async <T,>(name: string, body: unknown): Promise<T> => {
  const response = await fetch(`${functionsUrl}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  return (await response.json()) as T;
};

/** El token viaja en el fragmento (#t=...) para que nunca llegue al servidor. */
const readTokenFromHash = () => {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  return (params.get('t') ?? '').trim();
};

export default function DniCapturePage() {
  const [token] = useState(readTokenFromHash);
  const [step, setStep] = useState<Step>('loading');
  const [formTitle, setFormTitle] = useState('');
  const [minorWithoutDni, setMinorWithoutDni] = useState(false);
  const [extracted, setExtracted] = useState<DniExtractedData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [frontPreview, setFrontPreview] = useState<string | null>(null);
  const [backPreview, setBackPreview] = useState<string | null>(null);

  const titularDelDocumento = minorWithoutDni ? 'del padre, madre o tutor' : 'del menor';

  // --- Carga inicial de la sesión ----------------------------------------
  useEffect(() => {
    if (!token) {
      setError('El enlace no es válido. Vuelve a escanear el código QR.');
      setStep('error');
      return;
    }

    let cancelado = false;

    const cargar = async () => {
      try {
        const result = await postFunction<DniSessionResponse>('dni-verification-session', {
          mobile_token: token,
        });

        if (cancelado) return;

        if (!result.ok) {
          setError(
            result.message ??
              'Este código de verificación ya no es válido. Vuelve a empezar desde el ordenador.',
          );
          setStep('error');
          return;
        }

        setFormTitle(result.form_title ?? '');
        setMinorWithoutDni(Boolean(result.minor_without_dni));

        if (result.status === 'confirmed') {
          setStep('confirmed');
          return;
        }

        if (result.status === 'extracted' && result.extracted) {
          setExtracted(result.extracted);
          setStep('review');
          return;
        }

        setStep('intro');
      } catch (err) {
        console.error(err);
        if (cancelado) return;
        setError('No se ha podido conectar con el servidor.');
        setStep('error');
      }
    };

    cargar();

    return () => {
      cancelado = true;
    };
  }, [token]);

  // --- Subida de una cara -------------------------------------------------
  const subirCara = useCallback(
    async (side: 'front' | 'back', base64: string, preview: string) => {
      setUploading(true);
      setError('');
      setNotice('');

      if (side === 'front') setFrontPreview(preview);
      else setBackPreview(preview);

      if (side === 'back') setStep('processing');

      try {
        const result = await postFunction<DniUploadResponse>('dni-verification-upload', {
          mobile_token: token,
          side,
          image_b64: base64,
        });

        if (!result.ok) {
          setError(
            result.message ?? 'No se ha podido subir la foto. Inténtalo de nuevo.',
          );
          setStep(side === 'front' ? 'front' : 'back');
          return;
        }

        // Al repetir solo una cara, el servidor conserva la otra y vuelve a
        // extraer directamente: en ese caso saltamos ya a la revisión.
        if (result.status === 'extracted' && result.extracted) {
          setExtracted(result.extracted);
          setStep('review');
          return;
        }

        if (result.status === 'failed') {
          setError(
            result.message ??
              'No hemos podido leer los datos del documento. Repite las fotos con mejor luz.',
          );
          setStep(side === 'front' ? 'front' : 'back');
          return;
        }

        if (side === 'front') {
          setStep('back');
          return;
        }

        setError('Respuesta inesperada del servidor.');
        setStep('back');
      } catch (err) {
        console.error(err);
        setError('No se ha podido subir la foto. Comprueba tu conexión.');
        setStep(side === 'front' ? 'front' : 'back');
      } finally {
        setUploading(false);
      }
    },
    [token],
  );

  // --- Confirmación -------------------------------------------------------
  const confirmar = async () => {
    setUploading(true);
    setError('');

    try {
      const result = await postFunction<{ ok: boolean; message?: string }>(
        'dni-verification-confirm',
        { mobile_token: token },
      );

      if (!result.ok) {
        setError(result.message ?? 'No se ha podido confirmar la verificación.');
        return;
      }

      setStep('confirmed');
    } catch (err) {
      console.error(err);
      setError('No se ha podido confirmar la verificación.');
    } finally {
      setUploading(false);
    }
  };

  const repetir = (side: 'front' | 'back') => {
    setExtracted(null);
    setError('');
    setNotice(
      side === 'front'
        ? 'Repite solo la foto del anverso: la del reverso se conserva.'
        : 'Repite solo la foto del reverso: la del anverso se conserva.',
    );

    if (side === 'front') {
      setFrontPreview(null);
      setStep('front');
    } else {
      setBackPreview(null);
      setStep('back');
    }
  };

  const avisosRelevantes = useMemo(() => {
    if (!extracted?.avisos) return [];
    return extracted.avisos.filter(Boolean);
  }, [extracted]);

  return (
    <div className="min-h-[100dvh] bg-slate-50">
      <div className="max-w-md mx-auto px-4 py-6 pb-16">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-10 h-10 rounded-2xl bg-indigo-600 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-900 leading-tight">
              Verificación de DNI
            </p>
            {formTitle && (
              <p className="text-xs text-slate-500 truncate">{formTitle}</p>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 p-3 rounded-2xl">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <span className="text-sm font-medium">{error}</span>
          </div>
        )}

        {notice && !error && (
          <div className="mb-4 text-blue-800 bg-blue-50 border border-blue-200 p-3 rounded-2xl text-sm font-medium">
            {notice}
          </div>
        )}

        {step === 'loading' && (
          <div className="py-24 text-center">
            <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mx-auto mb-3" />
            <p className="text-slate-500 font-medium">Cargando...</p>
          </div>
        )}

        {step === 'error' && (
          <div className="bg-white border border-slate-200 rounded-3xl p-6 text-center">
            <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
            <p className="text-slate-700 font-medium">
              {error || 'Este enlace ya no es válido.'}
            </p>
          </div>
        )}

        {step === 'intro' && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white border border-slate-200 rounded-3xl p-6"
          >
            <IdCard className="w-10 h-10 text-indigo-600 mb-4" />

            <h1 className="text-2xl font-bold text-slate-900 mb-3">
              Vamos a fotografiar el DNI {titularDelDocumento}
            </h1>

            <p className="text-slate-600 mb-4">
              Necesitamos dos fotos: primero el <strong>anverso</strong> (la cara con la
              fotografía) y después el <strong>reverso</strong> (la cara con el domicilio).
            </p>

            <ul className="space-y-2 text-sm text-slate-600 mb-6">
              <li className="flex gap-2">
                <span className="text-indigo-600 font-bold">1.</span>
                Apoya el documento sobre una superficie lisa y de color liso.
              </li>
              <li className="flex gap-2">
                <span className="text-indigo-600 font-bold">2.</span>
                Encájalo dentro del marco que verás en pantalla.
              </li>
              <li className="flex gap-2">
                <span className="text-indigo-600 font-bold">3.</span>
                Evita reflejos y sombras: el botón se activa solo cuando la foto vale.
              </li>
            </ul>

            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 mb-6">
              <p className="text-xs text-slate-500">
                Las fotos se envían cifradas, se usan solo para leer el nombre, el número
                de DNI y el domicilio, y <strong>se borran en cuanto confirmes los datos</strong>.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setStep('front')}
              className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold"
            >
              Empezar
            </button>
          </motion.div>
        )}

        {step === 'front' && (
          <DocumentCamera
            title="Anverso del documento"
            hint="La cara con la fotografía, el nombre y los apellidos."
            onCapture={(base64, preview) => subirCara('front', base64, preview)}
          />
        )}

        {step === 'back' && (
          <DocumentCamera
            title="Reverso del documento"
            hint="La cara con el domicilio y la banda de caracteres."
            onCapture={(base64, preview) => subirCara('back', base64, preview)}
          />
        )}

        {(step === 'processing' || uploading) && step !== 'review' && (
          <div className="mt-6 flex items-center justify-center gap-3 text-slate-600">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm font-medium">
              {step === 'processing' ? 'Leyendo el documento...' : 'Subiendo la foto...'}
            </span>
          </div>
        )}

        {step === 'review' && extracted && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            <div className="bg-white border border-slate-200 rounded-3xl p-6">
              <h2 className="text-xl font-bold text-slate-900 mb-1">
                Esto es lo que hemos leído
              </h2>
              <p className="text-sm text-slate-600 mb-5">
                Comprueba que todo es correcto antes de continuar.
              </p>

              <div className="space-y-4">
                {!minorWithoutDni && (
                  <CampoLeido
                    etiqueta="Nombre completo"
                    valor={extracted.nombre}
                  />
                )}

                <CampoLeido
                  etiqueta="Número de DNI"
                  valor={extracted.numero}
                  aviso={
                    extracted.numero && extracted.numero_valido === false
                      ? 'La letra del DNI no cuadra con el número. Revísalo bien.'
                      : undefined
                  }
                />

                <CampoLeido
                  etiqueta="Domicilio"
                  valor={extracted.domicilio_texto}
                />
              </div>

              {minorWithoutDni && (
                <p className="mt-5 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-2xl p-3">
                  Como el menor no dispone de DNI, en el formulario solo se rellenarán el
                  número de DNI y el domicilio. El nombre lo tendrás que escribir tú.
                </p>
              )}

              {avisosRelevantes.length > 0 && (
                <ul className="mt-5 space-y-1.5">
                  {avisosRelevantes.map((aviso) => (
                    <li
                      key={aviso}
                      className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2"
                    >
                      {aviso}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <button
              type="button"
              onClick={confirmar}
              disabled={uploading}
              className="w-full bg-green-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-5 h-5" />
              )}
              Los datos son correctos
            </button>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => repetir('front')}
                disabled={uploading}
                className="py-3 rounded-2xl font-semibold text-sm bg-white border border-slate-200 text-slate-700 flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <RotateCcw className="w-4 h-4" />
                Repetir anverso
              </button>

              <button
                type="button"
                onClick={() => repetir('back')}
                disabled={uploading}
                className="py-3 rounded-2xl font-semibold text-sm bg-white border border-slate-200 text-slate-700 flex items-center justify-center gap-2 disabled:opacity-60"
              >
                <RotateCcw className="w-4 h-4" />
                Repetir reverso
              </button>
            </div>

            {(frontPreview || backPreview) && (
              <div className="grid grid-cols-2 gap-3 pt-2">
                {frontPreview && (
                  <img
                    src={frontPreview}
                    alt="Anverso capturado"
                    className="w-full rounded-xl border border-slate-200"
                  />
                )}
                {backPreview && (
                  <img
                    src={backPreview}
                    alt="Reverso capturado"
                    className="w-full rounded-xl border border-slate-200"
                  />
                )}
              </div>
            )}
          </motion.div>
        )}

        {step === 'confirmed' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white border border-slate-200 rounded-3xl p-8 text-center"
          >
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-9 h-9 text-green-600" />
            </div>

            <h2 className="text-2xl font-bold text-slate-900 mb-2">
              Verificación completada
            </h2>

            <p className="text-slate-600 mb-6">
              Ya puedes volver al ordenador: allí continuará el proceso de inscripción con
              los datos ya rellenados.
            </p>

            <p className="text-xs text-slate-500">
              Las fotos del documento ya se han borrado de nuestros servidores.
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}

function CampoLeido({
  etiqueta,
  valor,
  aviso,
}: {
  etiqueta: string;
  valor: string | null | undefined;
  aviso?: string;
}) {
  const vacio = !valor || !valor.trim();

  return (
    <div>
      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">
        {etiqueta}
      </p>

      <p
        className={`text-base font-semibold break-words ${
          vacio ? 'text-red-600' : 'text-slate-900'
        }`}
      >
        {vacio ? 'No se ha podido leer' : valor}
      </p>

      {aviso && <p className="text-xs text-amber-700 mt-1">{aviso}</p>}
    </div>
  );
}
