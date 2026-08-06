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

**Por qué ahora:** Render (paso 4) necesita leer el código desde GitHub, así que
tiene que estar subido antes.

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

Esta es la pieza que usa tu código de Python. Va en un servidor aparte porque
necesita Tesseract, que ni Supabase ni Vercel traen instalado.

Usaremos **Render**, que se maneja todo desde el navegador.

1. Crea una cuenta en https://render.com (puedes entrar con GitHub).
2. **New** → **Web Service**.
3. Conecta el repositorio `GrupoJoven/PortalDeInscripciones`.
4. Rellena así:

   | Campo          | Valor                          |
   | -------------- | ------------------------------ |
   | Name           | `dni-ocr`                      |
   | Region         | **Frankfurt** (la más cercana a tu Supabase) |
   | Branch         | `main`                         |
   | Root Directory | `dni-ocr-service`              |
   | Runtime        | **Docker**                     |
   | Instance Type  | ver la nota de abajo           |

5. Baja hasta **Environment Variables** y añade una:

   - Key: `DNI_OCR_SERVICE_SECRET`
   - Value: una contraseña larga e inventada, de al menos 40 caracteres.
     Sirve cualquier cosa aleatoria; **guárdala en un sitio seguro porque la
     necesitas en el paso 5**.

6. **Create Web Service**. El primer despliegue tarda unos 5-10 minutos
   (está instalando Tesseract).

### Sobre el plan gratuito

En el plan gratuito, Render apaga el servicio tras 15 minutos sin uso y tarda
unos 50 segundos en despertar. La primera persona que verifique su DNI después
de un rato de inactividad se quedará esperando casi un minuto, y puede llegar a
fallar.

Además, la instancia gratuita comparte 0,1 de CPU, así que la lectura del
documento tarda del orden de 15-30 segundos en lugar de 2-3.

- **Para probar**: el plan gratuito vale. Si la lectura falla por tardar
  demasiado, en el móvil aparece **"Reintentar la lectura"**: reaprovecha las
  fotos ya subidas y, con el contenedor ya despierto, suele funcionar.
- **Para el periodo de inscripciones**: pásate al plan de pago más barato
  (unos 7 $/mes), que no se duerme y da CPU completa. Puedes cambiarlo el día
  antes de abrir las inscripciones y volver al gratuito después.

**Comprobación:** cuando Render diga "Live", copia la URL que te da (algo como
`https://dni-ocr.onrender.com`) y ábrela en el navegador añadiendo `/health`:

```
https://dni-ocr.onrender.com/health
```

Debe responder exactamente esto:

```json
{"ok":true,"ocr_language":"spa","spanish":true,"configured":true}
```

Fíjate bien en que ponga **`"spanish":true`**. Si pone `false`, el paquete de
español no se instaló y el OCR leerá bastante peor: avísame antes de seguir.

---

## Paso 5 — Dar las contraseñas a Supabase

Supabase necesita saber dónde está el servicio de OCR y con qué contraseña
hablarle.

1. Entra en https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/settings/functions
2. En la sección de secretos (**Edge Function Secrets**), añade dos:

   | Nombre                   | Valor                                          |
   | ------------------------ | ---------------------------------------------- |
   | `DNI_OCR_SERVICE_URL`    | La URL de Render, sin barra final. Ej: `https://dni-ocr.onrender.com` |
   | `DNI_OCR_SERVICE_SECRET` | La misma contraseña larga del paso 4            |

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

## Paso 9 (opcional, recomendado) — Limpieza automática

Las sesiones caducan solas a los 30 minutos, pero las filas se quedan
acumuladas en la tabla. Para borrarlas cada hora, ejecuta esto una vez en el
editor SQL:

```sql
create extension if not exists pg_cron;

select cron.schedule(
  'limpiar-sesiones-dni',
  '0 * * * *',
  $$ select public.cleanup_dni_verification_sessions(); $$
);
```

---

## Si algo falla

| Síntoma | Causa probable | Solución |
| --- | --- | --- |
| El QR lleva a una página en blanco o de error | `APP_BASE_URL` mal configurada | Paso 5, punto 3 |
| El móvil dice "No se ha podido abrir la cámara" | Estás en `http://` o denegaste el permiso | Usa la web publicada (HTTPS) y acepta el permiso |
| Se queda en "Leyendo el documento..." y falla | Render estaba dormido o va muy justo de CPU | Pulsa **"Reintentar la lectura"**: las fotos siguen guardadas y no hay que repetirlas. Si pasa siempre, plan de pago |
| Pide repetir la foto del reverso una y otra vez | Versión anterior: cualquier fallo del servidor se trataba como foto ilegible | Redespliega `dni-verification-upload` |
| Falla la lectura y en los logs de Render no aparece ninguna petición `POST /extract` | La Edge Function no llegó a enviarla | Mira los logs de Supabase: registra la URL a la que llama y un diagnóstico de `/health` |
| Lee el DNI pero el formulario sale vacío | Faltan las dos funciones modificadas del paso 6 | Redespliega `start-public-form-email-access` y `verify-public-form-email-token` |
| Los datos leídos salen con errores raros | `"spanish":false` en `/health` | El paquete de español no se instaló; avísame |
| El marco nunca se pone verde | Umbrales del comprobador de encuadre | Espera 6 s y usa **"Hacer la foto igualmente"**. Para diagnosticarlo, toca el mensaje de aviso: se despliegan los números que está midiendo |
| "Este formulario requiere verificar el DNI... Vuelve a empezar" | La sesión caducó (30 min) | Vuelve a generar el QR |

Para ver qué está pasando por dentro:

- Logs de las funciones: https://supabase.com/dashboard/project/pqycvrpdyebshkfaxzmi/logs/edge-functions
- Logs del OCR: pestaña **Logs** de tu servicio en Render.

---

---

# Referencia técnica

A partir de aquí es documentación para entender cómo funciona por dentro. No
hace falta para ponerlo en marcha.

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
