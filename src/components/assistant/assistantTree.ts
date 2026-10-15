// Árbol de preguntas del asistente de la portada.
//
// Cada nodo es un mensaje del asistente con, opcionalmente, pasos numerados,
// una nota final, opciones que llevan a otro nodo y acciones que hacen algo
// en el portal (escribir el código, abrir la calculadora...). Para cambiar
// textos o añadir casos basta con tocar este archivo.

export type AssistantAction =
  | 'enter_code'
  | 'recover_code'
  | 'public_forms'
  | 'calculator'
  | 'guide';

export type AssistantNodeId =
  | 'start'
  | 'inscribir'
  | 'tiene_grupo'
  | 'con_codigo'
  | 'sin_codigo'
  | 'nuevo'
  | 'pagar'
  | 'incidencia'
  | 'inc_email'
  | 'inc_datos'
  | 'inc_id'
  | 'problemas'
  | 'p_correo'
  | 'p_formulario'
  | 'p_dni'
  | 'p_enviado';

export type AssistantNode = {
  message: string[];
  steps?: string[];
  note?: string;
  options?: { label: string; next: AssistantNodeId }[];
  actions?: { label: string; action: AssistantAction }[];
};

const PROXIMAMENTE_NOTE =
  'Si la actividad aparece en «Próximamente», todavía no ha abierto, pero ya puedes leer su circular y su autorización.';

