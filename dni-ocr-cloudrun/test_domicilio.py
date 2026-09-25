"""Pruebas de la lectura del domicilio en el reverso del DNI.

    cd dni-ocr-cloudrun && python3 test_domicilio.py

No hace falta PaddleOCR: se simulan los bloques de texto que devolvería el
OCR (texto + caja) y se pasan directamente por `_extract_back_fields`. Cada
caso reproduce un fallo real visto en las inscripciones de "NUEVOS:
PRE/CONFIRMACIÓN" (septiembre de 2026).
"""

import math
import pathlib
import sys
import types

sys.path.insert(0, str(pathlib.Path(__file__).parent))

# dni_reader.py importa PaddleOCR al cargarse, pero estas pruebas no lo usan.
sys.modules.setdefault("paddleocr", types.SimpleNamespace(PaddleOCR=object))

from app.dni_reader import DNIReader, OCRToken  # noqa: E402
from app.mapping import formatear_domicilio  # noqa: E402

# Sin __init__: no carga el modelo de OCR, que aquí no hace falta.
READER = DNIReader.__new__(DNIReader)


def _bloque(texto, x1, y, ancho=None, alto=24, grados=0.0):
    """Caja del OCR para `texto`, con su borde izquierdo en `x1` y centrado en
    `y`. Con `grados`, simula la foto girada: la caja alineada con los ejes
    de un texto inclinado crece en altura cuanto más largo es el texto."""
    ancho = ancho or len(texto) * 16
    caida = ancho * math.sin(math.radians(grados))
    return OCRToken(texto, 0.95, (x1, y - alto / 2, x1 + ancho, y + caida + alto / 2))


def _resto(y):
    """Lo que viene después del domicilio en el reverso de un DNI 4.0."""
    return [
        _bloque("LUGAR DE NACIMIENTO/LLOC DE NAIXEMENT", 100, y),
        _bloque("VALÈNCIA", 100, y + 35),
        _bloque("VALENCIA/VALÈNCIA", 100, y + 70),
        _bloque("HIJO/A DE/FILL/A DE", 100, y + 105),
        _bloque("JUAN / MARIA", 100, y + 140),
    ]


def _domicilio(direccion, localidad="VALÈNCIA", provincia="VALENCIA/VALÈNCIA"):
    return [
        _bloque(direccion, 100, 135),
        _bloque(localidad, 100, 170),
        _bloque(provincia, 100, 205),
    ] + _resto(260)


def _leer(bloques):
    reverso = READER._extract_back_fields(bloques)
    return formatear_domicilio({
        "direccion": reverso["domicilio"],
        "localidad": reverso["localidad"],
        "provincia": reverso["provincia"],
    })


