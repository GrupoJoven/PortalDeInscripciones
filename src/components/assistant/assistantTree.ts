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
  notes?: string[];
  options?: { label: string; next: AssistantNodeId }[];
  actions?: { label: string; action: AssistantAction }[];
};

const PROXIMAMENTE_NOTE =
  'Si la actividad aparece en «Próximamente», todavía no ha abierto, pero ya puedes leer su circular y su autorización.';

// El formulario de Google siempre pide primero un correo: no es el email de
// contacto, solo donde llega el resguardo (así lo explica la guía).
const RECEIPT_EMAIL_STEP =
  'Lo primero que te pedirá el formulario es un correo electrónico: es solo donde Google te enviará el resguardo de tus respuestas. No tiene por qué ser el email de contacto.';

const SEND_AND_CHECK_STEP =
  'Pulsa «Enviar» y comprueba que aparece la pantalla de confirmación. Después, mira que te llega el resguardo a ese correo: si no te llega, es que no lo hemos recibido.';

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
      {
        label: 'Sí, ya está en un grupo de Preconfirmación o Confirmación del Grupo Joven.',
        next: 'tiene_grupo',
      },
      { label: 'No, es nuevo/a o pertenece a comunión/postcomunión.', next: 'nuevo' },
    ],
  },

  tiene_grupo: {
    message: [
      'Entonces su formulario está en «Tus formularios», y se entra con su código, que empieza por SANP-.',
      'No uses los formularios públicos: son para quienes son nuevos o están en comunión/postcomunión.',
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
      'La primera vez te llegará un correo de no-reply@sanpas.es al email de contacto que tenemos guardado. Pulsa «Verificar correo» y, en la página que se abre, «Continuar» (si no lo ves, mira en spam).',
      'Se abrirá el portal con «Tus formularios». Pulsa «Acceder al Formulario» en la actividad.',
      RECEIPT_EMAIL_STEP,
      'Lee el aviso del formulario y rellena solo lo que falta. No cambies ningún dato de los que vienen rellenados, ni siquiera el email: si cambias alguno, la inscripción se borra.',
      SEND_AND_CHECK_STEP,
      'Si tienes varios hijos, repite los pasos con el código de cada uno: cada hijo tiene el suyo.',
    ],
    notes: [
      'Si algún dato rellenado está mal, no envíes el formulario: apunta qué está mal y avisa a su catequista, al coordinador del grupo o a grupojoven@sanpas.es. Cuando te confirmen que está corregido, vuelve a entrar desde el portal.',
      PROXIMAMENTE_NOTE,
    ],
    actions: [{ label: 'Escribir el código', action: 'enter_code' }],
  },

  sin_codigo: {
    message: [
      'No pasa nada: te lo enviamos ahora mismo.',
      'Escribe el email de contacto que nos diste al apuntarle y te llegarán los códigos de todos tus hijos.',
    ],
    notes: [
      'Si no te llega, puede que nos dieras otro correo: prueba con él. Si aun así no llega, pregunta a su catequista o al coordinador del grupo.',
    ],
    actions: [{ label: 'Enviarme los códigos', action: 'recover_code' }],
  },

  nuevo: {
    message: ['Entonces tienes que usar los «Formularios públicos». Estos son los pasos:'],
    steps: [
      'Baja hasta «Formularios públicos» (no escribas nada en el recuadro del código), busca la actividad y pulsa «Acceder al Formulario».',
      'Te preguntaremos si ya está en un grupo: responde «No, es nuevo/a o pertenece a comunión/postcomunión».',
      'Si pone «Requiere verificar el DNI con el móvil», ten a mano el DNI del participante (si es menor de 14 años y no tiene DNI, el de su padre, madre o tutor). Escanea el código QR con el móvil, o pulsa «Abre la verificación en este mismo dispositivo» si ya estás en el móvil, y fotografía el DNI por delante y por detrás.',
      'Escribe el correo que quieres usar como email de contacto: es el que usaremos para comunicarnos contigo y aparecerá ya puesto en el formulario.',
      'Si es la primera vez, te llegará un correo de no-reply@sanpas.es. Pulsa «Verificar correo» y después vuelve a la pestaña del portal y pulsa «Continuar».',
      RECEIPT_EMAIL_STEP,
      'Rellena solo los datos que faltan, sin cambiar los que vienen puestos: si cambias alguno, la inscripción se borra.',
      SEND_AND_CHECK_STEP,
    ],
    notes: [
      'No uses enlaces del formulario que te hayan pasado otras personas: esas inscripciones se borran.',
      PROXIMAMENTE_NOTE,
    ],
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
    notes: [
      'Si estás seguro de que sí lo verificaste, escribe a grupojoven@sanpas.es con una captura de la página de verificación. Aun así, tendrás que repetir la inscripción: la respuesta ya se ha borrado.',
    ],
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
    notes: [
      'Si algún dato está mal de verdad, no lo cambies en el formulario: avisa a su catequista, al coordinador del grupo o a grupojoven@sanpas.es para que lo corrijan y, cuando te lo confirmen, repite la inscripción desde el portal.',
    ],
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
      'El correo llega desde no-reply@sanpas.es. Búscalo también en spam, «Promociones» y «Notificaciones».',
      'Espera unos minutos: puede tardar, sobre todo si tu correo no es de Gmail o Hotmail, porque algunos proveedores bloquean los correos automáticos.',
      'Comprueba que escribiste bien el correo.',
      'Si lo pediste hace poco, puede que no te mandemos otro enseguida: busca el primero.',
    ],
    notes: [
      'Si entras con código, el correo va al email de contacto que tenemos guardado. Si está mal, pide a su catequista o al coordinador del grupo que lo cambien, o escribe a grupojoven@sanpas.es con el nombre de tu hijo/a y el correo antiguo.',
      'Si el correo está bien pero no te llega, o al verificar te da error, escribe a grupojoven@sanpas.es desde ese mismo correo explicando el problema: lo verificarán a mano.',
    ],
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
      'Cuando te pida permiso para usar la cámara, pulsa «Permitir»: sin él no se puede leer el DNI.',
      'Haz las fotos con buena luz, sin reflejos y con el documento entero: primero por delante y luego por detrás.',
      'No cierres la pestaña del portal. Si lo haces todo desde el móvil, al terminar vuelve a esa pestaña: no le des a «Atrás» ni recargues la página.',
      'El código QR caduca. Si ha caducado, cancela y vuelve a empezar.',
      'Si es menor de 14 años y no tiene DNI, marca la casilla y verifica el DNI de su padre, madre o tutor.',
    ],
    notes: [
      'Si no consigues que funcione de ninguna manera, envía un correo a grupojoven@sanpas.es, desde el correo que quieras usar como email de contacto, con el DNI escaneado por delante y por detrás (o una foto de cada cara), indicando el formulario al que intentas acceder y describiendo el problema.',
    ],
  },

  p_enviado: {
    message: ['Comprueba estas dos cosas, como se explica en la guía:'],
    steps: [
      'Que al pulsar «Enviar» te apareció la pantalla de confirmación del formulario.',
      'Que te ha llegado el resguardo (acuse de recibo) con la copia de tus respuestas, al correo que escribiste al principio del formulario. Míralo también en spam, «Promociones» y «Notificaciones».',
    ],
    notes: [
      'Si te ha llegado el resguardo, hemos recibido tu formulario. Si no te ha llegado, nosotros tampoco lo tenemos: tendrás que volver a rellenarlo.',
      'Si después hubiera algún problema con la inscripción, te llegará un correo de «Incidencia en formulario».',
      'En «Tus formularios», los que ya has respondido aparecen en gris. Si quieres cambiar algo, vuelve a rellenarlo: nos quedamos siempre con la respuesta más reciente.',
    ],
    actions: [{ label: 'Ver la guía', action: 'guide' }],
  },
};
