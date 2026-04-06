import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const INTERNAL_FUNCTIONS_SECRET = Deno.env.get('INTERNAL_FUNCTIONS_SECRET')!
const SUPABASE_FUNCTIONS_BASE_URL = `${SUPABASE_URL}/functions/v1`
const GOOGLE_PUBSUB_VERIFICATION_AUDIENCE =
  Deno.env.get('GOOGLE_PUBSUB_VERIFICATION_AUDIENCE') ||
  `${SUPABASE_URL}/functions/v1/google-forms-pubsub-webhook`

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function verifyPubSubOidcToken(req: Request) {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Falta el header Authorization Bearer.')
  }

  const token = authHeader.slice('Bearer '.length).trim()

  const googleResp = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
  )

  const tokenInfo = await googleResp.json()

  if (!googleResp.ok) {
    throw new Error(`No se pudo verificar el JWT OIDC de Pub/Sub: ${JSON.stringify(tokenInfo)}`)
  }

  if (tokenInfo.aud !== GOOGLE_PUBSUB_VERIFICATION_AUDIENCE) {
    throw new Error(
      `Audience inválida. Esperada: ${GOOGLE_PUBSUB_VERIFICATION_AUDIENCE}. Recibida: ${tokenInfo.aud}`
    )
  }

  return tokenInfo
}

function decodePubSubMessageData(data: string | undefined | null) {
  if (!data) return null
  return atob(data)
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
    }

    const tokenInfo = await verifyPubSubOidcToken(req)
    const body = await req.json()

    const pubsubMessage = body?.message ?? null
    const subscription = body?.subscription ?? null

    if (!pubsubMessage) {
      return jsonResponse(
        { ok: false, error: 'No se recibió message en el body de Pub/Sub.' },
        400
      )
    }

    const messageId = pubsubMessage.messageId ?? null
    const publishTime = pubsubMessage.publishTime ?? null
    const attributes = pubsubMessage.attributes ?? {}
    const rawData = pubsubMessage.data ?? null
    const decodedData = decodePubSubMessageData(rawData)

    const googleFormId = attributes?.formId ?? attributes?.form_id ?? null
    const eventType = attributes?.eventType ?? attributes?.event_type ?? null

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    let registrationFormId: string | null = null

    if (googleFormId) {
      const { data: formRow } = await supabase
        .from('registration_forms')
        .select('id')
        .eq('google_form_id', googleFormId)
        .maybeSingle()

      registrationFormId = formRow?.id ?? null
    }

    const { data: insertedEvent, error: insertError } = await supabase
      .from('google_form_events')
      .insert({
        google_form_id: googleFormId,
        registration_form_id: registrationFormId,
        event_type: eventType,
        pubsub_message_id: messageId,
        pubsub_publish_time: publishTime,
        payload: {
          subscription,
          message: pubsubMessage,
          decoded_data: decodedData,
          oidc_token_info: {
            email: tokenInfo.email ?? null,
            aud: tokenInfo.aud ?? null,
            iss: tokenInfo.iss ?? null,
            sub: tokenInfo.sub ?? null,
          },
        },
        processing_status: 'pending',
        received_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (insertError || !insertedEvent) {
      throw insertError || new Error('No se pudo insertar el evento.')
    }

    let syncResult: unknown = null
    let processResult: unknown = null

    if (googleFormId && eventType === 'RESPONSES') {
      const syncResp = await fetch(`${SUPABASE_FUNCTIONS_BASE_URL}/google-forms-sync-responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': INTERNAL_FUNCTIONS_SECRET,
        },
        body: JSON.stringify({
          google_form_id: googleFormId,
          registration_form_id: registrationFormId,
          last_event_id: insertedEvent.id,
        }),
      })

      const syncJson = await syncResp.json().catch(() => null)
      syncResult = syncJson

      if (!syncResp.ok) {
        await supabase
          .from('google_form_events')
          .update({
            processing_status: 'sync_error',
            processed_at: new Date().toISOString(),
            error: JSON.stringify(syncJson ?? { status: syncResp.status }),
          })
          .eq('id', insertedEvent.id)

        return jsonResponse(
          {
            ok: false,
            stored: true,
            synced: false,
            processed_response: false,
            event_id: insertedEvent.id,
            sync_result: syncJson,
          },
          500
        )
      }

      const processResp = await fetch(`${SUPABASE_FUNCTIONS_BASE_URL}/google-forms-process-responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: 20,
        }),
      })

      const processJson = await processResp.json().catch(() => null)
      processResult = processJson

      if (!processResp.ok) {
        await supabase
          .from('google_form_events')
          .update({
            processing_status: 'process_error',
            processed_at: new Date().toISOString(),
            error: JSON.stringify(processJson ?? { status: processResp.status }),
          })
          .eq('id', insertedEvent.id)

        return jsonResponse(
          {
            ok: false,
            stored: true,
            synced: true,
            processed_response: false,
            event_id: insertedEvent.id,
            sync_result: syncJson,
            process_result: processJson,
          },
          500
        )
      }

      await supabase
        .from('google_form_events')
        .update({
          processing_status: 'processed',
          processed_at: new Date().toISOString(),
          error: null,
        })
        .eq('id', insertedEvent.id)
    } else {
      await supabase
        .from('google_form_events')
        .update({
          processing_status: 'ignored',
          processed_at: new Date().toISOString(),
          error: null,
        })
        .eq('id', insertedEvent.id)
    }

    return jsonResponse({
      ok: true,
      stored: true,
      synced: googleFormId && eventType === 'RESPONSES',
      processed_response: googleFormId && eventType === 'RESPONSES',
      event_id: insertedEvent.id,
      google_form_id: googleFormId,
      event_type: eventType,
      pubsub_message_id: messageId,
      sync_result: syncResult,
      process_result: processResult,
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