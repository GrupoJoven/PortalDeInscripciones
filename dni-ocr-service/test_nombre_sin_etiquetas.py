"""El nombre debe salir del ANVERSO aunque no se lea ninguna etiqueta.

    cd dni-ocr-service && python3 test_nombre_sin_etiquetas.py

En todos los DNI reales probados, el anverso daba `etiquetas=ninguna`: sus
etiquetas (APELLIDOS, NOMBRE) van impresas en un azul muy tenue y bajo el
holograma, y Tesseract no las ve. El reverso, más limpio, sí reconoce las
suyas.

Sin etiquetas no hay forma de saber qué línea del anverso es el nombre y cuál
los apellidos, así que el nombre acababa saliendo del MRZ del reverso, que
trunca a 30 caracteres.

La solución es cotejar: el MRZ dice **qué es cada cosa**, y el texto que se
devuelve es **el del anverso**, completo.
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402


class LineaFalsa:
    """Imita una LineaOCR con su posición."""

    def __init__(self, texto: str, y: int):
        self.texto = texto
        self.x0 = 100
        self.y0 = y
        self.x1 = 600
        self.y1 = y + 30


def lineas(*textos: str) -> list:
    return [LineaFalsa(t, 50 + i * 60) for i, t in enumerate(textos)]


CASOS = [
    (
        "Nombre corriente",
        lineas(
            "ESPANA",
            "DOCUMENTO NACIONAL DE IDENTIDAD",
            "GARCIA",
            "LOPEZ",
            "MARIA ISABEL",
            "ESP",
            "12 03 2010",
            "48718068C",
        ),
        {"apellidos": "GARCIA LOPEZ", "nombre": "MARIA ISABEL"},
        "MARIA ISABEL GARCIA LOPEZ",
    ),
    (
        "Nombre largo: el MRZ trunca, el anverso no",
        lineas(
            "ESPANA",
            "DOCUMENTO NACIONAL DE IDENTIDAD",
            "FERNANDEZ-MONTESINOS",
            "DE LA SANTISIMA TRINIDAD",
            "MARIA DEL CARMEN INMACULADA",
            "ESP",
            "12 03 2010",
        ),
        # Tal como llega del MRZ: cortado a 30 caracteres
        {"apellidos": "FERNANDEZ MONTESINOS DE LA SANTIS", "nombre": "MARIA DEL CARM"},
        "MARIA DEL CARMEN INMACULADA FERNANDEZ-MONTESINOS DE LA SANTISIMA TRINIDAD",
    ),
    (
        "Apellidos en una sola línea",
        lineas("ESPANA", "PEREZ GOMEZ", "JOSE ANTONIO", "ESP"),
        {"apellidos": "PEREZ GOMEZ", "nombre": "JOSE ANTONIO"},
        "JOSE ANTONIO PEREZ GOMEZ",
    ),
]


def main() -> int:
    fallos = []

    for titulo, lineas_anverso, mrz, esperado in CASOS:
        candidatas = P._lineas_candidatas_a_nombre(lineas_anverso)
        obtenido = P.componer_nombre_con_mrz(candidatas, mrz)
        correcto = obtenido == esperado

        if not correcto:
            fallos.append(titulo)

        print(f"  {'OK   ' if correcto else 'FALLO'} {titulo}")
        print(f"          candidatas: {candidatas}")
        print(f"          -> {obtenido}")

        if not correcto:
            print(f"          esperado: {esperado}")

        print()

    # No debe inventarse un nombre si el anverso no lo trae
    vacias = P._lineas_candidatas_a_nombre(
        lineas("ESPANA", "DOCUMENTO NACIONAL DE IDENTIDAD")
    )
    sin_nombre = P.componer_nombre_con_mrz(
        vacias, {"apellidos": "GARCIA LOPEZ", "nombre": "MARIA ISABEL"}
    )

    if sin_nombre is not None:
        fallos.append("inventa un nombre que no está en el anverso")
        print(f"  FALLO  Se inventa un nombre: {sin_nombre}")
    else:
        print("  OK    No inventa un nombre que el anverso no trae")

    # Sin MRZ tampoco debe adivinar
    sin_mrz = P.componer_nombre_con_mrz(["GARCIA", "MARIA"], {})

    if sin_mrz is not None:
        fallos.append("compone sin MRZ")
        print(f"  FALLO  Compone sin MRZ: {sin_mrz}")
    else:
        print("  OK    Sin MRZ no adivina")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
