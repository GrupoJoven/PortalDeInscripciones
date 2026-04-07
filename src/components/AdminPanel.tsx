import React, { useState, useEffect } from 'react';
import type { User } from '@supabase/supabase-js';
import { motion } from 'motion/react';
import { 
  Plus,
  Trash2,
  Power,
  PowerOff,
  XCircle,
  Search,
  RefreshCcw,
  Copy,
  KeyRound,
  Settings,
  AlertCircle
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';

import Login from './Login';
import { supabase } from '../lib/supabaseClient';
import {
  RegistrationForm,
  GroupOption,
  StudentAccessRow,
  EditingForm,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  normalizeSearchText,
  isValidGoogleEntryKey
} from '../types';

export default function AdminPanel({
  user,
  isCoordinator,
  authLoading,
  onLogin,
  onLogout,
}: {
  user: User | null;
  isCoordinator: boolean;
  authLoading: boolean;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {

  const [activeTab, setActiveTab] = useState<'forms' | 'access'>('forms');

  const [forms, setForms] = useState<RegistrationForm[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [loadingForms, setLoadingForms] = useState(true);

  const [accessRows, setAccessRows] = useState<StudentAccessRow[]>([]);
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [accessSearch, setAccessSearch] = useState('');
  const [selectedAccessGroupId, setSelectedAccessGroupId] = useState<'all' | string>('all');
  const [regeneratingStudentId, setRegeneratingStudentId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingForm, setEditingForm] = useState<EditingForm | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [formModalError, setFormModalError] = useState<string | null>(null);
  const [syncingWatch, setSyncingWatch] = useState(false);
  const [copySourceSelectorOpen, setCopySourceSelectorOpen] = useState(false);

  const blockedFormIds = [
  '1688ad22-3c20-4474-97d1-8e65b7cd2c5b',
  '53352ca6-2dc6-45d0-9f07-cc3d170e5736',
  '5d0b4e27-ba69-416c-af3f-7a29c72219d2',
  'c1c11f45-99b0-4d0d-95bc-02b2c6192437'
];


  const loadFormsData = async () => {
    setLoadingForms(true);
    setError('');

    const [{ data: formsData, error: formsError }, { data: groupsData, error: groupsError }] =
      await Promise.all([
        supabase
          .from('registration_forms')
          .select('*')
          .order('created_at', { ascending: false }),
        supabase
          .from('groups')
          .select('id, name')
          .order('name', { ascending: true }),
      ]);

    if (formsError) {
      console.error(formsError);
      setError('Error al cargar los formularios.');
      setLoadingForms(false);
      return;
    }

    if (groupsError) {
      console.error(groupsError);
      setError('Error al cargar los grupos.');
      setLoadingForms(false);
      return;
    }

    const formIds = (formsData ?? []).map((f) => f.id);

    let relationsMap = new Map<string, string[]>();

    if (formIds.length > 0) {
      const { data: relData, error: relError } = await supabase
        .from('registration_form_groups')
        .select('form_id, group_id')
        .in('form_id', formIds);

      if (relError) {
        console.error(relError);
        setError('Error al cargar las relaciones de formularios con grupos.');
        setLoadingForms(false);
        return;
      }

      for (const row of relData ?? []) {
        const current = relationsMap.get(row.form_id) ?? [];
        current.push(row.group_id);
        relationsMap.set(row.form_id, current);
      }
    }

    const normalizedForms: RegistrationForm[] = (formsData ?? []).map((f) => ({
      ...f,
      group_ids: relationsMap.get(f.id) ?? [],
    })) as RegistrationForm[];

    setForms(normalizedForms);
    setGroups((groupsData ?? []) as GroupOption[]);
    setLoadingForms(false);
  };

  const loadAccessData = async () => {
    setLoadingAccess(true);
    setError('');

    const [{ data: studentsData, error: studentsError }, { data: groupsData, error: groupsError }, { data: accessData, error: accessError }] =
      await Promise.all([
        supabase
          .from('students')
          .select('id, name, dni, gender, email, parent_email, school, group_id')
          .order('name', { ascending: true }),
        supabase
          .from('groups')
          .select('id, name'),
        supabase
          .from('student_public_access')
          .select('student_id, public_id'),
      ]);

    if (studentsError) {
      console.error(studentsError);
      setError('Error al cargar los alumnos.');
      setLoadingAccess(false);
      return;
    }

    if (groupsError) {
      console.error(groupsError);
      setError('Error al cargar los grupos de los alumnos.');
      setLoadingAccess(false);
      return;
    }

    if (accessError) {
      console.error(accessError);
      setError('Error al cargar los identificadores públicos.');
      setLoadingAccess(false);
      return;
    }

    const groupsMap = new Map((groupsData ?? []).map((g) => [g.id, g.name]));
    const accessMap = new Map((accessData ?? []).map((a) => [a.student_id, a.public_id]));

    const rows: StudentAccessRow[] = (studentsData ?? []).map((student) => ({
      id: student.id,
      name: student.name,
      email: student.email,
      parent_email: student.parent_email,
      school: student.school,
      group_id: student.group_id,
      group_name: groupsMap.get(student.group_id) ?? 'Sin grupo',
      public_id: accessMap.get(student.id) ?? null,
    }));

    setAccessRows(rows);
    setLoadingAccess(false);
  };

  useEffect(() => {
    if (user && isCoordinator) {
      loadFormsData();
      loadAccessData();
    }
  }, [user, isCoordinator]);

  const openCreateForm = () => {
    setEditingForm({
      title: '',
      description: '',
      url: '',
      active: true,
      access_type: 'restricted',
      open_date: '',
      close_date: '',
      group_ids: [],
      prefill_public_id_entry: '',
      prefill_name_entry: '',
      prefill_dni_entry: '',
      prefill_gender_entry: '',
      prefill_parent_email_entry: '',
      prefill_school_entry: '',
      prefill_birth_date_entry: '',
      prefill_group_entry: '',
      google_form_id: '',
      google_form_watch_enabled: true,
      response_public_id_question_id: '',
      response_name_question_id: '',
      response_dni_question_id: '',
      response_gender_question_id: '',
      response_parent_email_question_id: '',
      response_school_question_id: '',
      response_birth_date_question_id: '',
      response_group_question_id: '',

    });
    setFormModalError(null);
    setCopySourceSelectorOpen(false);
  };

  const openEditForm = async (form: RegistrationForm) => {
    setFormModalError(null);
    setCopySourceSelectorOpen(false);
    const { data: relData, error: relError } = await supabase
      .from('registration_form_groups')
      .select('group_id')
      .eq('form_id', form.id);

    if (relError) {
      console.error(relError);
      setError('Error al cargar los grupos del formulario.');
      return;
    }

    setEditingForm({
      id: form.id,
      title: form.title,
      description: form.description ?? '',
      url: form.url,
      active: form.active,
      access_type: form.access_type,
      open_date: toDatetimeLocalValue(form.open_date),
      close_date: toDatetimeLocalValue(form.close_date),
      group_ids: (relData ?? []).map((r) => r.group_id),
      prefill_public_id_entry: form.prefill_public_id_entry ?? '',
      prefill_name_entry: form.prefill_name_entry ?? '',
      prefill_dni_entry: form.prefill_dni_entry ?? '',
      prefill_gender_entry: form.prefill_gender_entry ?? '',
      prefill_parent_email_entry: form.prefill_parent_email_entry ?? '',
      prefill_school_entry: form.prefill_school_entry ?? '',
      prefill_birth_date_entry: form.prefill_birth_date_entry ?? '',
      prefill_group_entry: form.prefill_group_entry ?? '',
      google_form_id: form.google_form_id ?? '',
      google_form_watch_enabled: form.google_form_watch_enabled ?? false,
      response_public_id_question_id: form.response_public_id_question_id ?? '',
      response_name_question_id: form.response_name_question_id ?? '',
      response_dni_question_id: form.response_dni_question_id ?? '',
      response_gender_question_id: form.response_gender_question_id ?? '',
      response_parent_email_question_id: form.response_parent_email_question_id ?? '',
      response_school_question_id: form.response_school_question_id ?? '',
      response_birth_date_question_id: form.response_birth_date_question_id ?? '',
      response_group_question_id: form.response_group_question_id ?? '',
    });
  };

  const syncGoogleFormWatch = async (registrationFormId: string) => {
    setSyncingWatch(true);

    try {
      const { data, error } = await supabase.functions.invoke('google-forms-watch-sync', {
        body: {
          registration_form_id: registrationFormId,
        },
      });

      if (error) {
        console.error(error);
        throw new Error('No se pudo sincronizar el watch del formulario.');
      }

      if (data?.ok === false) {
        console.error(data);
        throw new Error(
          typeof data?.error === 'string'
            ? data.error
            : 'La sincronización del watch devolvió un error.'
        );
      }
    } finally {
      setSyncingWatch(false);
    }
  };

  const getCompatibleFormsForCopy = (currentForm: EditingForm) => {
    return forms.filter((form) => {
      // Verificar si el formulario está en la lista de formularios bloqueados
      if (!blockedFormIds.includes(form.id)) return false;

      // Asegurarse de que el formulario tiene el mismo tipo de acceso
      if (form.access_type !== currentForm.access_type) return false;

      // Asegurarse de que no se copie el formulario actual
      if (currentForm.id && form.id === currentForm.id) return false;

      if (currentForm.google_form_watch_enabled && !form.google_form_watch_enabled) {
        return false;
      }

      return true;
    });
  };

  const copyIdentifiersFromForm = (sourceForm: RegistrationForm) => {
    if (!editingForm) return;

    const nextForm: EditingForm = {
      ...editingForm,
    };

    if (editingForm.access_type === 'public') {
      nextForm.prefill_parent_email_entry = sourceForm.prefill_parent_email_entry ?? '';

      if (editingForm.google_form_watch_enabled) {
        nextForm.response_parent_email_question_id =
          sourceForm.response_parent_email_question_id ?? '';
      }
    }

    if (editingForm.access_type === 'restricted') {
      nextForm.prefill_public_id_entry = sourceForm.prefill_public_id_entry ?? '';
      nextForm.prefill_name_entry = sourceForm.prefill_name_entry ?? '';
      nextForm.prefill_dni_entry = sourceForm.prefill_dni_entry ?? '';
      nextForm.prefill_gender_entry = sourceForm.prefill_gender_entry ?? '';
      nextForm.prefill_parent_email_entry = sourceForm.prefill_parent_email_entry ?? '';
      nextForm.prefill_school_entry = sourceForm.prefill_school_entry ?? '';
      nextForm.prefill_birth_date_entry = sourceForm.prefill_birth_date_entry ?? '';
      nextForm.prefill_group_entry = sourceForm.prefill_group_entry ?? '';

      if (editingForm.google_form_watch_enabled) {
        nextForm.response_public_id_question_id =
          sourceForm.response_public_id_question_id ?? '';
        nextForm.response_name_question_id =
          sourceForm.response_name_question_id ?? '';
        nextForm.response_dni_question_id =
          sourceForm.response_dni_question_id ?? '';
        nextForm.response_gender_question_id =
          sourceForm.response_gender_question_id ?? '';
        nextForm.response_parent_email_question_id =
          sourceForm.response_parent_email_question_id ?? '';
        nextForm.response_school_question_id =
          sourceForm.response_school_question_id ?? '';
        nextForm.response_birth_date_question_id =
          sourceForm.response_birth_date_question_id ?? '';
        nextForm.response_group_question_id =
          sourceForm.response_group_question_id ?? '';
      }
    }

    setEditingForm(nextForm);
    setCopySourceSelectorOpen(false);
    setFormModalError(null);
  };

  const saveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormModalError(null);

    if (!editingForm) return;

    setError('');

    if (!editingForm.title.trim() || !editingForm.url.trim()) {
      setFormModalError('El título y la URL son obligatorios.');
      return;
    }
    if (editingForm.google_form_watch_enabled && !editingForm.google_form_id.trim()) {
      setFormModalError('Si activas el seguimiento automático de respuestas, el ID del formulario de Google es obligatorio.');
      return;
    }

    if (
      editingForm.open_date &&
      editingForm.close_date &&
      new Date(editingForm.close_date).getTime() <= new Date(editingForm.open_date).getTime()
    ) {
      setFormModalError('La fecha de cierre debe ser posterior a la fecha de apertura.');
      return;
    }
    if (editingForm.access_type === 'restricted') {
      const requiredRestrictedFields: Array<{ label: string; value: string }> = [
        { label: 'IDENTIFICADOR', value: editingForm.prefill_public_id_entry },
        { label: 'NOMBRE COMPLETO', value: editingForm.prefill_name_entry },
        { label: 'DNI', value: editingForm.prefill_dni_entry },
        { label: 'GÉNERO', value: editingForm.prefill_gender_entry },
        { label: 'EMAIL DE CONTACTO', value: editingForm.prefill_parent_email_entry },
        { label: 'COLEGIO', value: editingForm.prefill_school_entry },
        { label: 'FECHA DE NACIMIENTO', value: editingForm.prefill_birth_date_entry },
        { label: 'GRUPO', value: editingForm.prefill_group_entry },
      ];

      const missingField = requiredRestrictedFields.find((field) => !field.value.trim());
      if (missingField) {
        setFormModalError(`El identificador de Google Forms para "${missingField.label}" es obligatorio.`);
        return;
      }

      const invalidField = requiredRestrictedFields.find((field) => !isValidGoogleEntryKey(field.value));
      if (invalidField) {
        setFormModalError(`El identificador de Google Forms para "${invalidField.label}" no es válido. Debe tener formato entry.123456789.`);
        return;
      }

      if (editingForm.google_form_watch_enabled) {
        const requiredRestrictedResponseFields: Array<{ label: string; value: string }> = [
          { label: 'IDENTIFICADOR', value: editingForm.response_public_id_question_id },
          { label: 'NOMBRE COMPLETO', value: editingForm.response_name_question_id },
          { label: 'DNI', value: editingForm.response_dni_question_id },
          { label: 'GÉNERO', value: editingForm.response_gender_question_id },
          { label: 'EMAIL DE CONTACTO', value: editingForm.response_parent_email_question_id },
          { label: 'COLEGIO', value: editingForm.response_school_question_id },
          { label: 'FECHA DE NACIMIENTO', value: editingForm.response_birth_date_question_id },
          { label: 'GRUPO', value: editingForm.response_group_question_id },
        ];

        const missingRestrictedResponseField = requiredRestrictedResponseFields.find(
          (field) => !field.value.trim()
        );

        if (missingRestrictedResponseField) {
          setFormModalError(
            `El identificador de respuesta de Google Forms para "${missingRestrictedResponseField.label}" es obligatorio si se activa el seguimiento.`
          );
          return;
        }
      }
    }

    if (editingForm.access_type === 'public') {
      if (!editingForm.prefill_parent_email_entry.trim()) {
        setFormModalError('El identificador de Google Forms para "EMAIL DE CONTACTO" es obligatorio.');
        return;
      }
      if (editingForm.google_form_watch_enabled && !editingForm.response_parent_email_question_id.trim()) {
        setFormModalError('El identificador de respuesta de Google Forms para "EMAIL DE CONTACTO" es obligatorio si se activa el seguimiento.');
        return;
      }

      if (!isValidGoogleEntryKey(editingForm.prefill_parent_email_entry)) {
        setFormModalError('El identificador de Google Forms para "EMAIL DE CONTACTO" no es válido. Debe tener formato entry.123456789.');
        return;
      }
    }

    setSaving(true);

    const payload = {
      title: editingForm.title.trim(),
      description: editingForm.description.trim() || null,
      url: editingForm.url.trim(),
      active: editingForm.active,
      access_type: editingForm.access_type,
      open_date: fromDatetimeLocalValue(editingForm.open_date),
      close_date: fromDatetimeLocalValue(editingForm.close_date),
      prefill_public_id_entry:
          editingForm.access_type === 'restricted' && editingForm.prefill_public_id_entry.trim()
            ? editingForm.prefill_public_id_entry.trim()
            : null,
      prefill_name_entry:
        editingForm.access_type === 'restricted' && editingForm.prefill_name_entry.trim()
          ? editingForm.prefill_name_entry.trim()
          : null,
      prefill_dni_entry:
        editingForm.access_type === 'restricted' && editingForm.prefill_dni_entry.trim()
          ? editingForm.prefill_dni_entry.trim()
          : null,
      prefill_gender_entry:
        editingForm.access_type === 'restricted' && editingForm.prefill_gender_entry.trim()
          ? editingForm.prefill_gender_entry.trim()
          : null,
      prefill_parent_email_entry:
        editingForm.prefill_parent_email_entry.trim()
          ? editingForm.prefill_parent_email_entry.trim()
          : null,
      prefill_school_entry:
        editingForm.access_type === 'restricted' && editingForm.prefill_school_entry.trim()
          ? editingForm.prefill_school_entry.trim()
          : null,
      prefill_birth_date_entry:
        editingForm.access_type === 'restricted' && editingForm.prefill_birth_date_entry.trim()
          ? editingForm.prefill_birth_date_entry.trim()
          : null,
      prefill_group_entry:
        editingForm.access_type === 'restricted' && editingForm.prefill_group_entry.trim()
          ? editingForm.prefill_group_entry.trim()
          : null,
      google_form_id: editingForm.google_form_id.trim() || null,
      google_form_watch_enabled: editingForm.google_form_watch_enabled,

      response_public_id_question_id:
        editingForm.access_type === 'restricted' && editingForm.response_public_id_question_id.trim()
          ? editingForm.response_public_id_question_id.trim()
          : null,

      response_name_question_id:
        editingForm.access_type === 'restricted' && editingForm.response_name_question_id.trim()
          ? editingForm.response_name_question_id.trim()
          : null,

      response_dni_question_id:
        editingForm.access_type === 'restricted' && editingForm.response_dni_question_id.trim()
          ? editingForm.response_dni_question_id.trim()
          : null,

      response_gender_question_id:
        editingForm.access_type === 'restricted' && editingForm.response_gender_question_id.trim()
          ? editingForm.response_gender_question_id.trim()
          : null,

      response_parent_email_question_id:
        editingForm.response_parent_email_question_id.trim()
          ? editingForm.response_parent_email_question_id.trim()
          : null,

      response_school_question_id:
        editingForm.access_type === 'restricted' && editingForm.response_school_question_id.trim()
          ? editingForm.response_school_question_id.trim()
          : null,

      response_birth_date_question_id:
        editingForm.access_type === 'restricted' && editingForm.response_birth_date_question_id.trim()
          ? editingForm.response_birth_date_question_id.trim()
          : null,

      response_group_question_id:
        editingForm.access_type === 'restricted' && editingForm.response_group_question_id.trim()
          ? editingForm.response_group_question_id.trim()
          : null,
    };

    let formId = editingForm.id;

    if (editingForm.id) {
      const { error: updateError } = await supabase
        .from('registration_forms')
        .update(payload)
        .eq('id', editingForm.id);

      if (updateError) {
        console.error(updateError);
        setFormModalError('Error al actualizar el formulario.');
        setSaving(false);
        return;
      }
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from('registration_forms')
        .insert(payload)
        .select('id')
        .single();

      if (insertError || !inserted) {
        console.error(insertError);
        setFormModalError('Error al crear el formulario.');
        setSaving(false);
        return;
      }

      formId = inserted.id;
    }

    const { error: deleteRelationsError } = await supabase
      .from('registration_form_groups')
      .delete()
      .eq('form_id', formId!);

    if (deleteRelationsError) {
      console.error(deleteRelationsError);
      setFormModalError('Error al actualizar los grupos del formulario.');
      setSaving(false);
      return;
    }

    if (editingForm.access_type === 'restricted' && editingForm.group_ids.length > 0) {
      const relationRows = editingForm.group_ids.map((groupId) => ({
        form_id: formId!,
        group_id: groupId,
      }));

      const { error: insertRelationsError } = await supabase
        .from('registration_form_groups')
        .insert(relationRows);

      if (insertRelationsError) {
        console.error(insertRelationsError);
        setFormModalError('Error al guardar los grupos del formulario.');
        setSaving(false);
        return;
      }
    }

    if (
      editingForm.google_form_watch_enabled &&
      editingForm.google_form_id.trim() &&
      formId
    ) {
      try {
        setSaving(false);
        await syncGoogleFormWatch(formId);
      } catch (err) {
        console.error(err);
        setFormModalError(
          err instanceof Error
            ? err.message
            : 'El formulario se ha guardado, pero no se ha podido sincronizar el watch de Google Forms.'
        );
        setSaving(false);
        return;
      }
    }

    setEditingForm(null);
    setSaving(false);
    loadFormsData();
  };

  const deleteForm = async (id: string) => {
    if (!confirm('¿Estás seguro de que quieres eliminar este formulario?')) return;

    const { error } = await supabase
      .from('registration_forms')
      .delete()
      .eq('id', id);

    if (error) {
      console.error(error);
      setError('Error al eliminar el formulario.');
      return;
    }

    loadFormsData();
  };

  const toggleFormActive = async (form: RegistrationForm) => {
    const { error } = await supabase
      .from('registration_forms')
      .update({ active: !form.active })
      .eq('id', form.id);

    if (error) {
      console.error(error);
      setError('Error al cambiar el estado del formulario.');
      return;
    }

    loadFormsData();
  };

  const regeneratePublicId = async (studentId: string) => {
    const confirmed = confirm('¿Seguro que quieres regenerar el identificador público de este alumno? El código anterior dejará de servir.');
    if (!confirmed) return;

    setRegeneratingStudentId(studentId);
    setError('');

    const { error } = await supabase.rpc('regenerate_student_public_id', {
      p_student_id: studentId,
    });

    if (error) {
      console.error(error);
      setError('Error al regenerar el identificador público.');
      setRegeneratingStudentId(null);
      return;
    }

    await loadAccessData();
    setRegeneratingStudentId(null);
  };

  const copyToClipboard = async (text: string, rowId: string) => {
    try {
      await navigator.clipboard.writeText(text);

      setCopiedId(rowId);

      setTimeout(() => {
        setCopiedId((current) => (current === rowId ? null : current));
      }, 2000);
    } catch (err) {
      console.error('No se pudo copiar al portapapeles:', err);
      setError('No se pudo copiar el identificador.');
    }
  };

  const filteredAccessRows = accessRows.filter((row) => {
    const matchesGroup =
      selectedAccessGroupId === 'all' || row.group_id === selectedAccessGroupId;

    if (!matchesGroup) return false;

    const term = normalizeSearchText(accessSearch);
    if (!term) return true;

    return (
      normalizeSearchText(row.name).includes(term) ||
      normalizeSearchText(row.email).includes(term) ||
      normalizeSearchText(row.parent_email).includes(term) ||
      normalizeSearchText(row.school).includes(term) ||
      normalizeSearchText(row.public_id).includes(term)
    );
  });

  const isSaveDisabled = !!editingForm && (
    !editingForm.title.trim() ||
    !editingForm.url.trim() ||
    (editingForm.google_form_watch_enabled && !editingForm.google_form_id.trim()) ||
    (
      editingForm.access_type === 'public' &&
      !editingForm.prefill_parent_email_entry.trim()
    ) ||
    (
      editingForm.access_type === 'public' && editingForm.google_form_watch_enabled &&
      !editingForm.response_parent_email_question_id.trim()
    ) ||

    (
      editingForm.access_type === 'restricted' &&
      (
        !editingForm.prefill_public_id_entry.trim() ||
        !editingForm.prefill_name_entry.trim() ||
        !editingForm.prefill_dni_entry.trim() ||
        !editingForm.prefill_gender_entry.trim() ||
        !editingForm.prefill_parent_email_entry.trim() ||
        !editingForm.prefill_school_entry.trim() ||
        !editingForm.prefill_birth_date_entry.trim() ||
        !editingForm.prefill_group_entry.trim()
      )
    ) ||
    (
      editingForm.access_type === 'restricted' && editingForm.google_form_watch_enabled &&
      (
        !editingForm.response_public_id_question_id.trim() ||
        !editingForm.response_name_question_id.trim() ||
        !editingForm.response_dni_question_id.trim() ||
        !editingForm.response_gender_question_id.trim() ||
        !editingForm.response_parent_email_question_id.trim() ||
        !editingForm.response_school_question_id.trim() ||
        !editingForm.response_birth_date_question_id.trim() ||
        !editingForm.response_group_question_id.trim()
      )
    )
  );

  if (authLoading) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-500 font-medium">Comprobando acceso...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={onLogin} />;
  }

  if (!isCoordinator) {
    return (
      <div className="min-h-[80vh] flex items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-8 rounded-3xl shadow-xl border border-slate-200 max-w-md w-full"
        >
          <div className="bg-red-100 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <AlertCircle className="w-8 h-8 text-red-600" />
          </div>
          <h2 className="text-2xl font-bold text-center text-slate-800 mb-2">
            Sin permisos
          </h2>
          <p className="text-slate-500 text-center mb-8">
            Has iniciado sesión correctamente, pero tu perfil no tiene rol de coordinator.
          </p>
          <button
            onClick={onLogout}
            className="w-full bg-slate-800 text-white py-3 rounded-xl font-bold hover:bg-slate-900 transition-all"
          >
            Cerrar sesión
          </button>
        </motion.div>
      </div>
    );
  }

  const compatibleFormsForCopy = editingForm
    ? getCompatibleFormsForCopy(editingForm)
    : [];

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight mb-2">
            Panel de Administración
          </h1>
          <p className="text-slate-500">
            Gestiona formularios y accesos públicos de los catecúmenos.
          </p>
        </div>
      </div>

      <div className="flex bg-slate-100 p-1 rounded-xl w-fit mb-8">
        <button
          onClick={() => setActiveTab('forms')}
          className={`px-6 py-2 rounded-lg font-bold transition-all ${
            activeTab === 'forms'
              ? 'bg-white text-indigo-600 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Formularios
        </button>
        <button
          onClick={() => setActiveTab('access')}
          className={`px-6 py-2 rounded-lg font-bold transition-all ${
            activeTab === 'access'
              ? 'bg-white text-indigo-600 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          Accesos
        </button>
      </div>

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 text-red-700 rounded-2xl p-4">
          {error}
        </div>
      )}

      {activeTab === 'forms' && (
        <>
          <div className="flex justify-end mb-6">
            <button
              onClick={openCreateForm}
              className="bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-lg shadow-indigo-100"
            >
              <Plus className="w-4 h-4" />
              Nuevo Formulario
            </button>
          </div>

          {loadingForms ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-10 text-center">
              <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-slate-500">Cargando formularios...</p>
            </div>
          ) : forms.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-10 text-center">
              <p className="text-slate-500">Todavía no hay formularios creados.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {forms.map((form) => (
                <div
                  key={form.id}
                  className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                      <h3 className="font-bold text-slate-800 text-lg">{form.title}</h3>

                      {form.active ? (
                        <span className="bg-green-100 text-green-700 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                          Activo
                        </span>
                      ) : (
                        <span className="bg-slate-100 text-slate-500 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                          Inactivo
                        </span>
                      )}

                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          form.access_type === 'public'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-indigo-100 text-indigo-700'
                        }`}
                      >
                        {form.access_type === 'public' ? 'Acceso libre' : 'Acceso limitado'}
                      </span>
                    </div>

                    <p className="text-slate-500 text-sm break-all mb-2">{form.url}</p>

                    <div className="text-sm text-slate-500 space-y-1">
                      <p>
                        Apertura:{' '}
                        {form.open_date ? format(parseISO(form.open_date), 'PPP p', { locale: es }) : 'Sin fecha'}
                      </p>
                      <p>
                        Cierre:{' '}
                        {form.close_date ? format(parseISO(form.close_date), 'PPP p', { locale: es }) : 'Sin fecha'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 w-full md:w-auto overflow-x-auto pb-2 md:pb-0">
                    {/* Verificar si el formulario está bloqueado */}
                    {blockedFormIds.includes(form.id) ? (
                      <p className="text-red-500 font-semibold">Este formulario está bloqueado para edición y eliminación.</p>
                    ) : (
                      <>
                        <button
                          onClick={() => toggleFormActive(form)}
                          className={`p-2 rounded-xl transition-all ${
                            form.active
                              ? 'bg-green-50 text-green-600 hover:bg-green-100'
                              : 'bg-slate-50 text-slate-400 hover:bg-slate-100'
                          }`}
                          title={form.active ? 'Desactivar' : 'Activar'}
                        >
                          {form.active ? <Power className="w-5 h-5" /> : <PowerOff className="w-5 h-5" />}
                        </button>

                        <button
                          onClick={() => openEditForm(form)}
                          className="p-2 bg-slate-50 text-slate-600 rounded-xl hover:bg-slate-100 transition-all"
                          title="Editar"
                        >
                          <Settings className="w-5 h-5" />
                        </button>

                        <button
                          onClick={() => deleteForm(form.id)}
                          className="p-2 bg-red-50 text-red-600 rounded-xl hover:bg-red-100 transition-all"
                          title="Eliminar"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'access' && (
        <>
          <div className="bg-white border border-slate-200 rounded-3xl p-5 mb-6">
            <div className="flex flex-col lg:flex-row gap-4 lg:items-center">
              <div className="relative flex-1 min-w-0">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="w-5 h-5 text-slate-400" />
                </div>
                <input
                  type="text"
                  value={accessSearch}
                  onChange={(e) => setAccessSearch(e.target.value)}
                  placeholder="Buscar por nombre, email, email del padre, colegio o identificador."
                  className="w-full pl-12 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
                />
              </div>

              <div className="lg:w-[320px] shrink-0">
                <div className="flex items-center gap-3 px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl focus-within:ring-4 focus-within:ring-indigo-100 focus-within:border-indigo-500 transition-all">
                  <span className="text-sm font-semibold text-slate-600 whitespace-nowrap">
                    Grupo
                  </span>

                  <select
                    value={selectedAccessGroupId}
                    onChange={(e) => setSelectedAccessGroupId(e.target.value)}
                    className="w-full bg-transparent text-slate-700 outline-none border-0 pr-8"
                  >
                    <option value="all">Todos los grupos</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {loadingAccess ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-10 text-center">
              <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-slate-500">Cargando accesos...</p>
            </div>
          ) : filteredAccessRows.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-10 text-center">
              <p className="text-slate-500">No se han encontrado alumnos con ese criterio.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {filteredAccessRows.map((row) => (
                <div
                  key={row.id}
                  className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col xl:flex-row justify-between items-start xl:items-center gap-5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <h3 className="font-bold text-slate-800 text-lg">{row.name}</h3>
                      <span className="bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                        {row.group_name}
                      </span>
                    </div>

                    <div className="text-sm text-slate-500 space-y-1">
                      <p><span className="font-semibold text-slate-600">Email:</span> {row.email || '—'}</p>
                      <p><span className="font-semibold text-slate-600">Email padre/madre:</span> {row.parent_email}</p>
                      <p><span className="font-semibold text-slate-600">Colegio:</span> {row.school}</p>
                    </div>
                  </div>

                  <div className="w-full xl:w-auto xl:min-w-[320px]">
                    <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <KeyRound className="w-4 h-4 text-indigo-600" />
                        <span className="text-sm font-bold text-slate-700">Identificador público</span>
                      </div>

                      <div className="font-mono text-lg font-bold text-indigo-700 break-all mb-3">
                        {row.public_id || 'Sin identificador'}
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() => row.public_id && copyToClipboard(row.public_id, row.id)}
                          disabled={!row.public_id}
                          className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                        >
                          <Copy className="w-4 h-4" />
                          {copiedId === row.id ? 'Copiado' : 'Copiar'}
                        </button>

                        <button
                          onClick={() => regeneratePublicId(row.id)}
                          disabled={regeneratingStudentId === row.id}
                          className="flex-1 px-3 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-all flex items-center justify-center gap-2"
                        >
                          <RefreshCcw className="w-4 h-4" />
                          {regeneratingStudentId === row.id ? 'Regenerando...' : 'Regenerar'}
                        </button>
                      </div>
                      {copiedId === row.id && (
                        <p className="mt-2 text-sm font-medium text-green-600">
                          Se ha copiado correctamente
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {editingForm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden"
          >
            <div className="px-8 py-6 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-2xl font-bold text-slate-800">
                {editingForm.id ? 'Editar Formulario' : 'Nuevo Formulario'}
              </h3>
              <button
                onClick={() => {
                  setEditingForm(null);
                  setFormModalError(null);
                  setCopySourceSelectorOpen(false);
                }}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <XCircle className="w-8 h-8" />
              </button>
            </div>

            <form onSubmit={saveForm} className="p-8 space-y-6 max-h-[80vh] overflow-y-auto">
              {formModalError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {formModalError}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-700 mb-2">
                    Título del Formulario
                  </label>
                  <input
                    required
                    type="text"
                    value={editingForm.title}
                    onChange={(e) => setEditingForm({ ...editingForm, title: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-700 mb-2">
                    URL de Google Forms
                  </label>
                  <input
                    required
                    type="url"
                    value={editingForm.url}
                    onChange={(e) => setEditingForm({ ...editingForm, url: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="flex items-start gap-3 p-4 rounded-xl border border-slate-200 bg-slate-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editingForm.google_form_watch_enabled}
                      onChange={(e) => {
                        setCopySourceSelectorOpen(false);
                        setEditingForm({
                          ...editingForm,
                          google_form_watch_enabled: e.target.checked,
                        });
                      }}
                      className="mt-1 w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <div className="font-bold text-sm text-slate-700">
                        Activar seguimiento automático de respuestas
                      </div>
                      <div className="text-sm text-slate-500">
                        Si está activado, este formulario quedará incluido en la sincronización de watches de Google Forms y se revisará de forma automática que los datos introducidos por los usuarios son correctos,
                        además de comprobarse también que ningún usuario externo envía el formulario.
                      </div>
                    </div>
                  </label>
                </div>
                {editingForm.google_form_watch_enabled && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-bold text-slate-700 mb-2">
                      ID de EDICIÓN del formulario de Google
                    </label>
                    <input
                      type="text"
                      value={editingForm.google_form_id}
                      onChange={(e) => setEditingForm({ ...editingForm, google_form_id: e.target.value })}
                      placeholder="Ej: 1FAIpQLSe..."
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                    />
                    <p className="mt-2 text-sm text-slate-500">
                      Se usará para integrar este formulario con Google Forms API y detectar respuestas enviadas.
                    </p>
                  </div>
                )}

                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-700 mb-2">
                    Descripción
                  </label>
                  <textarea
                    value={editingForm.description}
                    onChange={(e) => setEditingForm({ ...editingForm, description: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all h-24 resize-none"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-700 mb-4">
                    Tipo de acceso
                  </label>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label
                      className={`flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
                        editingForm.access_type === 'public'
                          ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name="access_type"
                        checked={editingForm.access_type === 'public'}
                        onChange={() => {
                          setCopySourceSelectorOpen(false);
                          setEditingForm({
                            ...editingForm,
                            access_type: 'public',
                            group_ids: [],
                            prefill_public_id_entry: '',
                            prefill_name_entry: '',
                            prefill_dni_entry: '',
                            prefill_gender_entry: '',
                            prefill_school_entry: '',
                            prefill_birth_date_entry: '',
                            prefill_group_entry: '',
                            response_public_id_question_id: '',
                            response_name_question_id: '',
                            response_dni_question_id: '',
                            response_gender_question_id: '',
                            response_school_question_id: '',
                            response_birth_date_question_id: '',
                            response_group_question_id: '',
                          });
                        }}
                        className="w-5 h-5"
                      />
                      <div>
                        <div className="font-bold text-sm">ACCESO LIBRE</div>
                        <div className="text-xs opacity-80">
                          Cualquiera puede ver y abrir este formulario.
                        </div>
                      </div>
                    </label>

                    <label
                      className={`flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
                        editingForm.access_type === 'restricted'
                          ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <input
                        type="radio"
                        name="access_type"
                        checked={editingForm.access_type === 'restricted'}
                        onChange={() => {
                          setCopySourceSelectorOpen(false);
                          setEditingForm({
                            ...editingForm,
                            access_type: 'restricted',
                          })
                        }}
                        className="w-5 h-5"
                      />
                      <div>
                        <div className="font-bold text-sm">ACCESO LIMITADO</div>
                        <div className="text-xs opacity-80">
                          Solo lo verán los alumnos de los grupos seleccionados.
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-2">
                    Fecha de Apertura
                  </label>
                  <input
                    type="datetime-local"
                    value={editingForm.open_date}
                    onChange={(e) => setEditingForm({ ...editingForm, open_date: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
                  />
                </div>

                <div>
                  <label className="block text-sm font-bold text-slate-700 mb-2">
                    Fecha de Cierre
                  </label>
                  <input
                    type="datetime-local"
                    value={editingForm.close_date}
                    onChange={(e) => setEditingForm({ ...editingForm, close_date: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
                  />
                </div>

                {editingForm && (
                  <div className="md:col-span-2">
                    <div className="bg-green-50 border border-green-200 rounded-2xl p-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="text-sm font-bold text-green-800">
                            Reutilizar identificadores desde otro formulario
                          </div>
                          <div className="text-sm text-green-600">
                            Solo se muestran plantillas de formularios del mismo tipo de acceso
                            {editingForm.google_form_watch_enabled
                              ? ' y con seguimiento automático activado'
                              : ''}.
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => setCopySourceSelectorOpen((prev) => !prev)}
                          className="px-4 py-2 bg-white border border-green-200 rounded-xl text-sm font-semibold text-green-700 hover:bg-green-100 transition-all flex items-center justify-center gap-2"
                        >
                          <Copy className="w-4 h-4" />
                          {editingForm.google_form_watch_enabled
                            ? 'Copiar identificadores prefill y de seguimiento de otro formulario'
                            : 'Copiar identificadores prefill de otro formulario'}
                        </button>
                      </div>

                      {copySourceSelectorOpen && (
                        <div className="mt-4 border-t border-slate-200 pt-4">
                          {compatibleFormsForCopy.length === 0 ? (
                            <p className="text-sm text-slate-500">
                              No hay otros formularios compatibles desde los que copiar.
                            </p>
                          ) : (
                            <div className="grid grid-cols-1 gap-2">
                              {compatibleFormsForCopy.map((form) => (
                                <button
                                  key={form.id}
                                  type="button"
                                  onClick={() => copyIdentifiersFromForm(form)}
                                  className="w-full text-left px-4 py-3 bg-white border border-slate-200 rounded-xl hover:bg-slate-100 transition-all"
                                >
                                  <div className="font-semibold text-slate-800">
                                    {form.title}
                                  </div>
                                  <div className="text-sm text-slate-500 break-all">
                                    {form.url}
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {editingForm.access_type === 'restricted' && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-bold text-slate-700 mb-4">
                      Grupos con acceso
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {groups.map((group) => (
                        <label
                          key={group.id}
                          className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer ${
                            editingForm.group_ids.includes(group.id)
                              ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={editingForm.group_ids.includes(group.id)}
                            onChange={(e) => {
                              const current = editingForm.group_ids;
                              if (e.target.checked) {
                                setEditingForm({
                                  ...editingForm,
                                  group_ids: [...current, group.id],
                                });
                              } else {
                                setEditingForm({
                                  ...editingForm,
                                  group_ids: current.filter((id) => id !== group.id),
                                });
                              }
                            }}
                            className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="font-medium text-sm truncate">{group.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {editingForm.access_type === 'restricted' && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-bold text-slate-700 mb-4">
                      Campos de prerrelleno de Google Forms
                    </label>
                    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
                      <p className="text-sm text-amber-800">
                        Introduce aquí los identificadores <span className="font-mono font-bold">entry.XXXXXXXXX</span> de Google Forms.
                        En los formularios de acceso limitado, todos estos identificadores son obligatorios para poder validar
                        correctamente las respuestas recibidas.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          IDENTIFICADOR
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_public_id_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_public_id_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          NOMBRE COMPLETO
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_name_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_name_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          DNI
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_dni_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_dni_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          GÉNERO
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_gender_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_gender_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          EMAIL DE CONTACTO
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_parent_email_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_parent_email_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          COLEGIO
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_school_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_school_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          FECHA DE NACIMIENTO
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_birth_date_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_birth_date_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          GRUPO
                        </label>
                        <input
                          type="text"
                          value={editingForm.prefill_group_entry}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, prefill_group_entry: e.target.value })
                          }
                          placeholder="entry.123456789"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                    </div>
                  </div>
                )}

{editingForm.access_type === 'restricted' && editingForm.google_form_watch_enabled && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-bold text-slate-700 mb-4">
                      Campos de seguimiento de preguntas
                    </label>
                    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
                      <p className="text-sm text-amber-800">
                        Introduce aquí los identificadores de respuesta que devuelve la API de Google Forms para cada pregunta.
                        Estos identificadores no tienen formato <span className="font-mono font-bold">entry.XXXXXXXXX</span>,
                        sino valores como <span className="font-mono font-bold">617c86bb</span>.
                        Se utilizan para leer y validar las respuestas enviadas.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL IDENTIFICADOR
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_public_id_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_public_id_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL NOMBRE COMPLETO
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_name_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_name_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL DNI
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_dni_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_dni_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL GÉNERO
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_gender_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_gender_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL EMAIL DE CONTACTO
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_parent_email_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_parent_email_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL COLEGIO
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_school_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_school_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL FECHA DE NACIMIENTO
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_birth_date_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_birth_date_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-slate-600 mb-2">
                          QUESTION ID DEL GRUPO
                        </label>
                        <input
                          type="text"
                          value={editingForm.response_group_question_id}
                          onChange={(e) =>
                            setEditingForm({ ...editingForm, response_group_question_id: e.target.value })
                          }
                          placeholder="012ad74c"
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {editingForm.access_type === 'public' && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-bold text-slate-700 mb-4">
                      Campos de prerrelleno para acceso libre
                    </label>
                    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-4">
                      <p className="text-sm text-blue-800">
                        Introduce aquí el identificador <span className="font-mono font-bold">entry.XXXXXXXXX</span> del campo
                        <span className="font-semibold"> EMAIL DE CONTACTO</span> de Google Forms.
                        Este identificador es obligatorio para poder validar las respuestas del formulario.
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-600 mb-2">
                        EMAIL DE CONTACTO
                      </label>
                      <input
                        type="text"
                        value={editingForm.prefill_parent_email_entry}
                        onChange={(e) =>
                          setEditingForm({ ...editingForm, prefill_parent_email_entry: e.target.value })
                        }
                        placeholder="entry.123456789"
                        className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                      />
                    </div>
                  </div>
                )}
                {editingForm.access_type === 'public' && editingForm.google_form_watch_enabled && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-bold text-slate-700 mb-4">
                      Campos de seguimiento de preguntas para acceso libre
                    </label>
                    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-4">
                      <p className="text-sm text-blue-800">
                        Introduce aquí el identificador de la pregunta
                        <span className="font-semibold"> EMAIL DE CONTACTO</span> de Google Forms.
                        Este identificador es obligatorio para poder hacer un seguimiento de las respuestas del formulario.
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-slate-600 mb-2">
                        QUESTION ID DEL EMAIL DE CONTACTO
                      </label>
                      <input
                        type="text"
                        value={editingForm.response_parent_email_question_id}
                        onChange={(e) =>
                          setEditingForm({ ...editingForm, response_parent_email_question_id: e.target.value })
                        }
                        placeholder="617c86bb"
                        className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setEditingForm(null);
                    setFormModalError(null);
                    setCopySourceSelectorOpen(false);
                  }}
                  className="px-6 py-3 text-slate-600 font-bold hover:bg-slate-100 rounded-xl transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving || syncingWatch || isSaveDisabled}
                  className="px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {syncingWatch ? 'Sincronizando watch...' : saving ? 'Guardando...' : 'Guardar Formulario'}
                </button>
              </div>

              {isSaveDisabled && (
                <p className="text-sm text-amber-700">
                  Completa todos los campos obligatorios antes de guardar.
                </p>
              )}
            </form>
          </motion.div>
        </div>
      )}
    </div>
  );
};
