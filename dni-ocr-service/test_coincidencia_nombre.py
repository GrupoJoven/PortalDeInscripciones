"""El cotejo de palabras del anverso contra el MRZ debe tolerar UN carácter
mal leído, pero no confundir palabras cortas realmente distintas.

    cd dni-ocr-service && python3 test_coincidencia_nombre.py

Antes, `_coinciden` solo miraba si los 4 primeros caracteres coincidían: una
sola letra mal leída al principio de la palabra ("BLOM" -> "8LOM") bastaba
para que no casase nada, aunque el resto de la palabra fuera idéntico. Un
primer intento de arreglo con `difflib.SequenceMatcher` lo resolvía, pero
introducía una regresión real: "GARCIA" y "MARIA" comparten letras de sobra
para superar un umbral de similitud del 70%, así que un apellido y un nombre
de pila distintos se confundían entre sí (visto en test_nombre_sin_etiquetas,
que pasó a perder "GARCIA" del resultado).

La distancia de edición (Levenshtein) con un solo cambio permitido, y solo
entre palabras de longitud parecida, separa bien ambos casos: el ruido de
OCR típico es UN carácter sustituido/insertado/borrado, mientras que dos
palabras reales distintas necesitan casi siempre más de un cambio para
convertirse la una en la otra.
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P  # noqa: E402


DEBEN_COINCIDIR = [
    ("BLOM", "8LOM", "letra confundida con un dígito, al principio"),
    ("BLOM", "BL0M", "letra confundida con un dígito, en medio"),
    ("RAMOS", "RAMDS", "una letra mal leída en medio"),
    ("CARLOS", "CARL0S", "letra confundida con un dígito"),
    ("DAHL", "KDAHL", "carácter de más pegado delante (caso real: guion mal leído)"),
    ("GARCIA", "GARCIA", "idénticas"),
]

NO_DEBEN_COINCIDIR = [
    ("GARCIA", "MARIA", "apellido y nombre reales distintos (caso real de regresión)"),
    ("GARCIA", "ISABEL", "apellido y nombre reales distintos"),
    ("LOPEZ", "MARIA", "apellido y nombre reales distintos"),
    ("LOPEZ", "ISABEL", "apellido y nombre reales distintos"),
    ("PEREZ", "MARIA", "apellido y nombre reales distintos"),
    ("RAMOS", "CARLOS", "apellido y nombre reales distintos"),
]


def main() -> int:
    fallos = []

    print("  Deben coincidir:")
    for a, b, motivo in DEBEN_COINCIDIR:
        ok = P._coinciden(a, b)
        if not ok:
            fallos.append(f"{a} vs {b}")
        print(f"    {'OK   ' if ok else 'FALLO'} {a!r} vs {b!r} ({motivo})")

    print("\n  NO deben coincidir:")
    for a, b, motivo in NO_DEBEN_COINCIDIR:
        ok = not P._coinciden(a, b)
        if not ok:
            fallos.append(f"{a} vs {b} (falso positivo)")
        print(f"    {'OK   ' if ok else 'FALLO'} {a!r} vs {b!r} ({motivo})")

    # De extremo a extremo: que el falso positivo no vuelva a colarse en
    # `componer_nombre_con_mrz` y se coma un apellido real.
    mrz = {"apellidos": "GARCIA LOPEZ", "nombre": "MARIA ISABEL"}
    lineas_anverso = ["GARCIA", "LOPEZ", "MARIA ISABEL"]
    nombre = P.componer_nombre_con_mrz(lineas_anverso, mrz)
    esperado = "MARIA ISABEL GARCIA LOPEZ"
    correcto = nombre == esperado

    if not correcto:
        fallos.append("componer_nombre_con_mrz pierde GARCIA")

    print(f"\n  {'OK   ' if correcto else 'FALLO'} extremo a extremo: GARCIA no se pierde")
    print(f"          -> {nombre}  (esperado: {esperado})")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
