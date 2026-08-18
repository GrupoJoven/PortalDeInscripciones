"""Traduce la salida de `DNIReader` al contrato HTTP que ya espera la Edge
Function `dni-verification-upload` (el mismo que usaba el servicio anterior
basado en Tesseract): así el cambio de motor de OCR no obliga a tocar
Supabase salvo por la comprobación de vigencia (ver `documento_vigente`).
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any


# ---------------------------------------------------------------------------
# Portadas tal cual de dni-ocr-service/app/pipeline.py (líneas 205 y 2181):
# ya estaban escritas y probadas, no hay motivo para reescribirlas.
# ---------------------------------------------------------------------------

def normalizar_espacios(texto: str) -> str:
    return re.sub(r"\s+", " ", texto).strip()


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


# ---------------------------------------------------------------------------
# Vigencia del documento
# ---------------------------------------------------------------------------

def _es_vigente(fecha_validez: str | None) -> bool | None:
    """True/False si se puede comparar la fecha de caducidad con hoy;
    `None` si no se ha podido leer o no tiene forma de fecha ISO.

    No se bloquea solo por no poder leer la fecha: se bloquea únicamente
    cuando se CONFIRMA que el documento ha caducado. Igual de conservador
    que el resto de validaciones del proyecto (mejor pedir repetir la foto
    que inventar un dato, pero tampoco bloquear por algo que no se sabe).
    """
    if not fecha_validez:
        return None

    try:
        return date.fromisoformat(fecha_validez) >= date.today()
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Mapeo principal
# ---------------------------------------------------------------------------

def mapear_respuesta(resultado: dict[str, Any]) -> dict[str, Any]:
    """Convierte el diccionario anidado de `DNIReader.leer_dni()` en el
    formato plano que consume `dni-verification-upload/index.ts`.
    """
    documento = resultado.get("documento") or {}
    titular = resultado.get("titular") or {}
    domicilio = resultado.get("domicilio") or {}
    fechas = resultado.get("fechas") or {}
    validacion = resultado.get("validacion") or {}

    numero = documento.get("numero")

    nombre = " ".join(
        parte for parte in (titular.get("nombre"), titular.get("apellidos")) if parte
    ) or None

    domicilio_dict = {
        "direccion": domicilio.get("direccion"),
        "localidad": domicilio.get("localidad"),
        "provincia": domicilio.get("provincia"),
    }
    domicilio_texto = formatear_domicilio(domicilio_dict)

    # "M"/"F"/"X" (ya fusionados con la MRZ en `_merge`), y la fecha de
    # nacimiento en ISO. No son obligatorios para la verificación en sí (lo
    # que importa es el número y el domicilio), así que si no se leen no se
    # añade ningún aviso: sencillamente no se prerrellenarán en el formulario.
    sexo = titular.get("sexo")
    fecha_nacimiento = titular.get("fecha_nacimiento")

    fecha_validez = fechas.get("validez")
    fecha_validez_frontal = fechas.get("validez_frontal")
    fecha_validez_trasera = fechas.get("validez_reverso")

    # Si el anverso y la MRZ del reverso no coinciden en la fecha de validez,
    # no hay forma fiable de decidir cuál de las dos está bien: en vez de
    # asumir una (y quizá rechazar por error un documento en vigor, o dar
    # por bueno uno caducado), se deja sin determinar y que quien consuma
    # esto se lo enseñe a la persona para que elija qué foto repetir.
    conflicto_fecha_validez = bool(validacion.get("fecha_validez_conflicto"))
    vigente = None if conflicto_fecha_validez else _es_vigente(fecha_validez)

    avisos: list[str] = list(validacion.get("advertencias") or [])

    if not numero:
        avisos.append("No se ha podido leer el número de DNI.")
    if not nombre:
        avisos.append("No se ha podido leer el nombre.")
    if not domicilio_texto:
        avisos.append("No se ha podido leer el domicilio.")

    if vigente is False:
        avisos.append(f"El DNI ha caducado (venció el {fecha_validez}).")
    elif vigente is None and fecha_validez is None and not conflicto_fecha_validez:
        avisos.append("No se ha podido comprobar la fecha de caducidad.")

    return {
        "numero": numero,
        "nombre": nombre,
        "sexo": sexo,
        "fecha_nacimiento": fecha_nacimiento,
        "domicilio": domicilio_dict,
        "domicilio_texto": domicilio_texto,
        "numero_valido": bool(validacion.get("dni_valido")),
        "fecha_validez": fecha_validez,
        "fecha_validez_frontal": fecha_validez_frontal,
        "fecha_validez_trasera": fecha_validez_trasera,
        "fecha_validez_conflicto": conflicto_fecha_validez,
        "documento_vigente": vigente,
        "campos_leidos": {
            "numero": bool(numero),
            "nombre": bool(nombre),
            "domicilio": bool(domicilio_texto),
        },
        "avisos": avisos,
    }
