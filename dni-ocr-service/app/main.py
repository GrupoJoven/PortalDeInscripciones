"""Servicio HTTP de extracción de datos de DNI.

Lo consume la Edge Function `dni-verification-upload` de Supabase.
Protegido con un secreto compartido en la cabecera X-Service-Secret.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dni-ocr")

# Se registra antes y después de importar el pipeline porque ahí es donde se
# cargan OpenCV y NumPy y se consulta Tesseract. Si el contenedor muriera
# durante el arranque, estas dos líneas dicen si llegó a pasar de aquí.
logger.info("Arrancando el servicio de OCR...")

from .pipeline import IDIOMA_OCR, decodificar_imagen, extraer_datos  # noqa: E402

logger.info("Pipeline cargado. Idioma de OCR: %s", IDIOMA_OCR)

SERVICE_SECRET = os.environ.get("DNI_OCR_SERVICE_SECRET", "")
MAX_BYTES = int(os.environ.get("DNI_OCR_MAX_BYTES", 8 * 1024 * 1024))

# Tesseract y OpenCV son bloqueantes: los sacamos del bucle de eventos.
executor = ThreadPoolExecutor(max_workers=int(os.environ.get("DNI_OCR_WORKERS", 2)))

app = FastAPI(title="DNI OCR", version="1.0.0", docs_url=None, redoc_url=None)


class SolicitudExtraccion(BaseModel):
    """Las imágenes pueden llegar de dos formas.

    Lo normal es `front_url` / `back_url`: enlaces firmados y efímeros de
    Supabase Storage que el servicio descarga por su cuenta. Así la Edge
    Function no tiene que mover megabytes de base64, que es justo lo que la
    hacía agotar su límite de CPU.

    `front_b64` / `back_b64` se mantienen para pruebas manuales.
    """

    front_url: str | None = Field(default=None, description="Enlace firmado del anverso")
    back_url: str | None = Field(default=None, description="Enlace firmado del reverso")
    front_b64: str | None = Field(default=None, description="Anverso en base64")
    back_b64: str | None = Field(default=None, description="Reverso en base64")


class RespuestaExtraccion(BaseModel):
    ok: bool
    numero: str | None = None
    nombre: str | None = None
    domicilio: dict | None = None
    domicilio_texto: str | None = None
    numero_valido: bool = False
    campos_leidos: dict = {}
    avisos: list[str] = []


def _comprobar_secreto(recibido: str | None) -> None:
    if not SERVICE_SECRET:
        logger.error("DNI_OCR_SERVICE_SECRET no está configurado.")
        raise HTTPException(status_code=500, detail="server_not_configured")

    if not recibido or not secrets.compare_digest(recibido, SERVICE_SECRET):
        raise HTTPException(status_code=401, detail="unauthorized")


def _descargar(url: str, campo: str) -> bytes:
    """Descarga una imagen desde un enlace firmado de Supabase Storage."""
    if not url.lower().startswith("https://"):
        raise HTTPException(status_code=400, detail=f"insecure_url:{campo}")

    try:
        with httpx.Client(timeout=httpx.Timeout(20.0)) as cliente:
            respuesta = cliente.get(url)
    except httpx.HTTPError as error:
        logger.error("No se ha podido descargar %s: %s", campo, error)
        raise HTTPException(status_code=502, detail=f"download_failed:{campo}") from error

    if respuesta.status_code != 200:
        logger.error("Descarga de %s devolvió %s", campo, respuesta.status_code)
        raise HTTPException(status_code=502, detail=f"download_failed:{campo}")

    datos = respuesta.content

    if not datos:
        raise HTTPException(status_code=400, detail=f"empty_image:{campo}")

    if len(datos) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"image_too_large:{campo}")

    return datos


def _obtener_imagen(url: str | None, b64: str | None, campo: str) -> bytes:
    if url:
        return _descargar(url, campo)

    if b64:
        return _decodificar_base64(b64, campo)

    raise HTTPException(status_code=400, detail=f"missing_image:{campo}")


def _decodificar_base64(valor: str, campo: str) -> bytes:
    # Admite tanto base64 puro como data URLs.
    if "," in valor and valor.strip().lower().startswith("data:"):
        valor = valor.split(",", 1)[1]

    try:
        datos = base64.b64decode(valor, validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(status_code=400, detail=f"invalid_base64:{campo}") from error

    if not datos:
        raise HTTPException(status_code=400, detail=f"empty_image:{campo}")

    if len(datos) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"image_too_large:{campo}")

    return datos


@app.get("/health")
def health() -> dict:
    # `spanish: false` significa que falta tesseract-ocr-spa y la precisión
    # sobre un DNI real será mucho peor.
    return {
        "ok": True,
        "ocr_language": IDIOMA_OCR,
        "spanish": IDIOMA_OCR == "spa",
        "configured": bool(SERVICE_SECRET),
    }


@app.post("/extract", response_model=RespuestaExtraccion)
async def extract(
    solicitud: SolicitudExtraccion,
    x_service_secret: str | None = Header(default=None, alias="X-Service-Secret"),
) -> RespuestaExtraccion:
    _comprobar_secreto(x_service_secret)

    inicio = time.monotonic()
    origen = "url" if solicitud.front_url else "base64"
    logger.info("Petición /extract recibida (imágenes por %s)", origen)

    datos_anverso = _obtener_imagen(solicitud.front_url, solicitud.front_b64, "front")
    datos_reverso = _obtener_imagen(solicitud.back_url, solicitud.back_b64, "back")

    logger.info(
        "Imágenes listas en %.1f s (%d KB + %d KB)",
        time.monotonic() - inicio,
        len(datos_anverso) // 1024,
        len(datos_reverso) // 1024,
    )

    def trabajo() -> dict:
        anverso = decodificar_imagen(datos_anverso)
        reverso = decodificar_imagen(datos_reverso)
        return extraer_datos(anverso, reverso)

    import asyncio

    bucle = asyncio.get_running_loop()

    try:
        resultado = await bucle.run_in_executor(executor, trabajo)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except MemoryError:
        logger.error("Sin memoria procesando el documento")
        raise HTTPException(status_code=507, detail="out_of_memory")
    except Exception:
        # No registramos nada del contenido de las imágenes.
        logger.exception("Fallo extrayendo datos del documento")
        raise HTTPException(status_code=500, detail="extraction_failed")

    logger.info("Extracción completada en %.1f s", time.monotonic() - inicio)

    return RespuestaExtraccion(ok=True, **resultado)
