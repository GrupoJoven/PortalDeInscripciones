"""Pruebas de la lectura por zonas aisladas.

    cd dni-ocr-service && python3 test_zonas.py

Reproduce el fallo del domicilio: al leer el reverso entero, el bloque del MRZ
—denso y de altísimo contraste— acapara el análisis de estructura de Tesseract
y la etiqueta DOMICILIO ni siquiera se reconoce. El síntoma en los logs era:

    Cara leída: 1901x1199, 4 líneas, 112 caracteres, etiquetas=['IDESP']

es decir, 112 caracteres que son básicamente el MRZ (90) y nada del domicilio.

Aislando la franja superior del reverso, el domicilio se lee sin problema.
"""

import sys
import pathlib

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402

FUENTE = cv2.FONT_HERSHEY_SIMPLEX


def reverso(ancho: int = 1900) -> np.ndarray:
    """Reverso realista: domicilio en letra pequeña arriba, MRZ denso abajo."""
    alto = int(ancho / P.PROPORCION_DNI)
    card = np.full((alto, ancho, 3), 231, np.uint8)
    ppmm = ancho / 85.6

    # Trama de fondo del documento
    for y in range(0, alto, max(2, int(ppmm / 3))):
        cv2.line(card, (0, y), (ancho, y + int(ppmm / 2)), (214, 220, 229), 1)

    escala_etiqueta = 1.2 * ppmm / 22   # etiquetas de ~1,2 mm
    escala_valor = 2.4 * ppmm / 22
    grosor_etiqueta = max(1, int(ppmm / 14))
    grosor_valor = max(1, int(ppmm / 11))

    x = int(4 * ppmm)
    y = int(6 * ppmm)

    def etiqueta(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), FUENTE, escala_etiqueta, (95, 95, 115), grosor_etiqueta)
        y += int(3.4 * ppmm)

    def valor(texto: str) -> None:
        nonlocal y
        cv2.putText(card, texto, (x, y), FUENTE, escala_valor, (25, 25, 35), grosor_valor)
        y += int(3.4 * ppmm)

    etiqueta("DOMICILIO")
    valor("CL EJEMPLO 12 3 B")
    valor("MADRID")
    valor("MADRID / MADRID")
    y += int(0.8 * ppmm)
    etiqueta("LUGAR DE NACIMIENTO")
    valor("MADRID")

    # MRZ: bloque denso y muy contrastado en la franja inferior
    y_mrz = int(alto * 0.68)

    for linea in (
        "IDESPBAA123456112345678Z<<<<<",
        "1003128F3001019ESP<<<<<<<<<<<4",
        "GARCIA<LOPEZ<<MARIA<ISABEL<<<<",
    ):
        cv2.putText(
            card,
            linea,
            (int(3 * ppmm), y_mrz),
            cv2.FONT_HERSHEY_COMPLEX,
            3.2 * ppmm / 22,
            (10, 10, 10),
            max(2, int(ppmm / 8)),
        )
        y_mrz += int(4.4 * ppmm)

    return card


def main() -> int:
    imagen = reverso()
    recorte = P._preparar_para_ocr(imagen)

    fallos = []

    # 1. Leyendo la tarjeta entera: así es como se perdía el domicilio.
    cara = P.leer_cara(imagen)
    domicilio_entero = P.extraer_domicilio_por_posicion(cara.lineas)

    print("  Leyendo el reverso entero:")
    print(f"      líneas detectadas : {len(cara.lineas)}")
    print(f"      domicilio         : {P.formatear_domicilio(domicilio_entero)}")

    # 2. Aislando la franja superior.
    domicilio_zona = P.extraer_domicilio_de_zona(recorte)
    texto_zona = P.formatear_domicilio(domicilio_zona)

    print("\n  Aislando la franja del domicilio:")
    print(f"      domicilio         : {texto_zona}")

    if not texto_zona or "EJEMPLO" not in texto_zona:
        fallos.append("no se lee el domicilio de la zona aislada")

    # 3. El resultado completo de la cara debe traer el domicilio.
    resultado = P.extraer_de_cara(cara, False)
    texto_final = P.formatear_domicilio(resultado.domicilio)

    print("\n  Resultado de la cara completa:")
    print(f"      domicilio         : {texto_final}")

    if not texto_final or "EJEMPLO" not in texto_final:
        fallos.append("la cara no acaba devolviendo el domicilio")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
