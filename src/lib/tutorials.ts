// Vídeos de la página «Tutoriales». Para añadir uno basta con añadirlo aquí
// (y su id a TutorialId). El id se usa en el enlace (/tutoriales?video=<id>)
// para abrir directamente ese vídeo, por ejemplo desde el asistente.

export type TutorialId =
  | 'inscripcion-comunion'
  | 'inscripcion-nuevos'
  | 'inscripcion-continuan'
  | 'acampada-comunion'
  | 'acampada-preconfirmacion'
  | 'formulario-pago';

export type Tutorial = {
  id: TutorialId;
  title: string;
  description: string;
  videoUrl: string;
};

export type TutorialCategory = {
  title: string;
  tutorials: Tutorial[];
};

export const TUTORIAL_CATEGORIES: TutorialCategory[] = [
  {
    title: 'Inscripción de inicio de curso',
    tutorials: [
      {
        id: 'inscripcion-comunion',
        title: 'Comunión',
        description: 'Paso a paso para inscribir a tu hijo/a en comunión al empezar el curso.',
        videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialComu.mp4',
      },
      {
        id: 'inscripcion-nuevos',
        title: 'Preconfirmación y Confirmación: nuevos',
        description:
          'Para quien entra nuevo/a este curso en un grupo de Preconfirmación o Confirmación del Grupo Joven.',
        videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialNuevos.mp4',
      },
      {
        id: 'inscripcion-continuan',
        title: 'Preconfirmación y Confirmación: quienes continúan',
        description:
          'Para quien ya estaba en el Grupo Joven el curso pasado y sigue este curso en Preconfirmación o Confirmación.',
        videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialInicioViejos.mp4',
      },
    ],
  },
  {
    title: 'Inscripción en acampadas',
    tutorials: [
      {
        id: 'acampada-comunion',
        title: 'Comunión y postcomunión',
        description: 'Paso a paso para inscribir a tu hijo/a en la acampada de comunión o postcomunión.',
        videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialAcampadaPOST.mp4',
      },
      {
        id: 'acampada-preconfirmacion',
        title: 'Preconfirmación y Confirmación',
        description: 'Paso a paso para inscribir a tu hijo/a en la acampada de Preconfirmación o Confirmación.',
        videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialAcampadaPreConfir.mp4',
      },
    ],
  },
  {
    title: 'Pagos',
    tutorials: [
      {
        id: 'formulario-pago',
        title: 'Cómo acceder y rellenar un formulario de pago',
        description: 'Paso a paso para entrar en un formulario de pago desde el portal y rellenarlo.',
        videoUrl: 'https://sanpas.es/wp-content/uploads/2026/10/TutorialPagos.mp4',
      },
    ],
  },
];

export const tutorialPath = (id: TutorialId) => `/tutoriales?video=${encodeURIComponent(id)}`;
