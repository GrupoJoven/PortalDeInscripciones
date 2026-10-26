import { useState } from 'react';

/** Datos de la transferencia; el IBAN se muestra en grupos de 4 pero se copia sin espacios. */
export const BANK_DETAILS = [
  { label: 'IBAN', value: 'ES1031590078512779528427', display: 'ES10 3159 0078 5127 7952 8427' },
  { label: 'Beneficiario', value: 'PARROQUIA SAN PASCUAL BAILÓN', display: 'PARROQUIA SAN PASCUAL BAILÓN' },
] as const;

const COPIED_FEEDBACK_MS = 2000;

/** Copia un dato al portapapeles y recuerda unos segundos cuál fue, para mostrar "Copiado". */
export const useCopyBankDetail = () => {
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const copyBankDetail = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedLabel(label);
      window.setTimeout(
        () => setCopiedLabel((current) => (current === label ? null : current)),
        COPIED_FEEDBACK_MS,
      );
    } catch (err) {
      console.error(err);
    }
  };

  return { copiedLabel, copyBankDetail };
};
