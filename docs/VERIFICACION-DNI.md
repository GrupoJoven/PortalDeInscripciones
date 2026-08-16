# Verificación de DNI — guía paso a paso

Todo el código ya está escrito. Lo que queda es publicarlo y conectar las
piezas. Sigue los pasos en orden; cada uno tiene una comprobación al final
para que sepas si ha ido bien antes de pasar al siguiente.

**Tranquilo con romper nada:** la función nace desactivada. La casilla
"Verificación de DNI" está desmarcada por defecto en todos los formularios, así
que hasta que no la marques tú en el paso 7, los usuarios no notarán ningún
cambio.

Tiempo estimado: unos 45 minutos, casi todo esperando a que las cosas se
desplieguen.

Tu proyecto de Supabase es `pqycvrpdyebshkfaxzmi`, alojado en Irlanda
(eu-west-1). Lo necesitarás en varios pasos.

---

## Paso 0 — Borrar un fichero de bloqueo de git

Al revisar el repositorio quedó un fichero de bloqueo vacío. Si no lo borras,
git te dará el error `Unable to create index.lock: File exists`.

Abre PowerShell en la carpeta del proyecto y ejecuta:

```powershell
Remove-Item .git\index.lock -Force
```

**Comprobación:** `git status` debe funcionar sin errores.

---

## Paso 1 — Evitar un lío de finales de línea

Los ficheros del proyecto están guardados con finales de línea de Windows
(CRLF) pero en GitHub están con finales de Linux (LF). Ahora mismo git cree que
has modificado **todos** los ficheros del proyecto, aunque en realidad solo han
cambiado 9.

Si no lo arreglas, el commit del paso 2 tendrá miles de líneas de ruido y será
imposible de revisar. Se soluciona con un comando:

```powershell
git config core.autocrlf true
```

**Comprobación:** ejecuta `git status`. Debe listar solo estos ficheros
modificados y ninguno más:

```
package.json
src/App.tsx
src/components/AdminPanel.tsx
src/components/FormCard.tsx
src/components/HomePage.tsx
src/types.ts
supabase/config.toml
supabase/functions/start-public-form-email-access/index.ts
supabase/functions/verify-public-form-email-token/index.ts
```

Más una lista de ficheros nuevos (los que empiezan por `??`): `dni-ocr-service/`,
`docs/`, `supabase/migrations/`, y los componentes y funciones nuevos.

Si siguen apareciendo ficheros como `src/components/Login.tsx` o `src/index.css`,
párate y dímelo antes de continuar.

---

## Paso 2 — Instalar la dependencia nueva y subir el código

El portal usa una librería nueva para generar el código QR.

```powershell
npm install
```

Después sube todo a GitHub:

```powershell
git add .
git commit -m "Verificacion de DNI en formularios de acceso libre"
git push
```

**Por qué ahora:** Vercel (el portal) despliega desde GitHub, así que tiene
que estar subido antes. El servicio de OCR del paso 4 (Google Cloud Run) se
construye a partir del código en tu ordenador, no necesita GitHub — pero
subirlo de todas formas mantiene el repositorio como fuente de verdad.

**Comprobación:**

1. Entra en https://github.com/GrupoJoven/PortalDeInscripciones y comprueba que
   aparece la carpeta `dni-ocr-service`.
2. Si tienes Vercel conectado a GitHub, se habrá lanzado un despliegue solo.
   Espera a que termine y entra en el portal: debe funcionar exactamente igual
   que antes. Todavía no verás nada nuevo, es lo esperado.

---

## Paso 3 — Crear las tablas en la base de datos

Vamos a hacerlo desde el editor SQL del navegador, sin línea de comandos.

1. Entra en https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/sql/new
2. Abre en tu ordenador el fichero
   `supabase/migrations/20260805090000_dni_verification.sql`
3. Copia **todo** su contenido y pégalo en el editor.
4. Pulsa **Run** (o Ctrl+Intro).

Debe salir `Success. No rows returned`.

> Este script se puede ejecutar varias veces sin problema: todo está escrito
> con `if not exists`. Si dudas de si lo lanzaste, vuelve a lanzarlo.

**Comprobación:** en el editor SQL, ejecuta esto en una pestaña nueva:

