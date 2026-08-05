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
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .pipeline import IDIOMA_OCR, decodificar_imagen, extraer_datos

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dni-ocr")

SERVICE_SECRET = os.environ.get("DNI_OCR_SERVICE_SECRET", "")
MAX_BYTES = int(os.environ.get("DNI_OCR_MAX_BYTES", 8 * 1024 * 1024))

# Tesseract y OpenCV son bloqueantes: los sacamos del bucle de eventos.
executor = ThreadPoolExecutor(max_workers=int(os.environ.get("DNI_OCR_WORKERS", 2)))

app = FastAPI(title="DNI OCR", version="1.0.0", docs_url=None, redoc_url=None)


class SolicitudExtraccion(BaseModel):
    front_b64: str = Field(..., description="Anverso del documento en base64")
    back_b64: str = Field(..., description="Reverso del documento en base64")


class RespuestaExtraccion(BaseModel):
    ok: bool
    numero: str | None = None
    nombre: str | None = None
    domicilio: dict | None = None
    domicilio_texto: str | None = None
    numero_valido: bool = False
    avisos: list[str] = []


def _comprobar_secreto(recibido: str | None) -> None:
    if not SERVICE_SECRET:
        logger.error("DNI_OCR_SERVICE_SECRET no está configurado.")
        raise HTTPException(status_code=500, detail="server_not_configured")

    if not recibido or not secrets.compare_digest(recibido, SERVICE_SECRET):
        raise HTTPException(status_code=401, detail="unauthorized")


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

    datos_anverso = _decodificar_base64(solicitud.front_b64, "front")
    datos_reverso = _decodificar_base64(solicitud.back_b64, "back")

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
    except Exception:
        # No registramos nada del contenido de las imágenes.
        logger.exception("Fallo extrayendo datos del documento")
        raise HTTPException(status_code=500, detail="extraction_failed")

    return RespuestaExtraccion(ok=True, **resultado)
