export interface RegistrationForm {
  id: string;
  title: string;
  description: string | null;
  url: string;
  circular_url: string | null;
  authorization_url: string | null;
  active: boolean;
  access_type: 'public' | 'restricted';
  open_date: string | null;
  close_date: string | null;
  created_at: string;
  group_ids: string[];
  prefill_public_id_entry: string | null;
  prefill_name_entry: string | null;
  prefill_dni_entry: string | null;
  prefill_gender_entry: string | null;
  prefill_parent_email_entry: string | null;
  prefill_school_entry: string | null;
  prefill_birth_date_entry: string | null;
  prefill_group_entry: string | null;
  prefill_address_entry: string | null;
  prefill_postal_code_entry: string | null;
  prefill_course_entry: string | null;
  prefill_preconfirmation_first_course_option: string | null;
  prefill_preconfirmation_second_course_option: string | null;
  prefill_confirmation_first_course_option: string | null;
  prefill_confirmation_second_course_option: string | null;
  dni_verification_enabled: boolean;
  google_form_id: string | null;
  google_form_watch_enabled: boolean;
  response_public_id_question_id: string | null;
  response_name_question_id: string | null;
  response_dni_question_id: string | null;
  response_gender_question_id: string | null;
  response_parent_email_question_id: string | null;
  response_school_question_id: string | null;
  response_birth_date_question_id: string | null;
  response_group_question_id: string | null;
}

export interface EditingForm {
  id?: string;
  title: string;
  description: string;
  url: string;
  circular_url: string;
  authorization_url: string;
  active: boolean;
  access_type: 'public' | 'restricted';
  open_date: string;
  close_date: string;
  group_ids: string[];
  prefill_public_id_entry: string;
  prefill_name_entry: string;
  prefill_dni_entry: string;
  prefill_gender_entry: string;
  prefill_parent_email_entry: string;
  prefill_school_entry: string;
  prefill_birth_date_entry: string;
  prefill_group_entry: string;
  prefill_address_entry: string;
  prefill_postal_code_entry: string;
  prefill_course_entry: string;
  prefill_preconfirmation_first_course_option: string;
  prefill_preconfirmation_second_course_option: string;
  prefill_confirmation_first_course_option: string;
  prefill_confirmation_second_course_option: string;
  dni_verification_enabled: boolean;
  google_form_id: string;
  google_form_edit_url: string;
  google_form_watch_enabled: boolean;
  response_public_id_question_id: string;
  response_name_question_id: string;
  response_dni_question_id: string;
  response_gender_question_id: string;
  response_parent_email_question_id: string;
  response_school_question_id: string;
  response_birth_date_question_id: string;
  response_group_question_id: string;
}

export interface GroupOption {
  id: string;
  name: string;
};

export interface StudentAccessRow {
  id: string;
  name: string;
  dni: string;
  gender: string;
  email: string | null;
  parent_email: string;
  school: string;
  group_id: string;
  group_name: string;
  public_id: string | null;
};


export interface PublicHomeForm {
  id: string;
  title: string;
  description: string | null;
  url: string;
  circular_url: string | null;
  authorization_url: string | null;
  open_date: string | null;
  close_date: string | null;
  access_type: 'public' | 'restricted';
  dni_verification_enabled?: boolean;
};

export interface PublicFormsResponse {
  ok: boolean;
  status?: 'verified' | 'verification_required' | 'not_found';
  forms: PublicHomeForm[];
  message?: string;
  error?: string;
};

export interface VerifyParentEmailResponse {
  ok: boolean;
  status?: 'verified' | 'already_verified';
  public_id?: string;
  error?: string;
}

export interface VerifyPublicFormEmailResponse {
  ok: boolean;
  status?: 'verified' | 'already_verified';
  access_url?: string;
  error?: string;
}

export interface StartPublicFormEmailAccessResponse {
  ok: boolean;
  status?: 'verified' | 'verification_required';
  access_url?: string;
  message?: string;
  error?: string;
}


// --- Verificación de DNI ---------------------------------------------------

export type DniSessionStatus =
  | 'pending'
  | 'capturing'
  | 'front_uploaded'
  | 'processing'
  | 'extracted'
  | 'confirmed'
  | 'failed'
  | 'expired';

export interface DniExtractedData {
  nombre: string | null;
  /** "M" / "F" / "X", tal como viene en el documento (MRZ). */
  sexo?: string | null;
  /** Fecha de nacimiento en ISO (YYYY-MM-DD). */
  fecha_nacimiento?: string | null;
  numero: string | null;
  domicilio_texto: string | null;
  codigo_postal?: string | null;
  en_zona_parroquial?: boolean | null;
  numero_valido?: boolean;
  avisos?: string[];
  /** Fecha de validez leída en el anverso. */
  fecha_validez_frontal?: string | null;
  /** Fecha de validez codificada en la MRZ del reverso. */
  fecha_validez_trasera?: string | null;
  /** true si anverso y reverso no coinciden en la fecha de validez. */
  fecha_validez_conflicto?: boolean;
}

export interface DniStartResponse {
  ok: boolean;
  session_id?: string;
  desktop_token?: string;
  mobile_url?: string;
  expires_at?: string;
  minor_without_dni?: boolean;
  error?: string;
  message?: string;
}

export interface DniStatusResponse {
  ok: boolean;
  status?: DniSessionStatus;
  minor_without_dni?: boolean;
  confirmed_at?: string | null;
  expires_at?: string;
  extracted?: DniExtractedData | null;
  error?: string;
}

export interface DniSessionResponse {
  ok: boolean;
  status?: DniSessionStatus;
  form_title?: string;
  minor_without_dni?: boolean;
  front_uploaded?: boolean;
  back_uploaded?: boolean;
  extracted?: DniExtractedData | null;
  extraction_error?: string | null;
  attempts?: number;
  expires_at?: string;
  error?: string;
  message?: string;
}

export interface DniUploadResponse {
  ok: boolean;
  status?: DniSessionStatus;
  extracted?: DniExtractedData | null;
  error?: string;
  message?: string;
  /** true si el fallo es del servicio de lectura y las fotos siguen valiendo. */
  can_retry?: boolean;
  /** Campos que no se han podido leer cuando `status` es 'failed'. */
  missing_fields?: string[];
}

export const toDatetimeLocalValue = (iso: string | null) => {
  if (!iso) return '';

  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

export const fromDatetimeLocalValue = (value: string) => {
  if (!value) return null;
  return new Date(value).toISOString();
};

export const isFormCurrentlyOpen = (form: {
  active?: boolean;
  open_date: string | null;
  close_date: string | null;
}) => {
  const now = new Date();

  if (form.active === false) return false;
  if (form.open_date && now < new Date(form.open_date)) return false;
  if (form.close_date && now > new Date(form.close_date)) return false;

  return true;
};

export const normalizeSearchText = (value: string | null | undefined) => {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
};

export const isValidGoogleEntryKey = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^entry\.\d+$/.test(trimmed);
};


