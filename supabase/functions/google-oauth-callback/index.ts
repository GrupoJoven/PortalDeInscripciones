import { createClient } from "npm:@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
const GOOGLE_OAUTH_STATE_SECRET = Deno.env.get("GOOGLE_OAUTH_STATE_SECRET")!;

function requireEnv(value: string | undefined, name: string) {
  if (!value) throw new Error(`Falta la variable de entorno: ${name}`);
  return value;
}

async function verifyState(state: string) {
  const secret = requireEnv(GOOGLE_OAUTH_STATE_SECRET, "GOOGLE_OAUTH_STATE_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  await verify(state, key);
}

async function fetchGoogleProfile(accessToken: string) {
  const resp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!resp.ok) return null;
  return await resp.json();
}

Deno.serve(async (req) => {
  try {
    requireEnv(SUPABASE_URL, "SUPABASE_URL");
    requireEnv(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY");
    requireEnv(GOOGLE_OAUTH_CLIENT_ID, "GOOGLE_OAUTH_CLIENT_ID");
    requireEnv(GOOGLE_OAUTH_CLIENT_SECRET, "GOOGLE_OAUTH_CLIENT_SECRET");
    requireEnv(GOOGLE_OAUTH_STATE_SECRET, "GOOGLE_OAUTH_STATE_SECRET");

    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return new Response(
        `<html><body><h2>Error OAuth</h2><p>${error}</p></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    if (!code || !state) {
      return new Response(
        `<html><body><h2>Error</h2><p>Faltan parámetros code o state.</p></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    await verifyState(state);

    const redirectUri = `${SUPABASE_URL}/functions/v1/google-oauth-callback`;

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokenJson = await tokenResp.json();

    if (!tokenResp.ok) {
      return new Response(
        `<html><body><h2>Error token</h2><pre>${JSON.stringify(tokenJson, null, 2)}</pre></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    if (!tokenJson.refresh_token) {
      return new Response(
        `<html><body><h2>Error</h2><p>Google no devolvió refresh_token. Revoca el acceso y vuelve a autorizar con prompt=consent.</p><pre>${JSON.stringify(tokenJson, null, 2)}</pre></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    const profile = await fetchGoogleProfile(tokenJson.access_token);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const expiryDate = tokenJson.expires_in
      ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
      : null;

    const { error: upsertError } = await supabase
      .from("google_oauth_tokens")
      .upsert({
        provider: "google_forms",
        google_email: profile?.email ?? null,
        access_token: tokenJson.access_token ?? null,
        refresh_token: tokenJson.refresh_token,
        scope: tokenJson.scope ?? null,
        token_type: tokenJson.token_type ?? null,
        expiry_date: expiryDate,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: "provider",
      });

    if (upsertError) {
      throw upsertError;
    }

    return new Response(
      `<html><body><h2>Autorización completada</h2><p>Ya se ha guardado el refresh token en Supabase.</p><p>Cuenta: ${profile?.email ?? "desconocida"}</p></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  } catch (err) {
    return new Response(
      `<html><body><h2>Error</h2><pre>${err instanceof Error ? err.message : String(err)}</pre></body></html>`,
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
});