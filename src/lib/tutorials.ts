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

export const TUTORIALS: Tutorial[] = [
  {
    id: PAYMENT_TUTORIAL_ID,
    title: 'Cómo acceder y rellenar un formulario de pago',
    description: 'Paso a paso para entrar en un formulario de pago desde el portal y rellenarlo.',
    videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialPagos.mp4',
  },
];

export const tutorialPath = (id: string) => `/tutoriales?video=${encodeURIComponent(id)}`;
