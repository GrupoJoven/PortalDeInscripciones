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
# --psm 4 (una columna de tamaños variables) va primero porque además de leer
# bien agrupa las líneas de forma utilizable, que es lo que necesita la
# extracción por posición. --psm 11 (texto disperso) queda como respaldo.
PSM_A_PROBAR = (4, 11)

# Puntuación a partir de la cual no merece la pena probar más configuraciones:
# equivale a haber reconocido 2 etiquetas del documento.
PUNTUACION_SUFICIENTE = 200

# Tiempo máximo para procesar un documento completo. Al agotarse se devuelve
# lo que se haya podido leer en vez de seguir y agotar el tiempo de espera de
# quien llama, que es peor: así al menos se sabe qué campo ha fallado.
PRESUPUESTO_SEGUNDOS = float(os.environ.get("DNI_OCR_PRESUPUESTO_SEGUNDOS", 70))

# Ancho al que se normaliza el recorte antes del OCR.
#
# Medido: por debajo de ~1300 px Tesseract empieza a perder las etiquetas
# pequeñas del documento ("NACIONALIDAD", "APELLIDOS"...), y al perderlas ya no
# se alcanza PUNTUACION_SUFICIENTE, así que se acaban probando las tres
# configuraciones y encima el resultado es peor: más lento y menos preciso.
ANCHO_OCR = 1500


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

CONFIGURACIONES_OCR = tuple(
    rf"--oem 3 --psm {psm} -l {IDIOMA_OCR}" for psm in PSM_A_PROBAR
)


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
    "-c load_system_dawg=0 -c load_freq_dawg=0"
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
    patron_apellidos = re.compile(
        r"\bAPELLIDOS\b[^\r\n]*[\r\n]+"
        r"(?P<apellidos>.*?)"
        r"(?=\s*\bNOMBRE\b)",
        re.IGNORECASE | re.DOTALL,
    )

    patron_nombre = re.compile(
        r"\bNOMBRE\b[^\r\n]*[\r\n]+"
        r"(?P<nombre>.*?)"
        r"(?=\s*\bSEXO\b)",
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

ETIQUETA_APELLIDOS = re.compile(
    r"\bAPELLIDOS?\b|\bSURNAMES?\b|PRIMER\s+APELLIDO", re.IGNORECASE
)

ETIQUETA_NOMBRE = re.compile(
    r"\bNOMBRE\b|\bGIVEN\s+NAMES?\b|\bNAME\b", re.IGNORECASE
)

# Lo que viene después del nombre en el anverso: marca dónde termina.
ETIQUETA_TRAS_NOMBRE = re.compile(
    r"\bSEXO\b|\bSEX\b|\bNACIONALIDAD\b|\bNATIONALITY\b|\bFECHA\b|"
    r"\bVALIDEZ\b|\bNACIM|\bIDESP\b|\bSOPORTE\b|\bDNI\b",
    re.IGNORECASE,
)

# Etiquetas que marcan el final del bloque del domicilio.
ETIQUETAS_SIGUIENTES = re.compile(
    r"\b(LUGAR|NACIM|EQUIPO|HIJO|PADRES?|DE\s+NACIM|IDESP|PROVINCIA\s*/)",
    re.IGNORECASE,
)

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
    maximo: int = 4,
) -> list[LineaOCR]:
    """Líneas situadas bajo una etiqueta y alineadas con ella."""
    resultado: list[LineaOCR] = []

    for linea in lineas:
        if linea is etiqueta or linea.y0 < etiqueta.y1 - 2:
            continue

        # Tiene que solaparse horizontalmente con la etiqueta: así no se
        # cuelan campos de la otra columna del documento.
        solape = min(linea.x1, etiqueta.x1 + 260) - max(linea.x0, etiqueta.x0 - 40)

        if solape <= 0:
            continue

        if ETIQUETAS_SIGUIENTES.search(linea.texto):
            break

        resultado.append(linea)

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


