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
  | 'partial'
  | 'out_of_frame'
  | 'blurry'
  | 'too_dark'
  | 'too_bright'
  | 'glare';

export interface FrameMetrics {
  /** Proporción de celdas del marco que parecen documento (0-1). */
  cobertura: number;
  /** Detalle (gradiente medio) dentro del marco. El DNI tiene mucho. */
  detalleDentro: number;
  /** Detalle de la banda exterior más invadida. La mesa tiene poco. */
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
  no_document: 'Coloca el documento dentro del marco',
  partial: 'El documento debe llenar todo el marco',
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
  /** Gradiente a partir del cual un píxel se considera "con detalle". */
  gradientePixel: 12,
  /**
   * Proporción de píxeles con detalle que debe tener una celda para contar
   * como documento. Se mide la densidad y no la media porque una celda casi
   * vacía atravesada por el canto de la tarjeta ya da una media alta: el borde
   * es un escalón enorme. La densidad distingue textura real de un solo canto.
   */
  densidadCelda: 0.06,
  /** Por debajo, en el marco no hay nada con aspecto de documento. */
  coberturaMinima: 0.3,
  /** Por debajo, el documento no llena el marco (está desplazado o lejos). */
  coberturaBuena: 0.55,
  /**
   * Una banda exterior está invadida si tiene mucho más detalle del que deja
   * el propio borde de la tarjeta. Se mide banda a banda, no de media: si se
   * promediaran las cuatro, medio DNI fuera por un lado quedaría diluido por
   * los tres lados que sí están sobre la mesa.
   */
  invasionAbsoluta: 28,
  invasionRelativa: 0.45,
  nitidezMinima: 18,
  luzMinima: 45,
  luzMaxima: 232,
  reflejoMaximo: 0.09,
};

/** Cuántas celdas se usan para medir la cobertura del marco. */
const CELDAS_X = 6;
const CELDAS_Y = 4;

/** Cuánto se mete hacia dentro la zona analizada, respecto al marco. */
const MARGEN_INTERIOR = 0.06;

/** Hueco entre el marco y el anillo, para no medir el borde de la tarjeta. */
const HUECO_ANILLO = 0.02;

/** Ancho del anillo exterior, en proporción al tamaño del marco. */
const ANCHO_ANILLO = 0.1;

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

  const luz = medirLuz(luma, width, interior);
  const nitidez = medirNitidez(luma, width, interior);
  const { cobertura, detalleMedio } = medirCobertura(luma, width, height, interior);
  const detalleFuera = medirBandaMasInvadida(luma, width, height, marco);

  const metrics: FrameMetrics = {
    cobertura,
    detalleDentro: detalleMedio,
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

  if (m.cobertura < UMBRALES.coberturaMinima) return 'no_document';

  // El desbordamiento se comprueba antes que la cobertura: con el documento
  // medio fuera, la mitad que queda dentro puede dar cobertura suficiente,
  // pero la banda por la que se sale lo delata.
  if (
    m.detalleFuera > UMBRALES.invasionAbsoluta &&
    m.detalleFuera > m.detalleDentro * UMBRALES.invasionRelativa
  ) {
    return 'out_of_frame';
  }

  if (m.cobertura < UMBRALES.coberturaBuena) return 'partial';

  if (m.reflejo > UMBRALES.reflejoMaximo) return 'glare';
  if (m.nitidez < UMBRALES.nitidezMinima) return 'blurry';

  return null;
}

/**
 * Divide el marco en una rejilla y cuenta cuántas celdas tienen detalle de
 * documento. Con el DNI bien encajado casi todas lo tienen; si está desplazado
 * o queda pequeño, las celdas que caen sobre la mesa bajan la cobertura.
 *
 * Se cuenta por celdas y no con la media del marco entero porque la media se
 * deja engañar: media tarjeta con mucho detalle promedia igual que una tarjeta
 * entera con detalle moderado.
 */
function medirCobertura(
  luma: Float32Array,
  width: number,
  height: number,
  interior: Region,
) {
  const anchoCelda = (interior.x1 - interior.x0) / CELDAS_X;
  const altoCelda = (interior.y1 - interior.y0) / CELDAS_Y;

  let conDocumento = 0;
  let sumaDetalle = 0;

  for (let cy = 0; cy < CELDAS_Y; cy += 1) {
    for (let cx = 0; cx < CELDAS_X; cx += 1) {
      const celda: Region = {
        x0: interior.x0 + cx * anchoCelda,
        y0: interior.y0 + cy * altoCelda,
        x1: interior.x0 + (cx + 1) * anchoCelda,
        y1: interior.y0 + (cy + 1) * altoCelda,
      };

      const { medio, densidad } = medirDetalle(luma, width, height, celda);
      sumaDetalle += medio;

      if (densidad > UMBRALES.densidadCelda) conDocumento += 1;
    }
  }

  const totalCeldas = CELDAS_X * CELDAS_Y;

  return {
    cobertura: conDocumento / totalCeldas,
    detalleMedio: sumaDetalle / totalCeldas,
  };
}

/**
 * Detalle de la banda exterior más invadida (arriba, abajo, izquierda o
 * derecha). Se coge el máximo y no la media: si el documento se sale por un
 * solo lado, promediar las cuatro bandas lo disimularía.
 */
