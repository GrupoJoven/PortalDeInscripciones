import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  KeyRound,
  Link2,
  Mail,
  Search,
  Send,
  ShieldCheck,
} from 'lucide-react';

import { supabase } from '../lib/supabaseClient';
import { RegistrationForm } from '../types';

type LinkMode = 'restricted' | 'public';

type VerifiedEmail = {
  email: string;
  normalized_email: string;
  verified_at: string | null;
};

type GeneratedLink = {
  /** Datos con los que se generó: si cambian, el enlace deja de mostrarse. */
  inputsKey: string;
  url: string;
  form_title: string;
  summary: string;
  recipient: string | null;
  sent_to: string | null;
  warnings: string[];
};

const MAX_EMAIL_SUGGESTIONS = 8;
const STORAGE_PREFIX = 'admin-access-links:';

/**
 * useState que sobrevive a que la pestaña se desmonte (cambiar de pestaña del
 * panel o de página) mientras dure la sesión del navegador.
 */
function useSessionState<T>(key: string, initialValue: T) {
  const storageKey = STORAGE_PREFIX + key;

  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored === null ? initialValue : (JSON.parse(stored) as T);
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Sin almacenamiento disponible el estado sigue funcionando en memoria.
    }
  }, [storageKey, value]);

  return [value, setValue] as const;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const describeFunctionError = (error: string | undefined, fallback: string) => {
  if (error === 'forbidden') return 'No tienes permisos para generar enlaces.';
  if (error === 'missing_jwt' || error === 'invalid_jwt') return 'Tu sesión ha caducado. Vuelve a iniciar sesión.';
  return fallback;
};

// Activos primero y, dentro de cada bloque, los más recientes arriba.
const sortForms = (forms: RegistrationForm[]) =>
  [...forms].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.created_at ?? '').localeCompare(a.created_at ?? '');
  });

