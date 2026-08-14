"""El pipeline debe corregir solo una tarjeta que llega girada 90°/180°.

    cd dni-ocr-service && python3 test_correccion_rotacion.py

Caso real (dos fotos de un DNI de prueba, compartidas para depurar este
problema): el reverso llegaba sistemáticamente ilegible -- decenas de líneas
de 3-5 caracteres, ninguna etiqueta reconocida -- con una nitidez que no
justificaba tanto destrozo. Probado con las fotos reales: la MISMA imagen,
solo que girada 90° o 180°, reproducía el patrón exacto de los logs de
producción (150+ líneas de ~4 caracteres); bien orientada, esas mismas fotos
se leían sin problema en unos segundos.

`ETIQUETAS_SIGUIENTES` y compañía no podían arreglar esto: no es un problema
de qué línea es cuál, es que Tesseract intenta leer el texto perpendicular a
como está escrito. La corrección (`_corregir_rotacion`) prueba las otras tres
rotaciones con una pasada barata de OCR y se queda con la que lea claramente
mejor, usando tanto las etiquetas del documento como el largo medio de línea
--porque el anverso rara vez deja leer sus etiquetas ni bien orientado--.
"""

import sys
import pathlib
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import numpy as np  # noqa: E402
import cv2  # noqa: E402

from app import pipeline as P  # noqa: E402
import test_reverso_realista as T  # noqa: E402


def test_rotaciones_reales() -> bool:
    fallos = []

    original = T.reverso()

    for titulo, rotacion in [
        ("0° (sin girar)", None),
        ("90° en sentido horario", cv2.ROTATE_90_CLOCKWISE),
        ("180°", cv2.ROTATE_180),
        ("90° en sentido antihorario", cv2.ROTATE_90_COUNTERCLOCKWISE),
    ]:
        imagen = original if rotacion is None else cv2.rotate(original, rotacion)

        cara = P.leer_cara(imagen)
        resultado = P.extraer_de_cara(cara, es_anverso=False)
        domicilio = P.formatear_domicilio(resultado.domicilio)

        correcto = bool(domicilio and "EJEMPLO" in domicilio)

        if not correcto:
            fallos.append(titulo)

        print(f"  {'OK   ' if correcto else 'FALLO'} {titulo}")
        print(f"          líneas={len(cara.lineas)}  domicilio={domicilio!r}")

    print("  " + ("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}"))

    return not fallos


def test_varias_etiquetas_sueltas_no_bloquean_el_reintento() -> bool:
    """Caso real: sobre una tarjeta rota en 26-74 líneas de basura, dos o
    tres etiquetas cortas (SEXO, DOMICILIO, IDESP...) pueden aparecer sueltas
    por azar y sumar entre todas más que el umbral de "ya se ha leído bien".
    Antes eso bastaba para que el reintento de rotación nunca se disparase,
    aunque el texto siguiera siendo ilegible.

    Se fuerza justo esa situación -texto muy fragmentado (4,8 car/línea) pero
    con puntuación de etiquetas alta (200, como si hubiera encontrado dos)-
    y se comprueba que el reintento salta de todas formas.
    """
    imagen = np.zeros((100, 200, 3), dtype=np.uint8)

    texto_fragmentado = "\n".join(["ab", "cd", "ef SEXO", "gh", "ij DOMICILIO"] * 6)
    lineas_fragmentadas = [
        P.LineaOCR(t, 0, i * 10, 20, i * 10 + 8)
        for i, t in enumerate(texto_fragmentado.splitlines())
    ]

    with mock.patch.object(
        P, "ocr_con_posiciones", return_value=(texto_fragmentado, lineas_fragmentadas)
    ), mock.patch.object(P, "_corregir_rotacion") as llamada:
        llamada.return_value = None  # no hace falta que "arregle" nada para esta prueba
        P.leer_cara(imagen)

    puntuacion = P._puntuar_texto_ocr(texto_fragmentado)
    disparado = llamada.called

    correcto = bool(puntuacion >= P.PUNTUACION_SUFICIENTE and disparado)

    print(
        f"  {'OK   ' if correcto else 'FALLO'} reintento con puntuación alta "
        f"({puntuacion:.0f}) por etiquetas sueltas"
    )

    return correcto


def main() -> int:
    resultados = {
        "rotaciones reales": test_rotaciones_reales(),
        "etiquetas sueltas no bloquean": test_varias_etiquetas_sueltas_no_bloquean_el_reintento(),
    }

    fallos = [nombre for nombre, ok in resultados.items() if not ok]

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
