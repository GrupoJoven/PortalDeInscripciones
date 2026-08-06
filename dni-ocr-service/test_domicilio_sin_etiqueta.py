"""El domicilio debe salir aunque no se lea la etiqueta DOMICILIO.

    cd dni-ocr-service && python3 test_domicilio_sin_etiqueta.py

La etiqueta DOMICILIO es diminuta y va en tinta clara. En unas fotos se
reconoce y en otras no, con el mismo documento y una nitidez parecida:

    reverso que funcionó : etiquetas=['DOMICILIO']  -> domicilio correcto
    reverso que falló    : etiquetas=['IDESP']      -> sin domicilio

Depender de esa etiqueta hacía que el resultado fuera una lotería. En el
reverso del DNI el domicilio es siempre el primer bloque de arriba a la
izquierda, así que se puede localizar por su sitio.
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402


class LineaFalsa:
    """Imita una LineaOCR con su geometría."""

    def __init__(self, texto: str, x0: int, y0: int, ancho: int = 500, alto: int = 34):
        self.texto = texto
        self.x0 = x0
        self.y0 = y0
        self.x1 = x0 + ancho
        self.y1 = y0 + alto


# Geometría aproximada de un reverso real a 1700x1072
def reverso(con_etiqueta: bool) -> list:
    lineas = []

    if con_etiqueta:
        lineas.append(LineaFalsa("DOMICILIO", 70, 55, ancho=180, alto=20))

    lineas += [
        LineaFalsa("CL EJEMPLO 12 3 B", 70, 95),
        LineaFalsa("MADRID", 70, 145),
        LineaFalsa("MADRID / MADRID", 70, 195),
        # Bloque siguiente, que no debe colarse
        LineaFalsa("LUGAR DE NACIMIENTO", 70, 280, ancho=260, alto=20),
        LineaFalsa("ALICANTE", 70, 320),
        LineaFalsa("HIJO/A DE", 70, 400, ancho=170, alto=20),
        LineaFalsa("JUAN Y ANA", 70, 440),
        # Columna derecha y MRZ
        LineaFalsa("EQUIPO", 1100, 280, ancho=150, alto=20),
        LineaFalsa("IDESPBAA123456112345678Z<<<<<", 60, 780, ancho=1500, alto=44),
    ]

    return lineas


def main() -> int:
    fallos = []

    for titulo, con_etiqueta in [
        ("Con la etiqueta DOMICILIO reconocida", True),
        ("SIN la etiqueta DOMICILIO (el caso que fallaba)", False),
    ]:
        bloque = P.extraer_domicilio_por_posicion(reverso(con_etiqueta))
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

    # Un reverso donde arriba a la izquierda no hay nada aprovechable
    vacio = [
        LineaFalsa("IDESPBAA123456112345678Z<<<<<", 60, 780, ancho=1500, alto=44),
    ]
    sin_nada = P.extraer_domicilio_por_posicion(vacio)

    if sin_nada is not None:
        fallos.append("inventa un domicilio donde no lo hay")
        print(f"  FALLO  Inventa un domicilio: {P.formatear_domicilio(sin_nada)}")
    else:
        print("  OK    No inventa un domicilio donde no lo hay")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