```sql
select count(*) as tabla_sesiones from public.dni_verification_sessions;

select column_name
from information_schema.columns
where table_name = 'registration_forms'
  and column_name in ('dni_verification_enabled', 'prefill_address_entry');

select id, public from storage.buckets where id = 'dni_uploads';
```

Debe devolver: `0`, las dos columnas, y el bucket con `public = false`.

---

## Paso 4 — Publicar el servicio que lee los DNI

Esta es la pieza que hace el OCR. Va en un servidor aparte porque ni las
Edge Functions de Supabase (Deno) ni Vercel pueden correr PaddleOCR.

> **Historial:** este paso usaba Render con un lector basado en Tesseract
> (`dni-ocr-service/`). Se migró a **Google Cloud Run** con un lector nuevo
> basado en PaddleOCR (`dni-ocr-cloudrun/`) porque el lector nuevo lee mucho
> mejor el nombre y el domicilio en fotos reales, pero necesita más memoria
> (~600 MB de pico) de la que da el plan gratuito de Render (512 MB). El
> directorio `dni-ocr-service/` se deja tal cual, sin desplegar, por si hace
> falta volver atrás: basta con repetir el paso 5 apuntando a su URL de
> Render.

### 4.1 Cuenta, proyecto y facturación de Google Cloud

Esto solo se puede hacer desde el navegador, con tu cuenta de Google:

1. Crea un **proyecto nuevo** en
   https://console.cloud.google.com/projectcreate (independiente de
   cualquier otro proyecto que ya tengas). Apunta el **ID del proyecto**
   (no el nombre) — lo pide más abajo.
2. Vincula una **cuenta de facturación** al proyecto, en
   https://console.cloud.google.com/billing. Cloud Run exige facturación
   activa aunque el uso se quede dentro de la capa gratuita (con el volumen
   de un colegio, no debería generar cargos).

### 4.2 Instalar `gcloud` y autenticarse

```powershell
scoop bucket add extras
scoop install extras/gcloud
gcloud auth login
gcloud config set project <ID-DEL-PROYECTO>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

`gcloud auth login` abre el navegador una vez. A partir de ahí, todo lo
demás se puede hacer por línea de comandos.

### 4.3 Desplegar

```powershell
cd dni-ocr-cloudrun
gcloud run deploy dni-ocr-cloudrun `
  --source . `
  --region europe-west1 `
  --memory 1Gi `
  --cpu 1 `
  --cpu-boost `
  --concurrency 1 `
  --min-instances 0 `
  --max-instances 3 `
  --timeout 120 `
  --allow-unauthenticated `
  --set-env-vars DNI_OCR_SERVICE_SECRET=<contraseña larga e inventada>
```

Genera la contraseña con `openssl rand -hex 32` (o cualquier cosa aleatoria
de 40+ caracteres). **Guárdala: la necesitas en el paso 5.**

El primer despliegue tarda varios minutos (construye la imagen con Cloud
Build). Al terminar, imprime algo como:

```
Service URL: https://dni-ocr-cloudrun-XXXXXXXXXXXX.europe-west1.run.app
```

Copia esa URL: es lo que necesita el paso 5.

`--allow-unauthenticated` es correcto y deliberado: la autenticación real la
hace la propia aplicación comprobando `X-Service-Secret`, igual que hacía en
Render — no hace falta autenticación a nivel de Google además de esa.

`europe-west1` (Bélgica) por cercanía al proyecto de Supabase (Irlanda). 1
GiB de memoria da margen sobre el pico medido (~600 MB); `min-instances=0`
mantiene esto en la capa gratuita entre temporadas de inscripción, a cambio
de un arranque en frío de ~20-30 s la primera vez tras un rato sin uso — la
Edge Function ya espera hasta 130 s, así que entra de sobra.

**Comprobación:**

```
https://<tu-url-de-cloud-run>/health
```

Debe responder exactamente esto:

```json
{"ok":true,"engine":"paddleocr-tiny","configured":true}
```

---

## Paso 5 — Dar las contraseñas a Supabase

Supabase necesita saber dónde está el servicio de OCR y con qué contraseña
hablarle.

