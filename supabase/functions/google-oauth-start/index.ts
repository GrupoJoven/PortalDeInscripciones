import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
const GOOGLE_OAUTH_STATE_SECRET = Deno.env.get("GOOGLE_OAUTH_STATE_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

function requireEnv(value: string | undefined, name: string) {
  if (!value) throw new Error(`Falta la variable de entorno: ${name}`);
  return value;
}

async function getStateToken() {
  const secret = requireEnv(GOOGLE_OAUTH_STATE_SECRET, "GOOGLE_OAUTH_STATE_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return await create(
    { alg: "HS256", typ: "JWT" },
    {
      purpose: "google_oauth",
      iat: getNumericDate(0),
      exp: getNumericDate(60 * 10),
    },
    key
  );
}

Deno.serve(async () => {
  try {
    requireEnv(GOOGLE_OAUTH_CLIENT_ID, "GOOGLE_OAUTH_CLIENT_ID");
    requireEnv(SUPABASE_URL, "SUPABASE_URL");

    const redirectUri = `${SUPABASE_URL}/functions/v1/google-oauth-callback`;
    const state = await getStateToken();

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set(
      "scope",
      [
        "https://www.googleapis.com/auth/forms.body",
        "https://www.googleapis.com/auth/forms.responses.readonly",
        "openid",
        "email",
      ].join(" ")
    );
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", state);

    return Response.redirect(authUrl.toString(), 302);
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }, null, 2),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});