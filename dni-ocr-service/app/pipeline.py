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
import re
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
PSM_A_PROBAR = (11, 6, 4)


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

def ocr(imagen: np.ndarray, configuraciones: tuple[str, ...] | None = None) -> str:
    """Ejecuta OCR con varias configuraciones y devuelve el texto más rico."""
    # Se lee en tiempo de llamada, no como valor por defecto, para poder
    # sustituirlo en pruebas y para respetar el idioma detectado al arrancar.
    configuraciones = configuraciones or CONFIGURACIONES_OCR

    mejor_texto = ""
    mejor_puntuacion = -1.0
    errores = 0

    for config in configuraciones:
        try:
            texto = pytesseract.image_to_string(imagen, config=config)
        except pytesseract.TesseractError as error:
            errores += 1
            logger.warning("Tesseract ha fallado con %s: %s", config, error)
            continue

        puntuacion = _puntuar_texto_ocr(texto)

        if puntuacion > mejor_puntuacion:
            mejor_puntuacion = puntuacion
            mejor_texto = texto

    if errores == len(configuraciones):
        raise RuntimeError(
            "Tesseract ha fallado con todas las configuraciones. "
            "Revisa la instalación del binario y del paquete de idioma."
        )

    return mejor_texto


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

    # Escalar a una altura de trabajo cómoda para Tesseract.
    alto, ancho = recorte.shape[:2]
    objetivo = 1000
    if alto < objetivo:
        factor = objetivo / alto
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


def procesar_cara(imagen: np.ndarray) -> ResultadoCara:
    """Procesa una cara del documento y decide si es anverso o reverso."""
    recorte = _preparar_para_ocr(imagen)

    texto = ocr(recorte)

    # Si el OCR en color va flojo, reintentar con la versión binarizada.
    if _puntuar_texto_ocr(texto) < 100:
        texto_binario = ocr(preprocesar_recorte_para_ocr(recorte))
        if _puntuar_texto_ocr(texto_binario) > _puntuar_texto_ocr(texto):
            texto = texto_binario

    es_anverso = bool(
        re.search(r"\bNACIONALIDAD\b", texto, flags=re.IGNORECASE)
        or re.search(r"\bAPELLIDOS\b", texto, flags=re.IGNORECASE)
    )

    if es_anverso:
        return ResultadoCara(
            es_anverso=True,
            numero=extraer_dni_anverso(texto),
            nombre=extraer_nombre_completo(texto),
            texto=texto,
        )

    return ResultadoCara(
        es_anverso=False,
        numero=extraer_dni_reverso(texto),
        domicilio=extraer_bloque_domicilio(texto),
        texto=texto,
    )


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


def extraer_datos(anverso: np.ndarray, reverso: np.ndarray) -> dict[str, Any]:
    """Procesa ambas caras y consolida nombre, número de DNI y domicilio."""
    caras = [procesar_cara(anverso), procesar_cara(reverso)]

    avisos: list[str] = []

    delanteras = [c for c in caras if c.es_anverso]
    traseras = [c for c in caras if not c.es_anverso]

    if not delanteras:
        avisos.append("No se ha reconocido el anverso del documento.")
    if not traseras:
        avisos.append("No se ha reconocido el reverso del documento.")

    nombre = next((c.nombre for c in delanteras if c.nombre), None)
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

    return {
        "numero": numero,
        "nombre": nombre,
        "domicilio": domicilio,
        "domicilio_texto": formatear_domicilio(domicilio),
        "numero_valido": letra_dni_correcta(numero) if numero else False,
        "avisos": avisos,
    }


def decodificar_imagen(datos: bytes) -> np.ndarray:
    buffer = np.frombuffer(datos, dtype=np.uint8)
    imagen = cv2.imdecode(buffer, cv2.IMREAD_COLOR)

    if imagen is None:
        raise ValueError("No se ha podido decodificar la imagen.")

    return imagen