1. Entra en https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/settings/functions
2. En la sección de secretos (**Edge Function Secrets**), añade dos:

   | Nombre                   | Valor                                          |
   | ------------------------ | ---------------------------------------------- |
   | `DNI_OCR_SERVICE_URL`    | La URL de Cloud Run, sin barra final. Ej: `https://dni-ocr-cloudrun-xxxxxxxxxxxx.europe-west1.run.app` |
   | `DNI_OCR_SERVICE_SECRET` | La misma contraseña larga del paso 4            |

   O por línea de comandos, más rápido:
   ```powershell
   supabase secrets set DNI_OCR_SERVICE_URL=<tu-url-de-cloud-run> --project-ref pqycvrpdyebshkfaxzmi
   supabase secrets set DNI_OCR_SERVICE_SECRET=<la-misma-contraseña-del-paso-4> --project-ref pqycvrpdyebshkfaxzmi
   ```

3. Comprueba en esa misma pantalla que ya existe `APP_BASE_URL` y que apunta a
   la dirección pública de tu portal (la de Vercel o tu dominio). Es la
   dirección que se meterá dentro del código QR: si está mal, el QR llevará a
   ninguna parte.

**Comprobación:** los tres nombres aparecen en la lista de secretos.

---

## Paso 6 — Publicar las funciones de Supabase

Aquí sí hace falta la línea de comandos. Ya tienes el CLI de Supabase instalado
(versión 2.111.0), así que no necesitas Docker.

Abre PowerShell en la carpeta del proyecto:

```powershell
supabase login
supabase link --project-ref pqycvrpdyebshkfaxzmi
```

Y despliega las siete funciones, una a una:

```powershell
supabase functions deploy dni-verification-start
supabase functions deploy dni-verification-session
supabase functions deploy dni-verification-upload
supabase functions deploy dni-verification-confirm
supabase functions deploy dni-verification-status
supabase functions deploy start-public-form-email-access
supabase functions deploy verify-public-form-email-token
```

Las dos últimas ya existían y las he modificado para que arrastren los datos
del DNI hasta la URL final del formulario. **No te las saltes**: sin ellas el
DNI se verifica pero no se prerrellena nada.

**Comprobación:** entra en
https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/functions
y comprueba que aparecen las cinco `dni-verification-*` y que las dos
modificadas tienen fecha de despliegue de hoy.

---

## Paso 7 — Configurar un formulario de prueba

Antes de tocar un formulario real, haz uno de pruebas.

### 7.1 Preparar el formulario de Google

Necesitas un formulario de Google con al menos estas cuatro preguntas de
respuesta corta:

- Email de contacto
- DNI
- Nombre completo
- Dirección de la residencia habitual

### 7.2 Obtener los identificadores `entry.`

Es lo mismo que ya haces con los formularios de acceso limitado:

1. En el formulario de Google: menú de tres puntos → **Obtener enlace
   prerrellenado**.
2. Escribe algo distinto en cada campo (por ejemplo `AAA`, `BBB`, `CCC`, `DDD`)
   para reconocerlos después.
3. Pulsa **Obtener enlace** y luego **Copiar enlace**.
4. Pega el enlace en el bloc de notas. Verás algo así:

   ```
   ...?usp=pp_url&entry.1111111111=AAA&entry.2222222222=BBB&entry.3333333333=CCC&entry.4444444444=DDD
   ```

5. Anota qué `entry.XXXXXXXXX` corresponde a cada pregunta.

### 7.3 Darlo de alta en el portal

1. Entra en tu panel de administración → **Nuevo formulario**.
2. Tipo de acceso: **ACCESO LIBRE**.
3. Marca la casilla nueva **Verificación de DNI**.
4. Aparecerán tres campos. Rellénalos con los identificadores del paso 7.2:
   **DNI**, **NOMBRE COMPLETO** y **DIRECCIÓN DE LA RESIDENCIA HABITUAL**.
5. Rellena también **EMAIL DE CONTACTO**, como en cualquier formulario de
   acceso libre.
6. Guarda.

Si el botón de guardar sigue gris, es que falta alguno de los tres
identificadores: los tres son obligatorios cuando la verificación está activa.

---

## Paso 8 — Probarlo de principio a fin

