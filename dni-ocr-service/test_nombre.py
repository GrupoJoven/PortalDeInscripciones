"""Pruebas de la lectura del nombre en el anverso, por posición de etiquetas.

    cd dni-ocr-service && python3 test_nombre.py

Incluye el caso de nombre largo, que es el motivo de no usar el MRZ para esto:
su línea de nombres mide 30 caracteres fijos y trunca sin remedio.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import numpy as np, cv2
from app import pipeline as P
# En un entorno sin el paquete de español se cae a inglés; para estas
# pruebas sintéticas da igual.

F = cv2.FONT_HERSHEY_SIMPLEX
def anverso(apellidos, nombre, ancho=1500):
    """Anverso a dos columnas: foto a la izquierda, campos a la derecha."""
    alto=int(ancho/P.PROPORCION_DNI)
    card=np.full((alto,ancho,3),233,np.uint8)
    for y in range(0,alto,4): cv2.line(card,(0,y),(ancho,y+9),(214,219,228),1)
    cv2.rectangle(card,(50,150),(330,650),(140,145,155),-1)      # fotografía
    cv2.putText(card,"DOCUMENTO NACIONAL DE IDENTIDAD",(50,80),F,0.7,(40,60,120),2)
    X=400; y=190
    def etiqueta(t):
        nonlocal y; cv2.putText(card,t,(X,y),F,0.52,(95,95,115),1); y+=46
    def valor(t):
        nonlocal y; cv2.putText(card,t,(X,y),F,0.92,(20,20,30),2); y+=52
    etiqueta("APELLIDOS")
    for a in apellidos: valor(a)
    etiqueta("NOMBRE")
    valor(nombre)
    etiqueta("SEXO          NACIONALIDAD")
    valor("F             ESP")
    etiqueta("FECHA DE NACIMIENTO")
    valor("12 03 2010")
    cv2.putText(card,"12345678Z",(X,y+40),F,0.95,(20,20,30),2)
    f=np.full((alto+280,ancho+280,3),52,np.uint8); f[140:140+alto,140:140+ancho]=card
    return f

casos = [
    ("Nombre corriente", ["GARCIA","LOPEZ"], "MARIA ISABEL", "MARIA ISABEL GARCIA LOPEZ"),
    ("Nombre MUY largo (el que fallaba en el MRZ)",
     ["FERNANDEZ-MONTESINOS","DE LA SANTISIMA TRINIDAD"],
     "MARIA DEL CARMEN INMACULADA",
     "MARIA DEL CARMEN INMACULADA FERNANDEZ-MONTESINOS DE LA SANTISIMA TRINIDAD"),
    ("Un solo apellido", ["PEREZ"], "JOSE", "JOSE PEREZ"),
]

fallos=[]
for titulo, apellidos, nombre, esperado in casos:
    img = anverso(apellidos, nombre)
    r = P.procesar_cara(img)
    obtenido = r.nombre or ""
    ok = obtenido.strip().upper() == esperado.upper()
    print(f"{'  OK  ' if ok else ' FALLO'} {titulo}")
    print(f"        esperado: {esperado}")
    print(f"        obtenido: {obtenido}")
    print(f"        (anverso={r.es_anverso}, longitud={len(obtenido)} car.)")
    if not ok: fallos.append(titulo)

print()
print("Nota: el MRZ solo admite 30 caracteres en su linea de nombres;")
print(f"el segundo caso tiene {len(casos[1][3])} caracteres y ahi se cortaria.")
print()
print("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}")
sys.exit(1 if fallos else 0)