export default function AccessLinksTab({
  forms,
  loadingForms,
}: {
  forms: RegistrationForm[];
  loadingForms: boolean;
}) {
  const [mode, setMode] = useSessionState<LinkMode>('mode', 'restricted');

  const [publicId, setPublicId] = useSessionState('publicId', '');
  const [restrictedFormId, setRestrictedFormId] = useSessionState('restrictedFormId', '');

  const [publicFormId, setPublicFormId] = useSessionState('publicFormId', '');
  const [emailInput, setEmailInput] = useSessionState('emailInput', '');
  const [emailDropdownOpen, setEmailDropdownOpen] = useState(false);
  const [highlightedEmailIndex, setHighlightedEmailIndex] = useState(0);

  const [verifiedEmails, setVerifiedEmails] = useState<VerifiedEmail[]>([]);
  const [loadingEmails, setLoadingEmails] = useState(true);
  const [emailsError, setEmailsError] = useState('');
  const [verifyingEmail, setVerifyingEmail] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [storedResult, setStoredResult] = useSessionState<GeneratedLink | null>('result', null);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);

  // Los formularios de pago no se prerrellenan con datos del catecúmeno, así
  // que aquí solo tienen sentido los de inscripción.
  const restrictedForms = useMemo(
    () => sortForms(forms.filter((f) => f.access_type === 'restricted' && f.form_type !== 'payment')),
    [forms]
  );
  const publicForms = useMemo(
    () => sortForms(forms.filter((f) => f.access_type === 'public' && f.form_type !== 'payment')),
    [forms]
  );

  const loadVerifiedEmails = async () => {
    setLoadingEmails(true);
    setEmailsError('');

    const { data, error } = await supabase.functions.invoke('admin-form-access-links', {
      body: { action: 'list_verified_emails' },
    });

    if (error || !data?.ok) {
      console.error(error ?? data);
      setEmailsError(describeFunctionError(data?.error, 'No se pudieron cargar los correos verificados.'));
      setLoadingEmails(false);
      return;
    }

    setVerifiedEmails((data.emails ?? []) as VerifiedEmail[]);
    setLoadingEmails(false);
  };

  useEffect(() => {
    loadVerifiedEmails();
  }, []);

  const normalizedEmailInput = normalizeEmail(emailInput);

  const linkRequest =
    mode === 'restricted'
      ? { mode, form_id: restrictedFormId, public_id: publicId.trim() }
      : { mode, form_id: publicFormId, email: normalizedEmailInput };
  const inputsKey = JSON.stringify(linkRequest);

  // Cualquier cambio en los datos invalida el enlace generado anteriormente.
  const result = storedResult?.inputsKey === inputsKey ? storedResult : null;

  useEffect(() => {
    setGenerateError('');
    setCopied(false);
  }, [inputsKey]);

  const verifiedEmailSet = useMemo(
    () => new Set(verifiedEmails.map((row) => row.normalized_email)),
    [verifiedEmails]
  );

  const isEmailVerified = verifiedEmailSet.has(normalizedEmailInput);
  const canVerifyManually =
    !loadingEmails && !emailsError && isValidEmail(normalizedEmailInput) && !isEmailVerified;

  const emailSuggestions = useMemo(() => {
    if (!normalizedEmailInput) return [];

    return verifiedEmails
      .filter((row) => row.normalized_email.includes(normalizedEmailInput))
      .sort((a, b) => {
        // Los que empiezan por lo escrito, antes que los que solo lo contienen.
        const aStarts = a.normalized_email.startsWith(normalizedEmailInput) ? 0 : 1;
        const bStarts = b.normalized_email.startsWith(normalizedEmailInput) ? 0 : 1;
        return aStarts - bStarts || a.normalized_email.localeCompare(b.normalized_email);
      })
      .slice(0, MAX_EMAIL_SUGGESTIONS);
  }, [verifiedEmails, normalizedEmailInput]);

  const showEmailDropdown =
    emailDropdownOpen && emailSuggestions.length > 0 && !isEmailVerified;

  const selectEmail = (email: string) => {
    setEmailInput(email);
    setEmailDropdownOpen(false);
  };

  const handleEmailKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showEmailDropdown) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedEmailIndex((i) => Math.min(i + 1, emailSuggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedEmailIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const suggestion = emailSuggestions[highlightedEmailIndex];
      if (suggestion) selectEmail(suggestion.normalized_email);
    } else if (e.key === 'Escape') {
      setEmailDropdownOpen(false);
    }
  };

  const verifyEmailManually = async () => {
    const confirmed = confirm(
      `¿Seguro que quieres marcar ${normalizedEmailInput} como verificado?\n\n` +
        'Hazlo solo si estás seguro de que el correo existe y de que el padre/madre tiene acceso a él. ' +
        'A partir de ahora se aceptarán las inscripciones en formularios públicos con este correo.'
    );
    if (!confirmed) return;

    setVerifyingEmail(true);
    setGenerateError('');

    const { data, error } = await supabase.functions.invoke('admin-form-access-links', {
      body: { action: 'verify_email_manually', email: emailInput.trim() },
    });

    if (error || !data?.ok) {
      console.error(error ?? data);
      setGenerateError(
        data?.message ?? describeFunctionError(data?.error, 'No se pudo verificar el correo.')
      );
      setVerifyingEmail(false);
      return;
    }

    const row = data.email as VerifiedEmail;
    setVerifiedEmails((current) =>
      current.some((e) => e.normalized_email === row.normalized_email) ? current : [...current, row]
    );
    setEmailInput(row.normalized_email);
    setVerifyingEmail(false);
  };

  const canGenerate =
    mode === 'restricted'
      ? Boolean(publicId.trim() && restrictedFormId)
      : Boolean(publicFormId && isEmailVerified);

  const generateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canGenerate) return;

    setGenerating(true);
    setGenerateError('');
    setStoredResult(null);

    const { data, error } = await supabase.functions.invoke('admin-form-access-links', {
      body: {
        ...linkRequest,
        action: mode === 'restricted' ? 'build_restricted_link' : 'build_public_link',
      },
    });

    if (error || !data?.ok) {
      console.error(error ?? data);
      setGenerateError(
        data?.message ?? describeFunctionError(data?.error, 'No se pudo generar el enlace.')
      );
      setGenerating(false);
      return;
    }

    setStoredResult({
      inputsKey,
      url: data.url,
      form_title: data.form_title,
      summary:
        mode === 'restricted'
          ? `${data.student.name} · ${data.student.group_name || 'Sin grupo'}`
          : data.email,
      recipient: data.recipient ?? null,
      sent_to: null,
      warnings: data.warnings ?? [],
    });
    setGenerating(false);
  };

  const sendLink = async () => {
    if (!result?.recipient) return;

    const confirmed = confirm(
      `¿Enviar el enlace de "${result.form_title}" a ${result.recipient}?` +
        (result.sent_to ? '\n\nYa se ha enviado antes: se enviará otro correo.' : '')
    );
    if (!confirmed) return;

    setSending(true);
    setGenerateError('');

    // El servidor vuelve a generar el enlace y decide el destinatario: no se
    // le manda la URL ni el correo mostrados aquí.
    const { data, error } = await supabase.functions.invoke('admin-form-access-links', {
      body: { ...linkRequest, action: 'send_link' },
    });

    if (error || !data?.ok) {
      console.error(error ?? data);
      setGenerateError(
        data?.message ?? describeFunctionError(data?.error, 'No se pudo enviar el enlace.')
      );
      setSending(false);
      return;
    }

    setStoredResult((current) =>
      current?.inputsKey === inputsKey ? { ...current, sent_to: data.sent_to } : current
    );
    setSending(false);
  };

  const copyLink = async () => {
    if (!result) return;

    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('No se pudo copiar al portapapeles:', err);
      setGenerateError('No se pudo copiar el enlace.');
    }
  };

  const renderFormOption = (form: RegistrationForm) => (
    <option key={form.id} value={form.id}>
      {form.title}
      {form.active ? '' : ' (inactivo)'}
    </option>
  );

  const inputClassName =
    'w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all';

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-3xl p-6">
        <p className="text-slate-600 mb-5">
          Genera el mismo enlace prerrellenado que recibe una familia al entrar a un formulario desde
          el portal, para enviárselo directamente.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setMode('restricted')}
            className={`text-left p-4 rounded-2xl border-2 transition-all ${mode === 'restricted'
              ? 'border-indigo-500 bg-indigo-50'
              : 'border-slate-200 hover:border-slate-300'
              }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <KeyRound className="w-4 h-4 text-indigo-600" />
              <span className="font-bold text-slate-800">Formulario privado</span>
            </div>
            <p className="text-sm text-slate-500">
              A partir del identificador del catecúmeno. Se prerrellenan todos sus datos.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setMode('public')}
            className={`text-left p-4 rounded-2xl border-2 transition-all ${mode === 'public'
              ? 'border-indigo-500 bg-indigo-50'
              : 'border-slate-200 hover:border-slate-300'
              }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <Mail className="w-4 h-4 text-indigo-600" />
              <span className="font-bold text-slate-800">Formulario público</span>
            </div>
            <p className="text-sm text-slate-500">
              A partir de un correo verificado. Se prerrellena el email de contacto.
            </p>
          </button>
        </div>
      </div>

      <form onSubmit={generateLink} className="bg-white border border-slate-200 rounded-3xl p-6 space-y-5">
        {mode === 'restricted' ? (
          <>
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2">
                Identificador del catecúmeno
              </label>
              <input
                type="text"
                value={publicId}
                onChange={(e) => setPublicId(e.target.value.toUpperCase())}
                placeholder="Ej.: ABC123"
                className={`${inputClassName} font-mono uppercase`}
                autoComplete="off"
              />
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2">Formulario privado</label>
              <select
                value={restrictedFormId}
                onChange={(e) => setRestrictedFormId(e.target.value)}
                disabled={loadingForms}
                className={inputClassName}
              >
                <option value="">
                  {loadingForms ? 'Cargando formularios...' : 'Selecciona un formulario'}
                </option>
                {restrictedForms.map(renderFormOption)}
              </select>
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2">Formulario público</label>
              <select
                value={publicFormId}
                onChange={(e) => setPublicFormId(e.target.value)}
                disabled={loadingForms}
                className={inputClassName}
              >
                <option value="">
                  {loadingForms ? 'Cargando formularios...' : 'Selecciona un formulario'}
                </option>
                {publicForms.map(renderFormOption)}
              </select>
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-700 mb-2">Correo de contacto</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="w-5 h-5 text-slate-400" />
                </div>
                <input
                  type="text"
                  inputMode="email"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    setEmailDropdownOpen(true);
                    setHighlightedEmailIndex(0);
                  }}
                  onFocus={() => setEmailDropdownOpen(true)}
                  onBlur={() => setEmailDropdownOpen(false)}
                  onKeyDown={handleEmailKeyDown}
                  placeholder={loadingEmails ? 'Cargando correos verificados...' : 'Busca un correo verificado'}
                  disabled={loadingEmails}
                  className={`${inputClassName} pl-12`}
                  autoComplete="off"
                />

                {showEmailDropdown && (
                  <ul className="absolute z-20 mt-2 w-full bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden">
                    {emailSuggestions.map((row, index) => (
                      <li key={row.normalized_email}>
                        <button
                          type="button"
                          // onMouseDown para que se seleccione antes del blur del input.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectEmail(row.normalized_email);
                          }}
                          onMouseEnter={() => setHighlightedEmailIndex(index)}
                          className={`w-full text-left px-4 py-2.5 text-sm break-all transition-colors ${index === highlightedEmailIndex
                            ? 'bg-indigo-50 text-indigo-700'
                            : 'text-slate-700'
                            }`}
                        >
                          {row.normalized_email}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {emailsError && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  <span>{emailsError}</span>
                  <button
                    type="button"
                    onClick={loadVerifiedEmails}
                    className="font-semibold underline whitespace-nowrap"
                  >
                    Reintentar
                  </button>
                </div>
              )}

              {isEmailVerified && (
                <p className="mt-2 text-sm font-medium text-green-600 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  Correo verificado
                </p>
              )}

              {canVerifyManually && (
                <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm text-amber-800 mb-3">
                    Este correo no está en la tabla de correos verificados. Solo debes verificarlo
                    manualmente si estás seguro de que el correo existe y de que el padre/madre tiene
                    acceso a él: a partir de ese momento se aceptarán las inscripciones con este correo.
                  </p>
                  <button
                    type="button"
                    onClick={verifyEmailManually}
                    disabled={verifyingEmail}
                    className="px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 disabled:opacity-60 transition-all flex items-center gap-2"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    {verifyingEmail ? 'Verificando...' : 'Verificar manualmente y añadir a la tabla'}
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {generateError && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {generateError}
          </div>
        )}

        <button
          type="submit"
          disabled={!canGenerate || generating}
          className="bg-indigo-600 text-white px-5 py-3 rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-60 transition-all flex items-center gap-2 shadow-lg shadow-indigo-100"
        >
          <Link2 className="w-4 h-4" />
          {generating ? 'Generando...' : 'Generar enlace'}
        </button>
      </form>

      {result && (
        <div className="bg-white border border-slate-200 rounded-3xl p-6 space-y-4">
          <div>
            <h3 className="font-bold text-slate-800 text-lg">{result.form_title}</h3>
            <p className="text-sm text-slate-500 break-all">{result.summary}</p>
          </div>

          {result.warnings.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-1.5">
              {result.warnings.map((warning) => (
                <p key={warning} className="text-sm text-amber-800 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {warning}
                </p>
              ))}
            </div>
          )}

          <textarea
            readOnly
            value={result.url}
            onFocus={(e) => e.target.select()}
            rows={3}
            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl font-mono text-xs text-slate-700 break-all resize-none outline-none"
          />

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={copyLink}
              className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-all flex items-center justify-center gap-2"
            >
              <Copy className="w-4 h-4" />
              {copied ? 'Copiado' : 'Copiar enlace'}
            </button>
            <button
              type="button"
              onClick={sendLink}
              disabled={!result.recipient || sending}
              title={result.recipient ? `Enviar a ${result.recipient}` : 'No hay correo de contacto válido'}
              className="flex-1 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
              <Send className="w-4 h-4" />
              {sending ? 'Enviando...' : result.sent_to ? 'Reenviar enlace' : 'Enviar enlace'}
            </button>
          </div>

          {result.recipient && !result.sent_to && (
            <p className="text-sm text-slate-500 break-all">
              Se enviará a <span className="font-semibold text-slate-700">{result.recipient}</span>.
            </p>
          )}

          {result.sent_to && (
            <p className="text-sm font-medium text-green-600 flex items-center gap-1.5 break-all">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              Enlace enviado a {result.sent_to}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