**Importante:** la cámara del móvil solo funciona sobre HTTPS. Tienes que
probarlo en la web publicada (Vercel), **no** en `localhost`.

Con el formulario de prueba abierto y un DNI a mano:

1. Desde el ordenador, entra en el portal y pulsa **Acceder al Formulario**.
2. Debe salir el aviso de verificación de DNI con la casilla del menor sin DNI.
   Déjala **sin marcar** para esta primera prueba.
3. Pulsa **Aceptar y continuar**. Aparece el código QR.
4. **Antes de escanear**, comprueba de paso que `APP_BASE_URL` es correcta:
   debajo del QR hay un enlace que pone "Abre la verificación en este mismo
   dispositivo". Pasa el ratón por encima sin pulsar y mira abajo a la
   izquierda del navegador: ahí sale la URL completa que lleva el QR. El
   dominio debe ser el de este portal.
5. Escanéalo con la cámara del móvil.
6. En el móvil: pulsa **Empezar**, apoya el DNI sobre una superficie lisa y de
   color uniforme (una mesa oscura va bien) y encájalo en el marco.
   - El marco se pone **verde** y el botón se activa solo cuando la foto vale.
   - Si no se pone verde, el mensaje de abajo te dice por qué: "Encaja el
     documento dentro del marco", "Evita los reflejos", "Mantén el móvil
     quieto"...
   - **Si aun así no se desbloquea**, a los 6 segundos aparece un segundo
     botón, **"Hacer la foto igualmente"**. Úsalo sin problema: el servicio de
     OCR vuelve a detectar y recortar el documento por su cuenta.
   - Tocando el mensaje de aviso se despliegan los números que está midiendo
     el comprobador, por si hace falta afinarlo.
7. Primero el anverso (la cara de la foto), después el reverso (la del
   domicilio).
8. Sale la pantalla con el nombre, el DNI y el domicilio detectados.
   Si algo está mal, **Repetir anverso** o **Repetir reverso**: se repite solo
   esa cara, la otra se conserva.
9. Pulsa **Los datos son correctos**.
10. Vuelve al ordenador: debe haber avanzado solo a la pantalla del correo
   electrónico, con un recuadro verde de "DNI verificado".
11. Escribe tu correo y continúa.
12. Se abre el formulario de Google con el DNI, el nombre y la dirección ya
    rellenados.

### Segunda prueba: menor sin DNI

Repite el proceso marcando la casilla **"El menor tiene menos de 14 años y no
dispone de DNI"** y fotografiando el DNI de un adulto.

Al final, en el formulario de Google deben aparecer rellenados **el DNI y la
dirección, pero el nombre en blanco**. Eso es lo correcto: el nombre leído es
el del adulto y no debe usarse como nombre del menor.

---

## Paso 9 (no lo saltes) — Borrado automático de las fotos

**Esto no es opcional pese a lo que decía antes esta guía.** Las sesiones
caducan solas a los 30 minutos, pero eso solo borra la fila de la tabla; las
fotos del documento se quedan en el bucket `dni_uploads` para siempre si
nadie las borra a propósito. La única vía que sí las borra
(`dni-verification-confirm`) solo se dispara cuando el usuario **confirma**
los datos leídos: cualquier verificación abandonada, fallida, o una simple
prueba, deja sus dos fotos ahí de por vida pese al mensaje de "las fotos se
han borrado".

*(Si en algún momento ejecutaste una versión anterior de este paso que solo
llamaba a `cleanup_dni_verification_sessions()` por SQL: esa función borra
las filas de la tabla, pero una función SQL no puede borrar archivos de
Storage —eso solo lo hace la API de Storage—, así que las fotos seguían
acumulándose. Es justo lo que corrige este paso.)*

### 9.1 Desplegar la función de limpieza

```powershell
supabase functions deploy dni-verification-cleanup
```

### 9.2 Darle un secreto

En https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/settings/functions,
añade un secreto más junto a los del paso 5:

| Nombre               | Valor                                                    |
| -------------------- | --------------------------------------------------------|
| `DNI_CLEANUP_SECRET` | Otra contraseña larga e inventada (no la reutilices de las otras) |

### 9.3 Programar que se ejecute sola

