import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const INTERNAL_SECRET_APPS_SCRIPT = Deno.env.get('INTERNAL_SECRET_APPS_SCRIPT')!

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requireInternalSecret(req: Request) {
  const secret = req.headers.get('x-internal-secret')
  if (!secret || secret !== INTERNAL_SECRET_APPS_SCRIPT) {
    throw new Error('Unauthorized')
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
    }

    requireInternalSecret(req)

    const body = await req.json().catch(() => ({}))
    const action = body?.action

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    if (action === 'claim') {
      const limit =
        typeof body?.limit === 'number' && body.limit > 0 && body.limit <= 100
          ? body.limit
          : 20

      const { data, error } = await supabase
        .from('google_form_processed_responses')
        .select('id, google_form_id, response_id, raw_response, processing_status, deletion_status')
        .in('processing_status', [
          'email_sent_public_unverified',
          'email_sent_restricted_unknown_id',
          'email_sent_restricted_data_mismatch',
        ])
        .eq('deletion_status', 'pending_delete')
        .order('deletion_requested_at', { ascending: true })
        .limit(limit)

      if (error) {
        throw error
      }

      return jsonResponse({
        ok: true,
        items: data ?? [],
      })
    }

    if (action === 'report') {
      const itemId = body?.id
      const success = body?.success === true
      const errorMessage =
        typeof body?.error === 'string' ? body.error.slice(0, 4000) : null

      if (!itemId) {
        return jsonResponse({ ok: false, error: 'Falta id' }, 400)
      }

      if (success) {
        const { error } = await supabase
          .from('google_form_processed_responses')
          .update({
            deletion_status: 'deleted',
            deletion_attempted_at: new Date().toISOString(),
            deleted_at: new Date().toISOString(),
            deletion_error: null,
          })
          .eq('id', itemId)

        if (error) {
          throw error
        }

        return jsonResponse({ ok: true, updated: 'deleted' })
      }

      const { error } = await supabase
        .from('google_form_processed_responses')
        .update({
          deletion_status: 'delete_error',
          deletion_attempted_at: new Date().toISOString(),
          deletion_error: errorMessage ?? 'Error desconocido al borrar respuesta',
        })
        .eq('id', itemId)

      if (error) {
        throw error
      }

      return jsonResponse({ ok: true, updated: 'delete_error' })
    }

    return jsonResponse({ ok: false, error: 'Acción no soportada' }, 400)
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