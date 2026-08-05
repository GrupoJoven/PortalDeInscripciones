/**
 * Análisis en tiempo real de los fotogramas de la cámara para decidir si la
 * foto del documento va a servir antes de dispararla.
 *
 * Todo en JS puro sobre un lienzo reducido (~220 px de ancho), así que el
 * coste por fotograma es despreciable incluso en móviles antiguos.
 *
 * Comprobaciones:
 *   1. Encuadre  - se detecta la tarjeta por diferencia con el color del fondo
 *                  y se compara su recuadro con el marco guía.
 *   2. Nitidez   - varianza del laplaciano (detecta trepidación y desenfoque).
 *   3. Luz       - luminancia media dentro del marco.
 *   4. Reflejos  - proporción de píxeles quemados.
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
  | 'too_far'
  | 'out_of_frame'
  | 'off_center'
  | 'blurry'
  | 'too_dark'
  | 'too_bright'
  | 'glare';

export interface FrameAnalysis {
  ok: boolean;
  issue: FrameIssue | null;
  message: string;
  metrics: {
    coverage: number;
    overflow: number;
    sharpness: number;
    brightness: number;
    glare: number;
  };
}

const MENSAJES: Record<FrameIssue, string> = {
  no_document: 'Coloca el documento dentro del marco',
  too_far: 'Acerca un poco más el documento',
  out_of_frame: 'El documento se sale del marco',
  off_center: 'Centra el documento en el marco',
  blurry: 'Mantén el móvil quieto para enfocar',
  too_dark: 'Hace falta más luz',
  too_bright: 'Hay demasiada luz, aléjate del foco',
  glare: 'Evita los reflejos sobre el documento',
};

export const MENSAJE_CORRECTO = 'Encuadre correcto, ya puedes hacer la foto';

// --- Umbrales -------------------------------------------------------------
// Ajustados a mano sobre fotos de DNI en interiores; son deliberadamente
// tolerantes: es mejor dejar pasar una foto regular que bloquear al usuario.
const UMBRALES = {
  coberturaMinima: 0.72,   // del área del marco que debe ocupar el documento
  desbordeMaximo: 0.14,    // cuánto puede sobresalir del marco
  descentradoMaximo: 0.13, // desplazamiento del centro respecto al del marco
  nitidezMinima: 42,       // varianza del laplaciano
  luzMinima: 55,
  luzMaxima: 218,
  reflejoMaximo: 0.055,    // proporción de píxeles > 248
  areaMascaraMinima: 0.05, // por debajo, no hay documento a la vista
};

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

export function analyzeFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  guide: GuideRect,
): FrameAnalysis {
  const imagen = ctx.getImageData(0, 0, width, height);
  const { data } = imagen;

  const luma = new Float32Array(width * height);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const marco = {
    x0: Math.round(guide.x * width),
    y0: Math.round(guide.y * height),
    x1: Math.round((guide.x + guide.width) * width),
    y1: Math.round((guide.y + guide.height) * height),
  };

  const metricasLuz = medirLuz(luma, width, marco);
  const nitidez = medirNitidez(luma, width, marco);
  const encuadre = medirEncuadre(data, width, height, marco);

  const metrics = {
    coverage: encuadre.cobertura,
    overflow: encuadre.desborde,
    sharpness: nitidez,
    brightness: metricasLuz.media,
    glare: metricasLuz.reflejo,
  };

  // El orden importa: primero lo que impide siquiera ver el documento.
  const issue = detectarProblema(encuadre, metricasLuz, nitidez);

  return {
    ok: issue === null,
    issue,
    message: issue ? MENSAJES[issue] : MENSAJE_CORRECTO,
    metrics,
  };
}

function detectarProblema(
  encuadre: ReturnType<typeof medirEncuadre>,
  luz: ReturnType<typeof medirLuz>,
  nitidez: number,
): FrameIssue | null {
  if (luz.media < UMBRALES.luzMinima) return 'too_dark';
  if (luz.media > UMBRALES.luzMaxima) return 'too_bright';

  if (encuadre.areaMascara < UMBRALES.areaMascaraMinima) return 'no_document';
  if (encuadre.desborde > UMBRALES.desbordeMaximo) return 'out_of_frame';
  if (encuadre.descentrado > UMBRALES.descentradoMaximo) return 'off_center';
  if (encuadre.cobertura < UMBRALES.coberturaMinima) return 'too_far';

  if (luz.reflejo > UMBRALES.reflejoMaximo) return 'glare';
  if (nitidez < UMBRALES.nitidezMinima) return 'blurry';

  return null;
}

interface Marco {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function medirLuz(luma: Float32Array, width: number, marco: Marco) {
  let suma = 0;
  let quemados = 0;
  let total = 0;

  for (let y = marco.y0; y < marco.y1; y += 2) {
    for (let x = marco.x0; x < marco.x1; x += 2) {
      const valor = luma[y * width + x];
      suma += valor;
      if (valor > 248) quemados += 1;
      total += 1;
    }
  }

  if (total === 0) return { media: 0, reflejo: 1 };

  return { media: suma / total, reflejo: quemados / total };
}

/** Varianza del laplaciano 3x3: cuanto más alta, más nítida es la imagen. */
function medirNitidez(luma: Float32Array, width: number, marco: Marco) {
  let suma = 0;
  let sumaCuadrados = 0;
  let total = 0;

  for (let y = marco.y0 + 1; y < marco.y1 - 1; y += 1) {
    for (let x = marco.x0 + 1; x < marco.x1 - 1; x += 1) {
      const centro = luma[y * width + x];

      const laplaciano =
        4 * centro -
        luma[(y - 1) * width + x] -
        luma[(y + 1) * width + x] -
        luma[y * width + x - 1] -
        luma[y * width + x + 1];

      suma += laplaciano;
      sumaCuadrados += laplaciano * laplaciano;
      total += 1;
    }
  }

  if (total === 0) return 0;

  const media = suma / total;
  return sumaCuadrados / total - media * media;
}

