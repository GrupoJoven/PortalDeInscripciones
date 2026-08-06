"""Pruebas del filtro que descarta lecturas ilegibles.

    cd dni-ocr-service && python3 test_plausibilidad.py

El caso que motivó esto es real: con una foto poco nítida (nitidez=25), el
pipeline localizó la etiqueta DOMICILIO y se llevó como valor las líneas de
debajo, que eran ruido:

    "omo: EE Pd a a 2, o 59 ALICANTE, A DE quo PS A A"

Y lo dio por bueno, así que el usuario podía continuar con un domicilio
inventado. Eso es peor que no leer nada: al menos si no se lee, se bloquea.

El DNI imprime nombre y domicilio enteramente en MAYÚSCULAS, así que la
proporción de minúsculas delata las letras mal leídas.
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app.pipeline import texto_plausible  # noqa: E402


BASURA = [
    # El caso real, tal cual llegó
    "omo: EE Pd a a 2, o 59 ALICANTE, A DE quo PS A A",
    "a a a 2, o 59",
    "EE Pd",
    "",
    "   ",
    "|| ~~ ,,",
    "aaa bbb ccc",          # palabras, pero en minúsculas
    "MADRID",               # una sola palabra: insuficiente
]

VALIDOS = [
    "CL EJEMPLO 12 3 B, MADRID",
    "AV DE LA CONSTITUCION 45 2 IZQ, ALICANTE",
    "PZA MAYOR 3, SAN VICENTE DEL RASPEIG, ALICANTE",
    "C/ SAN JUAN 8, ELCHE",
    "CL GRAN VIA 1, BILBAO, BIZKAIA",
    # Con algún carácter mal leído, pero mayoritariamente correcto
    "CL EJEMPLQ 12 3 B, MADRlD",
]

NOMBRES_VALIDOS = [
    "MARIA ISABEL GARCIA LOPEZ",
    "JOSE ANTONIO PEREZ",
    "MARIA DEL CARMEN FERNANDEZ-MONTESINOS DE LA SANTISIMA TRINIDAD",
]


def main() -> int:
    fallos = []

    print("  Debe RECHAZARSE:")
    for texto in BASURA:
        if texto_plausible(texto):
            fallos.append(f"aceptado: {texto!r}")
            print(f"    FALLO  {texto!r}")
        else:
            print(f"    OK     {texto[:52]!r}")

    print("\n  Debe ACEPTARSE (domicilios):")
    for texto in VALIDOS:
        if texto_plausible(texto):
            print(f"    OK     {texto[:52]!r}")
        else:
            fallos.append(f"rechazado: {texto!r}")
            print(f"    FALLO  {texto!r}")

    print("\n  Debe ACEPTARSE (nombres):")
    for texto in NOMBRES_VALIDOS:
        if texto_plausible(texto):
            print(f"    OK     {texto[:52]!r}")
        else:
            fallos.append(f"rechazado: {texto!r}")
            print(f"    FALLO  {texto!r}")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
