export interface RegistrationForm {
  id: string;
  title: string;
  description: string | null;
  url: string;
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
  google_form_id: string;
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
  open_date: string | null;
  close_date: string | null;
  access_type: 'public' | 'restricted';
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