function medirBandaMasInvadida(
  luma: Float32Array,
  width: number,
  height: number,
  marco: Region,
) {
  const anchoMarco = marco.x1 - marco.x0;
  const altoMarco = marco.y1 - marco.y0;

  const huecoX = anchoMarco * HUECO_ANILLO;
  const huecoY = altoMarco * HUECO_ANILLO;
  const bandaX = anchoMarco * ANCHO_ANILLO;
  const bandaY = altoMarco * ANCHO_ANILLO;

  const bandas: Region[] = [
    // Arriba
    {
      x0: marco.x0,
      y0: Math.max(0, marco.y0 - huecoY - bandaY),
      x1: marco.x1,
      y1: Math.max(0, marco.y0 - huecoY),
    },
    // Abajo
    {
      x0: marco.x0,
      y0: Math.min(height, marco.y1 + huecoY),
      x1: marco.x1,
      y1: Math.min(height, marco.y1 + huecoY + bandaY),
    },
    // Izquierda
    {
      x0: Math.max(0, marco.x0 - huecoX - bandaX),
      y0: marco.y0,
      x1: Math.max(0, marco.x0 - huecoX),
      y1: marco.y1,
    },
    // Derecha
    {
      x0: Math.min(width, marco.x1 + huecoX),
      y0: marco.y0,
      x1: Math.min(width, marco.x1 + huecoX + bandaX),
      y1: marco.y1,
    },
  ];

  let maximo = 0;

  for (const banda of bandas) {
    // Una banda pegada al borde del lienzo puede quedar sin superficie.
    if (banda.x1 - banda.x0 < 3 || banda.y1 - banda.y0 < 3) continue;

    maximo = Math.max(maximo, medirDetalle(luma, width, height, banda).medio);
  }

  return maximo;
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
 * Detalle de una región, en dos medidas complementarias:
 *
 *   - `medio`:    gradiente medio. Alto donde hay texto, fotografía o bordes;
 *                 casi cero en una superficie lisa, aunque esté en sombra.
 *   - `densidad`: proporción de píxeles con gradiente apreciable. Distingue
 *                 una zona con textura de una zona lisa cruzada por un único
 *                 borde, que daría un `medio` alto engañoso.
 */
function medirDetalle(
  luma: Float32Array,
  width: number,
  height: number,
  region: Region,
) {
  const x0 = Math.max(1, Math.floor(region.x0));
  const y0 = Math.max(1, Math.floor(region.y0));
  const x1 = Math.min(width - 1, Math.floor(region.x1));
  const y1 = Math.min(height - 1, Math.floor(region.y1));

  let suma = 0;
  let conDetalle = 0;
  let total = 0;

  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * width + x;

      const dx = Math.abs(luma[i + 1] - luma[i - 1]);
      const dy = Math.abs(luma[i + width] - luma[i - width]);
      const gradiente = dx + dy;

      suma += gradiente;
      if (gradiente > UMBRALES.gradientePixel) conDetalle += 1;
      total += 1;
    }
  }

  if (total === 0) return { medio: 0, densidad: 0 };

  return { medio: suma / total, densidad: conDetalle / total };
}

/** Varianza del laplaciano 3x3: cuanto más alta, más nítida es la imagen. */
/**
 * Nitidez de una imagen completa, para comparar dos candidatas a la misma
 * foto. Se normaliza el tamaño porque una imagen más grande tiene más detalle
 * de alta frecuencia y saldría favorecida sin serlo de verdad.
 */
export function nitidezDeLienzo(lienzo: HTMLCanvasElement): number {
  const ANCHO = 700;
  const alto = Math.max(1, Math.round((ANCHO * lienzo.height) / lienzo.width));

  const medida = document.createElement('canvas');
  medida.width = ANCHO;
  medida.height = alto;

  const ctx = medida.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lienzo, 0, 0, ANCHO, alto);

  const { data } = ctx.getImageData(0, 0, ANCHO, alto);
  const luma = new Float32Array(ANCHO * alto);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  return medirNitidez(luma, ANCHO, { x0: 1, y0: 1, x1: ANCHO - 1, y1: alto - 1 });
}

/**
 * Nitidez de una foto ya capturada, a su resolución real (sin reducirla a
 * 700 px como hace `nitidezDeLienzo`, que solo sirve para comparar dos
 * candidatas entre sí). El servicio de OCR calcula esta misma varianza del
 * laplaciano sobre la tarjeta ya normalizada a ~1700 px de ancho, así que
 * medirla aquí a una escala parecida (la foto capturada llega hasta 2200 px,
 * ver `anchoDestino` en DocumentCamera) da un número comparable al que
 * decide, en el servidor, si el domicilio se acaba descartando por ilegible.
 *
 * No es una traducción exacta: el laplaciano crece con la resolución para el
 * mismo desenfoque real, y aquí se parte de un canvas más grande que el que
 * procesa Python. `NITIDEZ_MINIMA_AVISO` compensa con un umbral algo más
 * alto que el 40 que usa el servicio; conviene afinarlo con más casos reales.
 */
export function nitidezCapturada(lienzo: HTMLCanvasElement): number {
  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;

  const { data } = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
  const luma = new Float32Array(lienzo.width * lienzo.height);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  return medirNitidez(luma, lienzo.width, {
    x0: 1,
    y0: 1,
    x1: lienzo.width - 1,
    y1: lienzo.height - 1,
  });
}

/**
 * Por debajo de este valor conviene avisar de que la foto puede salir
 * borrosa: es donde, en la práctica, el servicio de OCR empieza a descartar
 * el domicilio por ilegible (ver el umbral de 40 en `pipeline.py`, aplicado
 * sobre una imagen algo más pequeña que la que se mide aquí).
 */
export const NITIDEZ_MINIMA_AVISO = 55;

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
