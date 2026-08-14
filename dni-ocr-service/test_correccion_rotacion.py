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

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import cv2  # noqa: E402

from app import pipeline as P  # noqa: E402
import test_reverso_realista as T  # noqa: E402


def main() -> int:
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

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
