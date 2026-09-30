// Catálogo de actividades del formulario de pago de Google Forms.
//
// Es la única fuente de verdad: lo usan tanto la Edge Function que construye
// el enlace prerrellenado como el portal (panel de administración y pantalla
// de participantes). No debe importar nada específico de Deno ni del
// navegador.
//
// Cada actividad tiene dos preguntas en el formulario de Google:
//   - `namesEntry`: pregunta de párrafo (opcional) con los nombres de los
//     participantes, todos juntos en un único texto.
//   - `gridRowEntry`: fila de la cuadrícula "INDIQUE LAS ACTIVIDADES PAGADAS",
//     donde se marca en la columna cuántos hijos participan (0 si ninguno).

export type PaymentActivityKey =
  | 'acampada_postcomunion'
  | 'acampada_preconfirmacion'
  | 'acampada_confirmacion'
  | 'retiro_confirmacion'
  | 'campamento_verano'
  | 'camino_preconfirmacion'
  | 'camino_confirmacion';

/**
 * Cómo se identifica a cada participante en el portal: por su nombre escrito
 * a mano, o por su identificador personal (que se valida y se transforma en
 * el nombre registrado).
 */
export type PaymentParticipantInput = 'name' | 'public_id';

/** Etapa del grupo al que tiene que pertenecer un participante por identificador. */
export type CatechesisStage = 'preconfirmacion' | 'confirmacion';

export interface PaymentActivity {
  key: PaymentActivityKey;
  /** Nombre exacto de la pregunta de párrafo en el formulario de Google. */
  label: string;
  /** Nombre exacto de la fila en la cuadrícula del formulario de Google. */
  gridRowLabel: string;
  participantInput: PaymentParticipantInput;
  /**
   * Solo actividades por identificador: el alumno tiene que estar en un grupo
   * de esta etapa (ver `stageFromGroupName`).
   */
  requiredStage?: CatechesisStage;
  namesEntry: string;
  gridRowEntry: string;
}

export const PAYMENT_ACTIVITIES: readonly PaymentActivity[] = [
  {
    key: 'acampada_postcomunion',
    label: 'ACAMPADA POSTCOMUNIÓN/COMUNIÓN',
    gridRowLabel: 'ACAMPADA POST/COMU',
    participantInput: 'name',
    namesEntry: 'entry.794595863',
    gridRowEntry: 'entry.666452913',
  },
  {
    key: 'acampada_preconfirmacion',
    label: 'ACAMPADA PRECONFIRMACIÓN',
    gridRowLabel: 'ACAMPADA PRECONFIR',
    participantInput: 'public_id',
    requiredStage: 'preconfirmacion',
    namesEntry: 'entry.546902884',
    gridRowEntry: 'entry.2125776880',
  },
  {
    key: 'acampada_confirmacion',
    label: 'ACAMPADA CONFIRMACIÓN',
    gridRowLabel: 'ACAMPADA CONFIR',
    participantInput: 'public_id',
    requiredStage: 'confirmacion',
    namesEntry: 'entry.1625976138',
    gridRowEntry: 'entry.719210589',
  },
  {
    key: 'retiro_confirmacion',
    label: 'RETIRO CONFIRMACIÓN',
    gridRowLabel: 'RETIRO CONFIR',
    participantInput: 'public_id',
    requiredStage: 'confirmacion',
    namesEntry: 'entry.1441405370',
    gridRowEntry: 'entry.827903391',
  },
  {
    key: 'campamento_verano',
    label: 'CAMPAMENTO DE VERANO',
    gridRowLabel: 'CAMPAMENTO DE VERANO',
    participantInput: 'name',
    namesEntry: 'entry.1482861068',
    gridRowEntry: 'entry.1895229552',
  },
  {
    key: 'camino_preconfirmacion',
    label: 'CAMINO PRECONFIRMACIÓN',
    gridRowLabel: 'CAMINO PRECONFIR',
    participantInput: 'public_id',
    requiredStage: 'preconfirmacion',
    namesEntry: 'entry.31537136',
    gridRowEntry: 'entry.472469403',
  },
  {
    key: 'camino_confirmacion',
    label: 'CAMINO CONFIRMACIÓN',
    gridRowLabel: 'CAMINO CONFIR',
    participantInput: 'public_id',
    requiredStage: 'confirmacion',
    namesEntry: 'entry.374068113',
    gridRowEntry: 'entry.222505288',
  },
];

