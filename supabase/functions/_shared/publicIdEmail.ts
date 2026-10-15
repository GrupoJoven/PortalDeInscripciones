// Correo con los identificadores de acceso de los hijos de una familia.
// Lo usan el envío masivo de recordatorios (send-public-id-reminders) y la
// recuperación desde la portada (recover-public-ids).

export type PublicIdEmailChild = {
  name: string;
  public_id: string;
  group_name: string;
};

export function buildPublicIdEmail(children: PublicIdEmailChild[], appBaseUrl: string) {
  const isSingle = children.length === 1;

  const subject = isSingle
    ? "Identificador de acceso al portal de inscripciones"
    : "Identificadores de acceso al portal de inscripciones";

  const rows = children
    .map(
      (child) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;">${escapeHtml(child.name)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;">${escapeHtml(child.group_name)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-weight:bold;color:#4338ca;">${escapeHtml(
            child.public_id
          )}</td>
        </tr>`
    )
    .join("");

  const portalUrl = appBaseUrl ? appBaseUrl.replace(/\/$/, "") : "";

  const portalBlock = portalUrl
    ? `
        <p>
          <a href="${portalUrl}" style="display:inline-block;padding:12px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">
            Ir al portal de inscripciones
          </a>
        </p>
        <p>Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
        <p>${portalUrl}</p>`
    : "";

  // Usar el identificador de un hermano para inscribir a otro hace que la
  // respuesta no coincida con sus datos y se borre.
  const siblingsNote = isSingle
    ? ""
    : `
      <p>
        <strong>Cada hijo/a tiene su propio identificador.</strong> Usa el de cada uno para
        inscribirle: con el de un hermano, la inscripción no será válida.
      </p>`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
      <h2>${isSingle ? "Identificador de acceso" : "Identificadores de acceso"}</h2>
      <p>Hola,</p>
      <p>
        Te recordamos ${isSingle ? "el identificador" : "los identificadores"} de acceso al portal de
        inscripciones ${isSingle ? "de tu hijo/a" : "de tus hijos/as"}:
      </p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr>
            <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #cbd5e1;">Nombre</th>
            <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #cbd5e1;">Grupo</th>
            <th style="text-align:left;padding:10px 14px;border-bottom:2px solid #cbd5e1;">Identificador</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
      <p>
        Introduce ${isSingle ? "este identificador" : "el identificador correspondiente"} en el portal
        para ver los formularios disponibles.
      </p>
      ${siblingsNote}
      ${portalBlock}
      <p style="margin-top:24px;color:#6b7280;font-size:13px;">
        NOTA: no respondas a este correo electrónico, ha sido enviado de manera automática.
      </p>
    </div>
  `;

  return { subject, html };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