CASOS_OCR = [
    (
        "caso normal (no cambia)",
        [_bloque("DOMICILIO/DOMICILI", 100, 100)] + _domicilio("C. ALEMANIA 12 P03 5"),
        "C. ALEMANIA 12 P03 5, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
    (
        "etiqueta partida en dos bloques (antes: O/DOMICILI, C. ALEMANIA, VALÈNCIA)",
        [_bloque("DOMICILI", 100, 100), _bloque("O/DOMICILI", 240, 100)]
        + _domicilio("C. ALEMANIA 12 P03 5"),
        "C. ALEMANIA 12 P03 5, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
    (
        "segunda mitad de la etiqueta mal leída (antes: DOMICHLI, C. ALEMANIA, ...)",
        [_bloque("DOMICILIO/DOMICHLI", 100, 100)] + _domicilio("C. ALEMANIA 12 P03 5"),
        "C. ALEMANIA 12 P03 5, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
    (
        "letra suelta junto a la etiqueta (antes: A, C. CIRIL AMORÓS, VALÈNCIA)",
        [_bloque("DOMICILIO/DOMICILI", 100, 100), _bloque("A", 420, 100)]
        + _domicilio("C. CIRIL AMORÓS 5 P02 3"),
        "C. CIRIL AMORÓS 5 P02 3, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
    (
        "calle larga partida en dos (antes: C. DOCTOR RODRIGUEZ FORNOS, A, VALÈNCIA)",
        [
            _bloque("DOMICILIO/DOMICILI", 100, 100),
            _bloque("C. DOCTOR RODRIGUEZ FORNOS", 100, 135),
            _bloque("12 P03 A", 540, 155),
            _bloque("VALÈNCIA", 100, 190),
            _bloque("VALENCIA/VALÈNCIA", 100, 225),
        ] + _resto(280),
        "C. DOCTOR RODRIGUEZ FORNOS 12 P03 A, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
    (
        "ruido del fondo junto a la provincia (antes: ..., OSTO VALENCIA/VALÈNCIA)",
        [
            _bloque("DOMICILIO/DOMICILI", 100, 100),
            _bloque("C. ALEMANIA 12 P03 5", 100, 135),
            _bloque("VALÈNCIA", 100, 170),
            _bloque("OSTO", 20, 205, ancho=60),
            _bloque("VALENCIA/VALÈNCIA", 100, 205),
        ] + _resto(260),
        "C. ALEMANIA 12 P03 5, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
    (
        "O y 0 confundidas, sin espacio tras C. (antes: C.PINTOR MAELLA 1O PO7 13)",
        [_bloque("DOMICILIO/DOMICILI", 100, 100)] + _domicilio("C.PINTOR MAELLA 1O PO7 13"),
        "C. PINTOR MAELLA 10 P07 13, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
    (
        "foto girada 3° (antes: VALÈNCIA C. ALEMANIA 12 P03 5, VALENCIA/VALÈNCIA)",
        [
            _bloque(texto, 100, 100 + i * 28, grados=3)
            for i, texto in enumerate([
                "DOMICILIO/DOMICILI", "C. ALEMANIA 12 P03 5", "VALÈNCIA", "VALENCIA/VALÈNCIA",
                "LUGAR DE NACIMIENTO/LLOC DE NAIXEMENT", "VALÈNCIA", "VALENCIA/VALÈNCIA",
                "HIJO/A DE/FILL/A DE", "JUAN / MARIA",
            ])
        ],
        "C. ALEMANIA 12 P03 5, VALÈNCIA, VALENCIA/VALÈNCIA",
    ),
]

# Limpieza de la línea de la calle: (entrada, esperado). Salidas reales del OCR.
CASOS_CALLE = [
    ("C. JORGE JUAN 19 P06 11", "C. JORGE JUAN 19 P06 11"),
    ("CRER. JORGE JUAN 0005 P04 0007", "CRER. JORGE JUAN 0005 P04 0007"),
    ("C. MAR DE ALBORAN. 24", "C. MAR DE ALBORAN. 24"),
    ("PLZA. RODRIGO BOTET 3 PO12", "PLZA. RODRIGO BOTET 3 PO12"),
    ("VALENCIA C. TIRIG 1 E7 P06 36", "C. TIRIG 1 E7 P06 36"),
    ("D CRER. CAVANILLES 32 P03 5", "CRER. CAVANILLES 32 P03 5"),
    ("C. L0S CENTELLES 54 P04 14", "C. LOS CENTELLES 54 P04 14"),
    ("CRER. IRLANDA 001O PBJ", "CRER. IRLANDA 0010 PBJ"),
    ("PSSG.MIRADOR 00040", "PSSG. MIRADOR 00040"),
    ("C. GUARDIA CIVIL 23 6 PO6 24", "C. GUARDIA CIVIL 23 6 P06 24"),
]

# Limpieza de la provincia: (entrada, esperado). Salidas reales del OCR.
CASOS_PROVINCIA = [
    ("VALENCIA/VALÈNCIA", "VALENCIA/VALÈNCIA"),
    ("OSTO VALENCIA", "VALENCIA"),
    ("POPATOL VALENCIA/VALÈNCIA", "VALENCIA/VALÈNCIA"),
    ("E VALENCIA", "VALENCIA"),
    ("VALENCIA LUGAE B MACME NOM", "VALENCIA"),
    ("VALENCTA/VALÈNCIA", "VALENCTA/VALÈNCIA"),
    ("SANTA CRUZ DE TENERIFE", "SANTA CRUZ DE TENERIFE"),
    ("ALICANTE/ALACANT", "ALICANTE/ALACANT"),
    # Sin provincia reconocible (domicilio con una línea más): no se toca.
    ("BETERA", "BETERA"),
]


def main() -> int:
    fallos = []

    for nombre, bloques, esperado in CASOS_OCR:
        obtenido = _leer(bloques)
        ok = obtenido == esperado
        print(f"  {'OK   ' if ok else 'FALLO'} {nombre}")
        if not ok:
            print(f"          esperado: {esperado!r}\n          obtenido: {obtenido!r}")
            fallos.append(nombre)

    for entrada, esperado in CASOS_CALLE:
        obtenido = DNIReader._clean_address_text(entrada)
        ok = obtenido == esperado
        print(f"  {'OK   ' if ok else 'FALLO'} calle {entrada!r} -> {obtenido!r}")
        if not ok:
            fallos.append(f"calle {entrada}")

    for entrada, esperado in CASOS_PROVINCIA:
        obtenido = DNIReader._clean_province_text(entrada)
        ok = obtenido == esperado
        print(f"  {'OK   ' if ok else 'FALLO'} provincia {entrada!r} -> {obtenido!r}")
        if not ok:
            fallos.append(f"provincia {entrada}")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
