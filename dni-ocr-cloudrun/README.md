# Servicio de extracción de datos de DNI (PaddleOCR / Cloud Run)

Envuelve un lector de DNI basado en PaddleOCR (`app/dni_reader.py`, prototipo
ya validado sobre fotos reales) en un servicio HTTP que consume la Edge
Function `dni-verification-upload`.

Sustituye a `dni-ocr-service/` (Tesseract, en Render): mismo contrato HTTP,
motor de OCR distinto, alojado en Google Cloud Run porque necesita más
memoria (~600 MB de pico) de la que da el plan gratuito de Render (512 MB).
`dni-ocr-service/` se deja en el repositorio sin desplegar, como vía de
vuelta atrás — ver la tabla de fallos de `docs/VERIFICACION-DNI.md`.

## Endpoints

| Método | Ruta       | Descripción                                    |
| ------ | ---------- | ---------------------------------------------- |
| `GET`  | `/health`  | Comprobación de vida, sin autenticación.        |
| `POST` | `/extract` | Extrae los datos. Requiere `X-Service-Secret`. |

Cuerpo de `/extract`. Lo normal es pasar enlaces firmados de Supabase Storage,
que el servicio descarga por su cuenta:

```json
{ "front_url": "https://...", "back_url": "https://..." }
```

También admite las imágenes en base64, sobre todo para pruebas manuales:

```json
{ "front_b64": "<base64 del anverso>", "back_b64": "<base64 del reverso>" }
```

Respuesta:

```json
{
  "ok": true,
  "numero": "48718068C",
  "nombre": "CARLOS BLOM-DAHL RAMOS",
  "domicilio": {
    "direccion": "C. ALFAHUIR 44 P14 53",
    "localidad": "VALÈNCIA",
    "provincia": "VALENCIA/VALÈNCIA"
  },
  "domicilio_texto": "C. ALFAHUIR 44 P14 53, VALÈNCIA, VALENCIA/VALÈNCIA",
  "numero_valido": true,
  "fecha_validez": "2030-02-14",
  "documento_vigente": true,
  "campos_leidos": { "numero": true, "nombre": true, "domicilio": true },
  "avisos": []
}
```

- `numero_valido` indica si el dígito de control del DNI/NIE cuadra.
- `fecha_validez` es la fecha de caducidad leída (ISO, `null` si no se pudo
  leer).
- `documento_vigente` es `true`/`false` si se pudo comparar con la fecha de
  hoy, o `null` si no se pudo determinar. La Edge Function bloquea la
  verificación (`status: "failed"`) solo cuando es **`false`** — es decir,
  cuando se confirma que el documento ha caducado, no cuando simplemente no
  se ha podido leer la fecha.

## Variables de entorno

| Variable                 | Obligatoria | Descripción                                  |
| ------------------------ | ----------- | --------------------------------------------- |
| `DNI_OCR_SERVICE_SECRET` | Sí          | Secreto compartido con la Edge Function.       |
| `PORT`                   | No          | Puerto de escucha (por defecto `8080`).        |
| `DNI_OCR_MAX_BYTES`      | No          | Tamaño máximo por imagen (por defecto 8 MB).   |
| `DNI_OCR_WORKERS`        | No          | Hilos del executor (por defecto 1; ver Concurrencia). |

Genera el secreto con:

```bash
openssl rand -hex 32
```

## Concurrencia: un lector, con candado

El objeto `PaddleOCR` es un predictor con estado; no hay garantía de que
`.predict()` sea seguro desde varios hilos a la vez sobre la misma instancia,
y si no lo es, el fallo es peor que "más lento" (podría corromper
resultados). Por eso:

- Un único `DNIReader` se crea **al arrancar el proceso**, no de forma
  perezosa en la primera petición: si el modelo no cargara bien, se ve en
  los logs de arranque, no en la petición de un usuario real.
- Un `threading.Lock()` envuelve cada llamada a `leer_dni()`.
- El servicio se despliega con `--concurrency 1` en Cloud Run: cada
  instancia atiende una petición a la vez, y es Cloud Run quien arranca más
  instancias si llegan varias verificaciones a la vez, en vez de forzar
  concurrencia dentro del proceso. El candado es una red de seguridad, no el
  mecanismo principal.

## Pruebas en local

```bash
cd dni-ocr-cloudrun
docker build -t dni-ocr-cloudrun .
docker run --rm -p 8080:8080 -e DNI_OCR_SERVICE_SECRET=pruebas dni-ocr-cloudrun

# En otra terminal
curl -X POST http://localhost:8080/extract \
  -H "Content-Type: application/json" \
  -H "X-Service-Secret: pruebas" \
  -d "{\"front_b64\":\"$(base64 -w0 anverso.jpg)\",\"back_b64\":\"$(base64 -w0 reverso.jpg)\"}"
```

`test_mapping.py` prueba solo la traducción de la salida de `DNIReader` al
contrato HTTP (nombre compuesto, domicilio con duplicados, vigencia), sin
necesitar PaddleOCR instalado:

```bash
python3 test_mapping.py
```

## Despliegue en Google Cloud Run

```bash
gcloud auth login
gcloud config set project <ID-DEL-PROYECTO>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy dni-ocr-cloudrun \
  --source . \
  --region europe-west1 \
  --memory 1Gi \
  --cpu 1 \
  --cpu-boost \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 120 \
  --allow-unauthenticated \
  --set-env-vars DNI_OCR_SERVICE_SECRET=$(openssl rand -hex 32)
```

`--allow-unauthenticated` es deliberado: la autenticación real la hace la
propia aplicación con `X-Service-Secret`; pedir además un token de identidad
de Google complicaría la Edge Function sin aportar nada.

`min-instances=0` mantiene esto en la capa gratuita entre temporadas de
inscripción, a cambio de un arranque en frío (~20-30 s, carga de los
modelos) la primera vez tras un rato sin uso — la Edge Function ya
presupuesta hasta 130 s de espera.

Después registra la URL y el secreto en Supabase:

```bash
supabase secrets set DNI_OCR_SERVICE_URL=<url-que-devuelva-el-deploy> --project-ref pqycvrpdyebshkfaxzmi
supabase secrets set DNI_OCR_SERVICE_SECRET=<el-mismo-secreto-de-arriba> --project-ref pqycvrpdyebshkfaxzmi
```

Guía completa (cuenta de Google Cloud, facturación, todo el proceso desde
cero): `docs/VERIFICACION-DNI.md`, Paso 4.

## El lector (`app/dni_reader.py`)

Prototipo ya validado por su autor sobre fotos reales antes de integrarlo
aquí — este servicio no reescribe su lógica de OCR, solo la envuelve en
HTTP. Usa modelos "tiny" de PaddleOCR (13 MB en total, bajo `app/models/`),
mucho más ligeros que los modelos por defecto de PaddleOCR, y hace su propia
corrección de perspectiva y de orientación 0°/90°/180°/270° (con el
clasificador `PP-LCNet_x1_0_doc_ori`, no con heurísticas escritas a mano).

`DNIReader.leer_dni(frontal, trasera)` pide **rutas de fichero**, no bytes en
memoria: `app/main.py` escribe las imágenes descargadas a un directorio
temporal (`/tmp`, que en Cloud Run es tmpfs — RAM, no disco real) y lo borra
al terminar.

`app/mapping.py` traduce su salida (un diccionario anidado con `documento`,
`titular`, `domicilio`, `fechas`, `mrz`, `validacion`...) al contrato plano
que espera la Edge Function. Reutiliza sin cambios `formatear_domicilio` y
`normalizar_espacios` de `dni-ocr-service/app/pipeline.py`.
