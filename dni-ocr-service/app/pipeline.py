"""
Extracción de datos de un DNI español a partir de fotografías.

Adaptado del pipeline original (pytesseract + OpenCV) para funcionar sobre
imágenes en memoria en lugar de rutas de fichero, con validaciones extra:

  * Configuración de Tesseract corregida (el original pasaba
    "l spa - psm 11", que Tesseract no interpreta como se esperaba).
  * Varias pasadas de OCR con distintos --psm y se queda con la mejor.
  * Si falla la detección del contorno del documento se usa la imagen
    completa, porque el navegador ya recorta al marco guía.
  * Validación del dígito de control del DNI/NIE.
"""

from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
import pytesseract

logger = logging.getLogger(__name__)

# 85,60 x 53,98 mm -> proporción del formato ID-1
PROPORCION_DNI = 85.60 / 53.98

LETRAS_CONTROL = "TRWAGMYFPDXBNJZSQVHLCKE"

# Los --psm que mejor funcionan con el reverso (texto disperso) y con el
# anverso (bloques de texto). Se prueban en orden y se puntúa el resultado.
# Cada pasada de Tesseract sobre una tarjeta cuesta ~1 s en un servidor
# normal y hasta 10 s en una instancia compartida de 0,1 CPU, así que el
# número de pasadas es LO que determina si la petición termina a tiempo.
#
# Modos de segmentación de página, en el orden en que se prueban.
#
# Configurable con DNI_OCR_PSM (por ejemplo "3" o "3,4"). Se puede cambiar
# desde el panel del proveedor sin reconstruir la imagen, para comparar modos
# sobre documentos reales.
#
# Sobre una tarjeta sintética a dos columnas medí esto:
#
#     psm  3  ->  4 etiquetas reconocidas
#     psm  4  ->  4 etiquetas
#     psm  6  ->  4 etiquetas, pero pierde el domicilio
#     psm 11  ->  3 etiquetas, pierde NOMBRE
#
# ...pero una imagen sintética no es un DNI real: no tiene ni el ruido de la
# cámara, ni el holograma, ni el relieve, ni la trama de seguridad. Sobre
# documentos de verdad, psm 11 (texto disperso, sin análisis de estructura)
# dio mejor resultado, así que es el valor por defecto. psm 3 queda de
# respaldo por si psm 11 no reconoce nada.
PSM_A_PROBAR = tuple(
    int(valor)
    for valor in os.environ.get("DNI_OCR_PSM", "11,3").split(",")
    if valor.strip().isdigit()
) or (11, 3)

# Puntuación a partir de la cual no merece la pena probar más configuraciones:
# equivale a haber reconocido 2 etiquetas del documento.
PUNTUACION_SUFICIENTE = 200

# Tiempo máximo para procesar un documento completo. Al agotarse se devuelve
# lo que se haya podido leer en vez de seguir y agotar el tiempo de espera de
# quien llama, que es peor: así al menos se sabe qué campo ha fallado.
PRESUPUESTO_SEGUNDOS = float(os.environ.get("DNI_OCR_PRESUPUESTO_SEGUNDOS", 100))

# Ancho al que se normaliza el recorte antes del OCR.
#
# Las etiquetas del DNI ("APELLIDOS", "NOMBRE"...) miden en torno a 1,2 mm.
# Sobre una tarjeta de 85,6 mm de ancho:
#
#     ancho    px/mm    alto de una etiqueta de 1,2 mm
#     ------   -----    ------------------------------
#      950      11,1     13 px   ilegible
#     1500      17,5     21 px   justo
#     1700      19,9     24 px   cómodo
#
# Tesseract necesita 20-30 px de alto para leer con fiabilidad, así que por
# debajo de ~1500 px se pierden las etiquetas; y sin etiquetas no se alcanza
# PUNTUACION_SUFICIENTE, con lo que además se prueban todas las
# configuraciones: más lento y peor resultado.
#
# Ampliar una imagen pequeña no sirve: hace falta detalle real en la foto.
ANCHO_OCR = 1700

# Ancho al que se amplían las zonas recortadas (domicilio, nombre) antes de
# releerlas de forma aislada. El domicilio en particular lleva la tinta más
# clara y el cuerpo de letra más pequeño de toda la tarjeta: a 1700 px de
# ancho de tarjeta completa a menudo no llega a los 20-30 px de alto que
# Tesseract necesita. Como aquí ya se trabaja sobre un recorte pequeño (una
# franja, no la tarjeta entera), ampliarlo más sale barato: unos segundos
# extra de una pasada de Tesseract sobre una imagen pequeña, no sobre la
# tarjeta completa.
ANCHO_OCR_ZONA = 2300


def idioma_disponible() -> str:
    """Idioma de Tesseract a usar: 'spa' si está instalado, si no 'eng'.

    Sin esta comprobación, un despliegue sin el paquete tesseract-ocr-spa
    devolvería texto vacío en todas las peticiones sin dar ninguna pista.
    """
    try:
        idiomas = set(pytesseract.get_languages(config=""))
    except Exception:  # noqa: BLE001 - Tesseract mal instalado
        logger.error(
            "No se ha podido consultar los idiomas de Tesseract. "
            "¿Está instalado el binario?"
        )
        return "eng"

    if "spa" in idiomas:
        return "spa"

    logger.warning(
        "Falta el paquete de idioma 'spa' de Tesseract (instala tesseract-ocr-spa). "
        "Se usará 'eng', con peor precisión en acentos y etiquetas del DNI. "
        "Idiomas disponibles: %s",
        sorted(idiomas),
    )
    return "eng"


IDIOMA_OCR = idioma_disponible()

# Tesseract, por defecto, repite el reconocimiento sobre la imagen invertida
# por si el texto fuera claro sobre fondo oscuro. En un DNI nunca lo es, así
# que es trabajo duplicado: desactivarlo ahorra ~30 % del tiempo.
OPCIONES_VELOCIDAD = "-c tessedit_do_invert=0"

# OpenMP reparte el trabajo entre hilos, pero en una instancia con una
# fracción de CPU los hilos se pelean entre sí y va más lento. Limitarlo a uno
# ahorra otro ~30 %. Se fija también en el Dockerfile; aquí por si el servicio
# se ejecuta fuera del contenedor.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")


def config_ocr(psm: int, idioma: str | None = None) -> str:
    return f"--oem 3 --psm {psm} -l {idioma or IDIOMA_OCR} {OPCIONES_VELOCIDAD}"


def _configuraciones() -> tuple[str, ...]:
    """Orden en que se prueban las configuraciones de Tesseract.

    Primero el modo principal en español, que es lo correcto para un documento
    español. Si de ahí no sale nada se reintenta en inglés, porque es con lo
    que el pipeline original funcionaba sobre DNI reales: al ignorarse su
    cadena de configuración, corría con el idioma por defecto. El modelo de
    idioma influye en cómo se resuelven los caracteres dudosos, y en la
    tipografía condensada de las etiquetas eso se nota.

    Se corta en cuanto una reconoce suficientes etiquetas, así que lo normal
    es ejecutar solo la primera.
    """
    configuraciones = [config_ocr(PSM_A_PROBAR[0])]

    if IDIOMA_OCR != "eng":
        configuraciones.append(config_ocr(PSM_A_PROBAR[0], "eng"))

    for psm in PSM_A_PROBAR[1:]:
        configuraciones.append(config_ocr(psm))

    return tuple(configuraciones)


CONFIGURACIONES_OCR = _configuraciones()


# ---------------------------------------------------------------------------
# Utilidades de validación
# ---------------------------------------------------------------------------

def letra_dni_correcta(numero: str) -> bool:
    """Comprueba el dígito de control de un DNI o NIE español."""
    if not numero:
        return False

    valor = numero.strip().upper().replace("-", "").replace(" ", "")

    match = re.fullmatch(r"([XYZ]?)(\d{7,8})([A-Z])", valor)
    if not match:
        return False

    prefijo, digitos, letra = match.groups()

    if prefijo:
        # NIE: X -> 0, Y -> 1, Z -> 2
        digitos = str("XYZ".index(prefijo)) + digitos

    try:
        numerico = int(digitos)
    except ValueError:
        return False

    return LETRAS_CONTROL[numerico % 23] == letra


def normalizar_espacios(texto: str) -> str:
    return re.sub(r"\s+", " ", texto).strip()


def texto_plausible(
    texto: str | None,
    minimo_palabras: int = 2,
    minimo_mayusculas: float = 0.85,
) -> bool:
    """¿Esto parece un dato de verdad o el ruido de un OCR que no ha podido?

    El DNI imprime el nombre y el domicilio **enteramente en mayúsculas**, así
    que las minúsculas delatan letras mal leídas. Medido sobre un caso real:

        "omo: EE Pd a a 2, o 59 ALICANTE, A DE quo PS A A"   64 % mayúsculas
        "AV DE LA CONSTITUCION 45 2 IZQ, ALICANTE"          100 % mayúsculas

    Sin esta comprobación, una lectura ilegible se daba por buena y el usuario
    continuaba con datos inventados, que es peor que no leer nada.
    """
    if not texto or not texto.strip():
        return False

    letras = [c for c in texto if c.isalpha()]

    if not letras:
        return False

    proporcion_mayusculas = sum(1 for c in letras if c.isupper()) / len(letras)

    if proporcion_mayusculas < minimo_mayusculas:
        return False

    # Y tiene que haber palabras de verdad, no solo fragmentos sueltos.
    # No se exige que cada palabra sea íntegramente mayúscula: de la calidad
    # global ya se encarga la proporción de arriba, y una sola letra mal leída
    # ("MADRlD") no debería invalidar un domicilio por lo demás correcto.
    palabras = [
        t for t in re.split(r"[\s,.:;/\\|-]+", texto) if len(t) >= 3 and t.isalpha()
    ]

    return len(palabras) >= minimo_palabras


# ---------------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------------

def ocr(
    imagen: np.ndarray,
    configuraciones: tuple[str, ...] | None = None,
    puntuacion_suficiente: float = PUNTUACION_SUFICIENTE,
) -> str:
    """Texto reconocido en la imagen. Envoltorio de `ocr_con_posiciones`."""
    return ocr_con_posiciones(imagen, configuraciones, puntuacion_suficiente)[0]


