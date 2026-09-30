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

export interface PaymentActivity {
  key: PaymentActivityKey;
  /** Nombre exacto de la pregunta de párrafo en el formulario de Google. */
  label: string;
  /** Nombre exacto de la fila en la cuadrícula del formulario de Google. */
  gridRowLabel: string;
  participantInput: PaymentParticipantInput;
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
    namesEntry: 'entry.546902884',
    gridRowEntry: 'entry.2125776880',
  },
  {
    key: 'acampada_confirmacion',
    label: 'ACAMPADA CONFIRMACIÓN',
    gridRowLabel: 'ACAMPADA CONFIR',
    participantInput: 'public_id',
    namesEntry: 'entry.1625976138',
    gridRowEntry: 'entry.719210589',
  },
  {
    key: 'retiro_confirmacion',
    label: 'RETIRO CONFIRMACIÓN',
    gridRowLabel: 'RETIRO CONFIR',
    participantInput: 'public_id',
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
    namesEntry: 'entry.31537136',
    gridRowEntry: 'entry.472469403',
  },
  {
    key: 'camino_confirmacion',
    label: 'CAMINO CONFIRMACIÓN',
    gridRowLabel: 'CAMINO CONFIR',
    participantInput: 'public_id',
    namesEntry: 'entry.374068113',
    gridRowEntry: 'entry.222505288',
  },
];

export const PAYMENT_ACTIVITY_KEYS: readonly PaymentActivityKey[] = PAYMENT_ACTIVITIES.map(
  (activity) => activity.key,
);

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