export const ASSISTANT_TREE: Record<AssistantNodeId, AssistantNode> = {
  start: {
    message: ['¡Hola! Te ayudo a hacer la inscripción paso a paso.', '¿Qué necesitas hacer?'],
    options: [
      { label: 'Inscribir a mi hijo/a en una actividad', next: 'inscribir' },
      { label: 'Pagar una actividad', next: 'pagar' },
      { label: 'Me ha llegado un correo de «Incidencia en formulario»', next: 'incidencia' },
      { label: 'Tengo otro problema', next: 'problemas' },
    ],
  },

  // ---------------------------------------------------------------------
  // Inscripción
  // ---------------------------------------------------------------------

  inscribir: {
    message: [
      '¿Tu hijo/a ya está en un grupo de Preconfirmación o Confirmación del Grupo Joven este curso?',
    ],
    options: [
      { label: 'Sí, ya está en un grupo', next: 'tiene_grupo' },
      { label: 'No, es nuevo/a', next: 'nuevo' },
    ],
  },

  tiene_grupo: {
    message: [
      'Entonces su formulario está en «Tus formularios», y se entra con su código, que empieza por SANP-.',
      'No uses los formularios públicos: son para quienes todavía no están en un grupo.',
      '¿Tienes su código?',
    ],
    options: [
      { label: 'Sí, lo tengo', next: 'con_codigo' },
      { label: 'No lo sé', next: 'sin_codigo' },
    ],
  },

  con_codigo: {
    message: ['Perfecto. Estos son los pasos:'],
    steps: [
      'Escribe el código en el recuadro de la portada y pulsa «Verificar».',
      'La primera vez te enviaremos un correo de verificación al email de contacto que nos diste. Ábrelo y pulsa el enlace (si no lo ves, mira en spam).',
      'En «Tus formularios», pulsa «Acceder al Formulario» en la actividad.',
      'El formulario se abre con los datos de tu hijo/a ya rellenados. No cambies ninguno, ni siquiera el email: si cambias alguno, la inscripción se borra. Si algún dato está mal, avisa a sus catequistas.',
      'Si tienes varios hijos, repite los pasos con el código de cada uno: cada hijo tiene el suyo.',
    ],
    note: PROXIMAMENTE_NOTE,
    actions: [{ label: 'Escribir el código', action: 'enter_code' }],
  },

  sin_codigo: {
    message: [
      'No pasa nada: te lo enviamos ahora mismo.',
      'Escribe el email de contacto que nos diste al apuntarle y te llegarán los códigos de todos tus hijos.',
    ],
    note: 'Si no te llega, puede que nos dieras otro correo: prueba con él. Si aun así no llega, habla con los catequistas de tu hijo/a.',
    actions: [{ label: 'Enviarme los códigos', action: 'recover_code' }],
  },

  nuevo: {
    message: ['Entonces tienes que usar los «Formularios públicos». Estos son los pasos:'],
    steps: [
      'Baja hasta «Formularios públicos», busca la actividad y pulsa «Acceder al Formulario».',
      'Te preguntaremos si ya está en un grupo: responde «No, es nuevo/a».',
      'Si el formulario pide verificar el DNI, ten a mano el DNI del participante y un móvil con cámara: escanearás un código QR y harás dos fotos del documento. Si es menor de 14 años y no tiene DNI, se usa el de su padre, madre o tutor.',
      'Escribe tu correo electrónico. Si es la primera vez, te enviaremos un enlace para verificarlo: ábrelo (mira también en spam).',
      'Rellena el formulario desde el enlace que te damos y envíalo. No cambies el email que viene puesto ni uses enlaces del formulario reenviados por WhatsApp: esas inscripciones se borran.',
    ],
    note: PROXIMAMENTE_NOTE,
    actions: [{ label: 'Ver los formularios públicos', action: 'public_forms' }],
  },

  // ---------------------------------------------------------------------
  // Pagos
  // ---------------------------------------------------------------------

  pagar: {
    message: ['Para pagar una actividad:'],
    steps: [
      'Mira cuánto tienes que pagar en la calculadora de pagos: ya aplica el descuento por hermanos.',
      'Haz el pago como indique la circular de la actividad y guarda el justificante.',
      'Entra en el formulario de pago (en «Formularios públicos» o en «Tus formularios») y añade a cada hijo en su actividad. En las actividades de Preconfirmación y Confirmación te pediremos el código de cada hijo.',
      'Solo se puede adjuntar un justificante por formulario: si has hecho varios pagos, rellena un formulario por cada pago.',
    ],
    options: [{ label: 'No sé el código de mis hijos', next: 'sin_codigo' }],
    actions: [
      { label: 'Abrir la calculadora', action: 'calculator' },
      { label: 'Ver los formularios', action: 'public_forms' },
    ],
  },

  // ---------------------------------------------------------------------
  // Correos de incidencia (los envía google-forms-process-responses)
  // ---------------------------------------------------------------------

  incidencia: {
    message: [
      'Ese correo significa que la inscripción se ha borrado y hay que repetirla.',
      '¿Qué dice el correo?',
    ],
    options: [
      { label: 'Que mi email de contacto no figura como verificado', next: 'inc_email' },
      { label: 'Que se han modificado datos asociados al identificador', next: 'inc_datos' },
      { label: 'Que el identificador no existe', next: 'inc_id' },
    ],
  },

  inc_email: {
    message: [
      'Se envió el formulario sin pasar por el portal (por ejemplo, desde un enlace reenviado) o con un email distinto al que se verificó.',
      'Para repetirla:',
    ],
    steps: [
      'Entra en el formulario desde el portal, no desde un enlace guardado o reenviado.',
      'Escribe tu correo y, si te llega un enlace de verificación, ábrelo.',
      'Rellena el formulario desde el enlace que te damos, sin cambiar el email que viene puesto.',
    ],
    note: 'Si estás seguro de que sí lo verificaste, escribe a grupojoven@sanpas.es con una captura de la página de verificación.',
    options: [{ label: 'Mi hijo/a ya está en un grupo', next: 'tiene_grupo' }],
    actions: [{ label: 'Ver los formularios públicos', action: 'public_forms' }],
  },

  inc_datos: {
    message: [
      'Al rellenar el formulario se cambió alguno de los datos que venían rellenados. El correo te dice cuáles.',
      'Para repetirla:',
    ],
    steps: [
      'Vuelve a entrar con el código de tu hijo/a.',
      'Envía el formulario sin cambiar ningún dato rellenado, ni siquiera el email.',
    ],
    note: 'Si algún dato está mal de verdad, avisa a sus catequistas o al coordinador para que lo corrijan, y después repite la inscripción.',
    actions: [{ label: 'Escribir el código', action: 'enter_code' }],
  },

  inc_id: {
    message: [
      'El código que llegó en el formulario no existe. Suele pasar si se escribe a mano o se cambia en el formulario.',
      'Para repetirla:',
    ],
    steps: [
      'Escribe el código de tu hijo/a en el recuadro de la portada (si no lo sabes, te lo enviamos).',
      'Abre el formulario desde «Tus formularios»: el código ya irá puesto.',
    ],
    actions: [
      { label: 'Escribir el código', action: 'enter_code' },
      { label: 'No sé el código', action: 'recover_code' },
    ],
  },

  // ---------------------------------------------------------------------
  // Otros problemas
  // ---------------------------------------------------------------------

  problemas: {
    message: ['¿Qué te pasa?'],
    options: [
      { label: 'No me llega el correo de verificación', next: 'p_correo' },
      { label: 'No sé el código de mi hijo/a', next: 'sin_codigo' },
      { label: 'No encuentro el formulario de la actividad', next: 'p_formulario' },
      { label: 'Falla la verificación del DNI', next: 'p_dni' },
      { label: 'Ya lo he enviado: ¿está bien?', next: 'p_enviado' },
    ],
  },

  p_correo: {
    message: ['Prueba esto:'],
    steps: [
      'Mira en la carpeta de spam y en «Promociones».',
      'Espera unos minutos: a veces tarda.',
      'Comprueba que escribiste bien el correo.',
      'Si lo pediste hace poco, puede que no te mandemos otro enseguida: busca el primero.',
    ],
    note: 'Si entras con código, el correo va al email de contacto que nos diste al apuntarle. Si ese correo ya no lo usas, habla con sus catequistas para cambiarlo.',
  },

  p_formulario: {
    message: ['Puede ser por alguna de estas razones:'],
    steps: [
      'Si tu hijo/a está en Preconfirmación o Confirmación, su formulario solo aparece al escribir su código, en «Tus formularios».',
      'Si sale en «Próximamente», todavía no ha abierto: mira su fecha de apertura. Ya puedes leer su circular y su autorización.',
      'Cuando pasa la fecha de cierre, el formulario deja de aparecer.',
    ],
    actions: [
      { label: 'Escribir el código', action: 'enter_code' },
      { label: 'Ver los formularios públicos', action: 'public_forms' },
    ],
  },

  p_dni: {
    message: ['Algunos consejos:'],
    steps: [
      'Escanea el código QR con la cámara del móvil. Si ya estás en el móvil, usa el enlace «Abre la verificación en este mismo dispositivo».',
      'Haz las fotos con buena luz, sin reflejos y con el documento entero.',
      'No cierres la pestaña del portal: cuando termines en el móvil, el proceso sigue solo.',
      'El código QR caduca. Si ha caducado, cancela y vuelve a empezar.',
      'Si es menor de 14 años y no tiene DNI, marca la casilla y verifica el DNI de su padre, madre o tutor.',
    ],
  },

  p_enviado: {
    message: [
      'Si hay algún problema con la inscripción, te llegará un correo de «Incidencia en formulario». Si no te llega ninguno, está todo bien.',
      'En «Tus formularios», los que ya has respondido aparecen en gris. Si quieres cambiar algo, vuelve a rellenarlo: nos quedamos siempre con la respuesta más reciente.',
    ],
  },
};
