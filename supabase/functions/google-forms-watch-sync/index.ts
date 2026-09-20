// supabase/functions/google-forms-watch-sync/index.ts

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type RegistrationFormRow = {
  id: string
  title: string
  google_form_id: string | null
  google_form_watch_enabled: boolean
}

type GoogleFormWatchRow = {
  id: string
  registration_form_id: string
  google_form_id: string
  watch_id: string
  event_type: string
  topic_name: string
  expires_at: string
  status: string
}

type GoogleOAuthTokenRow = {
  provider: string
  google_email: string | null
  access_token: string | null
  refresh_token: string
  scope: string | null
  token_type: string | null
  expiry_date: string | null
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID')!
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET')!
const GOOGLE_FORMS_WATCH_TOPIC = Deno.env.get('GOOGLE_FORMS_WATCH_TOPIC')!
// Solo necesario si se pide sincronizar respuestas al recrear un watch
const INTERNAL_FUNCTIONS_SECRET = Deno.env.get('INTERNAL_FUNCTIONS_SECRET')

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_FORMS_API_BASE = 'https://forms.googleapis.com/v1'
const SUPABASE_FUNCTIONS_BASE_URL = `${SUPABASE_URL}/functions/v1`
// Los watches de Google Forms caducan a los 7 días; se renuevan cuando les
// queda menos de esto. El cron que llama a esta función debe ejecutarse con
// más frecuencia que este margen.
const WATCH_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000

function requireEnv(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`)
  }
  return value
}

function needsRenewal(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true
  const expiresMs = new Date(expiresAt).getTime()
  if (Number.isNaN(expiresMs)) return true
  return expiresMs - Date.now() <= WATCH_RENEWAL_THRESHOLD_MS
}

function isExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true
  const expiresMs = new Date(expiresAt).getTime()
  if (Number.isNaN(expiresMs)) return true
  return expiresMs <= Date.now()
}

async function getGoogleAccessTokenFromRefreshToken(params: {
  clientId: string
  clientSecret: string
  refreshToken: string
}) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const json = await resp.json()

  if (!resp.ok) {
    throw new Error(
      `No se pudo obtener access token con refresh token: ${resp.status} ${JSON.stringify(json)}`
    )
  }

  if (!json.access_token) {
    throw new Error('Google no devolvió access_token al refrescar credenciales')
  }

  return {
    accessToken: json.access_token as string,
    expiresIn: Number(json.expires_in ?? 0),
    scope: (json.scope as string | undefined) ?? null,
    tokenType: (json.token_type as string | undefined) ?? null,
  }
}

async function createGoogleFormsWatch(params: {
  accessToken: string
  googleFormId: string
  topicName: string
}) {
  const resp = await fetch(
    `${GOOGLE_FORMS_API_BASE}/forms/${encodeURIComponent(params.googleFormId)}/watches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        watch: {
          target: {
            topic: {
              topicName: params.topicName,
            },
          },
          eventType: 'RESPONSES',
        },
      }),
    }
  )

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Error creando watch para ${params.googleFormId}: ${resp.status} ${text}`)
  }

  return await resp.json()
}

/**
 * Extiende un watch vivo otros 7 días. Google solo admite un watch por
 * formulario y tipo de evento, así que mientras el actual siga activo no se
 * puede crear otro: hay que renovarlo. Devuelve null si Google ya no lo
 * conoce (NOT_FOUND, típicamente porque caducó), en cuyo caso toca crearlo.
 */
async function renewGoogleFormsWatch(params: {
  accessToken: string
  googleFormId: string
  watchId: string
}) {
  const resp = await fetch(
    `${GOOGLE_FORMS_API_BASE}/forms/${encodeURIComponent(params.googleFormId)}/watches/${encodeURIComponent(params.watchId)}:renew`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  )

  if (resp.status === 404) {
    return null
  }

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Error renovando watch ${params.watchId} de ${params.googleFormId}: ${resp.status} ${text}`)
  }

  return await resp.json()
}

/**
 * Descarga las respuestas del formulario que no estén ya en
 * google_form_processed_responses. Se usa al recrear un watch: si ha habido un
 * hueco sin watch, Google no ha avisado de las respuestas enviadas en ese
 * tiempo y hay que recuperarlas a mano.
 */
