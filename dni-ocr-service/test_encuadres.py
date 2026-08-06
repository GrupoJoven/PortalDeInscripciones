"""Pruebas de la preparación de la imagen antes del OCR.

    cd dni-ocr-service && python3 test_encuadres.py

Comprueba que se extrae el nombre con distintos encuadres de entrada. El caso
importante es el primero: la página de captura recorta exactamente al marco
guía, así que lo que llega del móvil ya viene sin fondo alrededor.

Ese caso era el que fallaba: al no haber fondo del que separar la tarjeta, el
detector de contorno tomaba por documento un bloque de texto o la fotografía
y devolvía un recorte deformado con el que Tesseract dejaba de leer. Los
síntomas eran "puntuaciones=[0, -1]" en los logs y ni nombre ni domicilio.
"""

import sys
import pathlib

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402

ESPERADO = "MARIA ISABEL GARCIA LOPEZ"
FUENTE = cv2.FONT_HERSHEY_SIMPLEX


def tarjeta(ancho: int = 1500) -> np.ndarray:
    """Anverso sintético a dos columnas: fotografía a la izquierda, campos a la derecha."""
    alto = int(ancho / P.PROPORCION_DNI)
    card = np.full((alto, ancho, 3), 233, np.uint8)

    # Trama de fondo, como el guilloche del documento real
    for y in range(0, alto, 4):
        cv2.line(card, (0, y), (ancho, y + 9), (214, 219, 228), 1)

    cv2.rectangle(card, (50, 150), (330, 650), (140, 145, 155), -1)  # fotografía

    x = 400
    y = 190

    def etiqueta(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), FUENTE, 0.52, (95, 95, 115), 1)
        y += 46

    def valor(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), FUENTE, 0.92, (20, 20, 30), 2)
        y += 52

    etiqueta("APELLIDOS")
    valor("GARCIA")
    valor("LOPEZ")
    etiqueta("NOMBRE")
    valor("MARIA ISABEL")
    etiqueta("SEXO          NACIONALIDAD")
    valor("F             ESP")

    return card


CARD = tarjeta()
ALTO, ANCHO = CARD.shape[:2]


def con_fondo(margen_x: int, margen_y: int, tono: int = 52) -> np.ndarray:
    fondo = np.full((ALTO + margen_y * 2, ANCHO + margen_x * 2, 3), tono, np.uint8)
    fondo[margen_y : margen_y + ALTO, margen_x : margen_x + ANCHO] = CARD
    return fondo


def inclinada(grados: float = 7) -> np.ndarray:
    fondo = con_fondo(200, 200)
    matriz = cv2.getRotationMatrix2D(
        (fondo.shape[1] / 2, fondo.shape[0] / 2), grados, 1.0
    )
    return cv2.warpAffine(
        fondo, matriz, (fondo.shape[1], fondo.shape[0]), borderValue=(52, 52, 52)
    )


CASOS = [
    ("Recortada al marco (lo que manda el móvil)", CARD),
    ("Sobre una mesa, margen normal", con_fondo(140, 140)),
    ("Sobre una mesa, mucho margen (foto de lejos)", con_fondo(ANCHO // 2, ALTO // 2)),
    ("Sobre una mesa clara", con_fondo(160, 120, 205)),
    ("Sobre una mesa, ligeramente inclinada", inclinada()),
]


def main() -> int:
    fallos = []

    for titulo, imagen in CASOS:
        resultado = P.procesar_cara(imagen)
        correcto = resultado.nombre == ESPERADO

        if not correcto:
            fallos.append(titulo)

        print(f"  {'OK   ' if correcto else 'FALLO'} {titulo}")
        print(
            f"          entrada {imagen.shape[1]}x{imagen.shape[0]}"
            f"  ->  {resultado.nombre}"
        )

    print()
    print("TODOS LOS ENCUADRES OK" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
