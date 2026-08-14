"""Extremo a extremo: apellido compuesto con guion, sin etiqueta NOMBRE.

    cd dni-ocr-service && python3 test_nombre_apellido_compuesto.py

Inspirado en un DNI real compartido para depurar este mismo pipeline:
apellidos "BLOM-DAHL RAMOS" (primer apellido compuesto, con guion) y nombre
"CARLOS". Dos cosas lo hacen un buen caso de prueba:

  * El MRZ sustituye el guion por relleno ("BLOM<DAHL<RAMOS<<CARLOS"), así
    que "BLOM" y "DAHL" llegan como dos tokens sueltos y hay que recomponer
    el guion del anverso, no del MRZ.
  * Aquí se simula que la etiqueta NOMBRE no se ha leído (solo APELLIDOS),
    que es el caso real que antes hacía que el reintento con la zona aislada
    se saltase por tener ya alguna candidata (ver test_nombre_fragmentado.py
    para la prueba de esa lógica sin necesidad de OCR real; esta prueba la
    verifica de extremo a extremo con Tesseract de verdad).
"""

import sys
import pathlib

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402

F = cv2.FONT_HERSHEY_SIMPLEX


def anverso(ancho: int = 1500) -> np.ndarray:
    alto = int(ancho / P.PROPORCION_DNI)
    card = np.full((alto, ancho, 3), 233, np.uint8)

    for y in range(0, alto, 4):
        cv2.line(card, (0, y), (ancho, y + 9), (214, 219, 228), 1)

    cv2.rectangle(card, (50, 150), (330, 650), (140, 145, 155), -1)
    cv2.putText(card, "DOCUMENTO NACIONAL DE IDENTIDAD", (50, 80), F, 0.7, (40, 60, 120), 2)

    x = 400
    y = 190

    def etiqueta(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), F, 0.52, (95, 95, 115), 1)
        y += 46

    def valor(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), F, 0.92, (20, 20, 30), 2)
        y += 52

    etiqueta("APELLIDOS")
    valor("BLOM-DAHL")
    valor("RAMOS")
    # Sin etiqueta NOMBRE (caso real): solo el valor.
    valor("CARLOS")
    etiqueta("SEXO          NACIONALIDAD")
    valor("M             ESP")
    etiqueta("FECHA DE NACIMIENTO")
    valor("03 01 2000")
    cv2.putText(card, "48718068C", (x, y + 40), F, 0.95, (20, 20, 30), 2)

    marco = np.full((alto + 280, ancho + 280, 3), 52, np.uint8)
    marco[140 : 140 + alto, 140 : 140 + ancho] = card
    return marco


def reverso(ancho: int = 1900) -> np.ndarray:
    alto = int(ancho / P.PROPORCION_DNI)
    card = np.full((alto, ancho, 3), 231, np.uint8)
    ppmm = ancho / 85.6

    for y in range(0, alto, max(2, int(ppmm / 3))):
        cv2.line(card, (0, y), (ancho, y + int(ppmm / 2)), (214, 220, 229), 1)

    y_mrz = int(alto * 0.70)
    for linea in (
        "IDESPCJZ102007248718068C<<<<",
        "0001030M3002142ESP<<<<<<<<<<6",
        "BLOM<DAHL<RAMOS<<CARLOS<<<<<<",
    ):
        cv2.putText(
            card, linea, (int(3 * ppmm), y_mrz), cv2.FONT_HERSHEY_COMPLEX,
            3.2 * ppmm / 22, (10, 10, 10), max(2, int(ppmm / 8)),
        )
        y_mrz += int(4.4 * ppmm)

    return card


def main() -> int:
    resultado = P.extraer_datos(anverso(), reverso())

    esperado = "CARLOS BLOM-DAHL RAMOS"
    obtenido = resultado["nombre"] or ""
    correcto = obtenido.strip().upper() == esperado

    print(f"  {'OK   ' if correcto else 'FALLO'} nombre con apellido compuesto y sin etiqueta NOMBRE")
    print(f"          esperado: {esperado}")
    print(f"          obtenido: {obtenido}")

    # No debe venir truncado al formato MRZ ("BLOM DAHL RAMOS" sin guion,
    # o cortado a 30 caracteres): eso era justo la queja original.
    trunco = obtenido.strip().upper() in ("BLOM DAHL RAMOS CARLOS", "")

    if trunco:
        print("  FALLO  ha caído al MRZ truncado en vez de leer el anverso")

    print()
    print("TODO CORRECTO" if correcto and not trunco else "FALLOS")

    return 0 if (correcto and not trunco) else 1


if __name__ == "__main__":
    sys.exit(main())
