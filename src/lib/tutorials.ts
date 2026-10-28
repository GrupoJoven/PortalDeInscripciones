// Vídeos de la página «Tutoriales». Para añadir uno basta con añadirlo aquí.
// El id se usa en el enlace (/tutoriales?video=<id>) para abrir directamente
// ese vídeo, por ejemplo desde el asistente.

export type Tutorial = {
  id: string;
  title: string;
  description: string;
  videoUrl: string;
};

export const PAYMENT_TUTORIAL_ID = 'formulario-pago';
export const COMMUNION_TUTORIAL_ID = 'inscripcion-comunion';
export const NEW_MEMBERS_TUTORIAL_ID = 'inscripcion-nuevos';

export const TUTORIALS: Tutorial[] = [
  {
    id: PAYMENT_TUTORIAL_ID,
    title: 'Cómo acceder y rellenar un formulario de pago',
    description: 'Paso a paso para entrar en un formulario de pago desde el portal y rellenarlo.',
    videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialPagos.mp4',
  },
  {
    id: COMMUNION_TUTORIAL_ID,
    title: 'Cómo hacer la inscripción de inicio de curso de comunión',
    description: 'Paso a paso para inscribir a tu hijo/a en comunión al empezar el curso.',
    videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialComu.mp4',
  },
  {
    id: NEW_MEMBERS_TUTORIAL_ID,
    title: 'Cómo inscribir a un nuevo/a en Preconfirmación o Confirmación',
    description:
      'Paso a paso para inscribir a quien entra nuevo/a en un grupo de Preconfirmación o Confirmación del Grupo Joven.',
    videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialNuevos.mp4',
  },
];

export const tutorialPath = (id: string) => `/tutoriales?video=${encodeURIComponent(id)}`;
