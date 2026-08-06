FROM python:3.12-slim

# ORDEN DE LAS CAPAS
#
# Docker cachea por capas y cambiar una línea invalida todas las siguientes.
# Por eso aquí arriba solo va lo que afecta a la construcción y no se toca
# nunca; lo que se ajusta a menudo va lo más abajo posible, para que un cambio
# no obligue a reinstalar Tesseract y OpenCV (10-20 minutos).
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# tesseract-ocr-spa: paquete de idioma español, imprescindible para el DNI.
# libgl1 / libglib2.0-0: dependencias nativas de OpenCV.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-spa \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# --- A partir de aquí, cambios baratos -----------------------------------
#
# Tesseract usa OpenMP; en una instancia con una fracción de CPU los hilos se
# estorban entre sí y va más lento con varios que con uno.
#
# Se puede sobrescribir desde el panel de Render sin reconstruir nada.
ENV OMP_THREAD_LIMIT=1

COPY app ./app

# Usuario sin privilegios
RUN useradd --create-home --uid 10001 ocr
USER ocr

EXPOSE 8080

# El healthcheck tiene que usar el mismo puerto que el servidor. Estaba fijo
# en 8080 mientras el contenedor escuchaba en el que impone la plataforma
# (Render usa el 10000), así que fallaba siempre.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os,urllib.request,sys; p=os.environ.get('PORT','8080'); sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{p}/health').status==200 else 1)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
