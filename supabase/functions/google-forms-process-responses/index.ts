import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APP_BASE_URL = Deno.env.get('APP_BASE_URL')!
const INTERNAL_EMAIL_FUNCTION_SECRET = Deno.env.get('INTERNAL_EMAIL_FUNCTION_SECRET')!

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
            response_group_question_id
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