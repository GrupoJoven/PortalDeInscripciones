"""Pruebas del mapeo entre la salida de DNIReader y el contrato HTTP que
espera la Edge Function `dni-verification-upload`.

    cd dni-ocr-cloudrun && python3 test_mapping.py

No hace falta PaddleOCR instalado para estas pruebas: `mapping.py` no
importa `dni_reader.py`, solo trabaja sobre el diccionario que `DNIReader`
ya habría devuelto.
"""

import sys
import pathlib
from datetime import date, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import mapping as M  # noqa: E402


def _resultado(
    numero="48718068C",
    nombre="CARLOS",
    apellidos="BLOM-DAHL RAMOS",
    direccion="C. ALFAHUIR 44 P14 53",
    localidad="VALÈNCIA",
    provincia="VALENCIA/VALÈNCIA",
    validez="2030-02-14",
    dni_valido=True,
    advertencias=None,
):
    return {
        "documento": {"numero": numero},
        "titular": {"nombre": nombre, "apellidos": apellidos},
        "domicilio": {"direccion": direccion, "localidad": localidad, "provincia": provincia},
        "fechas": {"validez": validez},
        "validacion": {"dni_valido": dni_valido, "advertencias": advertencias or []},
    }


def main() -> int:
    fallos = []

    # --- Caso normal: apellido compuesto con guion --------------------
    r = M.mapear_respuesta(_resultado())
    ok = (
        r["nombre"] == "CARLOS BLOM-DAHL RAMOS"
        and r["numero"] == "48718068C"
        and r["numero_valido"] is True
        and r["domicilio_texto"] == "C. ALFAHUIR 44 P14 53, VALÈNCIA, VALENCIA/VALÈNCIA"
        and r["campos_leidos"] == {"numero": True, "nombre": True, "domicilio": True}
    )
    print(f"  {'OK   ' if ok else 'FALLO'} caso normal (apellido compuesto)")
    print(f"          -> nombre={r['nombre']!r} domicilio={r['domicilio_texto']!r}")
    if not ok:
        fallos.append("caso normal")

    # --- Apellidos ausente: nombre no debe reventar --------------------
    r = M.mapear_respuesta(_resultado(apellidos=None))
    ok = r["nombre"] == "CARLOS" and r["campos_leidos"]["nombre"] is True
    print(f"  {'OK   ' if ok else 'FALLO'} apellidos ausente -> nombre={r['nombre']!r}")
    if not ok:
        fallos.append("apellidos ausente")

    # --- Nombre y apellidos ausentes -----------------------------------
    r = M.mapear_respuesta(_resultado(nombre=None, apellidos=None))
    ok = r["nombre"] is None and r["campos_leidos"]["nombre"] is False
    ok = ok and "No se ha podido leer el nombre." in r["avisos"]
    print(f"  {'OK   ' if ok else 'FALLO'} nombre y apellidos ausentes")
    if not ok:
        fallos.append("nombre ausente")

    # --- Domicilio con localidad/provincia duplicadas (dedupe) ---------
    r = M.mapear_respuesta(_resultado(localidad="MADRID", provincia="MADRID"))
    ok = r["domicilio_texto"] == "C. ALFAHUIR 44 P14 53, MADRID"
    print(f"  {'OK   ' if ok else 'FALLO'} domicilio con provincia duplicada -> {r['domicilio_texto']!r}")
    if not ok:
        fallos.append("domicilio duplicado")

    # --- Resultado vacío del todo ---------------------------------------
    r = M.mapear_respuesta({})
    ok = (
        r["numero"] is None
        and r["nombre"] is None
        and r["domicilio_texto"] is None
        and r["numero_valido"] is False
        and all(v is False for v in r["campos_leidos"].values())
    )
    print(f"  {'OK   ' if ok else 'FALLO'} resultado vacío no revienta")
    if not ok:
        fallos.append("resultado vacio")

    # --- Vigencia: fecha futura -> vigente -------------------------------
    futura = (date.today() + timedelta(days=365)).isoformat()
    r = M.mapear_respuesta(_resultado(validez=futura))
    ok = r["documento_vigente"] is True and not any("caducado" in a for a in r["avisos"])
    print(f"  {'OK   ' if ok else 'FALLO'} fecha de validez futura -> vigente={r['documento_vigente']}")
    if not ok:
        fallos.append("vigencia futura")

    # --- Vigencia: fecha pasada -> NO vigente, debe avisar de caducidad --
    pasada = (date.today() - timedelta(days=1)).isoformat()
    r = M.mapear_respuesta(_resultado(validez=pasada))
    ok = r["documento_vigente"] is False and any("caducado" in a for a in r["avisos"])
    print(f"  {'OK   ' if ok else 'FALLO'} fecha de validez pasada -> vigente={r['documento_vigente']}")
    print(f"          avisos={r['avisos']}")
    if not ok:
        fallos.append("vigencia pasada")

    # --- Vigencia: fecha de HOY mismo -> todavía vigente (>=) ------------
    r = M.mapear_respuesta(_resultado(validez=date.today().isoformat()))
    ok = r["documento_vigente"] is True
    print(f"  {'OK   ' if ok else 'FALLO'} fecha de validez = hoy -> vigente={r['documento_vigente']}")
    if not ok:
        fallos.append("vigencia hoy")

    # --- Vigencia: ausente -> None, aviso suave, no bloqueante -----------
    r = M.mapear_respuesta(_resultado(validez=None))
    ok = r["documento_vigente"] is None and any("caducidad" in a for a in r["avisos"])
    print(f"  {'OK   ' if ok else 'FALLO'} fecha de validez ausente -> vigente={r['documento_vigente']}")
    if not ok:
        fallos.append("vigencia ausente")

    print()
    print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")

    return 1 if fallos else 0


if __name__ == "__main__":
    sys.exit(main())