def ocr_con_posiciones(
    imagen: np.ndarray,
    configuraciones: tuple[str, ...] | None = None,
    puntuacion_suficiente: float = PUNTUACION_SUFICIENTE,
    deadline: float | None = None,
) -> tuple[str, list["LineaOCR"]]:
    """Ejecuta OCR y devuelve el texto y las líneas con sus coordenadas.

    Se usa `image_to_data`, que da lo mismo que `image_to_string` más la
    posición de cada palabra, así que sale gratis: una sola pasada sirve tanto
    para las expresiones regulares como para localizar los campos por su sitio
    en la tarjeta.

    Se prueban varias segmentaciones y se corta en cuanto una reconoce
    suficientes etiquetas del documento. Recorrerlas todas siempre triplicaba
    el tiempo sin mejorar el resultado.
    """
    # Se lee en tiempo de llamada, no como valor por defecto, para poder
    # sustituirlo en pruebas y para respetar el idioma detectado al arrancar.
    configuraciones = configuraciones or CONFIGURACIONES_OCR

    mejor_texto = ""
    mejores_lineas: list[LineaOCR] = []
    mejor_puntuacion = -1.0
    errores = 0

    for config in configuraciones:
        # Cada pasada puede costar decenas de segundos en una instancia lenta,
        # así que se comprueba el tiempo ANTES de empezarla, no después.
        if _sin_tiempo(deadline) and mejor_texto:
            logger.warning("Sin tiempo para más configuraciones de OCR")
            break

        try:
            datos = pytesseract.image_to_data(
                imagen, config=config, output_type=pytesseract.Output.DICT
            )
        except pytesseract.TesseractError as error:
            errores += 1
            logger.warning("Tesseract ha fallado con %s: %s", config, error)
            continue

        lineas = _agrupar_en_lineas(datos)
        texto = "\n".join(linea.texto for linea in lineas)

        puntuacion = _puntuar_texto_ocr(texto)

        if puntuacion > mejor_puntuacion:
            mejor_puntuacion = puntuacion
            mejor_texto = texto
            mejores_lineas = lineas

        if puntuacion >= puntuacion_suficiente:
            break

    if errores == len(configuraciones):
        raise RuntimeError(
            "Tesseract ha fallado con todas las configuraciones. "
            "Revisa la instalación del binario y del paquete de idioma."
        )

    return mejor_texto, mejores_lineas


def _puntuar_texto_ocr(texto: str) -> float:
    """Puntúa un texto OCR por la presencia de las etiquetas del DNI."""
    if not texto or not texto.strip():
        return 0.0

    etiquetas = (
        "APELLIDOS",
        "NOMBRE",
        "NACIONALIDAD",
        "SEXO",
        "DOMICILIO",
        "NACIMIENTO",
        "IDESP",
        "VALIDEZ",
        "DNI",
    )

    mayusculas = texto.upper()
    encontradas = sum(1 for etiqueta in etiquetas if etiqueta in mayusculas)

    # Peso principal: etiquetas reconocidas. Desempate: longitud del texto.
    return encontradas * 100 + min(len(texto), 2000) / 2000


# ---------------------------------------------------------------------------
# MRZ (banda de caracteres del reverso)
# ---------------------------------------------------------------------------
# El reverso del DNI lleva abajo tres líneas de 30 caracteres en formato TD1,
# impresas en OCR-B: una tipografía pensada precisamente para que la lean las
# máquinas. Ahí están el número de documento, los apellidos y el nombre, y
# además con dígitos de control para comprobar que se han leído bien.
#
# Leer el nombre de aquí es mucho más fiable que sacarlo del texto decorativo
# del anverso, que es pequeño, va sobre un fondo con guilloches y en las
# versiones nuevas del documento está en dos idiomas.

# Solo hacen falta letras, cifras y el relleno '<': restringir el alfabeto
# evita que Tesseract invente signos de puntuación.
CONFIG_MRZ = (
    "--oem 3 --psm 6 "
    "-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789< "
    "-c load_system_dawg=0 -c load_freq_dawg=0 "
    "-c tessedit_do_invert=0"
)

VALORES_MRZ = {**{str(d): d for d in range(10)}, "<": 0}
VALORES_MRZ.update({chr(ord("A") + i): 10 + i for i in range(26)})


def _digito_control_mrz(cadena: str) -> int:
    """Dígito de control estándar de un MRZ: pesos 7, 3, 1 en ciclo."""
    pesos = (7, 3, 1)
    total = 0

    for indice, caracter in enumerate(cadena):
        total += VALORES_MRZ.get(caracter, 0) * pesos[indice % 3]

    return total % 10


def _limpiar_linea_mrz(linea: str) -> str:
    """Normaliza una línea de MRZ y corrige confusiones típicas del OCR."""
    limpia = re.sub(r"[^A-Z0-9<]", "", linea.upper().replace(" ", ""))
    return limpia


def localizar_lineas_mrz(texto: str) -> list[str] | None:
    """Busca en el texto tres líneas consecutivas con pinta de MRZ TD1."""
    candidatas = [
        _limpiar_linea_mrz(linea)
        for linea in texto.splitlines()
        if linea.strip()
    ]

    # Una línea de TD1 mide 30 caracteres; damos margen porque el OCR se come
    # o añade alguno en los extremos.
    candidatas = [c for c in candidatas if 24 <= len(c) <= 36 and "<" in c]

    for indice in range(len(candidatas) - 2):
        trio = candidatas[indice : indice + 3]

        if trio[0].startswith("ID") or trio[0].startswith("I<") or "ESP" in trio[0][:8]:
            return trio

    # Si no reconocemos la primera línea, al menos devolvemos tres seguidas.
    if len(candidatas) >= 3:
        return candidatas[:3]

    return None


def parsear_mrz(lineas: list[str]) -> dict:
    """Extrae número, apellidos y nombre de un MRZ TD1 de tres líneas."""
    resultado: dict[str, Any] = {
        "numero": None,
        "nombre": None,
        "apellidos": None,
        "numero_valido": False,
    }

    if not lineas or len(lineas) < 3:
        return resultado

    primera, _, tercera = lineas[0], lineas[1], lineas[2]

    # --- Número de DNI ---------------------------------------------------
    # En el DNI español, el campo de número de documento del MRZ lleva el
    # número de soporte, y el número de DNI va en los datos opcionales.
    coincidencia = re.search(r"(\d{8}[A-Z])", primera)

    if coincidencia:
        candidato = coincidencia.group(1)
        resultado["numero"] = candidato
        resultado["numero_valido"] = letra_dni_correcta(candidato)

    # --- Nombre y apellidos ----------------------------------------------
    # Formato: APELLIDO1<APELLIDO2<<NOMBRE<COMPUESTO<<<<<<<
    if "<<" in tercera:
        parte_apellidos, _, parte_nombre = tercera.partition("<<")
    else:
        parte_apellidos, parte_nombre = tercera, ""

    apellidos = normalizar_espacios(parte_apellidos.replace("<", " "))
    nombre = normalizar_espacios(parte_nombre.replace("<", " "))

    if apellidos:
        resultado["apellidos"] = apellidos

    if nombre:
        resultado["nombre"] = nombre

    # La línea 3 mide 30 caracteres fijos: si el nombre los llena hasta el
    # final, es que no cabía y está cortado. Solo cuando queda relleno '<' al
    # final podemos fiarnos de que está completo.
    resultado["nombre_completo_garantizado"] = tercera.endswith("<")

    return resultado


MRZ_VACIO = {
    "numero": None,
    "nombre": None,
    "apellidos": None,
    "numero_valido": False,
    "nombre_completo_garantizado": False,
}


def leer_mrz(imagen_reverso: np.ndarray, deadline: float | None = None) -> dict:
    """Recorta la franja inferior del reverso y lee el MRZ.

    Como mucho hace dos pasadas de Tesseract: la franja tal cual y, si de ahí
    no sale nada, la misma binarizada. La versión anterior probaba tres
    recortes por dos variantes, seis pasadas, y en un servidor de 0,1 CPU eso
    solo eran cuarenta segundos tirados cada vez que la cara no llevaba MRZ.
    """
    alto = imagen_reverso.shape[0]

    franja = imagen_reverso[int(alto * 0.60) :, :]

    if franja.size == 0:
        return dict(MRZ_VACIO)

    for etiqueta, imagen in (("directa", franja), ("binarizada", None)):
        if _sin_tiempo(deadline):
            logger.warning("Sin tiempo para seguir intentando leer el MRZ")
            break

        if imagen is None:
            imagen = preprocesar_recorte_para_ocr(franja)

        try:
            texto = pytesseract.image_to_string(imagen, config=CONFIG_MRZ)
        except pytesseract.TesseractError as error:
            logger.warning("Tesseract ha fallado leyendo el MRZ: %s", error)
            continue

        lineas = localizar_lineas_mrz(texto)

        if not lineas:
            continue

        datos = parsear_mrz(lineas)

        if datos.get("nombre") or datos.get("numero"):
            logger.info(
                "MRZ leído (%s): numero=%s valido=%s nombre=%s completo=%s",
                etiqueta,
                datos.get("numero"),
                datos.get("numero_valido"),
                bool(datos.get("nombre")),
                datos.get("nombre_completo_garantizado"),
            )
            return datos

    logger.info("No se ha podido leer el MRZ del reverso")
    return dict(MRZ_VACIO)


# ---------------------------------------------------------------------------
# Extracción de campos
# ---------------------------------------------------------------------------

def extraer_nombre_completo(texto: str) -> str | None:
    # Sin `\b` de cierre: Tesseract pega letras sueltas al final de las
    # etiquetas ("SEXOQ", "NOMBRE|") y con el límite de palabra no casaban.
    patron_apellidos = re.compile(
        r"\bAPELLIDOS[^\r\n]*[\r\n]+"
        r"(?P<apellidos>.*?)"
        r"(?=\s*\bNOMBRE)",
        re.IGNORECASE | re.DOTALL,
    )

    patron_nombre = re.compile(
        r"\bNOMBRE[^\r\n]*[\r\n]+"
        r"(?P<nombre>.*?)"
        r"(?=\s*\bSEXO)",
        re.IGNORECASE | re.DOTALL,
    )

    resultado_apellidos = patron_apellidos.search(texto)
    resultado_nombre = patron_nombre.search(texto)

    if not resultado_apellidos or not resultado_nombre:
        return None

    apellidos = normalizar_espacios(resultado_apellidos.group("apellidos"))
    nombre = normalizar_espacios(resultado_nombre.group("nombre"))

    if not apellidos or not nombre:
        return None

    return f"{nombre} {apellidos}"