async function syncFormResponses(registrationFormId: string) {
  if (!INTERNAL_FUNCTIONS_SECRET) {
    throw new Error('Falta INTERNAL_FUNCTIONS_SECRET para sincronizar respuestas.')
  }

  const resp = await fetch(`${SUPABASE_FUNCTIONS_BASE_URL}/google-forms-sync-responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': INTERNAL_FUNCTIONS_SECRET,
    },
    body: JSON.stringify({ registration_form_id: registrationFormId }),
  })

  const json = await resp.json().catch(() => null)

  if (!resp.ok || json?.ok === false) {
    throw new Error(`Error sincronizando respuestas: ${resp.status} ${JSON.stringify(json)}`)
  }

  return json
}

/**
 * Procesa las respuestas pendientes por lotes hasta vaciar la cola (con un
 * tope por si algo se queda atascado). Devuelve el resumen de cada lote.
 */
async function processPendingResponses() {
  const batchSize = 50
  const maxBatches = 10
  const batches: unknown[] = []

  for (let i = 0; i < maxBatches; i++) {
    const resp = await fetch(`${SUPABASE_FUNCTIONS_BASE_URL}/google-forms-process-responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: batchSize }),
    })

    const json = await resp.json().catch(() => null)

    if (!resp.ok || json?.ok === false) {
      throw new Error(`Error procesando respuestas pendientes: ${resp.status} ${JSON.stringify(json)}`)
    }

    batches.push(json)

    const handled = Number(json?.processed ?? 0) + Number(json?.processing_error ?? 0)
    if (handled < batchSize) break
  }

  return batches
}

