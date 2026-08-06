"""Pruebas del lector de MRZ (la banda de caracteres del reverso del DNI).

    cd dni-ocr-service && python3 test_mrz.py
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from app import pipeline as P

fallos=[]
def check(n,c,extra=""):
    print(("  OK   " if c else "  FALLO ")+n+(f"  -> {extra}" if extra and not c else "")); 
    if not c: fallos.append(n)

print("\n== Dígito de control del MRZ ==")
# Ejemplos del documento 9303 de OACI
check("digito de '520727' = 3", P._digito_control_mrz("520727")==3, P._digito_control_mrz("520727"))
check("digito de 'AB2134<<<' = 5", P._digito_control_mrz("AB2134<<<")==5, P._digito_control_mrz("AB2134<<<"))
check("'<' vale 0", P._digito_control_mrz("<<<")==0)

print("\n== Parseo de un MRZ TD1 de DNI español ==")
mrz = [
    "IDESPBAA1234561234567 8Z<<<<<<".replace(" ",""),
    "1003128F3001019ESP<<<<<<<<<<<4",
    "GARCIA<LOPEZ<<MARIA<ISABEL<<<<",
]
d = P.parsear_mrz(mrz)
print("     ->", d)
check("apellidos", d["apellidos"]=="GARCIA LOPEZ", d)
check("nombre", d["nombre"]=="MARIA ISABEL", d)
check("numero", d["numero"]=="12345678Z", d)
check("numero validado con su letra", d["numero_valido"] is True, d)

print("\n== Apellido simple y nombre compuesto ==")
d = P.parsear_mrz(["IDESPXYZ0000001<<<<<<<<<<<<<<<","1003128F3001019ESP<<<<<<<<<<<4",
                   "PEREZ<<JOSE<MARIA<ANTONIO<<<<<"])
check("un solo apellido", d["apellidos"]=="PEREZ", d)
check("nombre compuesto", d["nombre"]=="JOSE MARIA ANTONIO", d)

print("\n== Localizar el MRZ dentro del texto del OCR ==")
texto = """DOMICILIO
CL EJEMPLO 12 3 B
MADRID
LUGAR DE NACIMIENTO
MADRID
IDESPBAA123456112345678Z<<<<<
1003128F3001019ESP<<<<<<<<<<<4
GARCIA<LOPEZ<<MARIA<ISABEL<<<<
"""
lineas = P.localizar_lineas_mrz(texto)
check("encuentra las 3 lineas", lineas is not None and len(lineas)==3, lineas)
if lineas:
    d = P.parsear_mrz(lineas)
    check("extrae el nombre del texto completo", d["nombre"]=="MARIA ISABEL", d)
    check("extrae los apellidos", d["apellidos"]=="GARCIA LOPEZ", d)

print("\n== Tolerancia a ruido del OCR ==")
sucio = """IDESPBAA123456112345678Z<<<<<
1003128F3001019ESP<<<<<<<<<<<4
GARCIA<LOPEZ<<MARIA<ISABEL<<<<"""
lineas = P.localizar_lineas_mrz(sucio.replace("<<<<<","<<<< <"))  # espacios metidos por el OCR
check("ignora espacios espurios", lineas is not None, lineas)

print("\n== No inventa datos si no hay MRZ ==")
d = P.parsear_mrz([])
check("devuelve todo a None", d["numero"] is None and d["nombre"] is None, d)
lineas = P.localizar_lineas_mrz("DOMICILIO\nCL EJEMPLO 12\nMADRID")
check("no encuentra MRZ donde no lo hay", lineas is None, lineas)

print("\n"+("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}"))
sys.exit(1 if fallos else 0)