@dataclass
class LineaOCR:
    texto: str
    x0: int
    y0: int
    x1: int
    y1: int


# --- Etiquetas del documento ----------------------------------------------
# En los DNI recientes las etiquetas van en español e inglés
# ("APELLIDOS / SURNAME"), así que se contemplan ambas.

# Ojo con los límites de palabra al final: Tesseract pega letras sueltas a las
# etiquetas con bastante frecuencia ("SEXOQ" en lugar de "SEXO", medido). Un
# `\bSEXO\b` no casa con eso y tira abajo toda la extracción, así que solo se
# ancla el principio de la palabra.
ETIQUETA_APELLIDOS = re.compile(
    r"\bAPELLIDOS?|\bSURNAMES?|PRIMER\s+APELLIDO", re.IGNORECASE
)

ETIQUETA_NOMBRE = re.compile(
    r"\bNOMBRE|\bGIVEN\s+NAMES?|\bNAME\b", re.IGNORECASE
)

# Lo que viene después del nombre en el anverso: marca dónde termina.
ETIQUETA_TRAS_NOMBRE = re.compile(
    r"\bSEXO|\bSEX\b|\bNACIONALIDAD|\bNATIONALITY|\bFECHA|"
    r"\bVALIDEZ|\bNACIM|\bIDESP|\bSOPORTE|\bDNI\b",
    re.IGNORECASE,
)

# Etiquetas que marcan el final del bloque del domicilio.
#
# Se contemplan las deformaciones típicas del OCR: la I de HIJO leída como 1
# o como l, NACIMIENTO con 1, etc. Si una de estas no se reconoce, el bloque
# de filiación (HIJO/A DE ...) se cuela dentro del domicilio.
# Ojo con ser demasiado goloso aquí: "PADRE" y "MADRE" aparecen en nombres de
# calle españoles ("CALLE PADRE MANJON"), así que solo se cortan cuando van
# como encabezado de la filiación, es decir seguidos de "DE" o al empezar la
# línea junto a HIJO.
#
# El DNI es bilingüe en las comunidades con lengua cooficial, y esas
# etiquetas van impresas junto a las castellanas: "LUGAR DE NACIMIENTO /
# LLOC DE NAIXEMENT", "HIJO/A DE / FILL/A DE", etc. Caso real visto en
# producción: al no reconocerse "NACIMIENTO" ni su traducción catalana
# "NAIXEMENT", ese bloque se coló entero como domicilio ("44 P14 53, DE
# NAIXEMENT", que en realidad era EQUIPO + LUGAR DE NAIXEMENT).
ETIQUETAS_SIGUIENTES = re.compile(
    r"\b("
    r"LUGAR\s+DE|LLOC\s+DE|DE\s+NAC[I1L]M|NAC[I1L]M[I1L]ENT|"
    r"NAIXEMENT|NACEMENTO|JAIOTZ|EQU[I1L]PO|"
    r"H[I1L]J[O0]\s*/?\s*A?\s*DE|FILL\s*/?\s*A?\s*DE|FILLO\s*/?\s*A?\s*DE|"
    r"SEME.{0,3}ALABA|[I1L]DESP|PROV[I1L]NC[I1L]A\s*/"
    r")",
    re.IGNORECASE,
)

# NOTA: hubo aquí un intento de reconocer el código de EQUIPO por su forma
# ("dígitos, letra+dígitos, dígitos") para excluirlo del domicilio si se
# leía suelto. Se ha quitado: esa forma es indistinguible de un número de
# piso/puerta real ("C. ALFAHUIR 44 P14 53" es una dirección auténtica), así
# que descartaba domicilios de verdad. El código de EQUIPO real no lleva
# espacios ("46745X6D1") y va aparte, junto al chip; con la palabra "EQUIPO"
# pegada delante ya lo corta `ETIQUETAS_SIGUIENTES`.

# Una línea que sea solo una etiqueta no es un valor.
SOLO_ETIQUETA = re.compile(
    r"^[\W_]*(APELLIDOS?|SURNAMES?|NOMBRE|NAME|GIVEN\s+NAMES?|SEXO|SEX|"
    r"NACIONALIDAD|NATIONALITY|DOMICILIO|ADDRESS)[\W_]*$",
    re.IGNORECASE,
)


def _agrupar_en_lineas(datos: dict) -> list[LineaOCR]:
    """Agrupa las palabras de `image_to_data` en líneas con sus coordenadas."""
    agrupadas: dict[tuple[int, int, int], list[int]] = {}

    for indice, texto in enumerate(datos["text"]):
        if not texto or not texto.strip():
            continue

        try:
            confianza = float(datos["conf"][indice])
        except (TypeError, ValueError):
            confianza = -1.0

        if confianza < 20:
            continue

        clave = (
            datos["block_num"][indice],
            datos["par_num"][indice],
            datos["line_num"][indice],
        )
        agrupadas.setdefault(clave, []).append(indice)

    lineas: list[LineaOCR] = []

    for indices in agrupadas.values():
        indices.sort(key=lambda i: datos["left"][i])

        palabras = [datos["text"][i].strip() for i in indices]
        x0 = min(datos["left"][i] for i in indices)
        y0 = min(datos["top"][i] for i in indices)
        x1 = max(datos["left"][i] + datos["width"][i] for i in indices)
        y1 = max(datos["top"][i] + datos["height"][i] for i in indices)

        lineas.append(LineaOCR(normalizar_espacios(" ".join(palabras)), x0, y0, x1, y1))

    lineas.sort(key=lambda l: (l.y0, l.x0))
    return lineas


def _lineas_debajo(
    lineas: list[LineaOCR],
    etiqueta: LineaOCR,
    maximo: int = 3,
) -> list[LineaOCR]:
    """Líneas situadas bajo una etiqueta, alineadas con ella y de su bloque.

    Además de parar en la siguiente etiqueta conocida, se corta cuando aparece
    un hueco vertical grande. Dentro de un bloque las líneas van muy juntas;
    el salto al bloque siguiente es notablemente mayor. Sin esto, si el OCR
    deforma la etiqueta que debía detenernos (HIJO/A DE, LUGAR DE
    NACIMIENTO...), ese bloque acaba dentro del domicilio.
    """
    resultado: list[LineaOCR] = []
    anterior: LineaOCR | None = None

    for linea in lineas:
        if linea is etiqueta or linea.y0 < etiqueta.y1 - 2:
            continue

        # Tiene que solaparse horizontalmente con la etiqueta: así no se
        # cuelan campos de la otra columna del documento.
        solape = min(linea.x1, etiqueta.x1 + 260) - max(linea.x0, etiqueta.x0 - 40)

        if solape <= 0:
            continue

        if ETIQUETAS_SIGUIENTES.search(linea.texto):
            logger.debug("Corte por etiqueta siguiente: %r", linea.texto[:40])
            break

        # El hueco solo se mide ENTRE líneas de valor. El que hay entre la
        # etiqueta y su primer valor es de otra naturaleza (la etiqueta es
        # mucho más pequeña) y medirlo ahí cortaba el bloque antes de empezar.
        if anterior is not None:
            hueco = linea.y0 - anterior.y1
            altura = max(14, anterior.y1 - anterior.y0)

            if hueco > altura * 2.2:
                logger.debug(
                    "Corte por hueco vertical (%d px sobre una altura de %d)",
                    hueco,
                    altura,
                )
                break

        resultado.append(linea)
        anterior = linea

        if len(resultado) >= maximo:
            break

    return resultado


def _resto_tras_etiqueta(linea: LineaOCR, patron: re.Pattern) -> str:
    """Texto que queda en la línea después de la etiqueta.

    A veces Tesseract junta la etiqueta y su valor en una sola línea
    ("APELLIDOS GARCIA"); así no se pierde el valor.
    """
    coincidencia = patron.search(linea.texto)

    if not coincidencia:
        return ""

    resto = linea.texto[coincidencia.end() :]
    resto = re.sub(r"^[\s/\\|:.,-]+", "", resto)

    # Quitar la traducción al inglés de la etiqueta, si la lleva pegada.
    resto = ETIQUETA_APELLIDOS.sub("", resto)
    resto = re.sub(r"^\s*(SURNAMES?|NAMES?)\b", "", resto, flags=re.IGNORECASE)

    return normalizar_espacios(resto)


def _valores_en_franja(
    lineas: list[LineaOCR],
    etiqueta: LineaOCR,
    limite_y: int | None,
    maximo: int = 3,
) -> list[str]:
    """Valores situados bajo una etiqueta y por encima de `limite_y`.

    Se exige que empiecen más o menos donde empieza la etiqueta: en el anverso
    los valores van alineados a la izquierda con su etiqueta, y eso evita que
    se cuelen campos de la otra columna o texto de encima de la fotografía.
    """
    tolerancia = max(60, int((etiqueta.x1 - etiqueta.x0) * 0.8))

    valores: list[str] = []

    # La propia línea de la etiqueta puede traer el valor pegado.
    pegado = _resto_tras_etiqueta(etiqueta, ETIQUETA_APELLIDOS) or _resto_tras_etiqueta(
        etiqueta, ETIQUETA_NOMBRE
    )

    if pegado and not SOLO_ETIQUETA.match(pegado):
        valores.append(pegado)

    for linea in lineas:
        if linea is etiqueta:
            continue

        if linea.y0 < etiqueta.y1 - 4:
            continue

        if limite_y is not None and linea.y0 >= limite_y - 4:
            continue

        if abs(linea.x0 - etiqueta.x0) > tolerancia:
            continue

        texto = linea.texto.strip()

        if not texto or SOLO_ETIQUETA.match(texto):
            continue

        # Un valor de nombre no lleva cifras ni signos raros.
        if not re.search(r"[A-ZÁÉÍÓÚÜÑ]", texto, re.IGNORECASE):
            continue

        valores.append(normalizar_espacios(texto))

        if len(valores) >= maximo:
            break

    return valores


