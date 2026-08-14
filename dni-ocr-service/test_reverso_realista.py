"""Prueba de extremo a extremo con una disposición fiel a un DNI 3.0 real.

    cd dni-ocr-service && python3 test_reverso_realista.py

Basado en una foto real compartida para depurar este mismo problema. Lo que
la hace más difícil que el resto de pruebas sintéticas:

  * El lugar de nacimiento aparece DOS VECES seguidas (castellano/cooficial:
    "ALICANTE" / "ALICANTE"), exactamente con la misma pinta que tendría un
    "localidad, provincia" del domicilio. Si el bloque de domicilio se lee
    mal, el respaldo del "bloque superior izquierdo" puede confundirlo con
    el domicilio y quedarse tan ancho: las dos líneas son válidas por
    separado (mayúsculas, palabra real), así que no hay filtro de texto que
    lo detecte solo.
  * La dirección real incluye un número de piso/puerta ("44 P14 53") con la
    misma forma que tiene un código de EQUIPO -- de ahí el error de la
    vuelta anterior, que lo trataba como basura y lo descartaba.
  * El código de EQUIPO real no lleva espacios y va pegado al chip, lejos
    del bloque de domicilio.
"""

import sys
import pathlib

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402

FUENTE = cv2.FONT_HERSHEY_SIMPLEX


def reverso(ancho: int = 1900) -> np.ndarray:
    alto = int(ancho / P.PROPORCION_DNI)
    card = np.full((alto, ancho, 3), 231, np.uint8)
    ppmm = ancho / 85.6

    for y in range(0, alto, max(2, int(ppmm / 3))):
        cv2.line(card, (0, y), (ancho, y + int(ppmm / 2)), (214, 220, 229), 1)

    escala_etiqueta = 1.2 * ppmm / 22
    escala_valor = 2.3 * ppmm / 22
    grosor_etiqueta = max(1, int(ppmm / 14))
    grosor_valor = max(1, int(ppmm / 11))

    # Chip y código de EQUIPO junto al borde izquierdo, como en el documento
    # real: lejos del bloque de domicilio, formato sin espacios.
    x_chip = int(3 * ppmm)
    y_chip = int(20 * ppmm)
    cv2.rectangle(
        card,
        (x_chip, y_chip),
        (x_chip + int(9 * ppmm), y_chip + int(7 * ppmm)),
        (150, 160, 40),
        -1,
    )
    cv2.putText(
        card, "EQUIPO 46745X6D1", (x_chip, y_chip - int(2 * ppmm)),
        FUENTE, escala_etiqueta * 0.8, (95, 95, 115), grosor_etiqueta,
    )

    x = int(16 * ppmm)
    y = int(8 * ppmm)

    def etiqueta(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), FUENTE, escala_etiqueta, (95, 95, 115), grosor_etiqueta)
        y += int(3.4 * ppmm)

    def valor(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), FUENTE, escala_valor, (25, 25, 35), grosor_valor)
        y += int(3.4 * ppmm)

    etiqueta("DOMICILIO / DOMICILI")
    valor("C. EJEMPLO 12 P3 21")
    valor("VALENCIA")
    valor("VALENCIA / VALENCIA")
    y += int(0.6 * ppmm)
    etiqueta("LUGAR DE NACIMIENTO / LLOC DE NAIXEMENT")
    valor("ALICANTE")
    valor("ALICANTE")
    y += int(0.6 * ppmm)
    etiqueta("HIJO/A DE / FILL/A DE")
    valor("JUAN ANTONIO / MARIA PILAR")

    y_mrz = int(alto * 0.70)
    for linea in (
        "IDESPCJZ102007248718068C<<<<",
        "0001030M3002142ESP<<<<<<<<<<6",
        "GARCIA<LOPEZ<<MARIA<ISABEL<<<",
    ):
        cv2.putText(
            card, linea, (int(3 * ppmm), y_mrz), cv2.FONT_HERSHEY_COMPLEX,
            3.2 * ppmm / 22, (10, 10, 10), max(2, int(ppmm / 8)),
        )
        y_mrz += int(4.4 * ppmm)

    return card


def main() -> int:
    imagen = reverso()
    fallos = []

    cara = P.leer_cara(imagen)
    resultado = P.extraer_de_cara(cara, es_anverso=False)
    texto_final = P.formatear_domicilio(resultado.domicilio)

    print(f"  líneas detectadas (tarjeta entera) : {len(cara.lineas)}")
    print(f"  domicilio final                    : {texto_final}")

    if not texto_final or "EJEMPLO" not in texto_final:
        fallos.append("no se lee la dirección real (con Nº piso/puerta)")

    if texto_final and "ALICANTE" in texto_final:
        fallos.append("cuela el lugar de nacimiento (ALICANTE) en el domicilio")

    if texto_final and ("JUAN" in texto_final or "PILAR" in texto_final):
        fallos.append("cuela la filiación en el domicilio")

    if texto_final and "46745" in texto_final:
        fallos.append("cuela el código de EQUIPO en el domicilio")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
