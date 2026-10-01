// Catálogo de actividades del formulario de pago de Google Forms.
//
// Es la única fuente de verdad: lo usan tanto la Edge Function que construye
// el enlace prerrellenado como el portal (panel de administración y pantalla
// de participantes). No debe importar nada específico de Deno ni del
// navegador.
//
// Cada actividad tiene dos preguntas en el formulario de Google, cuyos
// identificadores `entry.XXXXXXXXX` se configuran en cada formulario
// (`payment_prefill_entries`, ver `PaymentPrefillEntries`):
//   - `names`: pregunta de párrafo (opcional) con los nombres de los
//     participantes, todos juntos en un único texto.
//   - `grid`: fila de la cuadrícula "INDIQUE LAS ACTIVIDADES PAGADAS", donde
//     se marca en la columna cuántos hijos participan (0 si ninguno).

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
}

export const PAYMENT_ACTIVITIES: readonly PaymentActivity[] = [
  {
    key: 'acampada_postcomunion',
    label: 'ACAMPADA POSTCOMUNIÓN/COMUNIÓN',
    gridRowLabel: 'ACAMPADA POST/COMU',
    participantInput: 'name',
  },
  {
    key: 'acampada_preconfirmacion',
    label: 'ACAMPADA PRECONFIRMACIÓN',
    gridRowLabel: 'ACAMPADA PRECONFIR',
    participantInput: 'public_id',
    requiredStage: 'preconfirmacion',
  },
  {
    key: 'acampada_confirmacion',
    label: 'ACAMPADA CONFIRMACIÓN',
    gridRowLabel: 'ACAMPADA CONFIR',
    participantInput: 'public_id',
    requiredStage: 'confirmacion',
  },
  {
    key: 'retiro_confirmacion',
    label: 'RETIRO CONFIRMACIÓN',
    gridRowLabel: 'RETIRO CONFIR',
    participantInput: 'public_id',
    requiredStage: 'confirmacion',
  },
  {
    key: 'campamento_verano',
    label: 'CAMPAMENTO DE VERANO',
    gridRowLabel: 'CAMPAMENTO DE VERANO',
    participantInput: 'name',
  },
  {
    key: 'camino_preconfirmacion',
    label: 'CAMINO PRECONFIRMACIÓN',
    gridRowLabel: 'CAMINO PRECONFIR',
    participantInput: 'public_id',
    requiredStage: 'preconfirmacion',
  },
  {
    key: 'camino_confirmacion',
    label: 'CAMINO CONFIRMACIÓN',
    gridRowLabel: 'CAMINO CONFIR',
    participantInput: 'public_id',
    requiredStage: 'confirmacion',
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

/** Identificadores de las dos preguntas de una actividad en el formulario de Google. */
export interface PaymentActivityEntries {
  names: string;
  grid: string;
}

export type PaymentPrefillEntries = Partial<Record<PaymentActivityKey, PaymentActivityEntries>>;

/**
 * Lee `payment_prefill_entries` tal cual viene de la base de datos, quedándose
 * solo con actividades conocidas y valores de texto (vacíos si faltan).
 */
export const parsePaymentPrefillEntries = (value: unknown): PaymentPrefillEntries => {
  const entries: PaymentPrefillEntries = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return entries;

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isPaymentActivityKey(key) || !raw || typeof raw !== 'object') continue;

    const { names, grid } = raw as Record<string, unknown>;
    entries[key] = {
      names: typeof names === 'string' ? names.trim() : '',
      grid: typeof grid === 'string' ? grid.trim() : '',
    };
  }

  return entries;
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
 * % de descuento que corresponde a `count` hermanos. Se cuentan todos los
 * participantes de las actividades de un mismo formulario de pago (p. ej. un
 * hijo en la acampada de postcomunión y otro en la de confirmación son una
 * pareja); las actividades de formularios distintos no se suman.
 */
export const siblingDiscountPercent = (count: number, discounts: SiblingDiscounts) => {
  if (count >= 4) return discounts.fourPlus ?? 0;
  if (count === 3) return discounts.trio ?? 0;
  if (count === 2) return discounts.pair ?? 0;
  return 0;
};

export interface ActivityPaymentAmount {
  /** Precio por participante con el descuento ya aplicado. */
  discountedPrice: number;
  /** Precio × participantes, antes del descuento. */
  gross: number;
  discount: number;
  total: number;
}

export interface PaymentAmount {
  /** Importe de cada actividad, en el mismo orden recibido. */
  activities: ActivityPaymentAmount[];
  /** Participantes de todas las actividades del formulario. */
  participants: number;
  /** Suma de todas las actividades, antes del descuento. */
  gross: number;
  discountPercent: number;
  discount: number;
  total: number;
}

/**
 * Importe de un formulario de pago. El % de descuento por hermanos sale del
 * total de participantes de todas sus actividades, y se aplica al precio de
 * cada participante (redondeado al céntimo): así el precio con descuento de
 * cada actividad, el importe de cada actividad y el total del formulario
 * cuadran exactamente entre sí. Todo en céntimos para no arrastrar errores de
 * coma flotante.
 */
export const calculatePaymentAmount = (
  activities: readonly { price: number; count: number }[],
  discounts: SiblingDiscounts,
): PaymentAmount => {
  const participants = activities.reduce((sum, { count }) => sum + count, 0);
  const discountPercent = siblingDiscountPercent(participants, discounts);

  const activityCents = activities.map(({ price, count }) => {
    const priceCents = Math.round(price * 100);
    const discountPerParticipantCents = Math.round((priceCents * discountPercent) / 100);

    return {
      discountedPriceCents: priceCents - discountPerParticipantCents,
      grossCents: priceCents * count,
      discountCents: discountPerParticipantCents * count,
    };
  });

  const grossCents = activityCents.reduce((sum, item) => sum + item.grossCents, 0);
  const discountCents = activityCents.reduce((sum, item) => sum + item.discountCents, 0);

  return {
    activities: activityCents.map((item) => ({
      discountedPrice: item.discountedPriceCents / 100,
      gross: item.grossCents / 100,
      discount: item.discountCents / 100,
      total: (item.grossCents - item.discountCents) / 100,
    })),
    participants,
    gross: grossCents / 100,
    discountPercent,
    discount: discountCents / 100,
    total: (grossCents - discountCents) / 100,
  };
};