# Tesseract confunde a menudo el guion con sus primos tipográficos (raya,
# semirraya, signo menos...) y el apóstrofo con las comillas tipográficas.
# Sin normalizarlos, un apellido compuesto como FERNANDEZ-MONTESINOS perdía
# el guion al limpiarlo.
GUIONES = "‐‑‒–—―−﹘﹣－"
APOSTROFOS = "‘’ʼ´`"

TRADUCCION_SIGNOS = str.maketrans(
    {**{c: "-" for c in GUIONES}, **{c: "'" for c in APOSTROFOS}}
)


def _limpiar_nombre(valor: str) -> str:
    """Deja solo letras, espacios, guiones y apóstrofos."""
    normalizado = valor.upper().translate(TRADUCCION_SIGNOS)
    limpio = re.sub(r"[^A-ZÁÉÍÓÚÜÑÇ'\-\s]", " ", normalizado)

    # Un guion suelto entre espacios no es parte del apellido.
    limpio = re.sub(r"\s+-\s+", " ", limpio)

    return normalizar_espacios(limpio)


def _tokens(valor: str) -> list[str]:
    return [t for t in re.split(r"[\s\-]+", valor.upper()) if len(t) >= 3]


def _coinciden(uno: str, otro: str) -> bool:
    """Dos palabras se refieren a lo mismo aunque una venga cortada."""
    return uno.startswith(otro[:4]) or otro.startswith(uno[:4])


def componer_nombre_con_mrz(lineas: list[str], mrz: dict) -> str | None:
    """Localiza el nombre en el anverso usando el MRZ como plantilla.

    Las etiquetas del anverso (APELLIDOS, NOMBRE) van impresas en un azul muy
    tenue y bajo el holograma, así que Tesseract a menudo no las lee ninguna:
    en los DNI reales probados, el anverso daba sistemáticamente
    `etiquetas=ninguna`. Sin etiquetas no hay forma de saber qué línea es qué.

    Pero el MRZ del reverso sí distingue apellidos de nombre. Aunque los
    trunque a 30 caracteres, sirve de plantilla: se comparan sus palabras con
    las líneas del anverso y las que casan se identifican como apellidos o
    como nombre. El texto que se devuelve es **el del anverso**, completo y
    sin truncar; el MRZ solo dice qué es cada cosa.

    Las líneas que no casen con nada se descartan, así que se le pueden pasar
    todas las del anverso sin miedo a que se cuelen fechas o "ESPAÑA".
    """
    apellidos_mrz = _tokens(mrz.get("apellidos") or "")
    nombre_mrz = _tokens(mrz.get("nombre") or "")

    if not apellidos_mrz or not nombre_mrz:
        return None

    apellidos: list[str] = []
    nombres: list[str] = []

    for linea in lineas:
        tokens = _tokens(linea)

        if not tokens:
            continue

        puntos_apellido = sum(
            1 for t in tokens if any(_coinciden(t, m) for m in apellidos_mrz)
        )
        puntos_nombre = sum(1 for t in tokens if any(_coinciden(t, m) for m in nombre_mrz))

        if puntos_apellido > puntos_nombre:
            apellidos.append(linea)
        elif puntos_nombre > puntos_apellido:
            nombres.append(linea)

    if not apellidos or not nombres:
        return None

    compuesto = f"{' '.join(nombres)} {' '.join(apellidos)}"

    logger.info("Nombre recompuesto con la plantilla del MRZ")

    return _limpiar_nombre(compuesto)


def _lineas_candidatas_a_nombre(lineas: list[LineaOCR]) -> list[str]:
    """Líneas del anverso que podrían ser nombre o apellidos.

    Filtro deliberadamente laxo: solo descarta lo que con seguridad no es un
    nombre (cifras, etiquetas conocidas, fragmentos de una o dos letras). De
    separar el grano de la paja se encarga después el cotejo con el MRZ.
    """
    candidatas: list[str] = []

    for linea in lineas:
        texto = _limpiar_nombre(linea.texto)

        if len(texto) < 3:
            continue

        # Con cifras no es un nombre: es una fecha o un número de documento.
        if any(c.isdigit() for c in linea.texto):
            continue

        if SOLO_ETIQUETA.match(texto) or ETIQUETA_TRAS_NOMBRE.search(texto):
            continue

        if ETIQUETA_APELLIDOS.search(texto) or ETIQUETA_NOMBRE.search(texto):
            continue

        # Palabras sueltas de dos letras o menos: ruido.
        palabras = [p for p in texto.split() if len(p) >= 3]

        if not palabras:
            continue

        candidatas.append(texto)

    return candidatas


def extraer_bloque_nombre(lineas: list[LineaOCR]) -> tuple[str | None, list[str]]:
    """Devuelve (nombre completo, líneas candidatas sin clasificar).

    Si se encuentran las dos etiquetas, el nombre sale directamente. Si solo
    aparece APELLIDOS, se devuelven las líneas de valores para que quien llame
    las ordene con ayuda del MRZ.
    """
    nombre = extraer_nombre_por_posicion(lineas)

    if nombre:
        return nombre, []

    etiqueta_apellidos = next(
        (l for l in lineas if ETIQUETA_APELLIDOS.search(l.texto)), None
    )

    if etiqueta_apellidos is None:
        return None, []

    limite = None

    for linea in lineas:
        if linea.y0 > etiqueta_apellidos.y1 and ETIQUETA_TRAS_NOMBRE.search(linea.texto):
            limite = linea.y0
            break

    candidatas = _valores_en_franja(lineas, etiqueta_apellidos, limite, maximo=4)

    return None, [_limpiar_nombre(c) for c in candidatas if _limpiar_nombre(c)]


def extraer_nombre_por_posicion(lineas: list[LineaOCR]) -> str | None:
    """Lee nombre y apellidos del anverso usando la posición de las etiquetas.

    Se busca la etiqueta APELLIDOS y se toman las líneas que hay debajo hasta
    la etiqueta NOMBRE; luego, las que hay bajo NOMBRE hasta SEXO o
    NACIONALIDAD. Los apellidos ocupan a menudo dos líneas, y así se recogen
    ambas.

    Frente a leerlo del MRZ del reverso, esto no trunca: la línea 3 del MRZ
    mide 30 caracteres fijos y un nombre largo se corta sin remedio.
    """
    if not lineas:
        return None

    etiqueta_apellidos = None
    etiqueta_nombre = None

    for linea in lineas:
        if etiqueta_apellidos is None and ETIQUETA_APELLIDOS.search(linea.texto):
            etiqueta_apellidos = linea
            continue

        # La etiqueta NOMBRE tiene que estar por debajo de APELLIDOS.
        if (
            etiqueta_nombre is None
            and ETIQUETA_NOMBRE.search(linea.texto)
            and not ETIQUETA_APELLIDOS.search(linea.texto)
            and (etiqueta_apellidos is None or linea.y0 >= etiqueta_apellidos.y0)
        ):
            etiqueta_nombre = linea

    if etiqueta_apellidos is None or etiqueta_nombre is None:
        return None

    # Dónde termina el bloque del nombre.
    limite_nombre = None

    for linea in lineas:
        if linea.y0 > etiqueta_nombre.y1 and ETIQUETA_TRAS_NOMBRE.search(linea.texto):
            limite_nombre = linea.y0
            break

    apellidos = _valores_en_franja(lineas, etiqueta_apellidos, etiqueta_nombre.y0, maximo=3)
    nombres = _valores_en_franja(lineas, etiqueta_nombre, limite_nombre, maximo=2)

    apellidos_texto = _limpiar_nombre(" ".join(apellidos))
    nombre_texto = _limpiar_nombre(" ".join(nombres))

    if not apellidos_texto or not nombre_texto:
        return None

    return f"{nombre_texto} {apellidos_texto}"


def _recortar_zona(
    imagen: np.ndarray,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
) -> np.ndarray:
    """Recorta una zona de la tarjeta en coordenadas relativas (0-1)."""
    alto, ancho = imagen.shape[:2]

    return imagen[
        int(alto * y0) : int(alto * y1),
        int(ancho * x0) : int(ancho * x1),
    ]


def _leer_zona(imagen: np.ndarray, deadline: float | None = None) -> list[LineaOCR]:
    """OCR de una zona concreta, probando en color y binarizado.

    Aislar la zona mejora mucho el análisis de estructura de Tesseract: en el
    reverso, el bloque del MRZ es tan denso y contrastado que acapara la
    segmentación y el domicilio se pierde; en el anverso, la fotografía del
    titular estorba de forma parecida.
    """
    intentos = ((imagen, config_ocr(4)), (None, config_ocr(6)))

    mejores: list[LineaOCR] = []

    for fuente, config in intentos:
        if _sin_tiempo(deadline):
            logger.warning("Sin tiempo para leer la zona")
            break

        if fuente is None:
            fuente = preprocesar_recorte_para_ocr(imagen)

        try:
            datos = pytesseract.image_to_data(
                fuente, config=config, output_type=pytesseract.Output.DICT
            )
        except pytesseract.TesseractError as error:
            logger.warning("Tesseract ha fallado leyendo la zona: %s", error)
            continue

        lineas = _agrupar_en_lineas(datos)

        if len(lineas) > len(mejores):
            mejores = lineas

        # Con la etiqueta localizada ya no hace falta seguir probando.
        texto = " ".join(l.texto for l in lineas).upper()
        if "DOMICILIO" in texto or "APELLIDOS" in texto:
            break

    return mejores


def _escalar_zona(zona: np.ndarray, ancho_objetivo: int = ANCHO_OCR_ZONA) -> np.ndarray:
    """Amplía un recorte pequeño para darle a Tesseract más píxeles por trazo.

    A diferencia de `_escalar_para_ocr` (pensado para la tarjeta entera, cuyo
    coste hay que vigilar), aquí ya se parte de una franja pequeña, así que se
    amplía siempre que quepa margen, sin comprobar un mínimo antes.
    """
    ancho = zona.shape[1]

    if ancho <= 0 or ancho >= ancho_objetivo:
        return zona

    factor = ancho_objetivo / ancho
    return cv2.resize(zona, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)