Si ya tenías programado el `limpiar-sesiones-dni` de una versión anterior de
esta guía, quítalo primero (en el editor SQL):

```sql
select cron.unschedule('limpiar-sesiones-dni');
```

Y programa la limpieza de verdad, cambiando `TU_SECRETO_AQUI` por el valor
exacto que has puesto en `DNI_CLEANUP_SECRET`:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'limpiar-fotos-dni',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://pqycvrpdyebshkfaxzmi.supabase.co/functions/v1/dni-verification-cleanup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cleanup-secret', 'TU_SECRETO_AQUI'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

**Comprobación:** espera 15 minutos (o cambia momentáneamente el intervalo a
`* * * * *` para probarlo ya, y vuelve a `*/15 * * * *` después) y mira los
logs de la función en
https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/functions —
debe aparecer una ejecución con `fotos_encontradas` y `fotos_borradas`. Si
tienes fotos de pruebas antiguas acumuladas en el bucket de antes de aplicar
este paso, esta misma limpieza las recogerá en cuanto sus sesiones lleven más
de 30 minutos caducadas (todas las de pruebas ya llevan mucho más).

---

## Paso 10 — Código postal y zona parroquial

El DNI no lleva el código postal. Desde esta versión, `dni-verification-upload`
lo infiere llamando a la **API de Geocodificación de Google Maps** a partir
del domicilio ya leído (sin el piso/puerta, que se recorta antes de
preguntar), y comprueba si es el de la zona parroquial (CP **46010**). Es un
dato best-effort: si la API falla o no encuentra la dirección, la
verificación no se bloquea, solo avisa de que habrá que rellenarlo a mano.

### 10.1 Activar la API y crear la clave

1. En el **mismo proyecto de Google Cloud** que ya usas para Cloud Run (la
   facturación ya está vinculada, no hace falta un proyecto nuevo):
   https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com
   → **Habilitar**.
2. Crea una API key en
   https://console.cloud.google.com/apis/credentials → **Crear
   credenciales → Clave de API**.
3. **Restríngela**: edítala y en "Restricciones de API" marca solo
   **Geocoding API**. No hace falta restricción por IP (las Edge Functions
   de Supabase no tienen IP fija): la clave nunca llega al navegador, solo la
   usa el servidor, así que la restricción por API ya es suficiente
   seguridad.

### 10.2 Dar la clave a Supabase

```powershell
supabase secrets set GOOGLE_MAPS_API_KEY=<tu-clave> --project-ref pqycvrpdyebshkfaxzmi
```

Si no se configura este secreto, el portal sigue funcionando exactamente
igual que antes: simplemente no se infiere el código postal (se loguea un
aviso) y en la revisión del móvil aparece el mensaje de "tendrás que
indicarlo a mano".

### 10.3 Ejecutar la migración nueva

Igual que en el paso 3: abre
https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/sql/new, pega el
contenido de `supabase/migrations/20260816120000_dni_postal_code.sql` y
pulsa **Run**.

**Comprobación:**

```sql
select column_name
from information_schema.columns
where table_name = 'registration_forms'
  and column_name = 'prefill_postal_code_entry';
```

### 10.4 Redesplegar las funciones tocadas

```powershell
supabase functions deploy dni-verification-upload
supabase functions deploy dni-verification-session
supabase functions deploy dni-verification-status
supabase functions deploy start-public-form-email-access
supabase functions deploy verify-public-form-email-token
```

### 10.5 Añadir la pregunta al formulario y configurarla en el panel

1. En el formulario de Google de prueba, añade una pregunta de respuesta
   corta **Código Postal** y consigue su `entry.XXXXXXXXX` (menú de tres
   puntos → **Obtener enlace prerrellenado**, igual que en el paso 7.2).
2. En el panel de administración, edita el formulario → sección
   **Campos de prerrelleno de la verificación de DNI** → rellena el nuevo
   campo **CÓDIGO POSTAL**. Es opcional: si lo dejas en blanco, simplemente
   no se prerrellena nada ahí, el resto sigue funcionando igual.

### 10.6 Probarlo

Repite el paso 8 con un DNI real. En la pantalla de revisión del móvil, bajo
"Domicilio", debe aparecer un campo **C.P.** con el código inferido y un
aviso verde "Dentro de la zona parroquial" o ámbar "Fuera de la zona
parroquial". El formulario de Google final debe llegar con el código postal
ya relleno.

