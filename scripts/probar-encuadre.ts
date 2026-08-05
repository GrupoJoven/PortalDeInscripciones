/**
 * Pruebas del comprobador de encuadre de la cámara.
 *
 *   npx tsx scripts/probar-encuadre.ts
 *
 * Fabrica fotogramas sintéticos y comprueba que el análisis los clasifica
 * como toca. Útil si hay que retocar los umbrales de `dniFrameAnalyzer.ts`:
 * ajusta el valor, vuelve a lanzar esto y comprueba que no se rompe ningún
 * caso, sobre todo el de la sombra sobre la mesa.
 */
import { analyzeFrame, type GuideRect } from '../src/lib/dniFrameAnalyzer';

const W = 320, H = 427;
const guide: GuideRect = { x: 0.06, y: 0.292, width: 0.88, height: 0.416 };

// Lienzo falso: devolvemos los píxeles que fabriquemos.
const stubCtx = (data: Uint8ClampedArray) => ({
  getImageData: () => ({ data }),
}) as unknown as CanvasRenderingContext2D;

function frame(pintar: (x: number, y: number) => number) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = pintar(x, y), i = (y * W + x) * 4;
    d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
  }
  return stubCtx(d);
}

// Textura tipo documento: texto y foto -> mucho gradiente local.
const textura = (x: number, y: number) =>
  (y % 7 < 2 && x % 11 < 6) ? 25 : 232;

const gx0 = guide.x * W, gx1 = (guide.x + guide.width) * W;
const gy0 = guide.y * H, gy1 = (guide.y + guide.height) * H;

const casos: Array<[string, ReturnType<typeof frame>, string | null]> = [
  ['DNI encajado en el marco',
    frame((x, y) => (x >= gx0 && x < gx1 && y >= gy0 && y < gy1) ? textura(x, y) : 110),
    null],

  ['Mesa vacía, sin documento',
    frame(() => 110),
    'no_document'],

  ['DNI mucho más grande que el marco (se sale)',
    frame((x, y) => (x >= gx0 - 40 && x < gx1 + 40 && y >= gy0 - 60 && y < gy1 + 60) ? textura(x, y) : 110),
    'out_of_frame'],

  // === El fallo que reportó Carlos ===
  ['Sombra/degradado fuerte sobre la mesa (antes daba out_of_frame)',
    frame((x, y) => {
      const fondo = 60 + Math.round((x / W) * 110) + Math.round((y / H) * 50);
      return (x >= gx0 && x < gx1 && y >= gy0 && y < gy1) ? textura(x, y) : fondo;
    }),
    null],

  ['Mesa oscura, DNI claro (mucho contraste de fondo)',
    frame((x, y) => (x >= gx0 && x < gx1 && y >= gy0 && y < gy1) ? textura(x, y) : 30),
    null],

  ['Poca luz',
    frame((x, y) => (x >= gx0 && x < gx1 && y >= gy0 && y < gy1) ? Math.round(textura(x, y) * 0.12) : 12),
    'too_dark'],

  ['DNI desenfocado (liso, sin detalle)',
    frame((x, y) => (x >= gx0 && x < gx1 && y >= gy0 && y < gy1) ? 200 : 110),
    'no_document'],
];

let fallos = 0;
for (const [nombre, ctx, esperado] of casos) {
  const r = analyzeFrame(ctx, W, H, guide);
  const ok = r.issue === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? '  OK  ' : ' FALLO'} ${nombre}`);
  console.log(`        issue=${r.issue ?? 'ninguno'} (esperado ${esperado ?? 'ninguno'})  ` +
    `dentro=${r.metrics.detalleDentro.toFixed(1)} fuera=${r.metrics.detalleFuera.toFixed(1)} ` +
    `nitidez=${r.metrics.nitidez.toFixed(0)} luz=${r.metrics.luz.toFixed(0)}`);
}
console.log(fallos ? `\n${fallos} FALLOS` : '\nTODO CORRECTO');
process.exit(fallos ? 1 : 0);