/**
 * Separa documento y fondo por distancia de color respecto al borde de la
 * imagen (misma idea que el pipeline de Python, simplificada) y compara el
 * recuadro resultante con el marco guía.
 */
function medirEncuadre(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  marco: Marco,
) {
  const fondo = estimarColorFondo(data, width, height);

  // Umbral adaptativo: suficiente para separar una tarjeta clara sobre mesa
  // oscura y viceversa, sin disparar con sombras suaves.
  const umbral = 46;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixelesDocumento = 0;
  let muestras = 0;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;

      const distancia =
        Math.abs(data[i] - fondo.r) +
        Math.abs(data[i + 1] - fondo.g) +
        Math.abs(data[i + 2] - fondo.b);

      muestras += 1;

      if (distancia > umbral) {
        pixelesDocumento += 1;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const areaMascara = muestras > 0 ? pixelesDocumento / muestras : 0;

  if (maxX < 0 || maxY < 0) {
    return { cobertura: 0, desborde: 0, descentrado: 0, areaMascara: 0 };
  }

  const anchoMarco = marco.x1 - marco.x0;
  const altoMarco = marco.y1 - marco.y0;

  // Solape entre el recuadro detectado y el marco guía.
  const solapeAncho = Math.max(0, Math.min(maxX, marco.x1) - Math.max(minX, marco.x0));
  const solapeAlto = Math.max(0, Math.min(maxY, marco.y1) - Math.max(minY, marco.y0));

  const areaSolape = solapeAncho * solapeAlto;
  const areaMarco = anchoMarco * altoMarco;
  const areaDetectada = (maxX - minX) * (maxY - minY);

  const cobertura = areaMarco > 0 ? areaSolape / areaMarco : 0;
  const desborde = areaDetectada > 0 ? 1 - areaSolape / areaDetectada : 0;

  const centroDetectadoX = (minX + maxX) / 2;
  const centroDetectadoY = (minY + maxY) / 2;
  const centroMarcoX = (marco.x0 + marco.x1) / 2;
  const centroMarcoY = (marco.y0 + marco.y1) / 2;

  const descentrado = Math.max(
    Math.abs(centroDetectadoX - centroMarcoX) / anchoMarco,
    Math.abs(centroDetectadoY - centroMarcoY) / altoMarco,
  );

  return { cobertura, desborde, descentrado, areaMascara };
}

/** Color mediano de una banda estrecha en los cuatro bordes del fotograma. */
function estimarColorFondo(data: Uint8ClampedArray, width: number, height: number) {
  const grosor = Math.max(2, Math.round(Math.min(width, height) * 0.05));

  const rojos: number[] = [];
  const verdes: number[] = [];
  const azules: number[] = [];

  const muestrear = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    rojos.push(data[i]);
    verdes.push(data[i + 1]);
    azules.push(data[i + 2]);
  };

  for (let y = 0; y < grosor; y += 1) {
    for (let x = 0; x < width; x += 3) {
      muestrear(x, y);
      muestrear(x, height - 1 - y);
    }
  }

  for (let x = 0; x < grosor; x += 1) {
    for (let y = 0; y < height; y += 3) {
      muestrear(x, y);
      muestrear(width - 1 - x, y);
    }
  }

  return {
    r: mediana(rojos),
    g: mediana(verdes),
    b: mediana(azules),
  };
}

function mediana(valores: number[]) {
  if (valores.length === 0) return 0;

  const ordenados = valores.slice().sort((a, b) => a - b);
  const medio = Math.floor(ordenados.length / 2);

  return ordenados.length % 2 === 0
    ? (ordenados[medio - 1] + ordenados[medio]) / 2
    : ordenados[medio];
}
