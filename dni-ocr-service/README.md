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
| `DNI_OCR_PRESUPUESTO_SEGUNDOS` | No     | Tiempo máximo por documento (por defecto 70 s).        |

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

### Rendimiento: el número de pasadas de Tesseract lo es todo

Cada pasada cuesta ~1 s en un servidor normal y hasta 10 s en una instancia
compartida de 0,1 CPU, así que el tiempo total depende casi por completo de
cuántas veces se llame a Tesseract. El objetivo es **3 o 4 por documento**.

Lo que lo mantiene bajo:

- Se prueban como mucho dos segmentaciones (`--psm 4` y `--psm 11`) y se corta
  en cuanto una reconoce dos etiquetas del documento.
- **Las dos caras se clasifican comparándolas entre sí**, no una a una. Si cada
  cara decide por su cuenta, un anverso con el OCR flojo puede darse por
  reverso: entonces se le buscaba un MRZ inexistente (hasta 6 pasadas tiradas)
  y, peor aún, no se le buscaba el nombre.
- `leer_mrz` hace dos pasadas como mucho (la franja tal cual y binarizada) y
  solo se ejecuta sobre la cara clasificada como reverso.
- Hay un **presupuesto de tiempo** (`DNI_OCR_PRESUPUESTO_SEGUNDOS`, 70 s por
  defecto): al agotarse se devuelve lo que se haya podido leer en vez de seguir
  y provocar un tiempo de espera agotado en quien llama. Así al menos se sabe
  qué campo ha fallado.

Los logs indican en qué se va el tiempo:

```
INFO:app.pipeline:OCR de las dos caras en 12.4 s
INFO:app.pipeline:Clasificación de caras: puntuaciones=[4, -3] -> anverso=primera
INFO:app.pipeline:MRZ leído (directa): numero=12345678Z valido=True nombre=True completo=True
INFO:app.pipeline:Extracción terminada en 18.9 s: numero=True nombre=True domicilio=True
```

### Resolución de la foto: el factor que más pesa

Las etiquetas del DNI ("APELLIDOS", "NOMBRE"...) miden en torno a 1,2 mm.
Sobre una tarjeta de 85,6 mm de ancho:

| Ancho de la foto | px/mm | Alto de una etiqueta | |
| ---------------- | ----- | -------------------- | --- |
| 950 px  | 11,1 | 13 px | ilegible |
| 1500 px | 17,5 | 21 px | justo |
| 1700 px | 19,9 | 24 px | cómodo |

Tesseract necesita 20-30 px de alto para leer con fiabilidad. Con un flujo de
vídeo de 1080p el recorte del marco sale a unos 950 px y las etiquetas se
pierden: se lee texto suelto pero ninguna etiqueta, y sin etiquetas no hay
forma de localizar los campos. Por eso la página de captura pide la máxima
resolución al dispositivo y usa `ImageCapture.takePhoto()` cuando está
disponible, que usa el sensor completo en lugar de la vista previa.

**Ampliar una imagen pequeña no sirve de nada**: hace falta detalle real.

### La detección de contorno solo se usa cuando hace falta

El pipeline original se diseñó para fotos de un DNI sobre una mesa: detectaba
la tarjeta separándola del fondo y corregía la perspectiva. Pero la página de
captura recorta exactamente al marco guía, así que **lo que llega del móvil ya
viene sin fondo alrededor**.

Sobre una imagen así, el detector no falla limpiamente: toma por contorno un
bloque de texto o la fotografía del titular y devuelve un recorte deformado
(se llegó a medir un 130 % del área original) con el que Tesseract deja de
leer. El síntoma en los logs era `puntuaciones=[0, -1]`, es decir, ninguna
etiqueta reconocida en el anverso, y ni nombre ni domicilio en el resultado.

Ahora hay dos salvaguardas:

1. **Se omite la detección** si la imagen ya tiene la proporción del DNI y su
   borde no es un fondo liso.
2. **Se valida lo detectado**: si el recorte no tiene forma de DNI, o si la
   corrección de perspectiva lo ha agrandado, se descarta y se usa la imagen
   completa. No se exige un tamaño mínimo, porque una foto hecha de lejos da
   un recorte pequeño y perfectamente válido.

### Pruebas

```bash
cd dni-ocr-service
python3 test_pipeline.py   # extracción de campos y consolidación
python3 test_mrz.py        # lectura y dígitos de control del MRZ
python3 test_nombre.py     # nombre por posición, incluido un nombre muy largo
python3 test_encuadres.py  # imagen recortada, con fondo, de lejos, inclinada
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
