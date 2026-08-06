"""Pruebas del pipeline de extracción de datos del DNI.

    cd dni-ocr-service && python3 test_pipeline.py
"""
import sys, re, pathlib
import numpy as np, cv2
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from app import pipeline as P

fails = []
def check(name, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + name + (f"  -> {extra}" if extra and not cond else ""))
    if not cond: fails.append(name)

print("\n== 1. Dígito de control DNI/NIE ==")
check("12345678Z válido", P.letra_dni_correcta("12345678Z"))
check("12345678A inválido", not P.letra_dni_correcta("12345678A"))
check("00000000T válido", P.letra_dni_correcta("00000000T"))
check("X1234567L válido (NIE)", P.letra_dni_correcta("X1234567L"))
check("basura inválida", not P.letra_dni_correcta("ABCDEFGH"))
check("None/vacío inválido", not P.letra_dni_correcta(""))

print("\n== 2. Extracción del anverso ==")
anverso = """DOCUMENTO NACIONAL DE IDENTIDAD
APELLIDOS
GARCIA
LOPEZ
NOMBRE
MARIA ISABEL
SEXO        NACIONALIDAD
F           ESP
FECHA DE NACIMIENTO
12 03 2010
NUM SOPORTE  12345678Z
"""
check("nombre completo", P.extraer_nombre_completo(anverso) == "MARIA ISABEL GARCIA LOPEZ",
      P.extraer_nombre_completo(anverso))
check("número anverso", P.extraer_dni_anverso(anverso) == "12345678Z", P.extraer_dni_anverso(anverso))

print("\n== 3. Extracción del reverso ==")
reverso = """DOMICILIO
CL EJEMPLO 12 3 B
MADRID
MADRID / MADRID
LUGAR DE NACIMIENTO
MADRID
IDESP BAA123456 12345678Z
IDESPBAA00000012345678Z
"""
dom = P.extraer_bloque_domicilio(reverso)
check("dirección", dom and dom["direccion"] == "CL EJEMPLO 12 3 B", dom)
check("localidad", dom and dom["localidad"] == "MADRID", dom)
check("provincia", dom and dom["provincia"] == "MADRID", dom)
num_rev = P.extraer_dni_reverso(reverso)
check("número reverso", num_rev == "12345678Z", num_rev)
check("domicilio formateado sin duplicados",
      P.formatear_domicilio(dom) == "CL EJEMPLO 12 3 B, MADRID", P.formatear_domicilio(dom))

print("\n== 4. Reverso con OCR degradado (NACIM1ENTO) ==")
degradado = reverso.replace("NACIMIENTO", "NACIM1ENTO")
check("tolera I->1", P.extraer_bloque_domicilio(degradado) is not None)

print("\n== 5. Detección y recorte del documento ==")
def tarjeta(texto_lineas, ancho=900):
    alto = int(ancho / P.PROPORCION_DNI)
    card = np.full((alto, ancho, 3), 235, np.uint8)
    for i, t in enumerate(texto_lineas):
        cv2.putText(card, t, (25, 60 + i*46), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (20,20,20), 2)
    fondo = np.full((alto+340, ancho+340, 3), 40, np.uint8)   # mesa oscura
    y, x = 170, 170
    fondo[y:y+alto, x:x+ancho] = card
    return fondo

img = tarjeta(["APELLIDOS", "GARCIA LOPEZ", "NOMBRE", "MARIA ISABEL", "SEXO  NACIONALIDAD"])
try:
    rec = P.detectar_y_recortar_documento(img)
    ratio = rec.shape[1] / rec.shape[0]
    check("detecta la tarjeta", True)
    check(f"proporción del recorte ~1.586 (={ratio:.3f})", abs(ratio - P.PROPORCION_DNI) < 0.12)
    check("recorte apaisado", rec.shape[1] > rec.shape[0])
except Exception as e:
    check("detecta la tarjeta", False, repr(e))

print("\n== 6. Fallback cuando no hay tarjeta detectable ==")
ruido = np.random.randint(0, 255, (400, 640, 3), dtype=np.uint8)
try:
    out = P._preparar_para_ocr(ruido)
    check("usa la imagen completa sin romperse", out is not None and out.size > 0)
except Exception as e:
    check("usa la imagen completa sin romperse", False, repr(e))

print("\n== 7. OCR extremo a extremo (con 'eng', no hay 'spa' aquí) ==")
pass
try:
    res = P.procesar_cara(img)
    print("     texto detectado:", repr(res.texto[:90]))
    check("clasifica como anverso", res.es_anverso, f"es_anverso={res.es_anverso}")
except Exception as e:
    check("procesar_cara no revienta", False, repr(e))

print("\n== 8. Consolidación de ambas caras ==")
# extraer_datos ya no pasa por procesar_cara: lee las dos caras y las
# clasifica comparándolas, así que se sustituyen esos dos pasos.
orig_leer, orig_extraer = P.leer_cara, P.extraer_de_cara

def simular(anverso_datos, reverso_datos):
    P.leer_cara = lambda im, deadline=None: P.CaraLeida(
        recorte=im,
        texto="APELLIDOS NOMBRE SEXO NACIONALIDAD" if im is img else "DOMICILIO IDESP",
        lineas=[],
    )
    P.extraer_de_cara = lambda cara, es_anverso, deadline=None: (
        P.ResultadoCara(es_anverso=True, **anverso_datos) if es_anverso
        else P.ResultadoCara(es_anverso=False, **reverso_datos)
    )

simular(
    {"numero": "12345678Z", "nombre": "MARIA ISABEL GARCIA LOPEZ"},
    {"numero": "12345678Z",
     "domicilio": {"direccion": "CL EJEMPLO 12 3 B", "localidad": "MADRID", "provincia": "MADRID"}},
)
datos = P.extraer_datos(img, ruido)
P.leer_cara, P.extraer_de_cara = orig_leer, orig_extraer
check("nombre consolidado", datos["nombre"] == "MARIA ISABEL GARCIA LOPEZ", datos)
check("número consolidado", datos["numero"] == "12345678Z", datos)
check("marca número válido", datos["numero_valido"] is True, datos)
check("domicilio texto", datos["domicilio_texto"] == "CL EJEMPLO 12 3 B, MADRID", datos)
check("sin avisos", datos["avisos"] == [], datos["avisos"])
check("campos_leidos completo",
      datos["campos_leidos"] == {"numero": True, "nombre": True, "domicilio": True}, datos)

print("\n== 9. Caso: número con letra incorrecta ==")
simular({"numero": "12345678A", "nombre": "X Y"}, {"numero": "12345678A"})
d2 = P.extraer_datos(img, ruido)
P.leer_cara, P.extraer_de_cara = orig_leer, orig_extraer
check("avisa del dígito de control", any("control" in a for a in d2["avisos"]), d2["avisos"])
check("numero_valido = False", d2["numero_valido"] is False)

print("\n== 10. Falta el domicilio -> se marca como no leído ==")
simular({"numero": "12345678Z", "nombre": "A B"}, {"numero": "12345678Z", "domicilio": None})
d3 = P.extraer_datos(img, ruido)
P.leer_cara, P.extraer_de_cara = orig_leer, orig_extraer
check("campos_leidos['domicilio'] es False", d3["campos_leidos"]["domicilio"] is False, d3)
check("avisa de que falta el domicilio",
      any("domicilio" in a.lower() for a in d3["avisos"]), d3["avisos"])

print("\n" + ("TODO CORRECTO" if not fails else f"FALLOS: {fails}"))
sys.exit(1 if fails else 0)
