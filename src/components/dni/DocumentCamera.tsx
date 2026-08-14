import { useCallback, useEffect, useRef, useState } from 'react';
import { Zap, ZapOff, AlertCircle, RotateCcw } from 'lucide-react';

import {
  DNI_ASPECT_RATIO,
  NITIDEZ_MINIMA_AVISO,
  analyzeFrame,
  drawVisibleRegion,
  guideRectToVideoCrop,
  nitidezCapturada,
  nitidezDeLienzo,
  type FrameAnalysis,
  type GuideRect,
} from '../../lib/dniFrameAnalyzer';

type DocumentCameraProps = {
  /** Texto que describe qué cara hay que fotografiar. */
  title: string;
  hint?: string;
  onCapture: (jpegBase64: string, previewUrl: string) => void;
  onError?: (message: string) => void;
};

/** Milisegundos entre análisis de fotograma. */
const INTERVALO_ANALISIS = 140;

/** Fotogramas correctos seguidos antes de habilitar el disparo. */
const FOTOGRAMAS_ESTABLES = 3;

/** Ancho del lienzo reducido donde se analiza cada fotograma. */
const ANCHO_ANALISIS = 320;

/**
 * Si el análisis lleva bloqueado este tiempo, se ofrece disparar igualmente.
 * El comprobador es una ayuda, no un guardián: el servicio de OCR vuelve a
 * detectar y recortar el documento por su cuenta, así que más vale una foto
 * imperfecta que un usuario atrapado sin poder continuar.
 */
const MS_HASTA_FORZAR = 6000;

/** Margen lateral del marco guía dentro del área de la cámara. */
const MARGEN_MARCO = 0.06;

