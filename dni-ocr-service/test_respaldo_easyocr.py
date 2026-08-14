"""El respaldo de EasyOCR debe entrar solo cuando Tesseract se ha quedado
corto, usar sus líneas con la misma lógica de posición ya escrita, y no
romper nunca la petición si falla.

    cd dni-ocr-service && python3 test_respaldo_easyocr.py

No hace falta tener EasyOCR/PyTorch instalados de verdad para estas pruebas:
se usan mocks, igual que test_nombre_fragmentado.py hace con la zona
aislada. La validación de que EasyOCR en sí lee bien un DNI real que
Tesseract no podía se hizo aparte, con fotos reales (ver conversación).
"""

import sys
import pathlib
from unittest import mock

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402


def _recorte_falso() -> np.ndarray:
    """Imagen mínima válida: los pasos previos al respaldo de EasyOCR (zona
    aislada, etc.) necesitan un `.shape` real, aunque no encuentren nada."""
    return np.full((200, 300, 3), 230, dtype=np.uint8)


def test_conversion_de_formato():
    """`_easyocr_a_lineas` debe dar el mismo formato que usa el resto del
    pipeline, filtrando la basura de baja confianza."""
    resultados_easyocr = [
        ([[70, 40], [250, 40], [250, 60], [70, 60]], "DOMICILIO", 0.95),
        ([[70, 95], [400, 95], [400, 120], [70, 120]], "C. ALFAHUIR 44 P14 53", 0.85),
        ([[70, 150], [100, 150], [100, 160], [70, 160]], "?", 0.05),  # ruido, se descarta
    ]

    lineas = P._easyocr_a_lineas(resultados_easyocr)

    ok = (
        len(lineas) == 2
        and lineas[0].texto == "DOMICILIO"
        and lineas[1].texto == "C. ALFAHUIR 44 P14 53"
        and lineas[1].x0 == 70
        and lineas[1].y1 == 120
    )

    print(f"  {'OK   ' if ok else 'FALLO'} conversión de formato y filtro de confianza")
    return ok


def test_domicilio_usa_easyocr_solo_si_tesseract_falla():
    """El respaldo de EasyOCR para el domicilio solo debe llamarse cuando
    Tesseract no ha dado nada, y su resultado debe usarse."""
    lineas_easyocr = [
        P.LineaOCR("DOMICILIO", 70, 40, 250, 60),
        P.LineaOCR("C. ALFAHUIR 44 P14 53", 70, 95, 400, 120),
        P.LineaOCR("VALENCIA", 70, 145, 250, 170),
    ]

    cara = type("CaraFalsa", (), {})()
    cara.texto = ""
    cara.lineas = []  # Tesseract no ha encontrado ni la etiqueta ni nada
    cara.recorte = _recorte_falso()
    cara.nitidez = 60.0

    llamada = mock.Mock(return_value=lineas_easyocr)

    with mock.patch.object(P, "_leer_con_easyocr", llamada):
        resultado = P.extraer_de_cara(cara, es_anverso=False)

    llamado = llamada.called
    domicilio = P.formatear_domicilio(resultado.domicilio)
    correcto = bool(llamado and domicilio and "ALFAHUIR" in domicilio)

    print(f"  {'OK   ' if correcto else 'FALLO'} domicilio recuperado vía EasyOCR")
    print(f"          -> {domicilio}")
    return correcto


def test_no_se_llama_si_tesseract_ya_tuvo_domicilio():
    """Si Tesseract ya dio domicilio, no debe gastarse el tiempo/CPU de
    EasyOCR: es el respaldo más caro de todos."""
    lineas_tesseract = [
        P.LineaOCR("DOMICILIO", 70, 40, 250, 60),
        P.LineaOCR("CL EJEMPLO 12 3 B", 70, 95, 400, 120),
    ]

    cara = type("CaraFalsa", (), {})()
    cara.texto = "DOMICILIO\nCL EJEMPLO 12 3 B"
    cara.lineas = lineas_tesseract
    cara.recorte = _recorte_falso()
    cara.nitidez = 60.0

    llamada = mock.Mock(return_value=[])

    with mock.patch.object(P, "_leer_con_easyocr", llamada):
        P.extraer_de_cara(cara, es_anverso=False)

    correcto = not llamada.called

    print(f"  {'OK   ' if correcto else 'FALLO'} no llama a EasyOCR si Tesseract ya tenía domicilio")
    return correcto


def test_fallo_de_easyocr_no_rompe_la_extraccion():
    """Si EasyOCR falla (memoria, excepción, lo que sea), la extracción debe
    seguir devolviendo lo que tuviera, no reventar."""
    cara = type("CaraFalsa", (), {})()
    cara.texto = ""
    cara.lineas = []
    cara.recorte = _recorte_falso()
    cara.nitidez = 60.0

    with mock.patch.object(P, "_leer_con_easyocr", mock.Mock(return_value=[])):
        try:
            resultado = P.extraer_de_cara(cara, es_anverso=False)
            correcto = resultado.domicilio is None
        except Exception as error:  # noqa: BLE001
            print(f"          excepción: {error}")
            correcto = False

    print(f"  {'OK   ' if correcto else 'FALLO'} sin domicilio disponible, no revienta")
    return correcto


def test_lector_no_disponible_no_lanza():
    """Si `easyocr` no está instalado o falla al cargar, `_lector_easyocr`
    debe devolver `None` en vez de propagar la excepción."""
    with mock.patch.object(P, "LECTOR_EASYOCR", None), mock.patch.object(
        P, "EASYOCR_DISPONIBLE", True
    ):
        with mock.patch.dict(sys.modules, {"easyocr": None}):
            lector = P._lector_easyocr()

    correcto = lector is None

    print(f"  {'OK   ' if correcto else 'FALLO'} sin el paquete instalado, no lanza")
    return correcto


def test_apagado_por_defecto_no_intenta_cargar():
    """Con el interruptor en "no" (el valor por defecto sin DNI_OCR_EASYOCR),
    no debe intentarse ni importar `easyocr`.

    Caso real: en una instancia de Render de 512 MB, cargar EasyOCR mataba
    el contenedor entero con SIGKILL (exit 137) -algo que ningún try/except
    de Python puede evitar una vez ha empezado a cargarse-. Por eso el
    interruptor tiene que estar en "no" salvo que se active a propósito.
    """
    intentado = False

    def import_vigilado(nombre, *args, **kwargs):
        nonlocal intentado
        if nombre == "easyocr":
            intentado = True
        return __import__(nombre, *args, **kwargs)

    with mock.patch.object(P, "EASYOCR_DISPONIBLE", False), mock.patch.object(
        P, "LECTOR_EASYOCR", None
    ), mock.patch("builtins.__import__", side_effect=import_vigilado):
        lector = P._lector_easyocr()

    correcto = lector is None and not intentado

    print(f"  {'OK   ' if correcto else 'FALLO'} apagado no intenta importar easyocr")
    return correcto


def main() -> int:
    pruebas = [
        test_conversion_de_formato,
        test_domicilio_usa_easyocr_solo_si_tesseract_falla,
        test_no_se_llama_si_tesseract_ya_tuvo_domicilio,
        test_fallo_de_easyocr_no_rompe_la_extraccion,
        test_lector_no_disponible_no_lanza,
        test_apagado_por_defecto_no_intenta_cargar,
    ]

    fallos = [p.__name__ for p in pruebas if not p()]

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