async function markExistingWatchesAsReplaced(
  supabase: ReturnType<typeof createClient>,
  registrationFormId: string
) {
  const { error } = await supabase
    .from('google_form_watches')
    .update({
      status: 'replaced',
      updated_at: new Date().toISOString(),
    })
    .eq('registration_form_id', registrationFormId)
    .eq('status', 'active')

  if (error) {
    throw error
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  try {
    requireEnv(SUPABASE_URL, 'SUPABASE_URL')
    requireEnv(SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY')
    requireEnv(GOOGLE_OAUTH_CLIENT_ID, 'GOOGLE_OAUTH_CLIENT_ID')
    requireEnv(GOOGLE_OAUTH_CLIENT_SECRET, 'GOOGLE_OAUTH_CLIENT_SECRET')
    requireEnv(GOOGLE_FORMS_WATCH_TOPIC, 'GOOGLE_FORMS_WATCH_TOPIC')
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const registrationFormId =
      typeof body?.registration_form_id === 'string' ? body.registration_form_id.trim() : ''
    // Lo activa el cron: si hay que crear un watch nuevo es que ha habido un
    // hueco sin avisos, y conviene recuperar las respuestas de ese hueco.
    const syncResponsesOnCreate = body?.sync_responses_on_create === true

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: oauthTokenRow, error: oauthTokenError } = await supabase
      .from('google_oauth_tokens')
      .select('provider, google_email, access_token, refresh_token, scope, token_type, expiry_date')
      .eq('provider', 'google_forms')
      .single()

    if (oauthTokenError || !oauthTokenRow) {
      throw new Error('No se ha encontrado refresh token OAuth para provider="google_forms".')
    }

    const oauthToken = oauthTokenRow as GoogleOAuthTokenRow

    const refreshed = await getGoogleAccessTokenFromRefreshToken({
      clientId: GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: oauthToken.refresh_token,
    })

    const newExpiryDate =
      refreshed.expiresIn > 0
        ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
        : null

    const { error: oauthUpdateError } = await supabase
      .from('google_oauth_tokens')
      .update({
        access_token: refreshed.accessToken,
        scope: refreshed.scope,
        token_type: refreshed.tokenType,
        expiry_date: newExpiryDate,
        updated_at: new Date().toISOString(),
      })
      .eq('provider', 'google_forms')

    if (oauthUpdateError) {
      throw oauthUpdateError
    }

    // Solo formularios activos: un formulario cerrado o desactivado no debe
    // seguir recibiendo seguimiento (ni renovar su watch, ni recuperar y
    // procesar respuestas atrasadas).
    let formsQuery = supabase
      .from('registration_forms')
      .select('id, title, google_form_id, google_form_watch_enabled')
      .eq('google_form_watch_enabled', true)
      .eq('active', true)
      .order('created_at', { ascending: false })

    if (registrationFormId) {
      formsQuery = formsQuery.eq('id', registrationFormId)
    }

    const { data: forms, error: formsError } = await formsQuery

    if (formsError) {
      throw formsError
    }

    const formsRows = (forms ?? []) as RegistrationFormRow[]

    if (formsRows.length === 0) {
      return jsonResponse({
        ok: true,
        message: 'No hay formularios activos con watch habilitado.',
        processed: 0,
        created: 0,
        skipped: 0,
        errors: [],
      })
    }

    let created = 0
    let renewed = 0
    let skipped = 0
    const errors: Array<{ registration_form_id: string; title: string; error: string }> = []
    const synced: Array<{ registration_form_id: string; title: string; result: unknown }> = []

    for (const form of formsRows) {
      try {
        if (!form.google_form_id?.trim()) {
          errors.push({
            registration_form_id: form.id,
            title: form.title,
            error: 'El formulario no tiene google_form_id configurado.',
          })
          continue
        }

        const { data: existingWatch, error: existingWatchError } = await supabase
          .from('google_form_watches')
          .select('id, registration_form_id, google_form_id, watch_id, event_type, topic_name, expires_at, status')
          .eq('registration_form_id', form.id)
          .eq('status', 'active')
          .maybeSingle()

        if (existingWatchError) {
          throw existingWatchError
        }

        const activeWatch = existingWatch as GoogleFormWatchRow | null

        if (activeWatch && !needsRenewal(activeWatch.expires_at)) {
          skipped += 1
          continue
        }

        // Watch vivo pero a punto de caducar: renovarlo. Si Google ya no lo
        // conoce, se sigue adelante y se crea uno nuevo.
        if (activeWatch && !isExpired(activeWatch.expires_at)) {
          const renewResponse = await renewGoogleFormsWatch({
            accessToken: refreshed.accessToken,
            googleFormId: form.google_form_id.trim(),
            watchId: activeWatch.watch_id,
          })

          const renewedExpireTime = renewResponse?.expireTime ?? null

          if (renewedExpireTime) {
            const { error: renewUpdateError } = await supabase
              .from('google_form_watches')
              .update({
                expires_at: renewedExpireTime,
                updated_at: new Date().toISOString(),
              })
              .eq('id', activeWatch.id)

            if (renewUpdateError) {
              throw renewUpdateError
            }

            renewed += 1
            continue
          }
        }

        const watchResponse = await createGoogleFormsWatch({
          accessToken: refreshed.accessToken,
          googleFormId: form.google_form_id.trim(),
          topicName: GOOGLE_FORMS_WATCH_TOPIC,
        })

        await markExistingWatchesAsReplaced(supabase, form.id)

        const watchId = watchResponse.id ?? watchResponse.watchId ?? null
        const expireTime = watchResponse.expireTime ?? null

        if (!watchId || !expireTime) {
          throw new Error(`La respuesta de Google no incluyó id o expireTime para ${form.google_form_id}`)
        }

        const { error: insertWatchError } = await supabase
          .from('google_form_watches')
          .insert({
            registration_form_id: form.id,
            google_form_id: form.google_form_id.trim(),
            watch_id: watchId,
            event_type: 'RESPONSES',
            topic_name: GOOGLE_FORMS_WATCH_TOPIC,
            expires_at: expireTime,
            status: 'active',
            updated_at: new Date().toISOString(),
          })

        if (insertWatchError) {
          throw insertWatchError
        }

        created += 1

        if (syncResponsesOnCreate) {
          const syncResult = await syncFormResponses(form.id)
          synced.push({ registration_form_id: form.id, title: form.title, result: syncResult })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)

        errors.push({
          registration_form_id: form.id,
          title: form.title,
          error: message,
        })
      }
    }

    // Una sola pasada de procesado para todo lo recuperado
    let processResult: unknown = null

    if (synced.length > 0) {
      try {
        processResult = await processPendingResponses()
      } catch (err) {
        errors.push({
          registration_form_id: '',
          title: 'google-forms-process-responses',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return jsonResponse({
      ok: errors.length === 0,
      processed: formsRows.length,
      created,
      renewed,
      skipped,
      synced,
      process_result: processResult,
      oauth_google_email: oauthToken.google_email,
      errors,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse(
      {
        ok: false,
        error: message,
      },
      500
    )
  }
})

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}