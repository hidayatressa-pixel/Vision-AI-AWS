import { FormEvent, ReactNode, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { LockKeyhole, LogOut, ShieldCheck, KeyRound, Mail } from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../../services/supabase';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(Boolean(supabase));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(
    new URLSearchParams(window.location.search).get('resetPassword') === '1',
  );

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setError(sessionError.message);
      setSession(data.session);
      setChecking(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true);
        setError('');
        setNotice('Verify your new password below.');
      }
      setChecking(false);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const handleSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || submitting) return;
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      setSession(data.session);
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordRecovery = async () => {
    if (!supabase || submitting) return;
    if (!email.trim()) {
      setError('Enter your operator email first.');
      return;
    }
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/?resetPassword=1`,
      });
      if (recoveryError) throw recoveryError;
      setNotice('If the account exists, a password-reset link has been sent. Check your inbox and spam folder.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to send password-reset email.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetNewPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || submitting) return;
    if (newPassword.length < 8) {
      setError('Use a password with at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setSession(data.user ? (await supabase.auth.getSession()).data.session : null);
      setRecoveryMode(false);
      setNewPassword('');
      setConfirmPassword('');
      setNotice('Password updated. You can now continue using Vision-AI AWS.');
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update password. Request a new recovery link.');
    } finally {
      setSubmitting(false);
    }
  };

  const params = new URLSearchParams(window.location.search);
  const isPhoneCameraRoute = params.get('camera') === 'phone' && Boolean(params.get('session'));
  if (isPhoneCameraRoute) return <>{children}</>;

  if (!isSupabaseConfigured || !supabase) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <section className="w-full max-w-lg rounded-3xl border border-amber-500/30 bg-slate-900 p-7">
          <div className="text-xs font-mono tracking-[0.2em] text-amber-300">CONFIGURATION REQUIRED</div>
          <h1 className="mt-3 text-xl font-black">Supabase Auth is not configured</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">Cloud access is disabled until VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are configured in the frontend build environment. No inspection workspace is exposed in this state.</p>
        </section>
      </main>
    );
  }

  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm font-mono text-cyan-300">CHECKING SUPABASE SESSION...</div>;
  }

  if (recoveryMode) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <section className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-7 shadow-2xl">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300"><KeyRound size={28} /></div>
            <div><div className="text-xs font-mono tracking-[0.2em] text-cyan-300">VISION-AI AWS</div><div className="text-lg font-black">Set a new password</div></div>
          </div>
          <form onSubmit={handleSetNewPassword} className="space-y-4">
            <label className="block text-xs font-mono text-slate-400">NEW PASSWORD
              <input autoComplete="new-password" type="password" required minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400" placeholder="At least 8 characters" />
            </label>
            <label className="block text-xs font-mono text-slate-400">CONFIRM NEW PASSWORD
              <input autoComplete="new-password" type="password" required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400" placeholder="Repeat new password" />
            </label>
            {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-200">{error}</p>}
            {notice && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3 text-xs text-emerald-200">{notice}</p>}
            <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-black text-slate-950 hover:bg-cyan-300 disabled:opacity-50">
              <KeyRound size={16} /> {submitting ? 'UPDATING...' : 'UPDATE PASSWORD'}
            </button>
          </form>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
        <section className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-7 shadow-2xl">
          <div className="mb-8 flex items-center gap-3">
            <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300"><ShieldCheck size={28} /></div>
            <div><div className="text-xs font-mono tracking-[0.2em] text-cyan-300">VISION-AI AWS</div><div className="text-lg font-black">Secure operator sign-in</div></div>
          </div>
          <form onSubmit={handleSignIn} className="space-y-4">
            <label className="block text-xs font-mono text-slate-400">EMAIL
              <input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400" placeholder="operator@company.com" />
            </label>
            <label className="block text-xs font-mono text-slate-400">PASSWORD
              <input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400" placeholder="Your password" />
            </label>
            {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-200">{error}</p>}
            {notice && <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-3 text-xs text-emerald-200">{notice}</p>}
            <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-black text-slate-950 hover:bg-cyan-300 disabled:opacity-50">
              <LockKeyhole size={16} /> {submitting ? 'SIGNING IN...' : 'SIGN IN'}
            </button>
          </form>
          <button type="button" disabled={submitting} onClick={() => void handlePasswordRecovery()} className="mt-4 flex w-full items-center justify-center gap-2 text-xs font-semibold text-cyan-300 hover:text-cyan-200 disabled:opacity-50">
            <Mail size={14} /> FORGOT PASSWORD? SEND RESET LINK
          </button>
          <p className="mt-5 text-center text-[10px] leading-5 text-slate-500">Accounts must be provisioned by the project administrator in Supabase Auth. Public self-registration is not enabled in this application.</p>
        </section>
      </main>
    );
  }

  return (
    <>
      <div className="flex items-center justify-end gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2 text-[10px] font-mono text-slate-400">
        <span className="truncate">{session.user.email}</span>
        <button type="button" onClick={() => { if (supabase) void supabase.auth.signOut(); }} className="flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 hover:border-rose-400/50 hover:text-rose-200"><LogOut size={12} /> SIGN OUT</button>
      </div>
      {children}
    </>
  );
}
