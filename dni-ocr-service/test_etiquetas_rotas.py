"""Pruebas de tolerancia a etiquetas mal leídas.

    cd dni-ocr-service && python3 test_etiquetas_rotas.py

Tesseract pega letras sueltas al final de las etiquetas con bastante
frecuencia. Medido sobre una tarjeta sintética con --psm 3:

    ['APELLIDOS', 'GARCIA', 'LOPEZ', 'NOMBRE', 'MARIA ISABEL',
     'SEXOQ ~ NACIONALIDAD']
                ^^^^^ una Q pegada

El orden de las líneas es perfecto, pero un `\\bSEXO\\b` no casa con "SEXOQ"
por el límite de palabra final, y eso tiraba abajo toda la extracción del
nombre. Las expresiones ahora solo anclan el principio de la palabra.
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402


ESPERADO = "MARIA ISABEL GARCIA LOPEZ"

# Variantes de cómo Tesseract deforma las etiquetas en documentos reales
TEXTOS = {
    "etiquetas limpias": (
        "APELLIDOS\nGARCIA\nLOPEZ\nNOMBRE\nMARIA ISABEL\nSEXO NACIONALIDAD\n"
    ),
    "SEXOQ (letra pegada, caso real)": (
        "APELLIDOS\nGARCIA\nLOPEZ\nNOMBRE\nMARIA ISABEL\nSEXOQ ~ NACIONALIDAD\n"
    ),
    "APELLIDOS con basura detrás": (
        "APELLIDOS|\nGARCIA\nLOPEZ\nNOMBRE\nMARIA ISABEL\nSEXO\n"
    ),
    "etiquetas bilingües": (
        "APELLIDOS / SURNAME\nGARCIA\nLOPEZ\nNOMBRE / NAME\nMARIA ISABEL\nSEXO / SEX\n"
    ),
}

DOMICILIOS = {
    "etiquetas limpias": (
        "DOMICILIO\nCL EJEMPLO 12 3 B\nMADRID\nMADRID / MADRID\n"
        "LUGAR DE NACIMIENTO\nMADRID\n"
    ),
    "NACIMIENTO con I leída como 1": (
        "DOMICILIO\nCL EJEMPLO 12 3 B\nMADRID\nMADRID / MADRID\n"
        "LUGAR DE NACIM1ENTO\nMADRID\n"
    ),
}


def main() -> int:
    fallos = []

    print("  Nombre (expresión regular original, ya tolerante):")
    for titulo, texto in TEXTOS.items():
        obtenido = P.extraer_nombre_completo(texto)
        correcto = obtenido == ESPERADO

        if not correcto:
            fallos.append(titulo)

        print(f"    {'OK   ' if correcto else 'FALLO'} {titulo}")
        print(f"           -> {obtenido}")

    print("\n  Domicilio:")
    for titulo, texto in DOMICILIOS.items():
        bloque = P.extraer_bloque_domicilio(texto)
        obtenido = bloque.get("direccion") if bloque else None
        correcto = obtenido == "CL EJEMPLO 12 3 B"

        if not correcto:
            fallos.append(titulo)

        print(f"    {'OK   ' if correcto else 'FALLO'} {titulo}")
        print(f"           -> {obtenido}")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
