import { createClient } from '@supabase/supabase-js';

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || '').trim().replace(/\/$/, '');
const publishableKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && publishableKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export async function getSupabaseAccessToken(forceRefresh = false): Promise<string> {
  if (!supabase) {
    throw new Error('Supabase Auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  const result = forceRefresh
    ? await supabase.auth.refreshSession()
    : await supabase.auth.getSession();

  if (result.error) {
    throw new Error(forceRefresh
      ? 'Your Supabase session could not be refreshed. Sign in again to continue.'
      : result.error.message);
  }

  let session = result.data.session;
  if (!session) throw new Error('Sign in to Vision-AI before using cloud services.');

  // Refresh slightly before expiry so a request is not sent with a token
  // that expires while it is travelling to the Vision backend.
  if (!forceRefresh && session.expires_at && session.expires_at * 1000 <= Date.now() + 60_000) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session) {
      throw new Error('Your Supabase session has expired. Sign in again to continue.');
    }
    session = refreshed.data.session;
  }

  if (!session.access_token) throw new Error('Sign in to Vision-AI before using cloud services.');
  return session.access_token;
}

export function getVisionApiBaseUrl(): string {
  return String(import.meta.env.VITE_VISION_API_URL || '').trim().replace(/\/$/, '');
}
