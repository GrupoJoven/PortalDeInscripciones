/**
 * Análisis en tiempo real de los fotogramas de la cámara para decidir si la
 * foto del documento va a servir antes de dispararla.
 *
 * Todo en JS puro sobre un lienzo reducido (~320 px de ancho), así que el
 * coste por fotograma es despreciable incluso en móviles antiguos.
 *
 * Comprobaciones:
 *   1. Luz       - luminancia media dentro del marco.
 *   2. Encuadre  - se compara la cantidad de detalle DENTRO del marco con la
 *                  de un anillo justo por fuera.
 *   3. Reflejos  - proporción de píxeles quemados.
 *   4. Nitidez   - varianza del laplaciano (detecta trepidación y desenfoque).
 *
 * Sobre el encuadre: la primera versión estimaba el color del fondo a partir
 * de los bordes del fotograma y marcaba como "documento" cualquier píxel que
 * se diferenciara de él. Era demasiado frágil: una sombra o un degradado de
 * luz sobre la mesa bastaba para que casi todo el fotograma contase como
 * documento y siempre pareciera salirse del marco. Ahora solo se mira la zona
 * inmediatamente pegada al marco, que es lo único que de verdad importa.
 *
 * Aun así, esto es una ayuda, no un guardián: el pipeline de Python vuelve a
 * detectar y recortar el documento por su cuenta. Por eso la interfaz permite
 * disparar igualmente si el análisis se atasca.
 */

/** Proporción del formato ID-1: 85,60 x 53,98 mm. */
export const DNI_ASPECT_RATIO = 85.6 / 53.98;

/** Rectángulo del marco guía en proporciones (0-1) sobre el área visible. */
export interface GuideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FrameIssue =
  | 'no_document'
  | 'out_of_frame'
  | 'blurry'
  | 'too_dark'
  | 'too_bright'
  | 'glare';

export interface FrameMetrics {
  /** Detalle (gradiente medio) dentro del marco. El DNI tiene mucho. */
  detalleDentro: number;
  /** Detalle en el anillo justo por fuera del marco. La mesa tiene poco. */
  detalleFuera: number;
  nitidez: number;
  luz: number;
  reflejo: number;
}

export interface FrameAnalysis {
  ok: boolean;
  issue: FrameIssue | null;
  message: string;
  metrics: FrameMetrics;
}

const MENSAJES: Record<FrameIssue, string> = {
  no_document: 'Encaja el documento dentro del marco',
  out_of_frame: 'El documento se sale del marco',
  blurry: 'Mantén el móvil quieto para enfocar',
  too_dark: 'Hace falta más luz',
  too_bright: 'Hay demasiada luz, aléjate del foco',
  glare: 'Evita los reflejos sobre el documento',
};

export const MENSAJE_CORRECTO = 'Encuadre correcto, ya puedes hacer la foto';

// --- Umbrales -------------------------------------------------------------
// Deliberadamente permisivos: una foto regular que el OCR sabe arreglar es
// mucho mejor que un usuario bloqueado sin poder disparar.
const UMBRALES = {
  /** Por debajo, dentro del marco no hay nada con aspecto de documento. */
  detalleMinimoDentro: 3.5,
  /** El anillo exterior solo delata desbordamiento si tiene tanto detalle
   *  como el interior y además es alto en términos absolutos. */
  detalleFueraAbsoluto: 5.0,
  proporcionFueraDentro: 0.85,
  nitidezMinima: 18,
  luzMinima: 45,
  luzMaxima: 232,
  reflejoMaximo: 0.09,
};

/** Cuánto se mete hacia dentro la zona analizada, respecto al marco. */
const MARGEN_INTERIOR = 0.06;

/** Ancho del anillo exterior, en proporción al tamaño del marco. */
const ANCHO_ANILLO = 0.08;

/**
 * Recorta la zona visible del vídeo (equivalente a object-fit: cover) y la
 * dibuja en el lienzo de análisis, para que las proporciones del marco guía
 * coincidan con lo que ve el usuario.
 */
export function drawVisibleRegion(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  containerWidth: number,
  containerHeight: number,
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx || !video.videoWidth || !video.videoHeight || !containerWidth || !containerHeight) {
    return null;
  }

  const escala = Math.max(
    containerWidth / video.videoWidth,
    containerHeight / video.videoHeight,
  );

  const anchoVisible = containerWidth / escala;
  const altoVisible = containerHeight / escala;

  const origenX = (video.videoWidth - anchoVisible) / 2;
  const origenY = (video.videoHeight - altoVisible) / 2;

  ctx.drawImage(
    video,
    origenX,
    origenY,
    anchoVisible,
    altoVisible,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return ctx;
}

/**
 * Devuelve el recorte del vídeo original correspondiente al marco guía,
 * para capturar la foto a máxima resolución.
 */