def extraer_domicilio_de_zona(
    reverso: np.ndarray,
    deadline: float | None = None,
) -> dict | None:
    """Lee el domicilio aislando la mitad superior del reverso.

    El MRZ ocupa la franja inferior; dejándolo fuera, Tesseract analiza la
    estructura del bloque del domicilio sin interferencias.
    """
    zona = _recortar_zona(reverso, 0.0, 0.0, 1.0, 0.62)

    if zona.size == 0:
        return None

    lineas = _leer_zona(_escalar_zona(zona), deadline=deadline)

    logger.info("Zona del domicilio: %d líneas", len(lineas))

    return extraer_domicilio_por_posicion(lineas)


def extraer_nombre_de_zona(
    anverso: np.ndarray,
    deadline: float | None = None,
) -> tuple[str | None, list[str]]:
    """Lee el nombre aislando la columna de campos del anverso.

    Se deja fuera la fotografía del titular, que ocupa el tercio izquierdo y
    confunde el análisis de estructura.
    """
    zona = _recortar_zona(anverso, 0.22, 0.02, 1.0, 0.80)

    if zona.size == 0:
        return None, []

    lineas = _leer_zona(_escalar_zona(zona), deadline=deadline)

    logger.info("Zona del nombre: %d líneas", len(lineas))

    return extraer_bloque_nombre(lineas)


def _bloque_superior_izquierdo(lineas: list[LineaOCR]) -> list[str]:
    """Primeras líneas de contenido de la esquina superior izquierda.

    Respaldo para cuando no se reconoce la etiqueta DOMICILIO, que en las
    fotos reales pasa a menudo: es diminuta y va en tinta clara. En el reverso
    del DNI el domicilio es siempre el primer bloque de arriba a la izquierda,
    así que se puede localizar por su sitio.

    Lo que salga de aquí pasa después por `texto_plausible`, que descarta el
    ruido, y por la validación de campos obligatorios.
    """
    if not lineas:
        return []

    ancho = max(l.x1 for l in lineas)
    alto = max(l.y1 for l in lineas)

    utiles = [
        l
        for l in lineas
        # Mitad superior y dos tercios izquierdos: donde va el domicilio.
        if l.y1 < alto * 0.55
        and l.x0 < ancho * 0.62
        and len(l.texto.strip()) >= 4
        and not ETIQUETAS_SIGUIENTES.search(l.texto)
        and not SOLO_ETIQUETA.match(l.texto.strip())
        and not re.search(r"\bDOMICILIO|ADDRESS", l.texto, re.IGNORECASE)
    ]

    if not utiles:
        return []

    utiles.sort(key=lambda l: (l.y0, l.x0))

    return [normalizar_espacios(l.texto) for l in utiles[:3]]


def extraer_domicilio_por_posicion(lineas: list[LineaOCR]) -> dict | None:
    """Busca la etiqueta DOMICILIO y toma las líneas que hay debajo.

    Si la etiqueta no se reconoce, se recurre al bloque superior izquierdo.
    """
    etiqueta = next(
        (l for l in lineas if re.search(r"\bDOMICILIO|ADDRESS", l.texto, re.IGNORECASE)),
        None,
    )

    if etiqueta is None:
        textos = _bloque_superior_izquierdo(lineas)

        if not textos:
            logger.info("Ni etiqueta DOMICILIO ni bloque superior izquierdo utilizable")
            return None

        logger.info(
            "Sin etiqueta DOMICILIO: se usa el bloque superior izquierdo (%d líneas)",
            len(textos),
        )

        return _componer_domicilio(textos)

    debajo = _lineas_debajo(lineas, etiqueta, maximo=4)
    textos = [l.texto for l in debajo if l.texto.strip()]

    if not textos:
        logger.info("Etiqueta DOMICILIO encontrada pero sin líneas de valor debajo")
        return None

    return _componer_domicilio(textos)


def _componer_domicilio(textos: list[str]) -> dict | None:
    """Reparte las líneas del bloque en dirección, localidad y provincia."""
    if not textos:
        return None

    direccion = textos[0]
    localidad = textos[1] if len(textos) > 1 else None
    provincia = None

    for texto in textos[2:]:
        if "/" in texto:
            partes = [p.strip() for p in texto.split("/") if p.strip()]
            if partes:
                provincia = partes[-1]
                break

    if provincia is None and len(textos) > 2:
        provincia = textos[2]

    return {"direccion": direccion, "localidad": localidad, "provincia": provincia}


def extraer_bloque_domicilio(texto: str) -> dict | None:
    patron = re.compile(
        r"\bDOMICILIO\b[^\r\n]*[\r\n]+\s*"
        r"(?P<contenido>.*?)"
        r"(?="
        r"\s*[^\r\n]{0,15}"
        r"\bDE\s+NACIM(?:I|1)ENTO\b"
        r")",
        re.IGNORECASE | re.DOTALL,
    )

    coincidencia = patron.search(texto)

    if not coincidencia:
        # Respaldo: coger las líneas siguientes a DOMICILIO hasta una línea
        # que parezca otra etiqueta del documento.
        respaldo = re.search(
            r"\bDOMICILIO[^\r\n]*[\r\n]+(?P<contenido>(?:[^\r\n]+[\r\n]+){1,4})",
            texto,
            re.IGNORECASE,
        )
        if not respaldo:
            return None
        contenido = respaldo.group("contenido")
    else:
        contenido = coincidencia.group("contenido")

    lineas = []

    for linea in contenido.splitlines():
        if not linea.strip():
            continue

        # Cortar en cuanto empieza el bloque siguiente (LUGAR DE NACIMIENTO,
        # HIJO/A DE...). Sin esto, la filiación acababa dentro del domicilio.
        if ETIQUETAS_SIGUIENTES.search(linea):
            break

        lineas.append(normalizar_espacios(linea))

        if len(lineas) >= 3:
            break

    if not lineas:
        return None

    direccion = lineas[0]
    localidad = lineas[1] if len(lineas) > 1 else None
    provincia = None

    for linea in lineas[2:]:
        if "/" in linea:
            partes = [parte.strip() for parte in linea.split("/") if parte.strip()]

            if partes:
                provincia = partes[-1]
                break

    if provincia is None and len(lineas) > 2:
        provincia = lineas[2]

    return {
        "direccion": direccion,
        "localidad": localidad,
        "provincia": provincia,
    }


def extraer_dni_reverso(texto: str) -> str | None:
    """Extrae el número desde la línea IDESP de la zona MRZ del reverso."""
    coincidencia = re.search(r"(?m)^IDESP[^\r\n]{10}(\d{8}[A-Z])", texto)

    if coincidencia:
        return coincidencia.group(1)

    # Respaldo: cualquier IDESP en la línea, con separación variable.
    coincidencia = re.search(r"IDESP.{0,20}?(\d{8}[A-Z])", texto, re.DOTALL)

    if coincidencia:
        return coincidencia.group(1)

    # Último recurso: primer número con formato de DNI válido del texto.
    for candidato in re.findall(r"\b(\d{8})\s?([A-Z])\b", texto):
        numero = f"{candidato[0]}{candidato[1]}"
        if letra_dni_correcta(numero):
            return numero

    return None


def extraer_dni_anverso(texto: str) -> str | None:
    candidatos = re.findall(r"\b(\d{8})\s?-?\s?([A-Z])\b", texto)

    # Preferimos el que valide el dígito de control.
    for numero, letra in candidatos:
        completo = f"{numero}{letra}"
        if letra_dni_correcta(completo):
            return completo

    if candidatos:
        return f"{candidatos[0][0]}{candidatos[0][1]}"

    return None


# ---------------------------------------------------------------------------
# Preprocesado y detección del documento
# ---------------------------------------------------------------------------

def preprocesar_recorte_para_ocr(imagen_color: np.ndarray) -> np.ndarray:
    gris = cv2.cvtColor(imagen_color, cv2.COLOR_BGR2GRAY)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    contraste = clahe.apply(gris)

    fondo = cv2.GaussianBlur(contraste, (0, 0), sigmaX=25, sigmaY=25)
    normalizada = cv2.divide(contraste, fondo, scale=255)

    binaria = cv2.adaptiveThreshold(
        normalizada,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        41,
        12,
    )

    return binaria


def ordenar_puntos(puntos) -> np.ndarray:
    puntos = np.asarray(puntos, dtype=np.float32)
    ordenados = np.zeros((4, 2), dtype=np.float32)

    suma = puntos.sum(axis=1)
    diferencia = np.diff(puntos, axis=1).reshape(-1)

    ordenados[0] = puntos[np.argmin(suma)]        # Superior izquierda
    ordenados[2] = puntos[np.argmax(suma)]        # Inferior derecha
    ordenados[1] = puntos[np.argmin(diferencia)]  # Superior derecha
    ordenados[3] = puntos[np.argmax(diferencia)]  # Inferior izquierda

    return ordenados


def corregir_perspectiva(imagen: np.ndarray, puntos) -> np.ndarray:
    puntos = ordenar_puntos(puntos)
    sup_izq, sup_der, inf_der, inf_izq = puntos

    ancho = int(max(
        np.linalg.norm(sup_der - sup_izq),
        np.linalg.norm(inf_der - inf_izq),
    ))
    alto = int(max(
        np.linalg.norm(inf_izq - sup_izq),
        np.linalg.norm(inf_der - sup_der),
    ))

    if ancho < 10 or alto < 10:
        raise ValueError("Recorte degenerado.")

    destino = np.array(
        [[0, 0], [ancho - 1, 0], [ancho - 1, alto - 1], [0, alto - 1]],
        dtype=np.float32,
    )

    matriz = cv2.getPerspectiveTransform(puntos, destino)

    recorte = cv2.warpPerspective(
        imagen,
        matriz,
        (ancho, alto),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )

    if recorte.shape[0] > recorte.shape[1]:
        recorte = cv2.rotate(recorte, cv2.ROTATE_90_CLOCKWISE)

    return recorte