Para comprobar que el fallo no bloquea nada, quita temporalmente el secreto
`GOOGLE_MAPS_API_KEY` (o pon uno inválido) y repite la prueba: debe seguir
pudiéndose confirmar la verificación, con el aviso de "no se ha podido
inferir el código postal automáticamente".

### Nota de coste

La Geocoding API cuesta del orden de $5 por cada 1000 peticiones, con
$200/mes de crédito gratuito de Google Maps Platform (unas 40 000 peticiones
gratis al mes). Al volumen de este portal no debería generar ningún cargo,
pero conviene fijar un presupuesto y una alerta en **Facturación →
Presupuestos y alertas** del mismo proyecto de Google Cloud, tal como se
explicó para Cloud Run.

---

## Si algo falla

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| El QR lleva a una página en blanco o de error | `APP_BASE_URL` mal configurada | Paso 5, punto 3 |
| El móvil dice "No se ha podido abrir la cámara" | Estás en `http://` o denegaste el permiso | Usa la web publicada (HTTPS) y acepta el permiso |
| Se queda en "Leyendo el documento..." y falla | El contenedor de Cloud Run estaba en arranque en frío (`min-instances=0`) | Pulsa **"Reintentar la lectura"**: las fotos siguen guardadas y no hay que repetirlas. Si pasa siempre, sube `min-instances` a 1 |
| Pide repetir la foto del reverso una y otra vez | Versión anterior: cualquier fallo del servidor se trataba como foto ilegible | Redespliega `dni-verification-upload` |
| Falla la lectura y en los logs de Cloud Run no aparece ninguna petición `POST /extract` | La Edge Function no llegó a enviarla | Mira los logs de Supabase: registra la URL a la que llama y un diagnóstico de `/health` |
| Lee el DNI pero el formulario sale vacío | Faltan las dos funciones modificadas del paso 6 | Redespliega `start-public-form-email-access` y `verify-public-form-email-token` |
| `documento_vigente` sale `false` con un DNI que no ha caducado | Fecha de validez mal leída, u OCR confundido | Repite la foto del reverso; si persiste, revisa `fecha_validez` en la respuesta de `/extract` a mano |
| El marco nunca se pone verde | Umbrales del comprobador de encuadre | Espera 6 s y usa **"Hacer la foto igualmente"**. Para diagnosticarlo, toca el mensaje de aviso: se despliegan los números que está midiendo |
| "Este formulario requiere verificar el DNI... Vuelve a empezar" | La sesión caducó (30 min) | Vuelve a generar el QR |
| Necesito volver al servicio anterior (Render/Tesseract) | El de Cloud Run da problemas | `supabase secrets set DNI_OCR_SERVICE_URL=<url-de-render> --project-ref pqycvrpdyebshkfaxzmi` con la URL del servicio de Render (si sigue desplegado) — no hace falta redesplegar nada más |

Para ver qué está pasando por dentro:

- Logs de las funciones: https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/logs/edge-functions
- Logs del OCR: `gcloud run services logs read dni-ocr-cloudrun --region europe-west1`,
  o la consola de Cloud Run → el servicio → pestaña **Logs**.

---

---

# Referencia técnica

A partir de aquí es documentación para entender cómo funciona por dentro. No
hace falta para ponerlo en marcha.

> **Nota:** las secciones "Cómo se lee cada dato" en adelante describen el
> lector **original basado en Tesseract** (`dni-ocr-service/`), que ya no es
> el que está desplegado por defecto (ver el aviso del Paso 4). Se dejan tal
> cual porque `dni-ocr-service/` sigue en el repositorio como posible vuelta
> atrás, y porque documentan decisiones (nitidez, lectura por posición,
> etiquetas bilingües...) que costó bastante averiguar. Para el lector nuevo
> (`dni-ocr-cloudrun/`, PaddleOCR), consulta `dni-ocr-cloudrun/README.md`.

## Flujo completo