export default function DocumentCamera({
  title,
  hint,
  onCapture,
  onError,
}: DocumentCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const estableRef = useRef(0);
  const bloqueadoDesdeRef = useRef<number | null>(null);

  const [analysis, setAnalysis] = useState<FrameAnalysis | null>(null);
  const [ready, setReady] = useState(false);
  const [stableCount, setStableCount] = useState(0);
  const [cameraError, setCameraError] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [puedeForzar, setPuedeForzar] = useState(false);
  const [verDiagnostico, setVerDiagnostico] = useState(false);
  const [avisoBorrosa, setAvisoBorrosa] = useState<{
    base64: string;
    dataUrl: string;
    nitidez: number;
  } | null>(null);
  const [guide, setGuide] = useState<GuideRect>({
    x: MARGEN_MARCO,
    y: 0.25,
    width: 1 - MARGEN_MARCO * 2,
    height: 0.5,
  });

  // --- Marco guía: siempre con la proporción exacta del DNI ---------------
  const recalcularMarco = useCallback(() => {
    const contenedor = containerRef.current;
    if (!contenedor) return;

    const ancho = contenedor.clientWidth;
    const alto = contenedor.clientHeight;

    if (!ancho || !alto) return;

    let anchoMarco = ancho * (1 - MARGEN_MARCO * 2);
    let altoMarco = anchoMarco / DNI_ASPECT_RATIO;

    const altoMaximo = alto * 0.72;

    if (altoMarco > altoMaximo) {
      altoMarco = altoMaximo;
      anchoMarco = altoMarco * DNI_ASPECT_RATIO;
    }

    setGuide({
      x: (ancho - anchoMarco) / 2 / ancho,
      y: (alto - altoMarco) / 2 / alto,
      width: anchoMarco / ancho,
      height: altoMarco / alto,
    });
  }, []);

  // --- Arranque de la cámara ---------------------------------------------
  useEffect(() => {
    let cancelado = false;

    const arrancar = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        const mensaje =
          'Este navegador no permite acceder a la cámara. Prueba con Chrome o Safari.';
        setCameraError(mensaje);
        onError?.(mensaje);
        return;
      }

      try {
        // Se pide toda la resolución posible. Las etiquetas del DNI miden
        // ~1,2 mm: con un flujo de 1080p el recorte del marco sale a unos
        // 950 px de ancho y esas etiquetas quedan en 13 px de alto, por
        // debajo de lo que Tesseract puede leer. Hacen falta ~1900 px.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });

        if (cancelado) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }

        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { torch?: boolean })
          | undefined;

        setTorchAvailable(Boolean(capabilities?.torch));
        setReady(true);
        recalcularMarco();

        const ajustes = track?.getSettings?.();
        console.info(
          `[DNI] Cámara: ${ajustes?.width ?? '?'}x${ajustes?.height ?? '?'}`,
          `(máximo del dispositivo: ${capabilities?.width?.max ?? '?'}x${capabilities?.height?.max ?? '?'})`,
        );
      } catch (error) {
        console.error(error);

        const mensaje =
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Necesitamos permiso para usar la cámara. Actívalo y vuelve a intentarlo.'
            : 'No se ha podido abrir la cámara del dispositivo.';

        setCameraError(mensaje);
        onError?.(mensaje);
      }
    };

    arrancar();

    return () => {
      cancelado = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    // onError es estable en la práctica; no queremos reabrir la cámara por él.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalcularMarco]);

  useEffect(() => {
    window.addEventListener('resize', recalcularMarco);
    window.addEventListener('orientationchange', recalcularMarco);

    return () => {
      window.removeEventListener('resize', recalcularMarco);
      window.removeEventListener('orientationchange', recalcularMarco);
    };
  }, [recalcularMarco]);

  // --- Bucle de análisis --------------------------------------------------
  useEffect(() => {
    if (!ready || cameraError) return;

    let temporizador: number;
    let activo = true;

    const analizar = () => {
      if (!activo) return;

      const video = videoRef.current;
      const contenedor = containerRef.current;
      const lienzo = analysisCanvasRef.current;

      if (video && contenedor && lienzo && video.readyState >= 2) {
        const ancho = contenedor.clientWidth;
        const alto = contenedor.clientHeight;

        if (ancho && alto) {
          const anchoLienzo = ANCHO_ANALISIS;
          const altoLienzo = Math.max(1, Math.round((ANCHO_ANALISIS * alto) / ancho));

          if (lienzo.width !== anchoLienzo || lienzo.height !== altoLienzo) {
            lienzo.width = anchoLienzo;
            lienzo.height = altoLienzo;
          }

          const ctx = drawVisibleRegion(video, lienzo, ancho, alto);

          if (ctx) {
            const resultado = analyzeFrame(ctx, anchoLienzo, altoLienzo, guide);

            setAnalysis(resultado);

            estableRef.current = resultado.ok ? estableRef.current + 1 : 0;
            setStableCount(estableRef.current);

            // Cuenta cuánto tiempo llevamos sin poder disparar, para ofrecer
            // la captura manual si el análisis se atasca.
            if (estableRef.current >= FOTOGRAMAS_ESTABLES) {
              bloqueadoDesdeRef.current = null;
              setPuedeForzar(false);
            } else {
              bloqueadoDesdeRef.current ??= Date.now();

              if (Date.now() - bloqueadoDesdeRef.current > MS_HASTA_FORZAR) {
                setPuedeForzar(true);
              }
            }
          }
        }
      }

      temporizador = window.setTimeout(analizar, INTERVALO_ANALISIS);
    };

    analizar();

    return () => {
      activo = false;
      window.clearTimeout(temporizador);
    };
  }, [ready, cameraError, guide]);

  // --- Linterna -----------------------------------------------------------
  const alternarLinterna = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;

    const siguiente = !torchOn;

    try {
      await track.applyConstraints({
        advanced: [{ torch: siguiente } as MediaTrackConstraintSet],
      });
      setTorchOn(siguiente);
    } catch (error) {
      console.error('No se ha podido cambiar la linterna:', error);
      setTorchAvailable(false);
    }
  };

  // --- Captura ------------------------------------------------------------
  /**
   * Intenta una foto a resolución de cámara, no de vista previa.
   *
   * `takePhoto()` usa el sensor completo (varios megapíxeles) en lugar del
   * flujo de vídeo, que suele ir a 1080p. Solo se acepta si conserva la misma
   * proporción que el vídeo: si el móvil devuelve la foto en otro formato, el
   * marco guía ya no se correspondería con lo que ve el usuario.
   */
  const obtenerFuenteDeCaptura = async (
    video: HTMLVideoElement,
  ): Promise<{ fuente: CanvasImageSource; ancho: number; alto: number }> => {
    const track = streamRef.current?.getVideoTracks()[0];

    const CapturaDeImagen = (
      window as unknown as {
        ImageCapture?: new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> };
      }
    ).ImageCapture;

    if (track && CapturaDeImagen) {
      try {
        const captura = new CapturaDeImagen(track);
        const bitmap = await createImageBitmap(await captura.takePhoto());

        const proporcionFoto = bitmap.width / bitmap.height;
        const proporcionVideo = video.videoWidth / video.videoHeight;

        if (
          Math.abs(proporcionFoto - proporcionVideo) < 0.03 &&
          bitmap.width > video.videoWidth
        ) {
          return { fuente: bitmap, ancho: bitmap.width, alto: bitmap.height };
        }

        bitmap.close();
      } catch {
        // Muchos navegadores no lo permiten; se usa el fotograma de vídeo.
      }
    }

    return { fuente: video, ancho: video.videoWidth, alto: video.videoHeight };
  };

  /** Dibuja el recorte del marco a partir de una fuente, a máxima resolución. */
  const recortarMarco = (
    fuente: CanvasImageSource,
    anchoFuente: number,
    video: HTMLVideoElement,
    contenedor: HTMLDivElement,
  ): HTMLCanvasElement | null => {
    const { sx, sy, sw, sh } = guideRectToVideoCrop(
      video,
      contenedor.clientWidth,
      contenedor.clientHeight,
      guide,
    );

    const factor = anchoFuente / video.videoWidth;

    const rw = sw * factor;
    const rh = sh * factor;

    // Se conserva la resolución disponible hasta 2200 px. El servicio de OCR
    // la normaliza después, pero necesita detalle real: las etiquetas del
    // documento miden ~1,2 mm y por debajo de ~1500 px de ancho de tarjeta
    // quedan demasiado pequeñas para leerse.
    const anchoDestino = Math.min(2200, Math.round(rw));

    if (anchoDestino < 10) return null;

    const lienzo = document.createElement('canvas');
    lienzo.width = anchoDestino;
    lienzo.height = Math.round((anchoDestino * rh) / rw);

    const ctx = lienzo.getContext('2d');
    if (!ctx) return null;

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fuente, sx * factor, sy * factor, rw, rh, 0, 0, lienzo.width, lienzo.height);

    return lienzo;
  };

  const capturar = async () => {
    const video = videoRef.current;
    const contenedor = containerRef.current;

    if (!video || !contenedor || capturing) return;

    setCapturing(true);

    try {
      // Siempre se prepara el fotograma de vídeo, que es lo que el usuario ha
      // visto y lo que el comprobador de encuadre ha dado por bueno.
      const desdeVideo = recortarMarco(video, video.videoWidth, video, contenedor);

      if (!desdeVideo) return;

      let elegido = desdeVideo;

      // La foto del sensor tiene más resolución, pero puede salir movida o
      // sin enfocar: `takePhoto()` no siempre espera al autoenfoque. Se
      // compara la nitidez de ambas y se usa la mejor.
      const { fuente, ancho } = await obtenerFuenteDeCaptura(video);

      if (fuente !== video) {
        const desdeSensor = recortarMarco(fuente, ancho, video, contenedor);
        (fuente as ImageBitmap).close();

        if (desdeSensor) {
          const nitidezVideo = nitidezDeLienzo(desdeVideo);
          const nitidezSensor = nitidezDeLienzo(desdeSensor);

          console.info(
            `[DNI] Nitidez -> vídeo ${nitidezVideo.toFixed(0)} (${desdeVideo.width}px), ` +
              `sensor ${nitidezSensor.toFixed(0)} (${desdeSensor.width}px)`,
          );

          // Se exige que la del sensor sea claramente mejor para preferirla:
          // ante la duda, la que el usuario ha visto y validado.
          if (nitidezSensor > nitidezVideo * 0.9) {
            elegido = desdeSensor;
          }
        }
      }

      const dataUrl = elegido.toDataURL('image/jpeg', 0.92);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

      // El comprobador en vivo mide sobre un fotograma reducido a 320 px, muy
      // permisivo a propósito; esta es la única comprobación sobre la foto
      // que de verdad se va a subir. Solo avisa, no bloquea: mejor dejar
      // seguir a quien lo necesite que atraparlo sin poder continuar.
      const nitidez = nitidezCapturada(elegido);
      console.info(
        `[DNI] Nitidez de la foto capturada: ${nitidez.toFixed(0)} ` +
          `(aviso por debajo de ${NITIDEZ_MINIMA_AVISO})`,
      );

      if (nitidez < NITIDEZ_MINIMA_AVISO) {
        setAvisoBorrosa({ base64, dataUrl, nitidez });
        return;
      }

      onCapture(base64, dataUrl);
    } finally {
      setCapturing(false);
    }
  };

  const repetirTrasAviso = () => setAvisoBorrosa(null);

  const usarFotoBorrosa = () => {
    if (!avisoBorrosa) return;
    onCapture(avisoBorrosa.base64, avisoBorrosa.dataUrl);
    setAvisoBorrosa(null);
  };

  const puedeCapturar = ready && !cameraError && stableCount >= FOTOGRAMAS_ESTABLES;
  const estadoOk = analysis?.ok ?? false;

  /** Ancho en píxeles reales que tendrá la foto del documento. */
  const anchoRecorte = (() => {
    const video = videoRef.current;
    const contenedor = containerRef.current;

    if (!video?.videoWidth || !contenedor?.clientWidth) return 0;

    return Math.round(
      guideRectToVideoCrop(
        video,
        contenedor.clientWidth,
        contenedor.clientHeight,
        guide,
      ).sw,
    );
  })();

  const colorMarco = !ready
    ? 'rgba(255,255,255,0.5)'
    : puedeCapturar
      ? '#22c55e'
      : estadoOk
        ? '#facc15'
        : '#f87171';

  if (cameraError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-2xl p-6 text-center">
        <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
        <p className="text-red-700 font-medium">{cameraError}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900">{title}</h2>
        {hint && <p className="text-sm text-slate-600 mt-1">{hint}</p>}
      </div>

      {/* Altura limitada al viewport: con `aspect-ratio: 3/4` el visor medía
          casi 480 px en un móvil y empujaba el botón de disparo fuera de la
          pantalla, obligando a hacer scroll con el móvil sobre el documento. */}
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-3xl bg-slate-900"
        style={{ height: 'min(58dvh, 133vw, 520px)' }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* Máscara oscura con la ventana del marco recortada */}
        <div className="absolute inset-0 pointer-events-none">
          <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 100">
            <defs>
              <mask id="dni-guide-mask">
                <rect x="0" y="0" width="100" height="100" fill="white" />
                <rect
                  x={guide.x * 100}
                  y={guide.y * 100}
                  width={guide.width * 100}
                  height={guide.height * 100}
                  rx="2"
                  fill="black"
                />
              </mask>
            </defs>
            <rect
              x="0"
              y="0"
              width="100"
              height="100"
              fill="rgba(15, 23, 42, 0.6)"
              mask="url(#dni-guide-mask)"
            />
          </svg>
        </div>

        {/* Borde del marco */}
        <div
          className="absolute pointer-events-none rounded-2xl transition-colors duration-200"
          style={{
            left: `${guide.x * 100}%`,
            top: `${guide.y * 100}%`,
            width: `${guide.width * 100}%`,
            height: `${guide.height * 100}%`,
            border: `3px solid ${colorMarco}`,
            boxShadow: puedeCapturar ? `0 0 0 4px ${colorMarco}33` : 'none',
          }}
        >
          {/* Esquinas */}
          {(
            [
              'top-0 left-0 border-t-4 border-l-4 rounded-tl-2xl',
              'top-0 right-0 border-t-4 border-r-4 rounded-tr-2xl',
              'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-2xl',
              'bottom-0 right-0 border-b-4 border-r-4 rounded-br-2xl',
            ] as const
          ).map((clases) => (
            <span
              key={clases}
              className={`absolute w-7 h-7 ${clases}`}
              style={{ borderColor: colorMarco }}
            />
          ))}
        </div>

        {/* Disparador flotante, siempre visible sobre el visor. */}
        <div className="absolute left-0 right-0 bottom-4 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={capturar}
            disabled={(!puedeCapturar && !puedeForzar) || capturing}
            aria-label="Hacer la foto"
            className={`w-[72px] h-[72px] rounded-full flex items-center justify-center transition-all ${
              puedeCapturar
                ? 'bg-white ring-4 ring-green-500 shadow-2xl scale-100'
                : puedeForzar
                  ? 'bg-white/85 ring-4 ring-white/60 shadow-xl'
                  : 'bg-white/25 ring-4 ring-white/25 scale-90'
            }`}
          >
            <span
              className={`rounded-full transition-all ${
                puedeCapturar
                  ? 'w-14 h-14 bg-green-500'
                  : puedeForzar
                    ? 'w-14 h-14 bg-slate-400'
                    : 'w-12 h-12 bg-white/40'
              }`}
            />
          </button>

          {puedeForzar && !puedeCapturar && (
            <span className="text-[11px] font-semibold text-white/90 bg-slate-900/70 px-3 py-1 rounded-full backdrop-blur">
              Puedes disparar igualmente
            </span>
          )}
        </div>

        {/* Aviso de encuadre. Al tocarlo se ven los números, por si hay que
            diagnosticar por qué no se desbloquea el disparador. */}
        <div className="absolute left-0 right-0 top-4 px-4">
          <button
            type="button"
            onClick={() => setVerDiagnostico((v) => !v)}
            className={`block mx-auto max-w-xs text-center text-sm font-semibold px-4 py-2.5 rounded-full backdrop-blur ${
              puedeCapturar
                ? 'bg-green-500/90 text-white'
                : 'bg-slate-900/75 text-white'
            }`}
          >
            {!ready ? 'Abriendo la cámara...' : analysis?.message ?? 'Buscando el documento...'}
          </button>

          {verDiagnostico && analysis && (
            <div className="mx-auto mt-2 max-w-xs rounded-2xl bg-slate-900/85 px-4 py-3 text-[11px] font-mono text-slate-100 backdrop-blur">
              <div className="flex justify-between">
                <span>cobertura</span>
                <span>{(analysis.metrics.cobertura * 100).toFixed(0)}%</span>
              </div>
              <div className="flex justify-between">
                <span>detalle dentro</span>
                <span>{analysis.metrics.detalleDentro.toFixed(1)}</span>
              </div>
              <div className="flex justify-between">
                <span>detalle fuera</span>
                <span>{analysis.metrics.detalleFuera.toFixed(1)}</span>
              </div>
              <div className="flex justify-between">
                <span>nitidez</span>
                <span>{analysis.metrics.nitidez.toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span>luz</span>
                <span>{analysis.metrics.luz.toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span>reflejo</span>
                <span>{(analysis.metrics.reflejo * 100).toFixed(1)}%</span>
              </div>
              <div className="mt-1.5 border-t border-slate-700 pt-1.5 flex justify-between">
                <span>motivo</span>
                <span>{analysis.issue ?? 'ninguno'}</span>
              </div>
              <div className="flex justify-between">
                <span>cámara</span>
                <span>
                  {videoRef.current?.videoWidth ?? 0}x{videoRef.current?.videoHeight ?? 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span>recorte</span>
                <span
                  className={anchoRecorte < 1400 ? 'text-amber-400' : 'text-green-400'}
                >
                  {anchoRecorte} px
                </span>
              </div>
            </div>
          )}
        </div>

        {torchAvailable && (
          <button
            type="button"
            onClick={alternarLinterna}
            className="absolute top-4 right-4 w-11 h-11 rounded-full bg-slate-900/70 text-white flex items-center justify-center backdrop-blur"
            aria-label={torchOn ? 'Apagar la linterna' : 'Encender la linterna'}
          >
            {torchOn ? <ZapOff className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
          </button>
        )}

        {/* Aviso tras disparar: la foto capturada mide por debajo del umbral
            de nitidez. No bloquea -- el comprobador en vivo ya es permisivo
            a propósito -- pero avisa antes de gastar el minuto de lectura en
            el servidor con una foto que probablemente no sirva. */}
        {avisoBorrosa && (
          <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-sm flex flex-col items-center justify-center gap-4 p-6 text-center">
            <img
              src={avisoBorrosa.dataUrl}
              alt="Foto capturada"
              className="max-h-[45%] w-auto rounded-xl border border-white/20"
            />

            <div>
              <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-2" />
              <p className="text-white font-bold">Esta foto puede haber salido borrosa</p>
              <p className="text-white/70 text-sm mt-1 max-w-xs">
                Es justo lo que más falla al leer el domicilio. Si puedes, repítela
                sujetando el móvil quieto hasta que enfoque.
              </p>
            </div>

            <div className="w-full max-w-xs space-y-2">
              <button
                type="button"
                onClick={repetirTrasAviso}
                className="w-full bg-white text-slate-900 py-3 rounded-2xl font-bold flex items-center justify-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Repetir la foto
              </button>

              <button
                type="button"
                onClick={usarFotoBorrosa}
                className="w-full py-3 rounded-2xl font-semibold text-sm text-white/80 border border-white/25"
              >
                Usar esta foto igualmente
              </button>
            </div>
          </div>
        )}
      </div>

      <canvas ref={analysisCanvasRef} className="hidden" />

      <p className="text-center text-xs text-slate-500">
        {puedeCapturar
          ? 'Pulsa el botón blanco para hacer la foto.'
          : puedeForzar
            ? 'El botón sigue activo: puedes hacer la foto aunque el encuadre no esté perfecto.'
            : 'El botón se activará solo cuando el documento esté bien encuadrado.'}
      </p>
    </div>
  );
}