export function guideRectToVideoCrop(
  video: HTMLVideoElement,
  containerWidth: number,
  containerHeight: number,
  guide: GuideRect,
) {
  const escala = Math.max(
    containerWidth / video.videoWidth,
    containerHeight / video.videoHeight,
  );

  const anchoVisible = containerWidth / escala;
  const altoVisible = containerHeight / escala;

  const origenX = (video.videoWidth - anchoVisible) / 2;
  const origenY = (video.videoHeight - altoVisible) / 2;

  return {
    sx: origenX + guide.x * anchoVisible,
    sy: origenY + guide.y * altoVisible,
    sw: guide.width * anchoVisible,
    sh: guide.height * altoVisible,
  };
}

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function analyzeFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  guide: GuideRect,
): FrameAnalysis {
  const { data } = ctx.getImageData(0, 0, width, height);

  const luma = new Float32Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const marco: Region = {
    x0: Math.round(guide.x * width),
    y0: Math.round(guide.y * height),
    x1: Math.round((guide.x + guide.width) * width),
    y1: Math.round((guide.y + guide.height) * height),
  };

  const anchoMarco = marco.x1 - marco.x0;
  const altoMarco = marco.y1 - marco.y0;

  // Zona interior: el marco metido un poco hacia dentro, para no contar el
  // propio borde de la tarjeta como si fuera detalle del documento.
  const interior: Region = {
    x0: marco.x0 + anchoMarco * MARGEN_INTERIOR,
    y0: marco.y0 + altoMarco * MARGEN_INTERIOR,
    x1: marco.x1 - anchoMarco * MARGEN_INTERIOR,
    y1: marco.y1 - altoMarco * MARGEN_INTERIOR,
  };

  // Anillo exterior: banda pegada al marco por fuera, recortada al lienzo.
  const exterior: Region = {
    x0: Math.max(0, marco.x0 - anchoMarco * ANCHO_ANILLO),
    y0: Math.max(0, marco.y0 - altoMarco * ANCHO_ANILLO),
    x1: Math.min(width, marco.x1 + anchoMarco * ANCHO_ANILLO),
    y1: Math.min(height, marco.y1 + altoMarco * ANCHO_ANILLO),
  };

  const luz = medirLuz(luma, width, interior);
  const nitidez = medirNitidez(luma, width, interior);
  const detalleDentro = medirDetalle(luma, width, interior, null);
  const detalleFuera = medirDetalle(luma, width, exterior, marco);

  const metrics: FrameMetrics = {
    detalleDentro,
    detalleFuera,
    nitidez,
    luz: luz.media,
    reflejo: luz.reflejo,
  };

  const issue = detectarProblema(metrics);

  return {
    ok: issue === null,
    issue,
    message: issue ? MENSAJES[issue] : MENSAJE_CORRECTO,
    metrics,
  };
}

function detectarProblema(m: FrameMetrics): FrameIssue | null {
  // Primero lo que impide ver siquiera el documento.
  if (m.luz < UMBRALES.luzMinima) return 'too_dark';
  if (m.luz > UMBRALES.luzMaxima) return 'too_bright';

  if (m.detalleDentro < UMBRALES.detalleMinimoDentro) return 'no_document';

  // Solo damos por desbordado el documento si por fuera del marco hay tanto
  // detalle como por dentro. Un fondo liso apenas tiene, así que esto no se
  // dispara con sombras ni con degradados de luz.
  if (
    m.detalleFuera > UMBRALES.detalleFueraAbsoluto &&
    m.detalleFuera > m.detalleDentro * UMBRALES.proporcionFueraDentro
  ) {
    return 'out_of_frame';
  }

  if (m.reflejo > UMBRALES.reflejoMaximo) return 'glare';
  if (m.nitidez < UMBRALES.nitidezMinima) return 'blurry';

  return null;
}

function medirLuz(luma: Float32Array, width: number, region: Region) {
  const x0 = Math.max(0, Math.floor(region.x0));
  const y0 = Math.max(0, Math.floor(region.y0));
  const x1 = Math.floor(region.x1);
  const y1 = Math.floor(region.y1);

  let suma = 0;
  let quemados = 0;
  let total = 0;

  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const valor = luma[y * width + x];
      suma += valor;
      if (valor > 248) quemados += 1;
      total += 1;
    }
  }

  if (total === 0) return { media: 0, reflejo: 1 };

  return { media: suma / total, reflejo: quemados / total };
}

/**
 * Gradiente medio de una región: alto donde hay texto, fotografía o bordes;
 * casi cero en una superficie lisa, aunque esté en sombra o mal iluminada.
 *
 * Si se pasa `excluir`, los píxeles dentro de ese rectángulo se ignoran, que
 * es como se obtiene el anillo exterior.
 */
function medirDetalle(
  luma: Float32Array,
  width: number,
  region: Region,
  excluir: Region | null,
) {
  const x0 = Math.max(1, Math.floor(region.x0));
  const y0 = Math.max(1, Math.floor(region.y0));
  const x1 = Math.min(width - 1, Math.floor(region.x1));
  const y1 = Math.min(luma.length / width - 1, Math.floor(region.y1));

  let suma = 0;
  let total = 0;

  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      if (
        excluir &&
        x >= excluir.x0 &&
        x < excluir.x1 &&
        y >= excluir.y0 &&
        y < excluir.y1
      ) {
        continue;
      }

      const i = y * width + x;

      const dx = Math.abs(luma[i + 1] - luma[i - 1]);
      const dy = Math.abs(luma[i + width] - luma[i - width]);

      suma += dx + dy;
      total += 1;
    }
  }

  return total === 0 ? 0 : suma / total;
}

/** Varianza del laplaciano 3x3: cuanto más alta, más nítida es la imagen. */
function medirNitidez(luma: Float32Array, width: number, region: Region) {
  const x0 = Math.max(1, Math.floor(region.x0));
  const y0 = Math.max(1, Math.floor(region.y0));
  const x1 = Math.min(width - 1, Math.floor(region.x1));
  const y1 = Math.min(luma.length / width - 1, Math.floor(region.y1));

  let suma = 0;
  let sumaCuadrados = 0;
  let total = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * width + x;

      const laplaciano =
        4 * luma[i] - luma[i - width] - luma[i + width] - luma[i - 1] - luma[i + 1];

      suma += laplaciano;
      sumaCuadrados += laplaciano * laplaciano;
      total += 1;
    }
  }

  if (total === 0) return 0;

  const media = suma / total;
  return sumaCuadrados / total - media * media;
}
