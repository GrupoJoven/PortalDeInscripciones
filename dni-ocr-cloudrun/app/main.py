"""Servicio HTTP de extracción de datos de DNI, sobre PaddleOCR.

Sustituye al servicio anterior basado en Tesseract (`dni-ocr-service/`),
pero mantiene exactamente el mismo contrato HTTP: lo sigue consumiendo la
misma Edge Function `dni-verification-upload` de Supabase, protegido con el
mismo esquema de secreto compartido en `X-Service-Secret`.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import secrets
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dni-ocr")

logger.info("Arrancando el servicio de OCR (PaddleOCR)...")

from .dni_reader import DNIReader  # noqa: E402
from .mapping import mapear_respuesta  # noqa: E402

SERVICE_SECRET = os.environ.get("DNI_OCR_SERVICE_SECRET", "")
MAX_BYTES = int(os.environ.get("DNI_OCR_MAX_BYTES", 8 * 1024 * 1024))

# El lector se crea UNA SOLA VEZ, en un hilo de fondo lanzado al arrancar el
# proceso. NO se crea de forma síncrona aquí: cargar los modelos de
# PaddleOCR puede tardar más de lo que Cloud Run espera (tope duro de 240 s)
# a que el contenedor abra el puerto, y si esa carga bloquea el arranque,
# Cloud Run mata el contenedor antes de que Uvicorn llegue a escuchar.
# Dejando que Uvicorn abra el puerto de inmediato y el modelo cargue en
# paralelo, el arranque del contenedor nunca depende de cuánto tarde
# PaddleOCR; quien espera es, como mucho, la primera petición real a
# `/extract` (ver más abajo).
reader: DNIReader | None = None
reader_error: str | None = None
reader_load_finished = threading.Event()

# El predictor de PaddleOCR no está documentado como seguro para llamadas
# concurrentes desde varios hilos sobre la misma instancia. Un candado
# asegura que nunca se solapan dos lecturas dentro de este proceso; el
# servicio se despliega además con concurrencia 1 en Cloud Run, así que en
# la práctica el candado casi nunca compite con nadie: es una red de
# seguridad, no el mecanismo principal.
reader_lock = threading.Lock()


def _cargar_reader() -> None:
    global reader, reader_error
    try:
        reader = DNIReader(device="cpu")
        logger.info("DNIReader inicializado.")
    except Exception as error:  # noqa: BLE001 - se registra y se expone en /health y /extract
        logger.exception("No se pudo inicializar DNIReader")
        reader_error = str(error)
    finally:
        reader_load_finished.set()


threading.Thread(target=_cargar_reader, name="dni-reader-loader", daemon=True).start()

# Solo hace falta un hilo: la concurrencia real la da Cloud Run arrancando
# más instancias, no hilos dentro de esta.
executor = ThreadPoolExecutor(max_workers=int(os.environ.get("DNI_OCR_WORKERS", 1)))

app = FastAPI(title="DNI OCR (PaddleOCR)", version="1.0.0", docs_url=None, redoc_url=None)


class SolicitudExtraccion(BaseModel):
    """Las imágenes pueden llegar de dos formas.

    Lo normal es `front_url` / `back_url`: enlaces firmados y efímeros de
    Supabase Storage que el servicio descarga por su cuenta.

    `front_b64` / `back_b64` se mantienen para pruebas manuales.
    """

    front_url: str | None = Field(default=None, description="Enlace firmado del anverso")
    back_url: str | None = Field(default=None, description="Enlace firmado del reverso")
    front_b64: str | None = Field(default=None, description="Anverso en base64")
    back_b64: str | None = Field(default=None, description="Reverso en base64")

    # Con `debug: true` se devuelve el diccionario completo que produce
    # `DNIReader.leer_dni()` (documento/titular/fechas/domicilio/mrz/
    # validacion/fuentes/procesado, incluidas las líneas de OCR crudas),
    # sin pasar por `mapear_respuesta()` ni por `RespuestaExtraccion`. Sirve
    # para depurar qué ha leído *este* servicio desplegado exactamente
    # -engine, modelos y código en producción-, en vez de fiarse de una
    # copia local que puede no ser la misma versión.
    debug: bool = Field(default=False, description="Devuelve la salida cruda sin filtrar, para depurar")


class RespuestaExtraccion(BaseModel):
    """OJO: `response_model` filtra la respuesta a exactamente estos campos.

    `mapear_respuesta()` (en mapping.py) puede devolver un diccionario con
    más claves de las que haya aquí declaradas: FastAPI/Pydantic ignoran en
    silencio cualquier clave que no esté como campo de este modelo, sin
    avisar ni fallar. Así se perdieron `sexo`, `fecha_nacimiento` y los
    campos de conflicto de fecha de validez la primera vez que se añadieron
    a mapping.py: el cambio estaba desplegado y funcionando, pero esta clase
    seguía sin declararlos y los descartaba antes de que llegaran a la
    respuesta HTTP. Cualquier campo nuevo en `mapear_respuesta()` tiene que
    añadirse aquí también (`test_mapping.py` comprueba que no se te olvide).
    """

    ok: bool
    numero: str | None = None
    nombre: str | None = None
    sexo: str | None = None
    fecha_nacimiento: str | None = None
    domicilio: dict | None = None
    domicilio_texto: str | None = None
    numero_valido: bool = False
    fecha_validez: str | None = None
    fecha_validez_frontal: str | None = None
    fecha_validez_trasera: str | None = None
    fecha_validez_conflicto: bool = False
    documento_vigente: bool | None = None
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
    return {
        "ok": True,
        "engine": "paddleocr-small",
        "configured": bool(SERVICE_SECRET),
        "model_ready": reader_load_finished.is_set() and reader is not None,
    }


@app.post("/extract")
async def extract(
    solicitud: SolicitudExtraccion,
    x_service_secret: str | None = Header(default=None, alias="X-Service-Secret"),
):
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
        # Si esta es la primera petición tras un arranque en frío, el modelo
        # puede seguir cargándose en segundo plano (ver _cargar_reader). Se
        # espera aquí, dentro del hilo del executor, para no bloquear el
        # bucle de eventos de FastAPI.
        if not reader_load_finished.wait(timeout=180):
            raise TimeoutError("El modelo de OCR no ha terminado de cargar a tiempo.")
        if reader is None:
            raise RuntimeError(reader_error or "El modelo de OCR no se pudo inicializar.")

        # `DNIReader.leer_dni` pide rutas de fichero, no bytes en memoria.
        # Se escriben a un directorio temporal -en Cloud Run, `/tmp` es
        # tmpfs (RAM), no disco real- y se borran solos al salir del `with`.
        with tempfile.TemporaryDirectory() as directorio:
            ruta_anverso = os.path.join(directorio, "front.jpg")
            ruta_reverso = os.path.join(directorio, "back.jpg")

            with open(ruta_anverso, "wb") as f:
                f.write(datos_anverso)
            with open(ruta_reverso, "wb") as f:
                f.write(datos_reverso)

            with reader_lock:
                resultado = reader.leer_dni(frontal=ruta_anverso, trasera=ruta_reverso)

        return resultado

    import asyncio

    bucle = asyncio.get_running_loop()

    try:
        resultado_crudo = await bucle.run_in_executor(executor, trabajo)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except TimeoutError as error:
        raise HTTPException(status_code=503, detail="model_loading") from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="model_unavailable") from error
    except MemoryError:
        logger.error("Sin memoria procesando el documento")
        raise HTTPException(status_code=507, detail="out_of_memory")
    except Exception:
        # No registramos nada del contenido de las imágenes.
        logger.exception("Fallo extrayendo datos del documento")
        raise HTTPException(status_code=500, detail="extraction_failed")

    resultado = mapear_respuesta(resultado_crudo)

    logger.info(
        "Extracción completada en %.1f s: numero=%s nombre=%s domicilio=%s vigente=%s",
        time.monotonic() - inicio,
        bool(resultado.get("numero")),
        bool(resultado.get("nombre")),
        bool(resultado.get("domicilio_texto")),
        resultado.get("documento_vigente"),
    )

    if solicitud.debug:
        return JSONResponse(content=jsonable_encoder({"ok": True, **resultado_crudo}))

    return RespuestaExtraccion(ok=True, **resultado)
