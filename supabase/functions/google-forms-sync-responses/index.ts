import { createClient } from 'npm:@supabase/supabase-js@2'

type GoogleOAuthTokenRow = {
  provider: string
  google_email: string | null
  access_token: string | null
  refresh_token: string
  scope: string | null
  token_type: string | null
  expiry_date: string | null
}

type RegistrationFormRow = {
  id: string
  google_form_id: string | null
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID')!
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET')!
const INTERNAL_FUNCTIONS_SECRET = Deno.env.get('INTERNAL_FUNCTIONS_SECRET')!

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_FORMS_API_BASE = 'https://forms.googleapis.com/v1'


function requireEnv(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`)
  }
  return value
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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

async function listFormResponses(accessToken: string, googleFormId: string) {
  const resp = await fetch(
    `${GOOGLE_FORMS_API_BASE}/forms/${encodeURIComponent(googleFormId)}/responses`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  const json = await resp.json()

  if (!resp.ok) {
    throw new Error(
      `Error listando respuestas para ${googleFormId}: ${resp.status} ${JSON.stringify(json)}`
    )
  }

  return json.responses ?? []
}

Deno.serve(async (req) => {
  try {
    requireEnv(SUPABASE_URL, 'SUPABASE_URL')
    requireEnv(SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY')
    requireEnv(GOOGLE_OAUTH_CLIENT_ID, 'GOOGLE_OAUTH_CLIENT_ID')
    requireEnv(GOOGLE_OAUTH_CLIENT_SECRET, 'GOOGLE_OAUTH_CLIENT_SECRET')
    const internalSecret = req.headers.get('x-internal-secret')
    if (!INTERNAL_FUNCTIONS_SECRET || internalSecret !== INTERNAL_FUNCTIONS_SECRET) {
      return jsonResponse(
        {
          ok: false,
          error: 'Unauthorized',
        },
        401
      )
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const googleFormIdFromBody = typeof body?.google_form_id === 'string' ? body.google_form_id.trim() : ''
    const registrationFormIdFromBody = typeof body?.registration_form_id === 'string' ? body.registration_form_id.trim() : ''
    const lastEventIdFromBody = typeof body?.last_event_id === 'string' ? body.last_event_id.trim() : ''

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

    await supabase
      .from('google_oauth_tokens')
      .update({
        access_token: refreshed.accessToken,
        scope: refreshed.scope,
        token_type: refreshed.tokenType,
        expiry_date: newExpiryDate,
        updated_at: new Date().toISOString(),
      })
      .eq('provider', 'google_forms')

    let registrationFormId: string | null = registrationFormIdFromBody || null
    let googleFormId: string | null = googleFormIdFromBody || null

    if (!googleFormId && registrationFormId) {
      const { data: formRow, error: formError } = await supabase
        .from('registration_forms')
        .select('id, google_form_id')
        .eq('id', registrationFormId)
        .single()

      if (formError || !formRow?.google_form_id) {
        throw new Error('No se pudo resolver google_form_id desde registration_form_id.')
      }

      googleFormId = formRow.google_form_id
    }

    if (!registrationFormId && googleFormId) {
      const { data: formRow, error: formError } = await supabase
        .from('registration_forms')
        .select('id, google_form_id')
        .eq('google_form_id', googleFormId)
        .maybeSingle()

      if (formError) {
        throw formError
      }

      registrationFormId = formRow?.id ?? null
    }

    if (!googleFormId) {
      throw new Error('Debes enviar google_form_id o registration_form_id.')
    }

    const responses = await listFormResponses(refreshed.accessToken, googleFormId)

    let inserted = 0
    let alreadyExisting = 0

    for (const response of responses) {
      const responseId = response.responseId ?? null
      if (!responseId) continue

      const submittedAt = response.lastSubmittedTime ?? null

      const { data: upsertedRows, error: upsertError } = await supabase
        .from('google_form_processed_responses')
        .upsert(
          {
            google_form_id: googleFormId,
            response_id: responseId,
            registration_form_id: registrationFormId,
            submitted_at: submittedAt,
            first_seen_at: new Date().toISOString(),
            processed_at: null,
            processing_started_at: null,
            processing_status: 'pending',
            raw_response: response,
            error: null,
            last_event_id: lastEventIdFromBody || null,
          },
          {
            onConflict: 'google_form_id,response_id',
            ignoreDuplicates: true,
          }
        )
        .select('id')

      if (upsertError) {
        throw upsertError
      }

      if ((upsertedRows ?? []).length > 0) {
        inserted += 1
      } else {
        alreadyExisting += 1
      }
    }

    return jsonResponse({
      ok: true,
      google_form_id: googleFormId,
      registration_form_id: registrationFormId,
      fetched: responses.length,
      inserted,
      already_existing: alreadyExisting,
      oauth_google_email: oauthToken.google_email,
    })
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      500
    )
  }
})