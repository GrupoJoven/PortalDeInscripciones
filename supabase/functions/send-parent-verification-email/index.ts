const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-function-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const internalSecret = Deno.env.get("INTERNAL_EMAIL_FUNCTION_SECRET");
    const providedSecret = req.headers.get("x-internal-function-secret");

    if (!internalSecret || providedSecret !== internalSecret) {
      return jsonResponse({ ok: false, error: "forbidden" }, 403);
    }

    const body = await req.json().catch(() => null);

    const to = typeof body?.to === "string" ? body.to.trim() : "";
    const studentName = typeof body?.student_name === "string" ? body.student_name.trim() : "";
    const publicId = typeof body?.public_id === "string" ? body.public_id.trim() : "";
    const token = typeof body?.token === "string" ? body.token.trim() : "";

    if (!to || !publicId || !token) {
      return jsonResponse({ ok: false, error: "missing_fields" }, 400);
    }

    const serviceAccountEmail = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    const privateKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
    const impersonatedUser = Deno.env.get("GOOGLE_WORKSPACE_IMPERSONATED_USER");
    const appBaseUrl = Deno.env.get("APP_BASE_URL");

    if (!serviceAccountEmail || !privateKeyRaw || !impersonatedUser || !appBaseUrl) {
      console.error("Faltan variables de entorno");
      return jsonResponse({ ok: false, error: "missing_env_vars" }, 500);
    }

    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

    const accessToken = await getGoogleAccessToken({
      serviceAccountEmail,
      privateKey,
      impersonatedUser,
      scope: "https://www.googleapis.com/auth/gmail.send",
    });

    const verifyUrl =
      `${appBaseUrl.replace(/\/$/, "")}/verify-parent-email` +
      `?token=${encodeURIComponent(token)}&public_id=${encodeURIComponent(publicId)}`;

    const subject = "Verifica tu correo para acceder a los formularios";

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
        <h2>Verificación de correo</h2>
        <p>Hola,</p>
        <p>Se ha solicitado acceso a los formularios${studentName ? ` para <strong>${escapeHtml(studentName)}</strong>` : ""}.</p>
        <p>Antes de continuar, necesitamos comprobar que este correo funciona correctamente.</p>
        <p>
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;">
            Verificar correo
          </a>
        </p>
        <p>Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
        <p>${verifyUrl}</p>
        <p>Este enlace caduca en 24 horas.</p>
      </div>
    `;

    const rawEmail = buildMimeMessage({
      from: impersonatedUser,
      to,
      subject,
      html,
    });

    const gmailResponse = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          raw: base64UrlEncode(rawEmail),
        }),
      }
    );

    const gmailText = await gmailResponse.text();

    if (!gmailResponse.ok) {
      console.error("Error Gmail API:", gmailText);
      return jsonResponse(
        { ok: false, error: "gmail_send_failed", details: gmailText },
        500
      );
    }

    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    console.error("Error no controlado:", error);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

async function getGoogleAccessToken({
  serviceAccountEmail,
  privateKey,
  impersonatedUser,
  scope,
}: {
  serviceAccountEmail: string;
  privateKey: string;
  impersonatedUser: string;
  scope: string;
}) {
  const now = Math.floor(Date.now() / 1000);

  const jwtHeader = {
    alg: "RS256",
    typ: "JWT",
  };

  const jwtClaimSet = {
    iss: serviceAccountEmail,
    sub: impersonatedUser,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(jwtHeader));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(jwtClaimSet));
  const unsignedJwt = `${encodedHeader}.${encodedClaimSet}`;

  const signature = await signJwt(unsignedJwt, privateKey);
  const signedJwt = `${unsignedJwt}.${signature}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error("Error OAuth Google:", tokenData);
    throw new Error("google_oauth_failed");
  }

  return tokenData.access_token as string;
}

async function signJwt(unsignedJwt: string, privateKeyPem: string) {
  const keyData = pemToArrayBuffer(privateKeyPem);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedJwt)
  );

  return base64UrlEncode(new Uint8Array(signatureBuffer));
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer;
}

function buildMimeMessage({
  from,
  to,
  subject,
  html,
}: {
  from: string;
  to: string;
  subject: string;
  html: string;
}) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");
}

function base64UrlEncode(input: string | Uint8Array) {
  let bytes: Uint8Array;

  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = input;
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}