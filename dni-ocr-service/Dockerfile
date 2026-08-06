FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # Tesseract usa OpenMP; en una instancia con una fracción de CPU los
    # hilos se estorban y va bastante más lento. Con uno solo va ~30 % mejor.
    OMP_THREAD_LIMIT=1

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

COPY app ./app

# Usuario sin privilegios
RUN useradd --create-home --uid 10001 ocr
USER ocr

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health').status==200 else 1)"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
