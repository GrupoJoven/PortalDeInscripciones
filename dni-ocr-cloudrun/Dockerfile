FROM python:3.11-slim

# ORDEN DE LAS CAPAS
#
# Docker cachea por capas y cambiar una línea invalida todas las siguientes.
# Por eso aquí arriba solo va lo que afecta a la construcción y no se toca
# nunca; lo que se ajusta a menudo va lo más abajo posible.
#
# python:3.11, no 3.12: el prototipo de DNIReader se probó y midió en
# Python 3.11 (sus .pyc son cpython-311); no hay motivo para arriesgar una
# incompatibilidad de paddlepaddle con otra versión sin haberlo probado.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# libgl1 / libglib2.0-0: dependencias nativas de OpenCV. Se mantienen aunque
# se use opencv-python-headless: el servicio anterior también usaba la
# variante headless y las seguía necesitando.
# libgomp1: paddlepaddle enlaza contra el runtime de OpenMP en tiempo de
# carga (import paddle falla con "libgomp.so.1: cannot open shared object
# file" sin esto), aunque el propio lector limite el paralelismo con
# `cpu_threads=1`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# --- A partir de aquí, cambios baratos -----------------------------------

# Evita que PaddleX intente comprobar conectividad contra Hugging Face al
# arrancar ("Checking connectivity to the model hosters..."): aquí se pasan
# rutas locales explícitas a los tres modelos, así que esa comprobación de
# red es pura latencia (y un punto de fallo) de más en un arranque en frío
# de Cloud Run.
ENV PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True

COPY app ./app

# Usuario sin privilegios
RUN useradd --create-home --uid 10001 ocr
USER ocr

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import os,urllib.request,sys; p=os.environ.get('PORT','8080'); sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{p}/health').status==200 else 1)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
