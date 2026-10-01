import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APP_BASE_URL = Deno.env.get('APP_BASE_URL')!
const INTERNAL_EMAIL_FUNCTION_SECRET = Deno.env.get('INTERNAL_EMAIL_FUNCTION_SECRET')!
// A quién se avisa cuando el domicilio enviado no coincide con el del DNI.
const DNI_ADDRESS_ALERT_EMAIL = Deno.env.get('DNI_ADDRESS_ALERT_EMAIL') || 'grupojoven@sanpas.es'

type ProcessedResponseRow = {
  id: string
  google_form_id: string
  registration_form_id: string | null
  response_id: string
  raw_response: any
  processing_status: string
}

type RegistrationFormRow = {
  id: string
  title: string
  access_type: 'public' | 'restricted'
  response_public_id_question_id: string | null
  response_name_question_id: string | null
  response_dni_question_id: string | null
  response_gender_question_id: string | null
  response_parent_email_question_id: string | null
  response_school_question_id: string | null
  response_birth_date_question_id: string | null
  response_group_question_id: string | null
  dni_verification_enabled: boolean
  response_address_question_id: string | null
  response_postal_code_question_id: string | null
}

type DniPrefillSnapshotRow = {
  dni: string | null
  address: string | null
  postal_code: string | null
  minor_without_dni: boolean
}

