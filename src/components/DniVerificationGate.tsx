import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import QRCode from 'qrcode';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Smartphone,
  X,
} from 'lucide-react';

import type {
  DniExtractedData,
  DniSessionStatus,
  DniStartResponse,
  DniStatusResponse,
  PublicHomeForm,
} from '../types';

type DniVerificationGateProps = {
  form: PublicHomeForm;
  onCancel: () => void;
  onVerified: (desktopToken: string, extracted: DniExtractedData | null) => void;
};

const functionsUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const INTERVALO_SONDEO_MS = 2500;

/**
 * Marca la URL de captura para que sepa que se abre en una pestaña nueva del
 * mismo dispositivo: así, al terminar, no invita a "volver al ordenador"
 * (no lo hay) y esta pestaña, que sigue sondeando, puede continuar sola.
 */
const withSameDeviceFlag = (url: string) => {
  const [base, hash] = url.split('#');
  const separador = base.includes('?') ? '&' : '?';
  return `${base}${separador}same_device=1${hash ? `#${hash}` : ''}`;
};

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

const MENSAJES_ESTADO: Record<DniSessionStatus, string> = {
  pending: 'Esperando a que escanees el código con el móvil...',
  capturing: 'Móvil conectado. Sigue las instrucciones en su pantalla.',
  front_uploaded: 'Anverso recibido. Falta la foto del reverso.',
  processing: 'Leyendo los datos del documento...',
  extracted: 'Datos leídos. Confírmalos en el móvil.',
  confirmed: 'Verificación completada.',
  failed: 'No se han podido leer los datos. Repite las fotos en el móvil.',
  expired: 'El código ha caducado.',
};

