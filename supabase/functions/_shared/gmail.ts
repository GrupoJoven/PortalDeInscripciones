// Envío de correo a través de Gmail API (cuenta de servicio con delegación de dominio).
// Extraído de send-form-policy-email para poder invocarse directamente desde otras
// funciones sin pasar por una llamada HTTP interna (function-to-function), que en
// Supabase Edge Runtime está sujeta a su propio límite de peticiones salientes.

export type SendGmailEmailParams = {
  to: string;
  subject: string;
  html: string;
};

// Los tokens de acceso duran 1h; los reutilizamos entre envíos dentro del
// mismo isolate para no pedir uno nuevo a Google por cada correo.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export async function sendGmailEmail({ to, subject, html }: SendGmailEmailParams): Promise<void> {
  const serviceAccountEmail = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  const impersonatedUser = Deno.env.get("GOOGLE_WORKSPACE_IMPERSONATED_USER");

  if (!serviceAccountEmail || !privateKeyRaw || !impersonatedUser) {
    throw new Error("missing_env_vars");
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const accessToken = await getCachedGoogleAccessToken({
    serviceAccountEmail,
    privateKey,
    impersonatedUser,
    scope: "https://www.googleapis.com/auth/gmail.send",
  });

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
    throw new Error(`gmail_send_failed: ${gmailText}`);
  }
}

async function getCachedGoogleAccessToken(params: {
  serviceAccountEmail: string;
  privateKey: string;
  impersonatedUser: string;
  scope: string;
}) {
  const safetyMarginMs = 60_000;

  if (cachedAccessToken && cachedAccessToken.expiresAt - safetyMarginMs > Date.now()) {
    return cachedAccessToken.token;
  }

  const token = await getGoogleAccessToken(params);
  cachedAccessToken = { token, expiresAt: Date.now() + 3600 * 1000 };
  return token;
}

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
