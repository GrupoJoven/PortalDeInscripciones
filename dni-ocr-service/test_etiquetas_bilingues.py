"""El domicilio no debe tragarse el bloque de nacimiento/filiación en DNI
bilingües (catalán, gallego, euskera), y tampoco debe descartar direcciones
reales que incluyan un número de piso/puerta.

    cd dni-ocr-service && python3 test_etiquetas_bilingues.py

Caso real visto en producción (log de Render): con la etiqueta DOMICILIO sin
reconocer, el respaldo del "bloque superior izquierdo" se quedó con
"44 P14 53" (que resultó ser el número de piso/puerta de la dirección real,
no un código de EQUIPO como se pensó al principio) y con "DE NAIXEMENT"
(catalán de "de nacimiento"), y el domicilio salió como
"44 P14 53, DE NAIXEMENT" -> descartado por ilegible. `ETIQUETAS_SIGUIENTES`
solo reconocía las etiquetas en castellano, así que el corte por etiqueta de
nacimiento no entraba en juego.

Una foto real del reverso (compartida para depurar este mismo caso) confirmó
el domicilio de verdad: "C. ALFAHUIR 44 P14 53 / VALÈNCIA / VALENCIA /
VALÈNCIA", con el código de EQUIPO real en un sitio y formato totalmente
distinto ("46745X6D1", sin espacios, junto al chip). Por eso NO se debe
reconocer "NN Pnn nn" como un código a descartar: es un formato de dirección
española perfectamente normal (número, piso, puerta).
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

    # Caso real: una dirección de verdad con número de piso/puerta ("Nº P14
    # 53") no debe confundirse con basura ni descartarse. Con la etiqueta
    # DOMICILIO reconocida, el bloque completo se lee sin problema.
    direccion_con_piso_puerta = [
        LineaFalsa("DOMICILIO", 70, 40, ancho=180, alto=20),
        LineaFalsa("C. ALFAHUIR 44 P14 53", 70, 95),
        LineaFalsa("VALENCIA", 70, 145),
        LineaFalsa("VALENCIA / VALENCIA", 70, 195),
        LineaFalsa("LUGAR DE NACIMIENTO", 70, 280, ancho=260, alto=20),
        LineaFalsa("ALICANTE", 70, 320),
    ]
    bloque_real = P.extraer_domicilio_por_posicion(direccion_con_piso_puerta)
    obtenido_real = P.formatear_domicilio(bloque_real)
    correcto_real = bool(obtenido_real and "44 P14 53" in obtenido_real)

    if not correcto_real:
        fallos.append("descarta un número de piso/puerta real como si fuera basura")

    print(f"  {'OK   ' if correcto_real else 'FALLO'} dirección real con piso/puerta (Nº P14 53)")
    print(f"          -> {obtenido_real}")

    # Caso real exacto del primer log: sin la etiqueta DOMICILIO reconocida,
    # solo se leyó el fragmento "44 P14 53" (se perdió "C. ALFAHUIR") y el
    # inicio de "LLOC DE NAIXEMENT". Con el filtro de etiquetas bilingües esa
    # segunda línea se descarta; lo que queda ("44 P14 53" sin letras) no
    # pasa la comprobación de plausibilidad y no se devuelve nada, que es
    # preferible a inventar un domicilio.
    fragmento_sin_calle = [
        LineaFalsa("44 P14 53", 70, 95),
        LineaFalsa("DE NAIXEMENT", 70, 145),
        LineaFalsa("EQUIPO", 1100, 280, ancho=150, alto=20),
        LineaFalsa("IDESPBAA123456112345678Z<<<<<", 60, 780, ancho=1500, alto=44),
    ]
    bloque_incompleto = P.extraer_domicilio_por_posicion(fragmento_sin_calle)
    texto_incompleto = P.formatear_domicilio(bloque_incompleto)

    # A este nivel (extraer_domicilio_por_posicion) no se aplica todavía
    # texto_plausible (eso lo hace extraer_datos más arriba), así que aquí
    # solo se comprueba que ya no arrastra el fragmento de "NAIXEMENT".
    correcto_fragmento = bool(texto_incompleto and "NAIXEMENT" not in texto_incompleto)

    if not correcto_fragmento:
        fallos.append("arrastra el fragmento de NAIXEMENT en el domicilio")

    print(f"  {'OK   ' if correcto_fragmento else 'FALLO'} fragmento sin la calle, sin colar NAIXEMENT")
    print(f"          -> {texto_incompleto}")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
