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

## Cómo se lee cada dato

| Dato | De dónde sale | Por qué |
| --- | --- | --- |
| Nombre y apellidos | Anverso, por posición | Es donde aparece completo, sin truncar |
| Número de DNI | MRZ del reverso | Va en OCR-B y se valida con su dígito de control |
| Domicilio | Reverso, por posición | Se localiza la etiqueta DOMICILIO y se leen las líneas de debajo |

### Lectura por posición

Se usa `image_to_data`, que además del texto da las coordenadas de cada
palabra. Con ellas se localiza cada etiqueta y se toman las líneas que quedan
justo debajo y alineadas con ella:

- **APELLIDOS** → líneas hasta la etiqueta **NOMBRE** (los apellidos ocupan a
  menudo dos líneas, y así se recogen ambas).
- **NOMBRE** → líneas hasta **SEXO** o **NACIONALIDAD**.
- **DOMICILIO** → líneas hasta **LUGAR DE NACIMIENTO**.

Esto sustituye a las expresiones regulares originales, que dependían de que
Tesseract devolviera las líneas en el orden en que se leen. En un documento a
dos columnas como el DNI eso no se cumple: la fotografía y los campos se
entremezclan.

No cuesta tiempo extra: `image_to_data` se pide en la misma pasada que ya se
hacía para obtener el texto.

### Por qué el nombre NO sale del MRZ

El **MRZ** son las tres líneas de 30 caracteres del borde inferior del reverso
(formato TD1 de la OACI), impresas en una tipografía pensada para máquinas.
Es lo más fiable que tiene el documento... pero su línea de nombres mide
**30 caracteres fijos**, así que un nombre largo se corta y no hay forma de
recuperar lo que falta.

Por eso el MRZ se usa para el **número** (que además trae dígito de control) y,
para el nombre, solo como último recurso y únicamente cuando se puede
garantizar que no venía truncado: si la línea termina en relleno `<`, el nombre
cabía entero.

Para leerlo se recorta la franja inferior de la tarjeta y se pasa Tesseract con
el alfabeto restringido a `A-Z`, `0-9` y `<`, y con los diccionarios
desactivados, para que no intente "corregir" el texto convirtiéndolo en
palabras.

### Pruebas

```bash
cd dni-ocr-service
python3 test_mrz.py      # lectura y dígitos de control del MRZ
python3 test_nombre.py   # nombre por posición, incluido un nombre muy largo
```

## Cambios respecto al código original

- **Configuración de Tesseract corregida.** El original pasaba
  `r'l spa - psm 11'`; Tesseract espera `-l spa --psm 11`, así que la versión
  anterior estaba ignorando tanto el idioma como el modo de segmentación.
- **Varias pasadas de OCR, pero solo si hacen falta.** Se prueban `--psm 11`,
  `6` y `4` en ese orden y se corta en cuanto una reconoce suficientes
  etiquetas. Recorrerlas siempre triplicaba el tiempo sin mejorar nada.
- **Lectura por posición** del nombre, los apellidos y el domicilio, en lugar
  de por orden de líneas. Era el motivo de que solo se extrajera el número.
- **Lectura del MRZ** para el número de documento, validado con su dígito de
  control.
- **Normalización de signos.** Tesseract suele leer el guion como raya larga
  (`—`) y el apóstrofo como comilla tipográfica; sin normalizarlos, un
  apellido como FERNANDEZ-MONTESINOS perdía el guion.
- **Validación del dígito de control** del DNI/NIE, que sirve además para
  elegir entre el número leído en el anverso y el del reverso.
- **Recuperación ante fallos de detección**: si no se detecta el contorno de la
  tarjeta se usa la imagen completa, porque el navegador ya recorta al marco.
- **Trabaja en memoria** en lugar de sobre rutas de fichero, así el servicio
  nunca escribe la imagen del documento en disco.