def detectar_y_recortar_documento(
    imagen_original: np.ndarray,
    proporcion_esperada: float = PROPORCION_DNI,
    margen: float = 0.03,
) -> np.ndarray:
    """Detecta la tarjeta sobre el fondo y devuelve el recorte rectificado.

    Lanza ValueError si no encuentra un candidato razonable.
    """
    if imagen_original is None or imagen_original.size == 0:
        raise ValueError("Imagen vacía.")

    alto_original, ancho_original = imagen_original.shape[:2]

    ancho_trabajo = min(ancho_original, 1400)
    escala = ancho_trabajo / ancho_original

    imagen = cv2.resize(
        imagen_original, None, fx=escala, fy=escala, interpolation=cv2.INTER_AREA
    )

    alto, ancho = imagen.shape[:2]

    imagen_lab = cv2.cvtColor(imagen, cv2.COLOR_BGR2LAB).astype(np.float32)

    grosor_borde = max(5, int(min(alto, ancho) * 0.04))

    muestras_fondo = np.concatenate(
        [
            imagen_lab[:grosor_borde, :, :].reshape(-1, 3),
            imagen_lab[-grosor_borde:, :, :].reshape(-1, 3),
            imagen_lab[:, :grosor_borde, :].reshape(-1, 3),
            imagen_lab[:, -grosor_borde:, :].reshape(-1, 3),
        ],
        axis=0,
    )

    color_fondo = np.median(muestras_fondo, axis=0)

    distancia = np.linalg.norm(imagen_lab - color_fondo, axis=2)
    distancia = cv2.GaussianBlur(distancia, (0, 0), sigmaX=3)

    distancias_borde = np.linalg.norm(muestras_fondo - color_fondo, axis=1)
    mediana_fondo = np.median(distancias_borde)
    mad_fondo = np.median(np.abs(distancias_borde - mediana_fondo))

    umbral = float(np.clip(mediana_fondo + 5 * 1.4826 * mad_fondo, 8, 35))

    mascara = np.where(distancia > umbral, 255, 0).astype(np.uint8)

    mascara[:grosor_borde, :] = 0
    mascara[-grosor_borde:, :] = 0
    mascara[:, :grosor_borde] = 0
    mascara[:, -grosor_borde:] = 0

    tamano_kernel = max(9, int(min(alto, ancho) * 0.025))
    if tamano_kernel % 2 == 0:
        tamano_kernel += 1

    kernel_grande = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (tamano_kernel, tamano_kernel)
    )
    mascara = cv2.morphologyEx(mascara, cv2.MORPH_CLOSE, kernel_grande, iterations=3)

    kernel_pequeno = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mascara = cv2.morphologyEx(mascara, cv2.MORPH_OPEN, kernel_pequeno, iterations=1)

    contornos, _ = cv2.findContours(
        mascara, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    area_imagen = alto * ancho

    mejor_caja = None
    mejor_puntuacion = -1.0

    for contorno in contornos:
        area = cv2.contourArea(contorno)
        proporcion_area = area / area_imagen

        if proporcion_area < 0.02 or proporcion_area > 0.85:
            continue

        casco = cv2.convexHull(contorno)
        rectangulo = cv2.minAreaRect(casco)

        (_, _), (ancho_rect, alto_rect), _ = rectangulo

        if ancho_rect <= 0 or alto_rect <= 0:
            continue

        lado_mayor = max(ancho_rect, alto_rect)
        lado_menor = min(ancho_rect, alto_rect)

        proporcion = lado_mayor / lado_menor
        rectangularidad = area / (ancho_rect * alto_rect)

        if proporcion < 1.15 or proporcion > 2.1:
            continue

        error_proporcion = abs(proporcion - proporcion_esperada)
        puntuacion_proporcion = max(0.0, 1 - error_proporcion / 0.7)

        puntuacion = (
            proporcion_area
            * max(rectangularidad, 0.1)
            * (0.3 + 0.7 * puntuacion_proporcion)
        )

        if puntuacion > mejor_puntuacion:
            mejor_puntuacion = puntuacion
            mejor_caja = cv2.boxPoints(rectangulo).astype(np.float32)

    if mejor_caja is None:
        raise ValueError("No se ha podido detectar la tarjeta completa.")

    centro = mejor_caja.mean(axis=0)
    mejor_caja = centro + (mejor_caja - centro) * (1 + margen)

    mejor_caja[:, 0] = np.clip(mejor_caja[:, 0], 0, ancho - 1)
    mejor_caja[:, 1] = np.clip(mejor_caja[:, 1], 0, alto - 1)

    puntos_originales = mejor_caja / escala

    return corregir_perspectiva(imagen_original, puntos_originales)


def _borde_uniforme(imagen: np.ndarray, umbral: float = 14.0) -> bool:
    """¿El borde de la imagen es un fondo liso (una mesa, por ejemplo)?

    Una superficie de apoyo es muy uniforme; el borde de la propia tarjeta,
    con su texto y sus tramas, lo es mucho menos.
    """
    alto, ancho = imagen.shape[:2]
    grosor = max(3, int(min(alto, ancho) * 0.03))

    gris = cv2.cvtColor(imagen, cv2.COLOR_BGR2GRAY)

    banda = np.concatenate(
        [
            gris[:grosor, :].ravel(),
            gris[-grosor:, :].ravel(),
            gris[:, :grosor].ravel(),
            gris[:, -grosor:].ravel(),
        ]
    )

    return float(banda.std()) < umbral


def _ya_viene_recortada(imagen: np.ndarray, tolerancia: float = 0.08) -> bool:
    """¿La imagen es ya prácticamente solo la tarjeta?

    La página de captura recorta exactamente al marco guía, que tiene la
    proporción del DNI, así que en la práctica todo lo que llega del móvil
    entra por aquí y la detección de contorno ni se usa.

    Basta con la proporción: las cámaras dan 4:3 (1,33) o 16:9 (1,78), nunca
    la del DNI (1,59), así que una foto sin recortar no se confunde con una
    recortada. Y si la imagen ya tiene forma de tarjeta, lo más probable con
    diferencia es que sea la tarjeta: buscar un contorno dentro solo puede
    llevar a quedarse con un trozo (la fotografía del titular, un bloque de
    texto) y perderlo todo.
    """
    alto, ancho = imagen.shape[:2]

    if alto == 0 or ancho == 0:
        return False

    proporcion = max(alto, ancho) / min(alto, ancho)

    return abs(proporcion - PROPORCION_DNI) <= tolerancia


def _recorte_creible(recorte: np.ndarray, imagen: np.ndarray) -> bool:
    """Comprueba que lo detectado se parece de verdad a un DNI.

    Sin esta validación, sobre una imagen ya recortada el detector tomaba por
    contorno un bloque de texto o la fotografía y devolvía un recorte
    deformado con el que Tesseract dejaba de leer.
    """
    alto, ancho = recorte.shape[:2]

    if alto < 10 or ancho < 10:
        return False

    proporcion = max(alto, ancho) / min(alto, ancho)

    if abs(proporcion - PROPORCION_DNI) > 0.20:
        logger.info("Recorte descartado: proporción %.2f lejos de %.2f", proporcion, PROPORCION_DNI)
        return False

    area_original = imagen.shape[0] * imagen.shape[1]
    proporcion_area = (alto * ancho) / area_original if area_original else 0

    # Si el recorte "crece" respecto al original, la corrección de perspectiva
    # ha deformado la imagen: es el fallo que dejaba a Tesseract sin leer.
    if proporcion_area > 1.10:
        logger.info(
            "Recorte descartado: la corrección de perspectiva lo ha agrandado al %.0f%%",
            100 * proporcion_area,
        )
        return False

    # Aquí solo se llega con imágenes que NO tienen forma de tarjeta, es decir,
    # con fondo alrededor. Una foto hecha de lejos da un recorte legítimamente
    # pequeño, así que el mínimo es holgado: quien descarta los falsos
    # positivos es la comprobación de la proporción, porque un fragmento de
    # tarjeta no tiene la forma de un DNI.
    if proporcion_area < 0.04:
        logger.info("Recorte descartado: ocupa solo el %.1f%%", 100 * proporcion_area)
        return False

    return True


def _preparar_para_ocr(imagen: np.ndarray) -> np.ndarray:
    """Deja la imagen lista para el OCR: solo la tarjeta y a un tamaño útil.

    La detección de contorno solo se usa cuando hace falta. Si la imagen ya
    tiene la proporción del DNI, buscar la tarjeta dentro de la tarjeta es
    contraproducente: al no haber fondo del que separarla, el algoritmo toma
    por contorno cualquier bloque de texto o la fotografía, y devuelve un
    recorte deformado con el que Tesseract ya no lee nada.
    """
    alto_original, ancho_original = imagen.shape[:2]

    if _ya_viene_recortada(imagen):
        logger.info(
            "Imagen ya recortada (%dx%d): se omite la detección de contorno",
            ancho_original,
            alto_original,
        )
        recorte = imagen

        if recorte.shape[0] > recorte.shape[1]:
            recorte = cv2.rotate(recorte, cv2.ROTATE_90_CLOCKWISE)

        return _escalar_para_ocr(recorte)

    try:
        recorte = detectar_y_recortar_documento(imagen)

        if not _recorte_creible(recorte, imagen):
            raise ValueError("recorte_no_creible")

        logger.info(
            "Documento detectado: %dx%d -> %dx%d",
            ancho_original,
            alto_original,
            recorte.shape[1],
            recorte.shape[0],
        )
    except (ValueError, cv2.error):
        logger.info(
            "Sin detección fiable (%dx%d): se usa la imagen completa",
            ancho_original,
            alto_original,
        )
        recorte = imagen
        if recorte.shape[0] > recorte.shape[1]:
            recorte = cv2.rotate(recorte, cv2.ROTATE_90_CLOCKWISE)

    return _escalar_para_ocr(recorte)


def _escalar_para_ocr(recorte: np.ndarray) -> np.ndarray:
    """Normaliza el ancho: ni tan pequeño que Tesseract no lea, ni tan grande
    que tarde de más para nada."""
    ancho = recorte.shape[1]

    if ancho > ANCHO_OCR * 1.15:
        factor = ANCHO_OCR / ancho
        return cv2.resize(
            recorte, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA
        )

    if ancho < ANCHO_OCR * 0.75:
        factor = ANCHO_OCR / ancho
        return cv2.resize(
            recorte, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC
        )

    return recorte


# ---------------------------------------------------------------------------
# API del módulo
# ---------------------------------------------------------------------------

@dataclass
class ResultadoCara:
    es_anverso: bool
    numero: str | None = None
    nombre: str | None = None
    domicilio: dict | None = None
    texto: str = ""
    avisos: list[str] = field(default_factory=list)
    # Líneas del anverso que parecen nombre o apellidos pero que no se han
    # podido clasificar por faltar la etiqueta NOMBRE.
    lineas_nombre: list[str] = field(default_factory=list)
    # Datos del MRZ del reverso, para poder ordenar esas líneas.
    mrz: dict | None = None
    # Varianza del laplaciano: por debajo de ~40 el texto pequeño es ilegible.
    nitidez: float | None = None


@dataclass
class CaraLeida:
    recorte: np.ndarray
    texto: str
    lineas: list[LineaOCR]
    nitidez: float = 0.0


INDICIOS_ANVERSO = ("APELLIDOS", "SURNAME", "NOMBRE", "SEXO", "NACIONALIDAD", "VALIDEZ")
INDICIOS_REVERSO = ("DOMICILIO", "ADDRESS", "IDESP", "LUGAR DE NACIM", "HIJO", "EQUIPO")


def _sin_tiempo(deadline: float | None) -> bool:
    return deadline is not None and time.monotonic() >= deadline


# Girar la carta 90°/180° respecto a como la lee Tesseract la deja tan
# fragmentada como una foto realmente movida: decenas de líneas de 3-5
# caracteres, sin una sola etiqueta reconocida. Comprobado con fotos reales
# (ver test_correccion_rotacion.py): a la orientación correcta salen 15-50
# líneas con 6-15+ caracteres de media; girada 90° u 180°, 100-150 líneas de
# 4-5 caracteres. El aviso de "nitidez baja" que ya existía diagnosticaba
# bien el síntoma pero apuntaba a la causa equivocada: no es la foto, es el
# ángulo con el que ha llegado.
ROTACIONES_ALTERNATIVAS = (
    cv2.ROTATE_90_CLOCKWISE,
    cv2.ROTATE_180,
    cv2.ROTATE_90_COUNTERCLOCKWISE,
)

# Config barata (una sola pasada, sin las variantes en inglés/otros psm) para
# probar las cuatro orientaciones sin disparar el coste por cuatro.
CONFIG_ORIENTACION = config_ocr(6)


def _puntuacion_orientacion(texto: str) -> float:
    """Puntúa un texto por lo bien orientada que parece la imagen leída.

    Se suma a la puntuación habitual (etiquetas del documento) la longitud
    media de línea: el anverso rara vez deja leer sus etiquetas —van en tinta
    tenue bajo el holograma— ni siquiera bien orientado, así que hace falta
    una señal que no dependa solo de encontrarlas. Mal orientada, una tarjeta
    sale hecha decenas de líneas de 3-5 caracteres; bien orientada, aunque la
    lectura salga floja, las líneas miden bastante más.
    """
    if not texto or not texto.strip():
        return 0.0

    lineas = [l for l in texto.splitlines() if l.strip()]
    caracteres_por_linea = len(texto) / len(lineas) if lineas else 0

    return _puntuar_texto_ocr(texto) + min(caracteres_por_linea, 30)


def _corregir_rotacion(recorte: np.ndarray, deadline: float | None = None) -> np.ndarray | None:
    """Prueba las otras tres rotaciones y devuelve la que lea claramente mejor.

    Solo se llama cuando la lectura ya ha salido con la pinta de estar mal
    orientada. Cada intento es una única pasada de Tesseract (barata) en vez
    de las 2-3 configuraciones completas: aquí solo hace falta puntuar, no
    sacar el texto definitivo. Devuelve `None` si ninguna alternativa mejora
    claramente lo que ya había, para no girar una tarjeta que de verdad
    estaba bien orientada pero había salido borrosa por otro motivo.
    """
    try:
        texto_actual = pytesseract.image_to_string(recorte, config=CONFIG_ORIENTACION)
    except pytesseract.TesseractError:
        texto_actual = ""

    mejor_imagen = None
    mejor_puntuacion = _puntuacion_orientacion(texto_actual)

    for rotacion in ROTACIONES_ALTERNATIVAS:
        if _sin_tiempo(deadline):
            break

        candidata = cv2.rotate(recorte, rotacion)

        try:
            texto = pytesseract.image_to_string(candidata, config=CONFIG_ORIENTACION)
        except pytesseract.TesseractError:
            continue

        puntuacion = _puntuacion_orientacion(texto)

        # Margen para no girar por una diferencia que podría ser solo ruido.
        if puntuacion > mejor_puntuacion + 5:
            mejor_puntuacion = puntuacion
            mejor_imagen = candidata

    return mejor_imagen


def _puntuar_cara(texto: str) -> int:
    """Positivo si parece el anverso, negativo si parece el reverso."""
    mayusculas = texto.upper()

    anverso = sum(1 for i in INDICIOS_ANVERSO if i in mayusculas)
    reverso = sum(1 for i in INDICIOS_REVERSO if i in mayusculas)

    return anverso - reverso


def leer_cara(imagen: np.ndarray, deadline: float | None = None) -> CaraLeida:
    """Hace el OCR de una cara. No decide todavía si es anverso o reverso."""
    recorte = _preparar_para_ocr(imagen)

    texto, lineas = ocr_con_posiciones(recorte, deadline=deadline)

    # Si el OCR en color va flojo, reintentar con la versión binarizada.
    if _puntuar_texto_ocr(texto) < 100 and not _sin_tiempo(deadline):
        texto_binario, lineas_binario = ocr_con_posiciones(
            preprocesar_recorte_para_ocr(recorte),
            configuraciones=CONFIGURACIONES_OCR[:1],
            deadline=deadline,
        )
        if _puntuar_texto_ocr(texto_binario) > _puntuar_texto_ocr(texto):
            texto, lineas = texto_binario, lineas_binario

    etiquetas = [
        e
        for e in ("APELLIDOS", "NOMBRE", "SEXO", "NACIONALIDAD", "DOMICILIO", "IDESP")
        if e in texto.upper()
    ]

    caracteres_por_linea = len(texto) / len(lineas) if lineas else 0

    puntuacion_lectura = _puntuar_texto_ocr(texto)

    # Dos firmas distintas de una tarjeta girada 90°/180° (comprobado con
    # fotos reales y con tarjetas sintéticas):
    #   - decenas de líneas de 3-5 caracteres: lo típico en una foto real,
    #     donde girar el texto también fragmenta la segmentación de Tesseract;
    #   - puntuación ~0 aunque las líneas no sean tan cortas: en un render
    #     limpio (sin el ruido de una foto) Tesseract puede seguir agrupando
    #     líneas enteras aunque el texto salga leído "del revés" y por tanto
    #     irreconocible.
    # No se exige que `etiquetas` esté vacía: sobre 104 líneas de basura basta
    # que una palabra corta como "SEXO" aparezca por azar para que la lista
    # deje de estar vacía, y con eso bastaba para que este reintento nunca
    # llegara a dispararse (caso real). En su lugar se usa la puntuación
    # agregada, que exige más que una sola coincidencia suelta.
    # Antes esto solo se registraba como aviso de "posible desenfoque"; ahora
    # se intenta arreglar antes de rendirse.
    if (
        lineas
        and puntuacion_lectura < PUNTUACION_SUFICIENTE
        and (caracteres_por_linea < 6 or puntuacion_lectura < 1)
        and not _sin_tiempo(deadline)
    ):
        recorte_corregido = _corregir_rotacion(recorte, deadline=deadline)

        if recorte_corregido is not None:
            logger.info("Reintentando con otra rotación: la lectura tenía pinta de estar girada")

            recorte = recorte_corregido
            texto, lineas = ocr_con_posiciones(recorte, deadline=deadline)
            etiquetas = [
                e
                for e in ("APELLIDOS", "NOMBRE", "SEXO", "NACIONALIDAD", "DOMICILIO", "IDESP")
                if e in texto.upper()
            ]
            caracteres_por_linea = len(texto) / len(lineas) if lineas else 0

    # La nitidez se registra para poder relacionar los fallos con la calidad
    # de la foto. Muchas líneas con muy pocos caracteres delata una foto
    # movida: Tesseract ve manchas de texto pero no resuelve las letras.
    gris = cv2.cvtColor(recorte, cv2.COLOR_BGR2GRAY)
    nitidez = float(cv2.Laplacian(gris, cv2.CV_64F).var())

    # Sin etiquetas y con la foto por debajo de lo necesario, el problema es
    # de resolución de captura, no del reconocimiento.
    if not etiquetas and recorte.shape[1] < ANCHO_OCR * 0.9:
        logger.warning(
            "Ninguna etiqueta reconocida y la foto solo tiene %d px de ancho: "
            "hacen falta ~%d px para que las etiquetas del documento se lean",
            recorte.shape[1],
            ANCHO_OCR,
        )

    logger.info(
        "Cara leída: %dx%d, %d líneas, %d caracteres (%.1f por línea), "
        "nitidez=%.0f, etiquetas=%s",
        recorte.shape[1],
        recorte.shape[0],
        len(lineas),
        len(texto),
        caracteres_por_linea,
        nitidez,
        etiquetas or "ninguna",
    )

    if lineas and caracteres_por_linea < 6 and not etiquetas:
        logger.warning(
            "Muchas líneas con poquísimo texto y ninguna etiqueta: "
            "la foto parece movida o desenfocada (nitidez=%.0f)",
            nitidez,
        )

    return CaraLeida(recorte=recorte, texto=texto, lineas=lineas, nitidez=nitidez)


def extraer_de_cara(
    cara: CaraLeida,
    es_anverso: bool,
    deadline: float | None = None,
) -> ResultadoCara:
    """Extrae los campos de una cara ya leída y ya clasificada."""
    texto, lineas, recorte = cara.texto, cara.lineas, cara.recorte

    if es_anverso:
        # Primero por posición (etiquetas APELLIDOS y NOMBRE con sus líneas
        # debajo); si no, la expresión regular original.
        nombre, candidatas = extraer_bloque_nombre(lineas)

        # Se reintenta SIEMPRE aislando la columna de campos (sin la
        # fotografía del titular ni el holograma) cuando no ha salido un
        # nombre directo, aunque ya hubiera candidatas de la tarjeta entera.
        # Caso real: con el holograma fragmentando el OCR (97 líneas de 5
        # caracteres de media), `extraer_bloque_nombre` encontraba APELLIDOS
        # y devolvía candidatas, así que este reintento se saltaba por
        # completo justo cuando más falta hacía: la lectura aislada es más
        # limpia porque no compite con el ruido del resto de la tarjeta.
        if not nombre:
            nombre_zona, candidatas_zona = extraer_nombre_de_zona(recorte, deadline=deadline)
            nombre = nombre_zona
            candidatas = candidatas_zona + [c for c in candidatas if c not in candidatas_zona]

        if not nombre:
            nombre = extraer_nombre_completo(texto)

        # Red de seguridad amplia: TODAS las líneas del anverso que parezcan
        # nombre, casen o no con la posición de una etiqueta. Se suman
        # siempre que siga sin haber nombre, no solo cuando no había ninguna
        # candidata: con la tarjeta muy fragmentada las candidatas "de
        # posición" pueden venir mal cortadas y no casar luego con el MRZ, y
        # más vale tener de sobra donde elegir que quedarse corto. El cotejo
        # con el MRZ (`componer_nombre_con_mrz`) descarta solo él las líneas
        # que no coincidan con sus tokens, así que añadir de más no hace daño.
        if not nombre:
            amplias = _lineas_candidatas_a_nombre(lineas)
            candidatas = candidatas + [c for c in amplias if c not in candidatas]

            if candidatas:
                logger.info(
                    "%d líneas candidatas a nombre quedan a la espera de que "
                    "el MRZ diga cuál es cuál",
                    len(candidatas),
                )

        return ResultadoCara(
            es_anverso=True,
            numero=extraer_dni_anverso(texto),
            nombre=nombre,
            texto=texto,
            lineas_nombre=candidatas,
            nitidez=cara.nitidez,
        )

    # Reverso: el domicilio se busca primero por posición (etiqueta DOMICILIO
    # y líneas de debajo) y solo si eso falla se recurre a la expresión
    # regular, que depende del orden en que Tesseract devuelva las líneas.
    domicilio = extraer_domicilio_por_posicion(lineas)

    if not domicilio:
        domicilio = extraer_bloque_domicilio(texto)

    # El MRZ acapara la segmentación del reverso y deja el domicilio sin leer,
    # así que se reintenta con la franja superior aislada.
    if not domicilio:
        domicilio = extraer_domicilio_de_zona(recorte, deadline=deadline)

    # El MRZ da el número con dígito de control, que es lo más fiable.
    mrz = leer_mrz(recorte, deadline=deadline)

    numero = mrz.get("numero") or extraer_dni_reverso(texto)

    # El nombre del MRZ solo se usa como último recurso, y únicamente si se
    # puede garantizar que no está truncado: la línea 3 mide 30 caracteres
    # fijos y un nombre largo se corta.
    nombre = None

    if (
        mrz.get("nombre")
        and mrz.get("apellidos")
        and mrz.get("nombre_completo_garantizado")
    ):
        nombre = f"{mrz['nombre']} {mrz['apellidos']}"

    return ResultadoCara(
        es_anverso=False,
        numero=numero,
        nombre=nombre,
        domicilio=domicilio,
        texto=texto,
        mrz=mrz,
        nitidez=cara.nitidez,
    )


def procesar_cara(imagen: np.ndarray, es_anverso: bool | None = None) -> ResultadoCara:
    """Lee y extrae una cara suelta, decidiendo ella misma de cuál se trata.

    `extraer_datos` no usa esta función: clasifica las dos caras a la vez, que
    es más fiable. Se mantiene por comodidad para pruebas y uso manual.
    """
    cara = leer_cara(imagen)

    if es_anverso is None:
        es_anverso = _puntuar_cara(cara.texto) > 0

    return extraer_de_cara(cara, es_anverso)


def formatear_domicilio(domicilio: dict | None) -> str | None:
    if not domicilio:
        return None

    partes = [
        domicilio.get("direccion"),
        domicilio.get("localidad"),
        domicilio.get("provincia"),
    ]

    limpias = [normalizar_espacios(p) for p in partes if p and p.strip()]

    # Evitar repetir localidad y provincia cuando el OCR las duplica.
    sin_duplicados: list[str] = []
    for parte in limpias:
        if parte.upper() not in {p.upper() for p in sin_duplicados}:
            sin_duplicados.append(parte)

    return ", ".join(sin_duplicados) if sin_duplicados else None


def extraer_datos(
    anverso: np.ndarray,
    reverso: np.ndarray,
    presupuesto_segundos: float | None = None,
) -> dict[str, Any]:
    """Procesa ambas caras y consolida nombre, número de DNI y domicilio.

    Las dos caras se clasifican comparándolas entre sí, no una a una. Cuando
    cada cara decidía por su cuenta, un anverso con el OCR flojo podía darse
    por reverso: entonces se buscaba en él un MRZ inexistente (pasadas de
    Tesseract tiradas) y, lo que es peor, no se le buscaba el nombre.
    """
    inicio = time.monotonic()

    if presupuesto_segundos is None:
        presupuesto_segundos = PRESUPUESTO_SEGUNDOS

    deadline = inicio + presupuesto_segundos

    leidas = [leer_cara(anverso, deadline=deadline), leer_cara(reverso, deadline=deadline)]

    logger.info("OCR de las dos caras en %.1f s", time.monotonic() - inicio)

    puntuaciones = [_puntuar_cara(c.texto) for c in leidas]

    indice_anverso = 0 if puntuaciones[0] >= puntuaciones[1] else 1
    indice_reverso = 1 - indice_anverso

    logger.info(
        "Clasificación de caras: puntuaciones=%s -> anverso=%s",
        puntuaciones,
        "primera" if indice_anverso == 0 else "segunda",
    )

    cara_anverso = extraer_de_cara(leidas[indice_anverso], True, deadline=deadline)
    cara_reverso = extraer_de_cara(leidas[indice_reverso], False, deadline=deadline)

    caras = [cara_anverso, cara_reverso]
    delanteras = [cara_anverso]
    traseras = [cara_reverso]

    avisos: list[str] = []

    if max(puntuaciones) <= 0:
        avisos.append("No se ha reconocido bien ninguna de las dos caras.")

    if time.monotonic() >= deadline:
        avisos.append("La lectura ha agotado el tiempo disponible.")

    # El nombre se lee del anverso, que es donde aparece completo. El del MRZ
    # (reverso) solo llega aquí si se pudo garantizar que no venía truncado.
    nombre = next((c.nombre for c in delanteras if c.nombre), None)
    origen_nombre = "anverso (etiquetas)" if nombre else None

    # Si en el anverso no se leyeron las etiquetas, se cotejan sus líneas con
    # el MRZ del reverso: el MRZ dice qué es apellido y qué es nombre, y el
    # texto completo —sin truncar— se toma del anverso.
    if not nombre:
        candidatas = next((c.lineas_nombre for c in delanteras if c.lineas_nombre), [])
        mrz = next((c.mrz for c in traseras if c.mrz), None)

        if candidatas and mrz:
            nombre = componer_nombre_con_mrz(candidatas, mrz)

            if nombre:
                origen_nombre = "anverso (cotejado con el MRZ)"

    # Solo si el anverso no ha dado nada se recurre al nombre del propio MRZ,
    # que puede venir cortado a 30 caracteres.
    if not nombre:
        nombre = next((c.nombre for c in traseras if c.nombre), None)

        if nombre:
            origen_nombre = "MRZ del reverso (puede venir truncado)"

    if nombre:
        logger.info("Nombre obtenido del %s", origen_nombre)

    domicilio = next((c.domicilio for c in traseras if c.domicilio), None)

    # El número aparece en ambas caras; preferimos el que valide el control.
    numeros = [c.numero for c in caras if c.numero]
    numero = next((n for n in numeros if letra_dni_correcta(n)), None)

    if numero is None and numeros:
        numero = numeros[0]
        avisos.append("El dígito de control del DNI no cuadra.")

    if nombre is None:
        avisos.append("No se ha podido leer el nombre.")
    if domicilio is None:
        avisos.append("No se ha podido leer el domicilio.")
    if numero is None:
        avisos.append("No se ha podido leer el número de DNI.")

    # La nitidez explica casi siempre por qué falla la lectura. Medido sobre
    # fotos reales: por debajo de ~40 el texto pequeño del documento sale
    # ilegible, aunque las líneas se detecten.
    borrosas = [
        etiqueta
        for etiqueta, cara in (("anverso", cara_anverso), ("reverso", cara_reverso))
        if cara.nitidez is not None and cara.nitidez < 40
    ]

    if borrosas and not (nombre and domicilio):
        cuales = " y ".join(borrosas)
        avisos.append(
            f"La foto del {cuales} ha salido poco nítida. "
            "Apoya el documento en una superficie firme, acerca el móvil hasta "
            "llenar el marco y espera a que enfoque antes de disparar."
        )

    domicilio_texto = formatear_domicilio(domicilio)

    # Última criba: un texto que no se sostiene se descarta. Vale más pedir
    # que repitan la foto que dejarles seguir con un domicilio inventado.
    if domicilio_texto and not texto_plausible(domicilio_texto):
        logger.warning(
            "Domicilio descartado por ilegible: %r", domicilio_texto[:60]
        )
        avisos.append("El domicilio se ha leído mal; repite la foto del reverso.")
        domicilio = None
        domicilio_texto = None

    if nombre and not texto_plausible(nombre):
        logger.warning("Nombre descartado por ilegible: %r", nombre[:60])
        avisos.append("El nombre se ha leído mal; repite la foto del anverso.")
        nombre = None

    logger.info(
        "Extracción terminada en %.1f s: numero=%s nombre=%s domicilio=%s",
        time.monotonic() - inicio,
        bool(numero),
        bool(nombre),
        bool(domicilio_texto),
    )

    return {
        "numero": numero,
        "nombre": nombre,
        "domicilio": domicilio,
        "domicilio_texto": domicilio_texto,
        "numero_valido": letra_dni_correcta(numero) if numero else False,
        # Qué se ha podido leer. Quien llama decide si con eso basta: para un
        # menor sin DNI propio el nombre del progenitor no hace falta.
        "campos_leidos": {
            "numero": bool(numero),
            "nombre": bool(nombre),
            "domicilio": bool(domicilio_texto),
        },
        "avisos": avisos,
    }


def decodificar_imagen(datos: bytes) -> np.ndarray:
    buffer = np.frombuffer(datos, dtype=np.uint8)
    imagen = cv2.imdecode(buffer, cv2.IMREAD_COLOR)

    if imagen is None:
        raise ValueError("No se ha podido decodificar la imagen.")

    return imagen