export default function DniVerificationGate({
  form,
  onCancel,
  onVerified,
}: DniVerificationGateProps) {
  const [phase, setPhase] = useState<'notice' | 'qr'>('notice');
  const [minorWithoutDni, setMinorWithoutDni] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const [qrDataUrl, setQrDataUrl] = useState('');
  const [mobileUrl, setMobileUrl] = useState('');
  const [desktopToken, setDesktopToken] = useState('');
  const [status, setStatus] = useState<DniSessionStatus>('pending');
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState('');

  const verifiedRef = useRef(false);

  // --- Crear la sesión y generar el QR ------------------------------------
  const empezar = async () => {
    setStarting(true);
    setError('');

    try {
      const result = await postFunction<DniStartResponse>('dni-verification-start', {
        form_id: form.id,
        minor_without_dni: minorWithoutDni,
      });

      if (!result.ok || !result.mobile_url || !result.desktop_token) {
        setError(result.message ?? 'No se ha podido iniciar la verificación.');
        setStarting(false);
        return;
      }

      const dataUrl = await QRCode.toDataURL(result.mobile_url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
        color: { dark: '#1e1b4b', light: '#ffffff' },
      });

      setQrDataUrl(dataUrl);
      setMobileUrl(result.mobile_url);
      setDesktopToken(result.desktop_token);
      setExpiresAt(result.expires_at ? new Date(result.expires_at).getTime() : null);
      setStatus('pending');
      setPhase('qr');
    } catch (err) {
      console.error(err);
      setError('No se ha podido iniciar la verificación.');
    } finally {
      setStarting(false);
    }
  };

  // --- Sondeo del estado --------------------------------------------------
  const sondear = useCallback(async () => {
    if (!desktopToken || verifiedRef.current) return;

    try {
      const result = await postFunction<DniStatusResponse>('dni-verification-status', {
        desktop_token: desktopToken,
      });

      if (!result.ok || !result.status) return;

      setStatus(result.status);

      if (result.status === 'confirmed' && !verifiedRef.current) {
        verifiedRef.current = true;
        onVerified(desktopToken, result.extracted ?? null);
      }
    } catch (err) {
      console.error(err);
    }
  }, [desktopToken, onVerified]);

  useEffect(() => {
    if (phase !== 'qr' || !desktopToken) return;

    sondear();
    const intervalo = window.setInterval(sondear, INTERVALO_SONDEO_MS);

    return () => window.clearInterval(intervalo);
  }, [phase, desktopToken, sondear]);

  // --- Cuenta atrás -------------------------------------------------------
  useEffect(() => {
    if (!expiresAt) return;

    const actualizar = () => {
      const restante = expiresAt - Date.now();

      if (restante <= 0) {
        setRemaining('caducado');
        setStatus('expired');
        return;
      }

      const minutos = Math.floor(restante / 60000);
      const segundos = Math.floor((restante % 60000) / 1000);
      setRemaining(`${minutos}:${String(segundos).padStart(2, '0')}`);
    };

    actualizar();
    const intervalo = window.setInterval(actualizar, 1000);

    return () => window.clearInterval(intervalo);
  }, [expiresAt]);

  const caducado = status === 'expired';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-200 p-6 relative my-8"
      >
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
          aria-label="Cerrar"
        >
          <X className="w-5 h-5" />
        </button>

        {phase === 'notice' ? (
          <>
            <div className="flex items-start gap-3 mb-5 pr-8">
              <div className="w-11 h-11 rounded-2xl bg-amber-100 flex items-center justify-center flex-shrink-0">
                <ShieldAlert className="w-6 h-6 text-amber-700" />
              </div>

              <div>
                <h2 className="text-2xl font-bold text-slate-900 leading-tight">
                  Este formulario requiere verificar el DNI
                </h2>
                <p className="text-sm font-semibold text-slate-500 mt-1">{form.title}</p>
              </div>
            </div>

            <div className="space-y-4 text-slate-600 mb-6">
              <p>
                Para inscribirte en este formulario es necesario{' '}
                <strong>verificar el DNI del menor</strong>.
              </p>

              <p>
                Si el menor tiene menos de 14 años y todavía no dispone de DNI, habrá que
                verificar el DNI de alguno de los padres. Necesitamos comprobar que la
                familia pertenece a la <strong>zona pastoral de la parroquia</strong>, ya
                que nos vemos obligados a priorizar las inscripciones siguiendo este
                criterio.
              </p>
            </div>

            <label className="flex items-start gap-3 p-4 rounded-2xl border border-slate-200 bg-slate-50 cursor-pointer mb-6 hover:bg-slate-100 transition-colors">
              <input
                type="checkbox"
                checked={minorWithoutDni}
                onChange={(e) => setMinorWithoutDni(e.target.checked)}
                className="mt-0.5 w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm font-semibold text-slate-700">
                El menor tiene menos de 14 años y no dispone de DNI
              </span>
            </label>

            {minorWithoutDni && (
              <div className="mb-6 text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-2xl p-3">
                Verificaremos el DNI del padre, la madre o el tutor. El nombre del menor
                tendrás que escribirlo tú en el formulario.
              </div>
            )}

            {error && (
              <div className="mb-4 flex items-start gap-2 text-red-700 bg-red-50 border border-red-200 p-3 rounded-2xl">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span className="text-sm font-medium">{error}</span>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 px-6 py-3 text-slate-600 font-bold hover:bg-slate-100 rounded-xl transition-all"
              >
                Cancelar
              </button>

              <button
                type="button"
                onClick={empezar}
                disabled={starting}
                className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {starting && <Loader2 className="w-4 h-4 animate-spin" />}
                Aceptar y continuar
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-5 pr-8">
              <h2 className="text-2xl font-bold text-slate-900 leading-tight">
                Escanea el código con el móvil
              </h2>
              <p className="text-slate-600 text-sm mt-2">
                Abre la cámara del teléfono y apunta al código. Desde ahí harás las dos
                fotos del documento.
              </p>
            </div>

            <div className="flex flex-col items-center mb-5">
              <div
                className={`p-4 bg-white border-2 rounded-3xl transition-colors ${
                  caducado ? 'border-red-200 opacity-40' : 'border-slate-200'
                }`}
              >
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Código QR de verificación" className="w-56 h-56" />
                ) : (
                  <div className="w-56 h-56 flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-slate-300 animate-spin" />
                  </div>
                )}
              </div>

              {remaining && !caducado && (
                <p className="text-xs text-slate-400 mt-3">
                  El código caduca en {remaining}
                </p>
              )}
            </div>

            <div
              className={`flex items-start gap-3 p-4 rounded-2xl border mb-5 ${
                status === 'confirmed'
                  ? 'bg-green-50 border-green-200 text-green-800'
                  : status === 'failed' || caducado
                    ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-slate-50 border-slate-200 text-slate-700'
              }`}
            >
              {status === 'confirmed' ? (
                <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
              ) : status === 'failed' || caducado ? (
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              ) : (
                <Loader2 className="w-5 h-5 flex-shrink-0 mt-0.5 animate-spin" />
              )}

              <span className="text-sm font-medium">{MENSAJES_ESTADO[status]}</span>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 mb-5">
              <div className="flex items-center gap-2 text-slate-700 mb-2">
                <Smartphone className="w-4 h-4" />
                <span className="text-sm font-bold">¿Ya estás en el móvil?</span>
              </div>

              <a
                href={withSameDeviceFlag(mobileUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-semibold text-indigo-600 hover:text-indigo-700 underline break-all"
              >
                Abre la verificación en este mismo dispositivo
              </a>

              <p className="text-xs text-slate-500 mt-2">
                Se abrirá en una pestaña nueva. No cierres esta: en cuanto termines, aquí
                continuará solo el proceso de inscripción.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 px-6 py-3 text-slate-600 font-bold hover:bg-slate-100 rounded-xl transition-all"
              >
                Cancelar
              </button>

              {(caducado || status === 'failed') && (
                <button
                  type="button"
                  onClick={empezar}
                  disabled={starting}
                  className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors disabled:opacity-60"
                >
                  Generar un código nuevo
                </button>
              )}
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
