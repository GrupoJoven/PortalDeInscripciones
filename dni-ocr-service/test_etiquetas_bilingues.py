"""El domicilio no debe tragarse el bloque de nacimiento/filiación en DNI
bilingües (catalán, gallego, euskera).

    cd dni-ocr-service && python3 test_etiquetas_bilingues.py

Caso real visto en producción (log de Render): con la etiqueta DOMICILIO sin
reconocer, el respaldo del "bloque superior izquierdo" se quedó con el
código de EQUIPO y con "DE NAIXEMENT" (catalán de "de nacimiento"), y el
domicilio salió como "44 P14 53, DE NAIXEMENT" -> descartado por ilegible.
`ETIQUETAS_SIGUIENTES` solo reconocía las etiquetas en castellano, así que ni
el corte por etiqueta de nacimiento ni el filtro del código de EQUIPO
entraban en juego.
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402


class LineaFalsa:
    def __init__(self, texto: str, x0: int, y0: int, ancho: int = 500, alto: int = 34):
        self.texto = texto
        self.x0 = x0
        self.y0 = y0
        self.x1 = x0 + ancho
        self.y1 = y0 + alto


def reverso_sin_etiqueta_domicilio(lugar_nacimiento: str, filiacion: str) -> list:
    """Reverso bilingüe donde DOMICILIO no se ha reconocido (caso real)."""
    return [
        LineaFalsa("CL EJEMPLO 12 3 B", 70, 95),
        LineaFalsa("MADRID", 70, 145),
        LineaFalsa("MADRID / MADRID", 70, 195),
        # Bloque siguiente (nacimiento + filiación), que no debe colarse
        LineaFalsa(lugar_nacimiento, 70, 280, ancho=260, alto=20),
        LineaFalsa("ALICANTE", 70, 320),
        LineaFalsa(filiacion, 70, 400, ancho=170, alto=20),
        LineaFalsa("JUAN Y ANA", 70, 440),
        LineaFalsa("EQUIPO", 1100, 280, ancho=150, alto=20),
        LineaFalsa("IDESPBAA123456112345678Z<<<<<", 60, 780, ancho=1500, alto=44),
    ]


CASOS = {
    "catalán (LLOC DE NAIXEMENT / FILL DE)": ("LLOC DE NAIXEMENT", "FILL DE"),
    "gallego (LUGAR E DATA DE NACEMENTO / FILLO DE)": (
        "LUGAR E DATA DE NACEMENTO",
        "FILLO DE",
    ),
    "euskera (JAIOTZA LEKUA / SEME-ALABA)": ("JAIOTZA LEKUA", "SEME-ALABA"),
}


def main() -> int:
    fallos = []

    for titulo, (lugar, filiacion) in CASOS.items():
        bloque = P.extraer_domicilio_por_posicion(
            reverso_sin_etiqueta_domicilio(lugar, filiacion)
        )
        obtenido = P.formatear_domicilio(bloque)

        correcto = bool(
            obtenido
            and "EJEMPLO" in obtenido
            and "JUAN" not in obtenido
            and "ALICANTE" not in obtenido
            and "EQUIPO" not in obtenido
        )

        if not correcto:
            fallos.append(titulo)

        print(f"  {'OK   ' if correcto else 'FALLO'} {titulo}")
        print(f"          -> {obtenido}")

    # Caso real exacto del log: el código de EQUIPO y el fragmento de
    # nacimiento catalán quedan como las dos únicas líneas del bloque
    # superior izquierdo (la propia dirección no se pudo leer). No debe
    # devolverse un domicilio inventado a partir de ellas.
    solo_ruido = [
        LineaFalsa("44 P14 53", 70, 95),
        LineaFalsa("DE NAIXEMENT", 70, 145),
        LineaFalsa("EQUIPO", 1100, 280, ancho=150, alto=20),
        LineaFalsa("IDESPBAA123456112345678Z<<<<<", 60, 780, ancho=1500, alto=44),
    ]
    bloque_ruido = P.extraer_domicilio_por_posicion(solo_ruido)

    if bloque_ruido is not None:
        fallos.append("inventa domicilio a partir de EQUIPO + NAIXEMENT")
        print(f"  FALLO  Inventa un domicilio: {P.formatear_domicilio(bloque_ruido)}")
    else:
        print("  OK    No inventa domicilio cuando solo hay EQUIPO + NAIXEMENT")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