```
Ordenador                          Móvil                        Servidor
─────────                          ─────                        ────────
Pulsa "Acceder al formulario"
   │
   ▼
Aviso: se requiere verificar el DNI
[ ] El menor tiene menos de 14 años
    y no dispone de DNI
   │ Aceptar
   ▼
                                                    dni-verification-start
                                                    crea sesión (30 min)
   ◀───────── QR con token ─────────────────────────
   │                                 │ escanea
   │                                 ▼
   │                          /verificacion-dni#t=...
   │                                 │
   │                          Foto del anverso ──▶  dni-verification-upload
   │                          Foto del reverso ──▶  → bucket privado
   │  (sondea cada 2,5 s)                            → servicio Python (OCR)
   │                                 ◀───────────── nombre, DNI, domicilio
   │                          Revisa los datos
   │                          [Repetir anverso] [Repetir reverso]
   │                                 │ Correcto
   │                                 ▼
   │                                              dni-verification-confirm
   │                                              → borra las fotos
   ◀───────── estado: confirmado ──────────────────
   │
   ▼
Pide el email (flujo de siempre)
   │
   ▼
Formulario de Google con DNI,
nombre y domicilio ya rellenados
```

## Qué crea la migración

- `registration_forms.dni_verification_enabled` (booleano, por defecto `false`)
- `registration_forms.prefill_address_entry`
- `registration_forms.prefill_postal_code_entry` (paso 10, opcional)
- La tabla `dni_verification_sessions` con RLS activado y **sin policies**:
  solo se accede desde las Edge Functions con `service_role`.
- El bucket privado `dni_uploads`.
- `public_form_email_verification_tokens.dni_verification_session_id`.
- La función `cleanup_dni_verification_sessions()`.
- Una restricción que impide activar la verificación en formularios de acceso
  limitado.

## Decisiones de diseño

- **El token del QR viaja en el fragmento** (`#t=...`), así que nunca llega al
  servidor ni queda en logs de acceso ni en la cabecera `Referer`.
- **Dos tokens distintos**: el móvil no puede consultar el estado del
  escritorio ni al revés. En la base de datos solo se guardan sus hashes.
- **Las fotos se borran al confirmar.** Se conservan hasta ese momento para que
  se pueda repetir una sola cara sin rehacer las dos fotos. Después solo quedan
  nombre, número y domicilio, y como mucho 24 h (el margen para completar la
  verificación por correo).
- **Y si nunca se confirma, también se borran.** Una sesión abandonada, fallida
  o de prueba caduca a los 30 minutos; la limpieza periódica (paso 9,
  `dni-verification-cleanup`) borra la fila y, con ella, las fotos que hubiera
  en el bucket. Sin este paso, el mensaje de "las fotos se han borrado" solo
  era cierto para quien llegaba a confirmar.
- **Si el menor no tiene DNI**, el nombre leído es el del progenitor: se guarda
  pero nunca se devuelve al escritorio ni se prerrellena en el formulario. Solo
  se usan el DNI y el domicilio.
- **No se puede saltar la verificación**: `start-public-form-email-access`
  rechaza cualquier intento de acceder a un formulario con verificación activa
  sin una sesión confirmada para ese mismo formulario.
- **El encuadre se valida en el navegador** (nitidez por varianza del
  laplaciano, luz, reflejos y ajuste al marco). El botón de disparo solo se
  habilita tras 4 fotogramas seguidos correctos.
- **El número de DNI se valida con su dígito de control**, lo que además sirve
  para elegir entre el número leído en el anverso y el del reverso.

## Cambios sobre tu código Python original

- **Configuración de Tesseract corregida.** El original pasaba
  `r'l spa - psm 11'`; Tesseract espera `-l spa --psm 11`, así que estaba
  ignorando tanto el idioma como el modo de segmentación.
- **Varias pasadas de OCR**: se prueban `--psm 11`, `6` y `4` y se elige el
  resultado con más etiquetas del DNI reconocidas.
- **Detección del idioma al arrancar**: si falta `tesseract-ocr-spa`, antes
  devolvía texto vacío en silencio; ahora avisa por log y lo expone en
  `/health`.
- **Recuperación ante fallos de detección**: si no se detecta el contorno de la
  tarjeta se usa la imagen completa, porque el navegador ya recorta al marco.
- **Trabaja en memoria**, nunca escribe la imagen del documento en disco.
