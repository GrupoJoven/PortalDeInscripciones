"""Llama al servicio de OCR YA DESPLEGADO en Cloud Run con `debug: true` y
vuelca la respuesta completa (documento/titular/fechas/domicilio/mrz/
validacion/fuentes/procesado, con las líneas de OCR crudas incluidas).

A diferencia de un script local con tu propia copia de `dni_reader.py`, esto
llama exactamente al servicio, modelos y código que están en producción en
este momento -no una copia que pueda haberse quedado desactualizada-.

Uso:
    python debug_extract.py anverso.jpg reverso.jpg --url https://tu-url-de-cloud-run.run.app --secret TU_DNI_OCR_SERVICE_SECRET

El secreto también se puede pasar por variable de entorno DNI_OCR_SERVICE_SECRET
en vez de --secret, para no dejarlo en el historial de la terminal:

    $env:DNI_OCR_SERVICE_SECRET = "..."   # PowerShell
    python debug_extract.py anverso.jpg reverso.jpg --url https://tu-url-de-cloud-run.run.app
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error


def _b64(ruta: str) -> str:
    with open(ruta, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("anverso", help="Ruta a la foto del anverso")
    parser.add_argument("reverso", help="Ruta a la foto del reverso")
    parser.add_argument("--url", required=True, help="URL base del servicio de Cloud Run (sin /extract)")
    parser.add_argument(
        "--secret",
        default=os.environ.get("DNI_OCR_SERVICE_SECRET", ""),
        help="DNI_OCR_SERVICE_SECRET (o usa la variable de entorno del mismo nombre)",
    )
    args = parser.parse_args()

    if not args.secret:
        print("Falta el secreto: pásalo con --secret o en la variable de entorno DNI_OCR_SERVICE_SECRET.", file=sys.stderr)
        return 1

    cuerpo = json.dumps(
        {
            "front_b64": _b64(args.anverso),
            "back_b64": _b64(args.reverso),
            "debug": True,
        }
    ).encode("utf-8")

    endpoint = args.url.rstrip("/") + "/extract"
    print(f"Llamando a {endpoint} (puede tardar hasta un minuto si el contenedor estaba dormido)...", file=sys.stderr)

    peticion = urllib.request.Request(
        endpoint,
        data=cuerpo,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Service-Secret": args.secret,
        },
    )

    try:
        with urllib.request.urlopen(peticion, timeout=130) as respuesta:
            resultado = json.loads(respuesta.read())
    except urllib.error.HTTPError as error:
        print(f"El servicio respondió {error.code}: {error.read().decode('utf-8', errors='replace')}", file=sys.stderr)
        return 1

    print(json.dumps(resultado, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
