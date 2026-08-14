"""El reintento con la zona aislada del nombre no debe saltarse cuando la
tarjeta entera ya dejó algunas candidatas pobres.

    cd dni-ocr-service && python3 test_nombre_fragmentado.py

Caso real (log de Render): el holograma del anverso fragmentó tanto el OCR
sobre la tarjeta entera (97 líneas de 5 caracteres de media) que
`extraer_bloque_nombre` encontraba la etiqueta APELLIDOS pero las líneas de
"candidatas" que sacaba de ahí eran basura irreconocible. Como `candidatas`
no estaba vacía, el reintento aislando la columna (mucho más limpio, sin el
ruido del holograma) se saltaba entero, y el nombre acababa saliendo del MRZ
del reverso, truncado a 30 caracteres, en vez del anverso completo.
"""

import sys
import pathlib
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402


class LineaFalsa:
    def __init__(self, texto: str, x0: int = 100, y0: int = 100):
        self.texto = texto
        self.x0 = x0
        self.y0 = y0
        self.x1 = x0 + 400
        self.y1 = y0 + 30


class CaraFalsa:
    """Imita una CaraLeida sin necesidad de OCR real."""

    def __init__(self, lineas):
        self.texto = ""
        self.lineas = lineas
        self.recorte = None
        self.nitidez = 40.0


MRZ = {"apellidos": "GARCIA LOPEZ", "nombre": "MARIA ISABEL"}


def main() -> int:
    fallos = []

    # Candidatas "narrow" que deja el paso por posición: basura, no casan
    # con el MRZ. Incluye la etiqueta APELLIDOS para que `extraer_bloque_nombre`
    # entre por la rama que sí produce candidatas (no la vacía).
    lineas_tarjeta_entera = [
        LineaFalsa("APELLIDOS", y0=50),
        LineaFalsa("G4RC1", y0=90),   # basura del holograma, no casa con MRZ
        LineaFalsa("XZ99", y0=130),   # basura del holograma, no casa con MRZ
        LineaFalsa("NACIONALIDAD", y0=170),
    ]

    # La zona aislada, más limpia, sí trae el nombre real.
    candidatas_zona_limpias = ["GARCIA LOPEZ", "MARIA ISABEL"]

    llamada_a_zona = mock.Mock(return_value=(None, candidatas_zona_limpias))

    with mock.patch.object(P, "extraer_nombre_de_zona", llamada_a_zona):
        resultado = P.extraer_de_cara(
            CaraFalsa(lineas_tarjeta_entera), es_anverso=True
        )

    if not llamada_a_zona.called:
        fallos.append("no reintenta con la zona aislada aunque había candidatas pobres")
        print("  FALLO  extraer_nombre_de_zona no se ha llamado")
    else:
        print("  OK    extraer_nombre_de_zona se llama aunque ya había candidatas")

    nombre_final = P.componer_nombre_con_mrz(resultado.lineas_nombre, MRZ)
    esperado = "MARIA ISABEL GARCIA LOPEZ"
    correcto = nombre_final == esperado

    if not correcto:
        fallos.append("el nombre no sale de las candidatas limpias de la zona")

    print(f"  {'OK   ' if correcto else 'FALLO'} nombre compuesto con las candidatas de la zona")
    print(f"          candidatas finales: {resultado.lineas_nombre}")
    print(f"          -> {nombre_final}  (esperado: {esperado})")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