export const PAYMENT_ACTIVITY_KEYS: readonly PaymentActivityKey[] = PAYMENT_ACTIVITIES.map(
  (activity) => activity.key,
);

export const CATECHESIS_STAGE_LABELS: Record<CatechesisStage, string> = {
  preconfirmacion: 'preconfirmación',
  confirmacion: 'confirmación',
};

/**
 * Etapa de un grupo según su nombre: "PRECONFIRMACIÓN ..." o "CONFIRMACIÓN ...",
 * sin distinguir mayúsculas ni tildes. Cualquier otro grupo no tiene etapa y
 * no sirve para las actividades por identificador.
 */
export const stageFromGroupName = (groupName: string | null | undefined): CatechesisStage | null => {
  const normalized = (groupName ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (normalized.includes('PRECONFIRMACION')) return 'preconfirmacion';
  if (normalized.includes('CONFIRMACION')) return 'confirmacion';
  return null;
};

/** Límite de participantes por actividad en un mismo pago. */
export const MAX_PARTICIPANTS_PER_ACTIVITY = 10;

export const isPaymentActivityKey = (value: unknown): value is PaymentActivityKey =>
  typeof value === 'string' && (PAYMENT_ACTIVITY_KEYS as readonly string[]).includes(value);

/**
 * Texto de la columna de la cuadrícula que corresponde a `count` hijos.
 * Google Forms solo marca la casilla si el valor coincide exactamente con el
 * texto de la columna; si las columnas cambian (p. ej. "4 o más"), se ajusta
 * aquí.
 */
export const gridColumnForCount = (count: number) => String(count);

/** Los nombres de una actividad van todos juntos en un único párrafo. */
export const joinParticipantNames = (names: readonly string[]) => names.join(', ');

// --- Importes ----------------------------------------------------------------

/** % de descuento por hermanos de un formulario de pago (null = sin descuento). */
export interface SiblingDiscounts {
  pair: number | null;
  trio: number | null;
  fourPlus: number | null;
}

/** Valores con los que se rellena la configuración de un formulario de pago nuevo. */
export const DEFAULT_SIBLING_DISCOUNTS: SiblingDiscounts = { pair: 5, trio: 10, fourPlus: 15 };

/**
 * % de descuento que corresponde a `count` hermanos en una MISMA actividad.
 * Participar en dos actividades distintas no cuenta como pareja: se paga
 * cada actividad por separado.
 */
export const siblingDiscountPercent = (count: number, discounts: SiblingDiscounts) => {
  if (count >= 4) return discounts.fourPlus ?? 0;
  if (count === 3) return discounts.trio ?? 0;
  if (count === 2) return discounts.pair ?? 0;
  return 0;
};

export interface ActivityAmount {
  /** Precio × participantes, antes del descuento. */
  gross: number;
  discountPercent: number;
  discount: number;
  total: number;
}

/**
 * Importe de una actividad: el descuento se aplica sobre el total de todos
 * los hermanos que participan en ella. Se calcula en céntimos para no
 * arrastrar errores de coma flotante.
 */
export const calculateActivityAmount = (
  price: number,
  count: number,
  discounts: SiblingDiscounts,
): ActivityAmount => {
  const grossCents = Math.round(price * 100) * count;
  const discountPercent = siblingDiscountPercent(count, discounts);
  const discountCents = Math.round((grossCents * discountPercent) / 100);

  return {
    gross: grossCents / 100,
    discountPercent,
    discount: discountCents / 100,
    total: (grossCents - discountCents) / 100,
  };
};