def extraer_domicilio_por_posicion(lineas: list[LineaOCR]) -> dict | None:
    """Busca la etiqueta DOMICILIO y toma las líneas que hay debajo."""
    etiqueta = next(
        (l for l in lineas if re.search(r"\bDOMICILIO\b", l.texto, re.IGNORECASE)),
        None,
    )

    if etiqueta is None:
        return None

    debajo = _lineas_debajo(lineas, etiqueta, maximo=4)
    textos = [l.texto for l in debajo if l.texto.strip()]

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
            r"\bDOMICILIO\b[^\r\n]*[\r\n]+(?P<contenido>(?:[^\r\n]+[\r\n]+){1,4})",
            texto,
            re.IGNORECASE,
        )
        if not respaldo:
            return None
        contenido = respaldo.group("contenido")
    else:
        contenido = coincidencia.group("contenido")

    lineas = [
        normalizar_espacios(linea)
        for linea in contenido.splitlines()
        if linea.strip()
    ]

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


def _preparar_para_ocr(imagen: np.ndarray) -> np.ndarray:
    """Detecta el documento; si no lo consigue, usa la imagen tal cual.

    El navegador ya recorta al marco guía, así que la imagen completa suele
    ser un recorte aceptable.
    """
    try:
        recorte = detectar_y_recortar_documento(imagen)
    except (ValueError, cv2.error):
        recorte = imagen
        if recorte.shape[0] > recorte.shape[1]:
            recorte = cv2.rotate(recorte, cv2.ROTATE_90_CLOCKWISE)

    # Normalizar el ancho: ni tan pequeño que Tesseract no lea, ni tan grande
    # que tarde de más para nada.
    ancho = recorte.shape[1]

    if ancho > ANCHO_OCR * 1.15:
        factor = ANCHO_OCR / ancho
        recorte = cv2.resize(
            recorte, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA
        )
    elif ancho < ANCHO_OCR * 0.75:
        factor = ANCHO_OCR / ancho
        recorte = cv2.resize(
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


@dataclass
class CaraLeida:
    recorte: np.ndarray
    texto: str
    lineas: list[LineaOCR]


INDICIOS_ANVERSO = ("APELLIDOS", "SURNAME", "NOMBRE", "SEXO", "NACIONALIDAD", "VALIDEZ")
INDICIOS_REVERSO = ("DOMICILIO", "ADDRESS", "IDESP", "LUGAR DE NACIM", "HIJO", "EQUIPO")


def _sin_tiempo(deadline: float | None) -> bool:
    return deadline is not None and time.monotonic() >= deadline


def _puntuar_cara(texto: str) -> int:
    """Positivo si parece el anverso, negativo si parece el reverso."""
    mayusculas = texto.upper()

    anverso = sum(1 for i in INDICIOS_ANVERSO if i in mayusculas)
    reverso = sum(1 for i in INDICIOS_REVERSO if i in mayusculas)

    return anverso - reverso


def leer_cara(imagen: np.ndarray, deadline: float | None = None) -> CaraLeida:
    """Hace el OCR de una cara. No decide todavía si es anverso o reverso."""
    recorte = _preparar_para_ocr(imagen)

    texto, lineas = ocr_con_posiciones(recorte)

    # Si el OCR en color va flojo, reintentar con la versión binarizada.
    if _puntuar_texto_ocr(texto) < 100 and not _sin_tiempo(deadline):
        texto_binario, lineas_binario = ocr_con_posiciones(
            preprocesar_recorte_para_ocr(recorte),
            configuraciones=CONFIGURACIONES_OCR[:1],
        )
        if _puntuar_texto_ocr(texto_binario) > _puntuar_texto_ocr(texto):
            texto, lineas = texto_binario, lineas_binario

    return CaraLeida(recorte=recorte, texto=texto, lineas=lineas)


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
        nombre = extraer_nombre_por_posicion(lineas)

        if not nombre:
            nombre = extraer_nombre_completo(texto)

        return ResultadoCara(
            es_anverso=True,
            numero=extraer_dni_anverso(texto),
            nombre=nombre,
            texto=texto,
        )

    # Reverso: el domicilio se busca primero por posición (etiqueta DOMICILIO
    # y líneas de debajo) y solo si eso falla se recurre a la expresión
    # regular, que depende del orden en que Tesseract devuelva las líneas.
    domicilio = extraer_domicilio_por_posicion(lineas)

    if not domicilio:
        domicilio = extraer_bloque_domicilio(texto)

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

    if not nombre:
        nombre = next((c.nombre for c in traseras if c.nombre), None)

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

    domicilio_texto = formatear_domicilio(domicilio)

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
