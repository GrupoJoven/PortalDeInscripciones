# Servicio de extracción de datos de DNI

Envuelve el pipeline de `pytesseract` + OpenCV en un servicio HTTP que consume
la Edge Function `dni-verification-upload`.

Va aparte porque ni las Edge Functions de Supabase (Deno) ni el runtime de
Vercel incluyen el binario de Tesseract.

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
  "numero": "12345678Z",
  "nombre": "MARIA GARCIA LOPEZ",
  "domicilio": {
    "direccion": "C. EJEMPLO 12 3 B",
    "localidad": "MADRID",
    "provincia": "MADRID"
  },
  "domicilio_texto": "C. EJEMPLO 12 3 B, MADRID",
  "numero_valido": true,
  "avisos": []
}
```

`numero_valido` indica si el dígito de control del DNI/NIE cuadra: es la señal
más fiable de que el OCR ha leído bien el número.

## Variables de entorno

| Variable                  | Obligatoria | Descripción                                            |
| ------------------------- | ----------- | ------------------------------------------------------ |
| `DNI_OCR_SERVICE_SECRET`  | Sí          | Secreto compartido con la Edge Function.               |
| `PORT`                    | No          | Puerto de escucha (por defecto `8080`).                |
| `DNI_OCR_WORKERS`         | No          | Hilos para OCR simultáneo (por defecto `2`).           |
| `DNI_OCR_MAX_BYTES`       | No          | Tamaño máximo por imagen (por defecto 8 MB).           |

Genera el secreto con:

```bash
openssl rand -hex 32
```

## Pruebas en local

```bash
cd dni-ocr-service
docker build -t dni-ocr .
docker run --rm -p 8080:8080 -e DNI_OCR_SERVICE_SECRET=pruebas dni-ocr

# En otra terminal
curl -X POST http://localhost:8080/extract \
  -H "Content-Type: application/json" \
  -H "X-Service-Secret: pruebas" \
  -d "{\"front_b64\":\"$(base64 -w0 anverso.jpg)\",\"back_b64\":\"$(base64 -w0 reverso.jpg)\"}"
```

## Despliegue

Cualquier plataforma que corra un contenedor sirve. Con **Render**:

1. New → Web Service → conecta el repositorio.
2. Root Directory: `dni-ocr-service`; Runtime: Docker.
3. Añade la variable de entorno `DNI_OCR_SERVICE_SECRET`.
4. Copia la URL pública que te dé.

Con **Fly.io**:

```bash
cd dni-ocr-service
fly launch --no-deploy
fly secrets set DNI_OCR_SERVICE_SECRET=$(openssl rand -hex 32)
fly deploy
```

Después registra la URL y el secreto en Supabase:

```bash
supabase secrets set DNI_OCR_SERVICE_URL=https://tu-servicio.onrender.com
supabase secrets set DNI_OCR_SERVICE_SECRET=<el mismo secreto>
```

> Los planes gratuitos suelen dormir el contenedor tras un rato de inactividad
> y tardan ~30 s en despertar. La Edge Function espera hasta 60 s, pero para
> producción conviene un plan que lo mantenga despierto.

## Cambios respecto al código original

- **Configuración de Tesseract corregida.** El original pasaba
  `r'l spa - psm 11'`; Tesseract espera `-l spa --psm 11`, así que la versión
  anterior estaba ignorando tanto el idioma como el modo de segmentación.
- **Varias pasadas de OCR.** Se prueban `--psm 11`, `6` y `4` y se elige el
  resultado con más etiquetas del DNI reconocidas; si el color falla, se
  reintenta con la imagen binarizada.
- **Validación del dígito de control** del DNI/NIE, que sirve además para
  elegir entre el número leído en el anverso y el del reverso.
- **Recuperación ante fallos de detección**: si no se detecta el contorno de la
  tarjeta se usa la imagen completa, porque el navegador ya recorta al marco.
- **Trabaja en memoria** en lugar de sobre rutas de fichero, así el servicio
  nunca escribe la imagen del documento en disco.