type MismatchRow = {
  field: string
  expected: string
  received: string
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requireEnv(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`)
  }
  return value
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeDni(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

function normalizeGender(value: string | null | undefined): string {
  const normalized = normalizeText(value)

  if (!normalized) return ''

  if (normalized === 'male' || normalized === 'masculino') return 'male'
  if (normalized === 'female' || normalized === 'femenino') return 'female'

  return normalized
}

function normalizeSchool(value: string | null | undefined): string {
  return normalizeText(value)
}

function normalizeGroupName(value: string | null | undefined): string {
  return normalizeText(value)
}

function normalizeBirthDate(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slashMatch) {
    const [, d, m, y] = slashMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  const dashMatch = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (dashMatch) {
    const [, d, m, y] = dashMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  return raw
}

function extractAnswerValue(
  answers: Record<string, any> | null | undefined,
  questionId: string | null | undefined
): string | null {
  if (!answers || !questionId) return null

  const answer = answers[questionId]
  if (!answer) return null

  if (answer.textAnswers?.answers?.length) {
    return (
      answer.textAnswers.answers
        .map((a: any) => a?.value ?? '')
        .filter(Boolean)
        .join(', ')
        .trim() || null
    )
  }

  return null
}

function withLegalDisclaimer(html: string) {
  const disclaimer = `
    <div style="
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #e5e7eb;
      font-size: 10px;
      line-height: 1.4;
      color: #6b7280;
    ">
      <p>
        De conformidad con lo establecido en el Reglamento UE 679/2016 General de Protección de Datos (en adelante, “RGPD”) 
        y la Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales 
        (en adelante, “LOPDGDD”), se les informa que los datos identificativos serán tratados por el Grupo Joven de SAN PASCUAL BAYLÓN, 
        autorizándose el tratamiento de los datos en los términos indicados.
      </p>
      <p>
        En este sentido, se informa a los interesados de que la base que legitima el tratamiento de los datos es el interés legítimo de las Partes, 
        conforme a la LOPDGDD. Los datos personales de los firmantes serán conservados hasta que el interesado manifieste de forma expresa su deseo 
        de supresión o limitación. Sus datos serán conservados debidamente, así como bloqueados y/o en su caso suprimidos, siempre que no se esté 
        realizando la actividad de tiempo libre, así como para el cumplimiento de otras obligaciones legales.
      </p>
      <p>
        En cualquier momento, los firmantes podrán ejercer los derechos que les son conferidos por la normativa aplicable en materia de protección de datos 
        (acceso, rectificación, supresión, limitación, portabilidad, oposición y a no ser objeto de decisiones individuales automatizadas) dirigiéndose al 
        responsable del tratamiento, el Grupo Joven de SAN PASCUAL BAYLÓN, incluyendo en la comunicación la referencia “Protección de Datos de Carácter Personal”, 
        a través del correo: grupojoven@sanpas.es.
      </p>
      <p>
        Si para las actividades de SAN PASCUAL BAYLÓN se tuviera la necesidad de acceder a datos de carácter personal, este se compromete a respetar y cumplir 
        la legislación vigente, especialmente el RGPD y la LOPDGDD.
      </p>
      <p>
        Este mensaje se dirige exclusivamente a su destinatario y contiene información confidencial. Su divulgación, copia o utilización no autorizada es 
        contraria a la ley. Si ha recibido este mensaje por error, notifíquelo y elimínelo.
      </p>
    </div>
  `

  return `
    ${html}
    ${disclaimer}
  `
}


async function updateProcessedResponse(
  supabase: ReturnType<typeof createClient>,
  id: string,
  processingStatus: string,
  error: string | null,
  options?: {
    enqueueDeletion?: boolean
    clearDeletionState?: boolean
  }
) {
  const payload: Record<string, any> = {
    processing_status: processingStatus,
    processed_at: new Date().toISOString(),
    error,
  }

  if (options?.enqueueDeletion) {
    payload.deletion_status = 'pending_delete'
    payload.deletion_requested_at = new Date().toISOString()
    payload.deletion_attempted_at = null
    payload.deleted_at = null
    payload.deletion_error = null
  }

  if (options?.clearDeletionState) {
    payload.deletion_status = 'not_requested'
    payload.deletion_requested_at = null
    payload.deletion_attempted_at = null
    payload.deleted_at = null
    payload.deletion_error = null
  }

  const { error: updateError } = await supabase
    .from('google_form_processed_responses')
    .update(payload)
    .eq('id', id)

  if (updateError) {
    throw updateError
  }
}

async function sendPolicyEmail(params: {
  to: string
  subject: string
  html: string
}) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-form-policy-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-function-secret': INTERNAL_EMAIL_FUNCTION_SECRET,
    },
    body: JSON.stringify(params),
  })

  const json = await resp.json().catch(() => null)

  if (!resp.ok) {
    throw new Error(`Error enviando correo a ${params.to}: ${resp.status} ${JSON.stringify(json)}`)
  }
}

async function sendPolicyEmailWithFallback(params: {
  primaryTo: string
  fallbackTo?: string | null
  subject: string
  html: string
}) {
  const primaryTo = normalizeEmail(params.primaryTo)
  const fallbackTo = normalizeEmail(params.fallbackTo)

  if (!primaryTo) {
    throw new Error('No hay destinatario principal para enviar el correo.')
  }

  try {
    await sendPolicyEmail({
      to: primaryTo,
      subject: params.subject,
      html: params.html,
    })

    return {
      deliveredTo: primaryTo,
      usedFallback: false,
    }
  } catch (primaryError) {
    const sameRecipient = fallbackTo && fallbackTo === primaryTo

    if (!fallbackTo || sameRecipient) {
      throw new Error(
        `Fallo enviando al destinatario principal (${primaryTo}) y no existe un fallback distinto utilizable. ` +
          `Detalle: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`
      )
    }

    try {
      await sendPolicyEmail({
        to: fallbackTo,
        subject: params.subject,
        html: params.html,
      })

      return {
        deliveredTo: fallbackTo,
        usedFallback: true,
      }
    } catch (fallbackError) {
      throw new Error(
        `Fallo enviando al destinatario principal (${primaryTo}) y también al fallback (${fallbackTo}). ` +
          `Primary: ${primaryError instanceof Error ? primaryError.message : String(primaryError)} | ` +
          `Fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
      )
    }
  }
}

function escapeHtml(value: string) {
  return (value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildPublicUnverifiedEmail(contactEmail: string) {
  const subject = 'Incidencia en formulario'

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <h2>Incidencia en tu inscripción</h2>
      <p>Hola,</p>
      <p>
        Hemos detectado que el correo introducido como <strong>EMAIL DE CONTACTO</strong> en tu inscripción
        (<strong>${escapeHtml(contactEmail)}</strong>) no figura como verificado en nuestro sistema.
      </p>
      <p>
        Por este motivo, sospechamos que se ha intentado acceder al formulario saltándose el control de acceso,
        algo que vulnera nuestra política de inscripciones.
      </p>
      <p>
        En consecuencia, la inscripción enviada va a ser eliminada de forma automática.
      </p>
      <p>
        Este mensaje ha sido enviado automáticamente. No debes responder a este correo,
        ya que la dirección desde la que se envía no está supervisada y nadie leerá tu respuesta.
      </p>
      <p>
        Si crees que se trata de un error y que el correo introducido sí estaba verificado,
        debes escribir a <strong>grupojoven@sanpas.es</strong> explicando lo sucedido y adjuntando una
        captura de pantalla de la página de verificación exitosa.
      </p>
      <p>
        Portal de inscripciones:
        <a href="${escapeHtml(APP_BASE_URL)}">${escapeHtml(APP_BASE_URL)}</a>
      </p>
      <p>Un saludo.</p>
    </div>
  `

  return { subject, html }
}

function buildRestrictedUnknownIdEmail(publicId: string) {
  const subject = 'Incidencia en formulario'

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <h2>Incidencia en tu inscripción</h2>
      <p>Hola,</p>
      <p>
        Hemos detectado que en la inscripción enviada se ha introducido un identificador que no existe en nuestra base de datos.
      </p>
      <p>
        Por este motivo, la respuesta enviada va a ser eliminada de forma automática.
      </p>
      <p>
        Si crees que se trata de un error, debes ponerte en contacto con los catequistas de tu hijo
        o con el coordinador del grupo.
      </p>
      <p>
        Portal de inscripciones:
        <a href="${escapeHtml(APP_BASE_URL)}">${escapeHtml(APP_BASE_URL)}</a>
      </p>
      <p>Un saludo.</p>
    </div>
  `

  return { subject, html }
}

function buildRestrictedMismatchEmail(publicId: string, mismatches: MismatchRow[]) {
  const subject = 'Incidencia en formulario'

  const mismatchHtml = mismatches
    .map(
      (m) => `
        <li>
          <strong>${escapeHtml(m.field)}</strong>:
          esperado "<strong>${escapeHtml(m.expected)}</strong>",
          recibido "<strong>${escapeHtml(m.received)}</strong>"
        </li>
      `
    )
    .join('')

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <h2>Incidencia en tu inscripción</h2>
      <p>Hola,</p>
      <p>
        Hemos detectado que en la inscripción enviada se han modificado datos asociados al identificador
        <strong>${escapeHtml(publicId)}</strong>.
      </p>
      <p>
        Esto vulnera la política de inscripciones, por lo que la respuesta enviada va a ser eliminada de forma automática
        y será necesario repetir la inscripción sin modificar los datos para que figure correctamente.
      </p>
      <p>Datos que no coinciden:</p>
      <ul>
        ${mismatchHtml}
      </ul>
      <p>
        Si necesitas modificar algún dato, debes avisar a los catequistas de tu hijo o al coordinador del grupo.
        No debes realizar modificaciones directamente en el formulario.
      </p>
      <p>
        Portal de inscripciones:
        <a href="${escapeHtml(APP_BASE_URL)}">${escapeHtml(APP_BASE_URL)}</a>
      </p>
      <p>Un saludo.</p>
    </div>
  `

  return { subject, html }
}

// ---------------------------------------------------------------------
// Comparación del domicilio prerrellenado desde el DNI con el enviado
// ---------------------------------------------------------------------

/**
 * Para decidir si "es lo mismo" se ignoran mayúsculas, tildes, signos y
 * espacios: no tiene sentido avisar porque alguien haya pasado VALÈNCIA a
 * VALENCIA o quitado una coma. En el registro se guardan los textos tal cual.
 */
function normalizeAddress(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

function normalizePostalCode(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

function normalizeAlphanumeric(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Todo el texto respondido, para buscar en él el DNI prerrellenado. */
function allAnswersText(answers: Record<string, any>): string {
  return Object.values(answers ?? {})
    .flatMap((answer: any) => answer?.textAnswers?.answers ?? [])
    .map((a: any) => normalizeAlphanumeric(a?.value))
    .join('|')
}

type AddressComparison = {
  snapshot: DniPrefillSnapshotRow
  status: 'match' | 'mismatch' | 'not_compared'
  addressReceived: string | null
  addressMatches: boolean | null
  postalCodeReceived: string | null
  postalCodeMatches: boolean | null
}

function compareWithSnapshot(
  snapshot: DniPrefillSnapshotRow,
  form: RegistrationFormRow,
  answers: Record<string, any>
): AddressComparison {
  const addressReceived = extractAnswerValue(answers, form.response_address_question_id)
  const postalCodeReceived = extractAnswerValue(answers, form.response_postal_code_question_id)

  // Solo se compara lo que se prerrellenó y cuya pregunta está configurada.
  // Una respuesta vacía donde había dato prerrellenado cuenta como cambio.
  const addressMatches =
    form.response_address_question_id && snapshot.address
      ? normalizeAddress(addressReceived) === normalizeAddress(snapshot.address)
      : null

  const postalCodeMatches =
    form.response_postal_code_question_id && snapshot.postal_code
      ? normalizePostalCode(postalCodeReceived) === normalizePostalCode(snapshot.postal_code)
      : null

  const status =
    addressMatches === false || postalCodeMatches === false
      ? 'mismatch'
      : addressMatches === null && postalCodeMatches === null
        ? 'not_compared'
        : 'match'

  return {
    snapshot,
    status,
    addressReceived,
    addressMatches,
    postalCodeReceived,
    postalCodeMatches,
  }
}

/**
 * Busca qué prerrelleno corresponde a esta respuesta y la compara con él.
 *
 * La respuesta y el prerrelleno se enlazan por formulario + EMAIL DE
 * CONTACTO (que ya está verificado a estas alturas). Si con ese email se
 * abrieron varios enlaces (hermanos, o alguien que repitió la verificación),
 * se prefieren los cuyo DNI aparece en la respuesta, y entre ellos basta con
 * que uno coincida.
 */
async function compareDniAddress(
  supabase: ReturnType<typeof createClient>,
  row: ProcessedResponseRow,
  form: RegistrationFormRow,
  contactEmail: string,
  respondentEmail: string
): Promise<AddressComparison['status'] | 'no_snapshot' | null> {
  if (!form.dni_verification_enabled) return null
  if (!form.response_address_question_id && !form.response_postal_code_question_id) return null

  const answers = row.raw_response?.answers ?? {}
  const submittedAt = row.raw_response?.lastSubmittedTime ?? row.raw_response?.createTime ?? null

  const { data: snapshots, error: snapshotsError } = await supabase
    .from('dni_prefill_snapshots')
    .select('dni, address, postal_code, minor_without_dni')
    .eq('registration_form_id', form.id)
    .eq('normalized_email', contactEmail)
    .order('created_at', { ascending: false })
    .limit(20)

  if (snapshotsError) {
    throw snapshotsError
  }

  const candidates = (snapshots ?? []) as DniPrefillSnapshotRow[]
  const answersText = allAnswersText(answers)
  const sameDni = candidates.filter((snapshot) => {
    const dni = normalizeAlphanumeric(snapshot.dni)
    return dni.length >= 8 && answersText.includes(dni)
  })
  const pool = sameDni.length > 0 ? sameDni : candidates
  const comparisons = pool.map((snapshot) => compareWithSnapshot(snapshot, form, answers))

  const best =
    comparisons.find((c) => c.status === 'match') ??
    comparisons.find((c) => c.status === 'not_compared') ??
    comparisons[0] ??
    null

  const status = best?.status ?? 'no_snapshot'

  const { data: inserted, error: insertError } = await supabase
    .from('dni_address_comparisons')
    .insert({
      registration_form_id: form.id,
      google_form_id: row.google_form_id,
      response_id: row.response_id,
      submitted_at: submittedAt,
      contact_email: contactEmail,
      dni: best?.snapshot.dni ?? null,
      minor_without_dni: best?.snapshot.minor_without_dni ?? null,
      status,
      address_expected: best?.snapshot.address ?? null,
      address_received: best
        ? best.addressReceived
        : extractAnswerValue(answers, form.response_address_question_id),
      address_matches: best?.addressMatches ?? null,
      postal_code_expected: best?.snapshot.postal_code ?? null,
      postal_code_received: best
        ? best.postalCodeReceived
        : extractAnswerValue(answers, form.response_postal_code_question_id),
      postal_code_matches: best?.postalCodeMatches ?? null,
    })
    .select('id')
    .single()

  if (insertError) {
    // Ya se comparó en una pasada anterior (y, si tocaba, ya se avisó).
    if (insertError.code === '23505') return status
    throw insertError
  }

  if (status !== 'mismatch' || !best) return status

  const errors: string[] = []
  const notifiedAt: Record<string, string> = {}

  try {
    const adminEmail = buildDniAddressAdminEmail(form.title, contactEmail, submittedAt, best)
    await sendPolicyEmail({
      to: DNI_ADDRESS_ALERT_EMAIL,
      subject: adminEmail.subject,
      html: adminEmail.html,
    })
    notifiedAt.admin_notified_at = new Date().toISOString()
  } catch (err) {
    errors.push(`Administración: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const contactEmailContent = buildDniAddressContactEmail(form.title, best)
    await sendPolicyEmailWithFallback({
      primaryTo: contactEmail,
      fallbackTo: respondentEmail,
      subject: contactEmailContent.subject,
      html: withLegalDisclaimer(contactEmailContent.html),
    })
    notifiedAt.contact_notified_at = new Date().toISOString()
  } catch (err) {
    errors.push(`Contacto: ${err instanceof Error ? err.message : String(err)}`)
  }

  const { error: updateError } = await supabase
    .from('dni_address_comparisons')
    .update({
      ...notifiedAt,
      notification_error: errors.length > 0 ? errors.join(' | ') : null,
    })
    .eq('id', inserted.id)

  if (updateError) {
    console.error('Error guardando el estado de los avisos de domicilio:', updateError)
  }

  return status
}

function dniAddressMismatchListHtml(comparison: AddressComparison) {
  const rows: MismatchRow[] = []

  if (comparison.addressMatches === false) {
    rows.push({
      field: 'DIRECCIÓN DE LA RESIDENCIA HABITUAL',
      expected: comparison.snapshot.address ?? '',
      received: comparison.addressReceived ?? '',
    })
  }

  if (comparison.postalCodeMatches === false) {
    rows.push({
      field: 'CÓDIGO POSTAL',
      expected: comparison.snapshot.postal_code ?? '',
      received: comparison.postalCodeReceived ?? '',
    })
  }

  return rows
    .map(
      (m) => `
        <li>
          <strong>${escapeHtml(m.field)}</strong>:
          leído del DNI "<strong>${escapeHtml(m.expected)}</strong>",
          indicado en el formulario "<strong>${escapeHtml(m.received || '(en blanco)')}</strong>"
        </li>
      `
    )
    .join('')
}

function buildDniAddressContactEmail(formTitle: string, comparison: AddressComparison) {
  const subject = 'Revisión de tu inscripción'

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <h2>Revisión de tu inscripción</h2>
      <p>Hola,</p>
      <p>
        Hemos recibido tu inscripción en <strong>${escapeHtml(formTitle)}</strong>. Al revisarla,
        hemos visto que el domicilio indicado en el formulario no coincide con el que se leyó del DNI
        durante la verificación:
      </p>
      <ul>
        ${dniAddressMismatchListHtml(comparison)}
      </ul>
      <p>
        Tu inscripción <strong>no se ha eliminado</strong>, pero va a ser revisada manualmente.
        Es posible que nos pongamos de nuevo en contacto contigo para solicitarte más información.
      </p>
      <p>
        Este mensaje ha sido enviado automáticamente. No debes responder a este correo,
        ya que la dirección desde la que se envía no está supervisada y nadie leerá tu respuesta.
        Si quieres aclarar algo, escribe a <strong>grupojoven@sanpas.es</strong>.
      </p>
      <p>
        Portal de inscripciones:
        <a href="${escapeHtml(APP_BASE_URL)}">${escapeHtml(APP_BASE_URL)}</a>
      </p>
      <p>Un saludo.</p>
    </div>
  `

  return { subject, html }
}

function buildDniAddressAdminEmail(
  formTitle: string,
  contactEmail: string,
  submittedAt: string | null,
  comparison: AddressComparison
) {
  const subject = `Domicilio modificado en "${formTitle}"`
  const submittedText = submittedAt
    ? new Date(submittedAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })
    : 'desconocida'
  const dniText = comparison.snapshot.minor_without_dni
    ? `${comparison.snapshot.dni ?? ''} (de un progenitor: menor sin DNI)`
    : comparison.snapshot.dni ?? ''

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <h2>Domicilio distinto al del DNI</h2>
      <p>
        Una respuesta del formulario <strong>${escapeHtml(formTitle)}</strong> tiene un domicilio
        distinto del que se prerrellenó a partir del DNI.
      </p>
      <ul>
        <li><strong>EMAIL DE CONTACTO</strong>: ${escapeHtml(contactEmail)}</li>
        <li><strong>DNI prerrellenado</strong>: ${escapeHtml(dniText)}</li>
        <li><strong>Enviada</strong>: ${escapeHtml(submittedText)}</li>
      </ul>
      <p>Datos que no coinciden:</p>
      <ul>
        ${dniAddressMismatchListHtml(comparison)}
      </ul>
      <p>
        La respuesta se mantiene y a la familia se le ha avisado de que se revisará manualmente.
        Puedes ver todas las discrepancias y marcarlas como revisadas en el panel de administración:
        <a href="${escapeHtml(APP_BASE_URL)}/admin">${escapeHtml(APP_BASE_URL)}/admin</a>
      </p>
    </div>
  `

  return { subject, html }
}

Deno.serve(async (req) => {
  try {
    requireEnv(SUPABASE_URL, 'SUPABASE_URL')
    requireEnv(SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY')
    requireEnv(APP_BASE_URL, 'APP_BASE_URL')
    requireEnv(INTERNAL_EMAIL_FUNCTION_SECRET, 'INTERNAL_EMAIL_FUNCTION_SECRET')

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const limit = typeof body?.limit === 'number' && body.limit > 0 ? body.limit : 20

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: responses, error: responsesError } = await supabase
      .rpc('claim_pending_google_form_processed_responses', {
        p_limit: limit,
      })

    if (responsesError) {
      throw responsesError
    }

    const rows = (responses ?? []) as ProcessedResponseRow[]

    let processed = 0
    let validatedOk = 0
    let publicUnverified = 0
    let restrictedUnknownId = 0
    let restrictedMismatch = 0
    let processingErrors = 0
    let queuedForDeletion = 0
    let dniAddressMismatch = 0

    for (const row of rows) {
      try {
        if (!row.registration_form_id) {
          throw new Error('La respuesta no tiene registration_form_id.')
        }

        const respondentEmail = normalizeEmail(row.raw_response?.respondentEmail)

        const { data: formConfig, error: formConfigError } = await supabase
          .from('registration_forms')
          .select(`
            id,
            title,
            access_type,
            response_public_id_question_id,
            response_name_question_id,
            response_dni_question_id,
            response_gender_question_id,
            response_parent_email_question_id,
            response_school_question_id,
            response_birth_date_question_id,
            response_group_question_id,
            dni_verification_enabled,
            response_address_question_id,
            response_postal_code_question_id
          `)
          .eq('id', row.registration_form_id)
          .single()

        if (formConfigError || !formConfig) {
          throw new Error('No se pudo cargar la configuración del formulario.')
        }

        const form = formConfig as RegistrationFormRow
        const answers = row.raw_response?.answers ?? {}

        if (form.access_type === 'public') {
          const contactEmailRaw = extractAnswerValue(answers, form.response_parent_email_question_id)
          const normalizedEmail = normalizeEmail(contactEmailRaw)

          if (!normalizedEmail) {
            throw new Error('No se ha podido extraer EMAIL DE CONTACTO en un formulario público.')
          }

          const { data: verificationRow, error: verificationError } = await supabase
            .from('parent_email_verifications')
            .select('normalized_email')
            .eq('normalized_email', normalizedEmail)
            .maybeSingle()

          if (verificationError) {
            throw verificationError
          }

          if (verificationRow) {
            // Un fallo al comparar el domicilio no debe invalidar una
            // inscripción correcta: se registra y se sigue.
            try {
              const comparison = await compareDniAddress(supabase, row, form, normalizedEmail, respondentEmail)
              if (comparison === 'mismatch') dniAddressMismatch += 1
            } catch (comparisonError) {
              console.error(
                `Error comparando el domicilio de la respuesta ${row.response_id}:`,
                comparisonError
              )
            }

            await updateProcessedResponse(
              supabase,
              row.id,
              'validated_ok',
              null,
              { clearDeletionState: true }
            )
            validatedOk += 1
            processed += 1
            continue
          }

          const emailContent = buildPublicUnverifiedEmail(normalizedEmail)

          await sendPolicyEmailWithFallback({
            primaryTo: normalizedEmail,
            fallbackTo: respondentEmail,
            subject: emailContent.subject,
            html: withLegalDisclaimer(emailContent.html),
          })

          await updateProcessedResponse(
            supabase,
            row.id,
            'email_sent_public_unverified',
            null,
            { enqueueDeletion: true }
          )

          publicUnverified += 1
          queuedForDeletion += 1
          processed += 1
          continue
        }

        if (form.access_type === 'restricted') {
          const publicId = (extractAnswerValue(answers, form.response_public_id_question_id) ?? '').trim()
          const inputName = extractAnswerValue(answers, form.response_name_question_id) ?? ''
          const inputDni = extractAnswerValue(answers, form.response_dni_question_id) ?? ''
          const inputGender = extractAnswerValue(answers, form.response_gender_question_id) ?? ''
          const inputParentEmail = extractAnswerValue(answers, form.response_parent_email_question_id) ?? ''
          const inputSchool = extractAnswerValue(answers, form.response_school_question_id) ?? ''
          const inputBirthDate = extractAnswerValue(answers, form.response_birth_date_question_id) ?? ''
          const inputGroupName = extractAnswerValue(answers, form.response_group_question_id) ?? ''

          const normalizedParentEmail = normalizeEmail(inputParentEmail)

          if (!publicId) {
            throw new Error('No se ha podido extraer IDENTIFICADOR en un formulario restricted.')
          }

          if (!normalizedParentEmail) {
            throw new Error('No se ha podido extraer EMAIL DE CONTACTO en un formulario restricted.')
          }

          const { data: accessRow, error: accessError } = await supabase
            .from('student_public_access')
            .select('student_id, public_id')
            .eq('public_id', publicId)
            .maybeSingle()

          if (accessError) {
            throw accessError
          }

          if (!accessRow) {
            const emailContent = buildRestrictedUnknownIdEmail()

            await sendPolicyEmailWithFallback({
              primaryTo: normalizedParentEmail,
              fallbackTo: respondentEmail,
              subject: emailContent.subject,
              html: withLegalDisclaimer(emailContent.html),
            })

            await updateProcessedResponse(
              supabase,
              row.id,
              'email_sent_restricted_unknown_id',
              null,
              { enqueueDeletion: true }
            )

            restrictedUnknownId += 1
            queuedForDeletion += 1
            processed += 1
            continue
          }

          const { data: studentRow, error: studentError } = await supabase
            .from('students')
            .select('id, name, dni, gender, parent_email, school, birth_date, group_id')
            .eq('id', accessRow.student_id)
            .single()

          if (studentError || !studentRow) {
            throw new Error(`No se ha encontrado el alumno asociado al identificador ${publicId}.`)
          }

          const { data: groupRow, error: groupError } = await supabase
            .from('groups')
            .select('id, name')
            .eq('id', studentRow.group_id)
            .maybeSingle()

          if (groupError) {
            throw groupError
          }

          const expectedGroupName = groupRow?.name ?? ''
          const mismatches: MismatchRow[] = []

          if (normalizeText(inputName) !== normalizeText(studentRow.name)) {
            mismatches.push({
              field: 'NOMBRE COMPLETO',
              expected: studentRow.name ?? '',
              received: inputName,
            })
          }

          if (normalizeDni(inputDni) !== normalizeDni(studentRow.dni)) {
            mismatches.push({
              field: 'DNI',
              expected: studentRow.dni ?? '',
              received: inputDni,
            })
          }

          if (normalizeGender(inputGender) !== normalizeGender(studentRow.gender)) {
            mismatches.push({
              field: 'GÉNERO',
              expected: studentRow.gender ?? '',
              received: inputGender,
            })
          }

          if (normalizeEmail(inputParentEmail) !== normalizeEmail(studentRow.parent_email)) {
            mismatches.push({
              field: 'EMAIL DE CONTACTO',
              expected: studentRow.parent_email ?? '',
              received: inputParentEmail,
            })
          }

          if (normalizeSchool(inputSchool) !== normalizeSchool(studentRow.school)) {
            mismatches.push({
              field: 'COLEGIO',
              expected: studentRow.school ?? '',
              received: inputSchool,
            })
          }

          if (normalizeBirthDate(inputBirthDate) !== normalizeBirthDate(studentRow.birth_date)) {
            mismatches.push({
              field: 'FECHA DE NACIMIENTO',
              expected: studentRow.birth_date ?? '',
              received: inputBirthDate,
            })
          }

          if (normalizeGroupName(inputGroupName) !== normalizeGroupName(expectedGroupName)) {
            mismatches.push({
              field: 'GRUPO',
              expected: expectedGroupName,
              received: inputGroupName,
            })
          }

          if (mismatches.length === 0) {
            await updateProcessedResponse(
              supabase,
              row.id,
              'validated_ok',
              null,
              { clearDeletionState: true }
            )
            validatedOk += 1
            processed += 1
            continue
          }

          const emailContent = buildRestrictedMismatchEmail(publicId, mismatches)

          await sendPolicyEmailWithFallback({
            primaryTo: normalizedParentEmail,
            fallbackTo: respondentEmail,
            subject: emailContent.subject,
            html: withLegalDisclaimer(emailContent.html),
          })

          await updateProcessedResponse(
            supabase,
            row.id,
            'email_sent_restricted_data_mismatch',
            null,
            { enqueueDeletion: true }
          )

          restrictedMismatch += 1
          queuedForDeletion += 1
          processed += 1
          continue
        }

        throw new Error(`Tipo de acceso no soportado: ${form.access_type}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)

        await updateProcessedResponse(
          supabase,
          row.id,
          'processing_error',
          message
        )

        processingErrors += 1
      }
    }

    return jsonResponse({
      ok: true,
      processed,
      validated_ok: validatedOk,
      email_sent_public_unverified: publicUnverified,
      email_sent_restricted_unknown_id: restrictedUnknownId,
      email_sent_restricted_data_mismatch: restrictedMismatch,
      queued_for_deletion: queuedForDeletion,
      dni_address_mismatch: dniAddressMismatch,
      processing_error: processingErrors,
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